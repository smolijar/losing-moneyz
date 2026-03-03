import type { Experiment, ExperimentSnapshot, AutopilotConfig } from "../config";
import { COINMATE_FEES } from "../config";
import { CoinmateApiError, type ExchangeClient } from "../coinmate";
import {
  calculateGridLevels,
  reconcileOrders,
  matchOrdersToGrid,
  computePnL,
  computeUnrealizedPnl,
  getBudgetPerLevel,
  type OrderAction,
  type FillEvent,
} from "../grid";
import type { Repository } from "../storage";
import type { WalletManager } from "../storage";
import { Autopilot, type AutopilotResult } from "../autopilot";
import {
  runAllSafeguards,
  type SafeguardConfig,
  DEFAULT_SAFEGUARD_CONFIG,
} from "./safeguards";

/** Result of processing a single experiment tick */
export interface TickResult {
  experimentId: string;
  status: "ok" | "paused" | "error" | "skipped";
  ordersPlaced: number;
  ordersCancelled: number;
  fillsDetected: number;
  warnings: string[];
  error?: string;
}

/** Result of the full grid tick across all experiments */
export interface GridTickResult {
  timestamp: Date;
  experimentResults: TickResult[];
  totalDurationMs: number;
  autopilotResult?: AutopilotResult;
}

/** Logger interface — thin abstraction for structured logging */
export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Severity levels for alert events */
export type AlertSeverity = "info" | "warning" | "critical";

/** Structured alert event for monitoring/alerting systems */
export interface AlertEvent {
  severity: AlertSeverity;
  type:
    | "safeguard_pause"
    | "order_disappeared"
    | "order_action_failed"
    | "api_error"
    | "unexpected_error"
    | "emergency_stop_completed"
    | "emergency_stop_failed"
    | "circuit_breaker_increment"
    | "wallet_release_success"
    | "wallet_release_failed";
  experimentId: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: Date;
}

/** Sink for alert events — implement to route to PagerDuty, Slack, email, etc. */
export interface AlertSink {
  emit(event: AlertEvent): void;
}

/** No-op alert sink for when no alerting is configured */
export const nullAlertSink: AlertSink = {
  emit() {
    /* noop */
  },
};

/**
 * Determine if an error is an API/transport error (eligible for circuit breaker)
 * vs a business logic error that should not increment the circuit breaker.
 */
function isTransportOrApiError(err: unknown): boolean {
  if (err instanceof CoinmateApiError) return true;
  if (err instanceof TypeError) return true; // fetch failures
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("fetch") ||
      msg.includes("network") ||
      msg.includes("timeout") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("socket")
    );
  }
  return false;
}

/**
 * Grid Tick Orchestrator — the core loop that processes all active experiments.
 *
 * For each active experiment:
 * 1. Fetch current price from Coinmate
 * 2. Run safeguard checks (with exchange-derived order count)
 * 3. Fetch open orders from Coinmate, filtered to this experiment (#7)
 * 4. Detect fills by comparing previous orders with current
 * 5. Run grid engine reconciliation with ReconcileOptions (pair, fees, availableBase)
 * 6. Execute order actions (place/cancel)
 * 7. Save state snapshot with fill-derived balances (#13)
 */
export interface OrchestratorOptions {
  safeguardConfig?: SafeguardConfig;
  alertSink?: AlertSink;
  walletManager?: WalletManager;
  /** Autopilot config. Pass `false` to disable autopilot entirely. */
  autopilotConfig?: Partial<AutopilotConfig> | false;
}

export class GridTickOrchestrator {
  private readonly alertSink: AlertSink;
  private readonly safeguardConfig: SafeguardConfig;
  private readonly walletManager: WalletManager | undefined;
  private readonly autopilot: Autopilot | undefined;

  constructor(
    private readonly client: ExchangeClient,
    private readonly repo: Repository,
    private readonly logger: Logger,
    options?: OrchestratorOptions,
  ) {
    this.safeguardConfig = options?.safeguardConfig ?? DEFAULT_SAFEGUARD_CONFIG;
    this.alertSink = options?.alertSink ?? nullAlertSink;
    this.walletManager = options?.walletManager;

    // Initialize autopilot if wallet manager is available and not explicitly disabled
    if (this.walletManager && options?.autopilotConfig !== false) {
      this.autopilot = new Autopilot(
        client,
        repo,
        this.walletManager,
        logger,
        options?.autopilotConfig || undefined,
      );
    }
  }

  /**
   * Execute a full grid tick — process all active experiments.
   */
  async executeTick(): Promise<GridTickResult> {
    const startTime = Date.now();
    const timestamp = new Date();

    this.logger.info("Grid tick started");

    // Sync internal wallet with exchange balances
    if (this.walletManager) {
      try {
        const balances = await this.client.getBalances();
        // Treat missing currencies as zero — e.g. BTC won't appear until the account first holds some
        const czkAvailable = balances.data["CZK"]?.available ?? 0;
        const btcAvailable = balances.data["BTC"]?.available ?? 0;
        const sync = await this.walletManager.syncWallet(czkAvailable, btcAvailable);
        this.logger.info("Wallet synced with exchange", {
          availableQuote: sync.walletState.availableQuote,
          availableBase: sync.walletState.availableBase,
          discrepancy: sync.discrepancy,
        });
        if (sync.discrepancy) {
          this.logger.warn("Wallet discrepancy detected", {
            quoteDiscrepancy: sync.quoteDiscrepancy,
            baseDiscrepancy: sync.baseDiscrepancy,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error("Wallet sync failed", { error: errMsg });
        // Non-fatal — continue tick with stale wallet state
      }
    }

    const experiments = await this.repo.getExperimentsByStatus("active");
    this.logger.info(`Found ${experiments.length} active experiments`);

    const results: TickResult[] = [];
    let autopilotResult: AutopilotResult | undefined;

    for (const experiment of experiments) {
      const result = await this.processExperiment(experiment, timestamp);
      results.push(result);
    }

    // Also check for "stopped" experiments that need cleanup
    const stoppedExperiments = await this.repo.getExperimentsByStatus("stopped");
    for (const experiment of stoppedExperiments) {
      const result = await this.handleEmergencyStop(experiment);
      results.push(result);
    }

    // Autopilot: when no active experiments, try to self-regulate
    if (experiments.length === 0 && this.autopilot) {
      try {
        autopilotResult = await this.autopilot.engage();
        this.logger.info("Autopilot result", {
          action: autopilotResult.action,
          reason: autopilotResult.reason,
          experimentId: autopilotResult.experimentId,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error("Autopilot failed", { error: errMsg });
        // Non-fatal: autopilot failure should not crash the tick
      }
    }

    const totalDurationMs = Date.now() - startTime;
    this.logger.info("Grid tick completed", {
      durationMs: totalDurationMs,
      experiments: results.length,
    });

    return { timestamp, experimentResults: results, totalDurationMs, autopilotResult };
  }

  /**
   * Process a single experiment's tick.
   */
  private async processExperiment(
    experiment: Experiment,
    timestamp: Date,
  ): Promise<TickResult> {
    const result: TickResult = {
      experimentId: experiment.id,
      status: "ok",
      ordersPlaced: 0,
      ordersCancelled: 0,
      fillsDetected: 0,
      warnings: [],
    };

    try {
      // 1. Get current price
      const ticker = await this.client.getTicker(experiment.gridConfig.pair);
      const currentPrice = ticker.data.last;

      // 2. Get previous snapshot and DB orders
      const lastSnapshot = await this.repo.getLatestSnapshot(experiment.id);
      const previousOrders = await this.repo.getOrdersByStatus(experiment.id, "open");

      // Fetch historical fills for real-time drawdown calculation (#9)
      const historicalFilled = await this.repo.getOrdersByStatus(experiment.id, "filled");
      const historicalFillEvents: FillEvent[] = historicalFilled.map((o) => ({
        orderId: Number(o.coinmateOrderId),
        side: o.side,
        price: o.price,
        amount: o.amount,
        gridLevel: o.gridLevel,
        timestamp: o.filledAt?.getTime() ?? o.createdAt.getTime(),
      }));

      // 3. Fetch open orders from Coinmate
      const openOrdersResponse = await this.client.getOpenOrders(experiment.gridConfig.pair);
      const gridLevels = calculateGridLevels(experiment.gridConfig);

      // Normalize Coinmate order IDs to numbers (API can return string or number)
      const allCoinmateOrders = openOrdersResponse.data.map((o) => ({
        id: Number(o.id),
        type: o.type,
        price: o.price,
        amount: o.amount,
      }));

      // #7: Cross-experiment order isolation — only consider orders that belong
      // to this experiment (tracked in our DB). Orders from other experiments
      // or manual orders are ignored.
      const experimentCoinmateIds = new Set(
        previousOrders.map((o) => Number(o.coinmateOrderId)),
      );
      const coinmateOrders = allCoinmateOrders.filter(
        (o) => experimentCoinmateIds.has(o.id),
      );

      // #14: Use exchange-derived order count for safeguard check (not stale DB count)
      const exchangeOrderCount = coinmateOrders.length;

      // 4. Run safeguards (uses exchange-based order count, real-time drawdown #9)
      const safeguards = runAllSafeguards(
        experiment,
        currentPrice,
        lastSnapshot,
        experiment.consecutiveFailures,
        exchangeOrderCount,
        this.safeguardConfig,
        timestamp,
        historicalFillEvents,
      );

      result.warnings = safeguards.warnings;

      if (safeguards.shouldPause) {
        const pauseReasons = safeguards.results
          .filter((r) => r.action === "pause")
          .map((r) => r.reason);
        this.logger.warn("Safeguard triggered, pausing experiment", {
          experimentId: experiment.id,
          reasons: pauseReasons,
        });
        this.alertSink.emit({
          severity: "critical",
          type: "safeguard_pause",
          experimentId: experiment.id,
          message: `Experiment paused by safeguard: ${pauseReasons.join("; ")}`,
          data: { reasons: pauseReasons },
          timestamp: new Date(),
        });
        await this.repo.updateExperimentStatus(experiment.id, "paused");
        result.status = "paused";
        return result;
      }

      // 5. Match this experiment's Coinmate orders to grid levels
      const matchedOrders = matchOrdersToGrid(coinmateOrders, gridLevels);

      // 6. Detect fills: orders that were "open" in our DB but are no longer on Coinmate
      //    Verify via trade history — disappeared orders might have been externally cancelled.
      const coinmateOrderIds = new Set(coinmateOrders.map((o) => o.id));
      const missingOrders = previousOrders.filter(
        (dbOrder) => !coinmateOrderIds.has(Number(dbOrder.coinmateOrderId)),
      );

      const fills: FillEvent[] = [];

      if (missingOrders.length > 0) {
        // Fetch trade history to confirm which missing orders were actually filled
        const tradeHistory = await this.client.getOrderHistory(experiment.gridConfig.pair);
        const filledOrderIds = new Set(tradeHistory.data.map((t) => t.orderId));

        for (const dbOrder of missingOrders) {
          const cmId = Number(dbOrder.coinmateOrderId);

          if (filledOrderIds.has(cmId)) {
            // Confirmed fill via trade history
            fills.push({
              orderId: cmId,
              side: dbOrder.side,
              price: dbOrder.price,
              amount: dbOrder.amount,
              gridLevel: dbOrder.gridLevel,
              timestamp: Date.now(),
            });

            await this.repo.updateOrderStatus(
              experiment.id,
              dbOrder.id,
              "filled",
              new Date(),
            );
          } else {
            // Order disappeared but no matching trade — likely externally cancelled
            this.logger.warn("Order disappeared without fill confirmation, marking cancelled", {
              experimentId: experiment.id,
              orderId: dbOrder.id,
              coinmateOrderId: cmId,
            });
            this.alertSink.emit({
              severity: "warning",
              type: "order_disappeared",
              experimentId: experiment.id,
              message: `Order ${cmId} disappeared without fill — marked cancelled`,
              data: { orderId: dbOrder.id, coinmateOrderId: cmId },
              timestamp: new Date(),
            });

            await this.repo.updateOrderStatus(
              experiment.id,
              dbOrder.id,
              "cancelled",
            );
            result.warnings.push(`Order ${cmId} disappeared without fill — marked cancelled`);
          }
        }
      }

      result.fillsDetected = fills.length;

      // 7. Run grid reconciliation with ReconcileOptions
      const budgetPerLevel = getBudgetPerLevel(experiment.gridConfig);
      const pair = experiment.gridConfig.pair;
      const feeRate = COINMATE_FEES.maker;

      // #12: Compute available quote budget for buy orders.
      // Start from allocated quote, subtract buy fills, add sell fills (minus fees),
      // then subtract what's already committed in existing open buy orders.
      const allFillEvents = [...historicalFillEvents, ...fills];
      let availableQuote = experiment.allocatedQuote;
      for (const fill of allFillEvents) {
        const value = fill.price * fill.amount;
        if (fill.side === "buy") {
          availableQuote -= value * (1 + feeRate); // spent quote + fee
        } else {
          availableQuote += value * (1 - feeRate); // received quote - fee
        }
      }
      // Subtract quote committed in existing open buy orders
      for (const order of matchedOrders) {
        if (order.side === "buy") {
          availableQuote -= order.price * order.amount;
        }
      }

      // #4: Compute available base for sell orders (from fills minus open sells)
      let availableBase = experiment.allocatedBase;
      for (const fill of allFillEvents) {
        if (fill.side === "buy") {
          availableBase += fill.amount;
        } else {
          availableBase -= fill.amount;
        }
      }
      // Subtract base committed in existing open sell orders
      for (const order of matchedOrders) {
        if (order.side === "sell") {
          availableBase -= order.amount;
        }
      }

      const actions = reconcileOrders(
        gridLevels,
        matchedOrders,
        fills,
        currentPrice,
        budgetPerLevel,
        {
          feeRate,
          pair,
          availableBase,
          availableQuote,
        },
      );

      // 8. Execute order actions
      for (const action of actions) {
        try {
          if (action.type === "place") {
            await this.executePlaceOrder(experiment, action);
            result.ordersPlaced++;
          } else if (action.type === "cancel") {
            await this.executeCancelOrder(experiment, action);
            result.ordersCancelled++;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error("Failed to execute order action", {
            experimentId: experiment.id,
            action,
            error: errMsg,
          });
          this.alertSink.emit({
            severity: "warning",
            type: "order_action_failed",
            experimentId: experiment.id,
            message: `Order action failed: ${errMsg}`,
            data: { action, error: errMsg },
            timestamp: new Date(),
          });
          result.warnings.push(`Order action failed: ${errMsg}`);
        }
      }

      // 9. Save snapshot with fill-derived balances (#13)
      // allFillEvents and feeRate already computed above for budget enforcement
      const pnl = computePnL(allFillEvents);

      // Use engine's quantity-aware unrealized P&L computation
      const unrealized = computeUnrealizedPnl(allFillEvents, currentPrice);

      // #13: Derive balances from fills rather than static allocations.
      // Quote spent = sum of (price * amount) for buys; quote received = sum for sells.
      // Base = net bought - net sold.
      let derivedQuote = experiment.allocatedQuote;
      let derivedBase = experiment.allocatedBase;
      for (const fill of allFillEvents) {
        const value = fill.price * fill.amount;
        if (fill.side === "buy") {
          derivedQuote -= value * (1 + feeRate); // spent quote + fee
          derivedBase += fill.amount;
        } else {
          derivedQuote += value * (1 - feeRate); // received quote - fee
          derivedBase -= fill.amount;
        }
      }

      const snapshot: ExperimentSnapshot = {
        timestamp,
        balanceQuote: derivedQuote,
        balanceBase: derivedBase,
        openOrders: matchedOrders.length,
        unrealizedPnl: unrealized,
        realizedPnl: pnl.realizedPnl,
        currentPrice,
      };
      await this.repo.saveSnapshot(experiment.id, snapshot);

      // Reset consecutive failures on success
      if (experiment.consecutiveFailures > 0) {
        await this.repo.updateExperiment(experiment.id, { consecutiveFailures: 0 });
      }

      this.logger.info("Experiment tick completed", {
        experimentId: experiment.id,
        fills: result.fillsDetected,
        placed: result.ordersPlaced,
        cancelled: result.ordersCancelled,
        currentPrice,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.status = "error";
      result.error = errMsg;

      // #10: Only increment circuit breaker on API/transport errors,
      // not business logic errors (e.g. validation failures)
      if (isTransportOrApiError(err)) {
        const newFailures = experiment.consecutiveFailures + 1;
        try {
          await this.repo.updateExperiment(experiment.id, {
            consecutiveFailures: newFailures,
          });
        } catch (updateErr) {
          this.logger.error("Failed to update consecutiveFailures", {
            experimentId: experiment.id,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        }

        this.alertSink.emit({
          severity: "warning",
          type: "circuit_breaker_increment",
          experimentId: experiment.id,
          message: `Consecutive failures incremented to ${newFailures}`,
          data: { consecutiveFailures: newFailures },
          timestamp: new Date(),
        });
      }

      // Don't pause on transient API errors — just log and retry next tick
      if (err instanceof CoinmateApiError) {
        this.logger.error("Coinmate API error during tick", {
          experimentId: experiment.id,
          statusCode: err.statusCode,
          message: errMsg,
        });
        this.alertSink.emit({
          severity: "warning",
          type: "api_error",
          experimentId: experiment.id,
          message: `Coinmate API error: ${errMsg}`,
          data: { statusCode: err.statusCode },
          timestamp: new Date(),
        });
      } else {
        this.logger.error("Unexpected error during tick", {
          experimentId: experiment.id,
          error: errMsg,
        });
        this.alertSink.emit({
          severity: "critical",
          type: "unexpected_error",
          experimentId: experiment.id,
          message: `Unexpected error: ${errMsg}`,
          data: { error: errMsg },
          timestamp: new Date(),
        });
      }
    }

    return result;
  }

  /**
   * Place an order on Coinmate and record it in Firestore.
   */
  private async executePlaceOrder(
    experiment: Experiment,
    action: Extract<OrderAction, { type: "place" }>,
  ): Promise<void> {
    const pair = experiment.gridConfig.pair;
    let coinmateOrderId: number;

    if (action.side === "buy") {
      const response = await this.client.buyLimit(pair, action.amount, action.price);
      coinmateOrderId = Number(response.data);
    } else {
      const response = await this.client.sellLimit(pair, action.amount, action.price);
      coinmateOrderId = Number(response.data);
    }

    await this.repo.createOrder(experiment.id, {
      coinmateOrderId: coinmateOrderId.toString(),
      side: action.side,
      price: action.price,
      amount: action.amount,
      status: "open",
      gridLevel: action.gridLevel,
      createdAt: new Date(),
    });

    this.logger.info("Order placed", {
      experimentId: experiment.id,
      side: action.side,
      price: action.price,
      amount: action.amount,
      gridLevel: action.gridLevel,
      coinmateOrderId,
    });
  }

  /**
   * Cancel an order on Coinmate and update Firestore.
   */
  private async executeCancelOrder(
    experiment: Experiment,
    action: Extract<OrderAction, { type: "cancel" }>,
  ): Promise<void> {
    await this.client.cancelOrder(action.orderId);

    // Find the order in our DB and mark it cancelled
    const dbOrder = await this.repo.getOrderByCoinmateId(
      experiment.id,
      action.orderId.toString(),
    );
    if (dbOrder) {
      await this.repo.updateOrderStatus(experiment.id, dbOrder.id, "cancelled");
    }

    this.logger.info("Order cancelled", {
      experimentId: experiment.id,
      orderId: action.orderId,
      reason: action.reason,
    });
  }

  /**
   * Handle emergency stop: cancel all open orders for a stopped experiment.
   *
   * #8: Only marks DB orders as cancelled when the API cancel succeeds.
   * Orders whose cancel fails remain "open" so they're retried next tick.
   */
  private async handleEmergencyStop(experiment: Experiment): Promise<TickResult> {
    const result: TickResult = {
      experimentId: experiment.id,
      status: "ok",
      ordersPlaced: 0,
      ordersCancelled: 0,
      fillsDetected: 0,
      warnings: [],
    };

    try {
      this.logger.warn("Processing emergency stop", {
        experimentId: experiment.id,
      });

      // Get this experiment's DB orders so we only cancel orders we own
      const dbOpenOrders = await this.repo.getOrdersByStatus(experiment.id, "open");
      const dbOrderByCoinmateId = new Map(
        dbOpenOrders.map((o) => [Number(o.coinmateOrderId), o]),
      );

      // Cancel only the orders that belong to this experiment on Coinmate
      const openOrders = await this.client.getOpenOrders(experiment.gridConfig.pair);
      const cancelledCoinmateIds = new Set<number>();

      for (const order of openOrders.data) {
        const orderId = Number(order.id);
        if (!dbOrderByCoinmateId.has(orderId)) continue; // skip orders from other experiments
        try {
          await this.client.cancelOrder(orderId);
          result.ordersCancelled++;
          cancelledCoinmateIds.add(orderId);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error("Failed to cancel order during emergency stop", {
            experimentId: experiment.id,
            orderId,
            error: errMsg,
          });
          result.warnings.push(`Failed to cancel order ${orderId}: ${errMsg}`);
        }
      }

      // #8: Only mark DB orders as cancelled if the API cancel confirmed success.
      // Orders that failed to cancel on the exchange stay "open" for retry.
      for (const dbOrder of dbOpenOrders) {
        const cmId = Number(dbOrder.coinmateOrderId);
        if (cancelledCoinmateIds.has(cmId)) {
          await this.repo.updateOrderStatus(experiment.id, dbOrder.id, "cancelled");
        }
        // If the order wasn't on Coinmate at all (already gone), also mark cancelled
        const stillOnExchange = openOrders.data.some((o) => Number(o.id) === cmId);
        if (!stillOnExchange && !cancelledCoinmateIds.has(cmId)) {
          await this.repo.updateOrderStatus(experiment.id, dbOrder.id, "cancelled");
        }
      }

      // Only transition to paused if ALL orders were successfully cancelled
      const remainingOpen = await this.repo.getOrdersByStatus(experiment.id, "open");
      if (remainingOpen.length === 0) {
        await this.repo.updateExperimentStatus(experiment.id, "paused");

        // Release wallet allocation back to the pool
        if (this.walletManager) {
          try {
            const walletResult = await this.walletManager.releaseForExperiment(experiment.id);
            if (walletResult.success) {
              this.logger.info("Wallet allocation released", {
                experimentId: experiment.id,
                walletState: walletResult.walletState,
              });
              this.alertSink.emit({
                severity: "info",
                type: "wallet_release_success",
                experimentId: experiment.id,
                message: `Wallet allocation released for experiment ${experiment.id}`,
                data: { walletState: walletResult.walletState },
                timestamp: new Date(),
              });
            } else {
              this.logger.warn("Wallet release returned failure", {
                experimentId: experiment.id,
                reason: walletResult.reason,
              });
              this.alertSink.emit({
                severity: "warning",
                type: "wallet_release_failed",
                experimentId: experiment.id,
                message: `Wallet release failed: ${walletResult.reason}`,
                data: { reason: walletResult.reason },
                timestamp: new Date(),
              });
              result.warnings.push(`Wallet release failed: ${walletResult.reason}`);
            }
          } catch (walletErr) {
            const walletErrMsg = walletErr instanceof Error ? walletErr.message : String(walletErr);
            this.logger.error("Wallet release threw error", {
              experimentId: experiment.id,
              error: walletErrMsg,
            });
            this.alertSink.emit({
              severity: "warning",
              type: "wallet_release_failed",
              experimentId: experiment.id,
              message: `Wallet release error: ${walletErrMsg}`,
              data: { error: walletErrMsg },
              timestamp: new Date(),
            });
            result.warnings.push(`Wallet release error: ${walletErrMsg}`);
          }
        }

        this.logger.info("Emergency stop completed", {
          experimentId: experiment.id,
          cancelledOrders: result.ordersCancelled,
        });
        this.alertSink.emit({
          severity: "info",
          type: "emergency_stop_completed",
          experimentId: experiment.id,
          message: `Emergency stop completed, ${result.ordersCancelled} orders cancelled`,
          data: { cancelledOrders: result.ordersCancelled },
          timestamp: new Date(),
        });
      } else {
        // Some orders couldn't be cancelled — stay "stopped" for retry next tick
        this.logger.warn("Emergency stop partial — retrying remaining orders next tick", {
          experimentId: experiment.id,
          remainingOrders: remainingOpen.length,
        });
        result.warnings.push(`${remainingOpen.length} orders still open after emergency stop attempt`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.status = "error";
      result.error = errMsg;
      this.logger.error("Emergency stop failed", {
        experimentId: experiment.id,
        error: errMsg,
      });
      this.alertSink.emit({
        severity: "critical",
        type: "emergency_stop_failed",
        experimentId: experiment.id,
        message: `Emergency stop failed: ${errMsg}`,
        data: { error: errMsg },
        timestamp: new Date(),
      });
    }

    return result;
  }
}
