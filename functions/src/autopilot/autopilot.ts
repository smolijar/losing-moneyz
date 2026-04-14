import {
  type AutopilotConfig,
  type AutopilotState,
  AUTOPILOT_DEFAULTS,
  COINMATE_FEES,
  getPairLimits,
} from "../config";
import type { ExchangeClient } from "../coinmate";
import type { Repository } from "../storage";
import { WalletManager } from "../storage";
import { validateWithBacktest, type PriceTick } from "../backtest";
import { searchBestParams, type SuggestResult, type SuggestSkip } from "./param-suggester";
import { getBudgetPerLevel, validateGridConfig } from "../grid";
import type { Logger } from "../tick";

/** Result of an autopilot engagement attempt */
export interface AutopilotResult {
  action: "created" | "skipped";
  reason: string;
  experimentId?: string;
  config?: {
    lowerPrice: number;
    upperPrice: number;
    levels: number;
    budgetQuote: number;
    pair: string;
  };
}

/**
 * Autopilot — self-regulating grid experiment manager.
 *
 * When there are no active experiments, the autopilot:
 * 1. Checks cooldown to prevent churn
 * 2. Cleans up paused experiments (stop + release wallet)
 * 3. Pulls available wallet capital
 * 4. Fetches recent price data from the exchange
 * 5. Computes volatility-based grid parameters
 * 6. Validates via backtest
 * 7. Creates a new experiment if everything checks out
 */
export class Autopilot {
  private readonly config: AutopilotConfig;

  constructor(
    private readonly client: ExchangeClient,
    private readonly repo: Repository,
    private readonly walletManager: WalletManager,
    private readonly logger: Logger,
    config?: Partial<AutopilotConfig>,
  ) {
    this.config = { ...AUTOPILOT_DEFAULTS, ...config };
  }

  /**
   * Attempt to create a new self-regulated experiment.
   * Called by the orchestrator when there are 0 active experiments.
   */
  async engage(): Promise<AutopilotResult> {
    // 0. Check kill switch
    const autopilotState = await this.repo.getAutopilotState();
    if (autopilotState && !autopilotState.enabled) {
      this.logger.info("Autopilot disabled via kill switch");
      return { action: "skipped", reason: "disabled" };
    }

    // 1. Check cooldown
    if (autopilotState?.lastActionAt) {
      const elapsed = Date.now() - autopilotState.lastActionAt.getTime();
      const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
      if (elapsed < cooldownMs) {
        const remainingMin = ((cooldownMs - elapsed) / 60000).toFixed(1);
        this.logger.info(`Autopilot cooldown: ${remainingMin} min remaining`);
        return { action: "skipped", reason: `cooldown (${remainingMin} min remaining)` };
      }
    }

    // 2. Check that no stopped experiments are still being cleaned up
    const stopped = await this.repo.getExperimentsByStatus("stopped");
    if (stopped.length > 0) {
      this.logger.info("Autopilot waiting: stopped experiments still being cleaned up", {
        count: stopped.length,
      });
      return { action: "skipped", reason: "stopped experiments pending cleanup" };
    }

    // 3. Clean up paused experiments. If they still have open orders, promote
    // them to stopped so the orchestrator cancels exchange orders first.
    const paused = await this.repo.getExperimentsByStatus("paused");
    for (const exp of paused) {
      const openOrders = await this.repo.getOrdersByStatus(exp.id, "open");
      if (openOrders.length > 0) {
        this.logger.warn("Autopilot found paused experiment with open orders", {
          experimentId: exp.id,
          openOrders: openOrders.length,
        });
        await this.repo.updateExperimentStatus(exp.id, "stopped");
        await this.repo.updateAutopilotState({
          lastReason: `paused experiment ${exp.id} has open orders`,
          lastSupervisorDecision: "paused_promoted_to_stopped",
        });
        return { action: "skipped", reason: "paused experiments pending order cleanup" };
      }

      if (exp.allocatedQuote > 0 || exp.allocatedBase > 0) {
        this.logger.info("Autopilot releasing wallet for paused experiment", {
          experimentId: exp.id,
        });
        await this.walletManager.releaseForExperiment(exp.id);
      }

      // Delete fully-cleaned paused experiments to prevent accumulation
      this.logger.info("Autopilot deleting cleaned-up paused experiment", {
        experimentId: exp.id,
      });
      await this.repo.deleteExperiment(exp.id);
    }

    // 4. Pull wallet capital
    const wallet = await this.walletManager.getState();
    if (wallet.availableQuote < this.config.minBudgetQuote && wallet.availableBase <= 0.00000001) {
      const reason = `Insufficient capital: ${wallet.availableQuote.toFixed(2)} < ${this.config.minBudgetQuote}`;
      this.logger.info(`Autopilot skipped: ${reason}`);
      await this.saveState(null, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    // 5. Fetch recent price data
    let ticks: PriceTick[];
    try {
      const txResponse = await this.client.getTransactions(
        this.config.pair,
        this.config.minHistoryMinutes,
      );
      if (txResponse.error) {
        const reason = `Exchange error: ${txResponse.errorMessage}`;
        this.logger.warn(`Autopilot skipped: ${reason}`);
        await this.saveState(null, `skipped:${reason}`);
        return { action: "skipped", reason };
      }
      ticks = txResponse.data.map((t) => ({
        timestamp: t.timestamp,
        price: t.price,
        amount: t.amount,
        side: t.tradeType === "BUY" ? ("buy" as const) : ("sell" as const),
      }));
    } catch (err) {
      const reason = `Failed to fetch transactions: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.warn(`Autopilot skipped: ${reason}`);
      await this.saveState(null, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    if (ticks.length < 100) {
      const reason = `Insufficient price data: ${ticks.length} ticks (need >= 100)`;
      this.logger.info(`Autopilot skipped: ${reason}`);
      await this.saveState(null, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    // Sort ticks by timestamp ascending
    ticks.sort((a, b) => a.timestamp - b.timestamp);

    const currentPrice = ticks[ticks.length - 1].price;
    const managedQuoteEquivalent =
      wallet.availableQuote + wallet.availableBase * currentPrice * (1 - COINMATE_FEES.maker);
    if (managedQuoteEquivalent < this.config.minBudgetQuote) {
      const reason =
        `Insufficient capital: ${managedQuoteEquivalent.toFixed(2)} < ${this.config.minBudgetQuote}`;
      this.logger.info(`Autopilot skipped: ${reason}`);
      await this.saveState(null, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    const walletMode = this.getWalletMode(wallet, currentPrice);
    this.logger.info("Autopilot wallet mode", {
      mode: walletMode,
      availableQuote: wallet.availableQuote,
      availableBase: wallet.availableBase,
      currentPrice,
      managedQuoteEquivalent,
    });

    // 6. Determine entry bias mode.
    // Even when the wallet holds some base, use sell_resume only if the base
    // can cover at least one grid-level sell order.  Otherwise the grid will
    // be biased toward sells the bot cannot execute, pushing the only buy far
    // below market — which triggers stall detection and a recycle loop.
    let entryBiasMode: "buy_bootstrap" | "sell_resume" = "buy_bootstrap";
    if (walletMode === "mixed" || walletMode === "base_only") {
      const { minOrderSize } = getPairLimits(this.config.pair);
      const minLevels = COINMATE_FEES.minSpacingMultiplier;
      const estimatedSellSize = managedQuoteEquivalent / Math.ceil(minLevels / 2) / currentPrice;
      const sellViable = wallet.availableBase >= Math.max(minOrderSize, estimatedSellSize);
      entryBiasMode = sellViable ? "sell_resume" : "buy_bootstrap";
      if (!sellViable) {
        this.logger.info("Entry bias fallback: base insufficient for sells, using buy_bootstrap", {
          availableBase: wallet.availableBase,
          estimatedSellSize,
          minOrderSize,
        });
      }
    }

    const suggestion = searchBestParams(
      ticks,
      managedQuoteEquivalent,
      this.config,
      entryBiasMode,
    );
    if (!suggestion) {
      const reason =
        walletMode === "mixed" || walletMode === "base_only"
          ? "Parameter suggestion failed (could not find valid config for current wallet composition)"
          : "Parameter suggestion failed (could not find valid config)";
      this.logger.warn(`Autopilot skipped: ${reason}`);
      await this.saveState(null, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    if (isSuggestSkip(suggestion)) {
      const reason = `Parameter suggestion skipped: ${suggestion.reason}`;
      this.logger.warn(`Autopilot skipped: ${reason}`, {
        pair: this.config.pair,
        availableQuote: wallet.availableQuote,
        trend: suggestion.trend,
      });
      await this.saveState(null, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    const suggested = suggestion;

    // Log search metadata when adaptive search was used
    if ("fromSearch" in suggested && suggested.fromSearch) {
      this.logger.info("Autopilot param search result", {
        candidatesEvaluated: suggested.candidatesEvaluated,
        candidatesWithCycles: suggested.candidatesWithCycles,
        selectedScore: suggested.selectedScore,
      });
    }

    this.logger.info("Autopilot suggested config", {
      config: suggested.config,
      metrics: suggested.metrics,
    });

    // 7. Validate via backtest
    const validation = validateWithBacktest(suggested.config, ticks, {
      minReturnPercent: this.config.backtestMinReturnPercent,
      maxDrawdownPercent: this.config.backtestMaxDrawdownPercent,
    });

    if (!validation.approved) {
      const reason = `Backtest rejected: ${validation.reasons.join("; ")}`;
      this.logger.warn(`Autopilot skipped: ${reason}`);
      await this.saveState(suggested.config, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    this.logger.info("Autopilot backtest passed", {
      returnPercent: validation.report.totalReturnPercent.toFixed(2),
      maxDrawdown: validation.report.maxDrawdownPercent.toFixed(2),
      completedCycles: validation.report.completedCycles,
    });

    // 8. Clamp levels to match actual CZK budget.
    // suggestParams uses managedQuoteEquivalent (CZK + BTC value) to find the
    // optimal grid shape, but the real buy budget is wallet.availableQuote.
    const effectiveBudgetQuote = wallet.availableQuote;
    const limits = getPairLimits(this.config.pair);
    let adjustedConfig = { ...suggested.config, budgetQuote: effectiveBudgetQuote };

    // Reduce levels until budgetPerLevel / upperPrice >= minOrderSize
    while (adjustedConfig.levels > 3) {
      const bpl = getBudgetPerLevel(adjustedConfig);
      const minAmount = bpl / adjustedConfig.upperPrice;
      if (minAmount >= limits.minOrderSize) break;
      adjustedConfig = { ...adjustedConfig, levels: adjustedConfig.levels - 1 };
    }

    // Check if even 3 levels can't meet minimum order size
    const finalBpl = getBudgetPerLevel(adjustedConfig);
    const finalMinAmount = finalBpl / adjustedConfig.upperPrice;
    if (finalMinAmount < limits.minOrderSize) {
      // Try auto-rebalance: sell some BTC to get enough CZK
      const rebalanceResult = await this.tryRebalanceWallet(
        wallet, currentPrice, limits, adjustedConfig.upperPrice, ticks,
      );
      if (rebalanceResult) {
        return rebalanceResult;
      }
      const minCzk = limits.minOrderSize * adjustedConfig.upperPrice * Math.ceil(3 / 2);
      const reason =
        `CZK budget too low for minimum order size: ${effectiveBudgetQuote.toFixed(0)} CZK, ` +
        `need ~${minCzk.toFixed(0)} CZK for 3 levels`;
      this.logger.warn(`Autopilot skipped: ${reason}`);
      await this.saveState(null, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    // Validate the adjusted config
    const adjustedValidation = validateGridConfig(adjustedConfig, currentPrice);
    if (!adjustedValidation.valid) {
      const reason = `Adjusted config invalid: ${adjustedValidation.errors.join("; ")}`;
      this.logger.warn(`Autopilot skipped: ${reason}`);
      await this.saveState(null, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    if (adjustedConfig.levels !== suggested.config.levels) {
      this.logger.info("Clamped grid levels for actual CZK budget", {
        originalLevels: suggested.config.levels,
        adjustedLevels: adjustedConfig.levels,
        effectiveBudgetQuote,
        managedQuoteEquivalent,
        budgetPerLevel: getBudgetPerLevel(adjustedConfig),
      });
    }

    // 9. Create experiment
    const experimentId = await this.repo.createExperiment({
      status: "active",
      gridConfig: adjustedConfig,
      allocatedQuote: adjustedConfig.budgetQuote,
      allocatedBase: 0,
      consecutiveFailures: 0,
    });

    // 10. Allocate wallet
    const allocation = await this.walletManager.allocateForExperiment(
      experimentId,
      adjustedConfig,
      {
        quoteDelta: wallet.availableQuote,
        baseDelta: wallet.availableBase,
      },
    );

    if (!allocation.success) {
      // Rollback: set experiment to stopped
      this.logger.error("Autopilot wallet allocation failed, rolling back", {
        experimentId,
        reason: allocation.reason,
      });
      await this.repo.updateExperimentStatus(experimentId, "stopped");
      const reason = `Wallet allocation failed: ${allocation.reason}`;
      await this.saveState(adjustedConfig, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    await this.saveState(adjustedConfig, "created");

    // Set lastReplacementAt so the 6h regrid cooldown protects new
    // experiments from premature capital-increase replacement.
    await this.repo.updateAutopilotState({ lastReplacementAt: new Date() });

    this.logger.info("Autopilot created experiment", {
      experimentId,
      pair: adjustedConfig.pair,
      lowerPrice: adjustedConfig.lowerPrice,
      upperPrice: adjustedConfig.upperPrice,
      levels: adjustedConfig.levels,
      budgetQuote: adjustedConfig.budgetQuote,
      dailyVolatility: (suggested.metrics.dailyVolatility * 100).toFixed(2) + "%",
    });

    return {
      action: "created",
      reason: "Experiment created successfully",
      experimentId,
      config: adjustedConfig,
    };
  }

  private getWalletMode(
    wallet: { availableQuote: number; availableBase: number },
    currentPrice: number,
  ):
    | "quote_only"
    | "base_only"
    | "mixed"
    | "empty" {
    const hasQuote = wallet.availableQuote > 0.01;
    // Treat base as meaningful only when its value exceeds 10% of total capital.
    // Tiny BTC dust from previous partial fills should not trigger sell_resume mode,
    // which shifts the grid so the nearest sell is near market and pushes the only
    // buy far away — causing a stall/recycle loop when the dust is too small to sell.
    const baseValueQuote = wallet.availableBase * currentPrice;
    const totalValue = wallet.availableQuote + baseValueQuote;
    const hasBase = totalValue > 0 && baseValueQuote / totalValue > 0.1;
    if (hasQuote && hasBase) return "mixed";
    if (hasQuote) return "quote_only";
    if (hasBase) return "base_only";
    return "empty";
  }

  /**
   * Attempt to sell some BTC to increase CZK balance when the CZK portion is
   * too small to fund a viable grid, but total wallet value (CZK + BTC) is
   * sufficient.
   *
   * Places a limit sell at the current bid price for near-immediate fill.
   * Returns an AutopilotResult to short-circuit engage() if a rebalance sell
   * was placed (the next tick will see the new CZK and create a grid).
   */
  private async tryRebalanceWallet(
    wallet: { availableQuote: number; availableBase: number },
    currentPrice: number,
    limits: { minOrderSize: number; basePrecision: number },
    upperPrice: number,
    ticks: PriceTick[],
  ): Promise<AutopilotResult | null> {
    // Check total value is sufficient for a grid
    const managedQuoteEquivalent =
      wallet.availableQuote + wallet.availableBase * currentPrice * (1 - COINMATE_FEES.maker);
    if (managedQuoteEquivalent < this.config.minBudgetQuote) {
      return null; // total value too low, can't help
    }

    // Check rebalance cooldown (10 minutes)
    const autopilotState = await this.repo.getAutopilotState();
    if (autopilotState?.lastRebalanceAt) {
      const elapsed = Date.now() - autopilotState.lastRebalanceAt.getTime();
      const cooldownMs = 10 * 60 * 1000; // 10 minutes
      if (elapsed < cooldownMs) {
        const remainingMin = ((cooldownMs - elapsed) / 60000).toFixed(1);
        this.logger.info(`Rebalance cooldown: ${remainingMin} min remaining`);
        return null;
      }
    }

    // Compute how much CZK we need: enough for 3 levels at minimum order size
    const minCzkNeeded = limits.minOrderSize * upperPrice * Math.ceil(3 / 2);
    const shortfall = minCzkNeeded - wallet.availableQuote;
    if (shortfall <= 0) {
      return null; // shouldn't happen if we got here, but guard
    }

    // Sell enough BTC to cover shortfall + 5% buffer for fees/slippage
    let sellAmountBtc = (shortfall / currentPrice) * 1.05;

    // Bump up to minOrderSize if the shortfall is tiny but we have enough base
    if (sellAmountBtc < limits.minOrderSize) {
      sellAmountBtc = limits.minOrderSize;
    }

    // Cap at 50% of available base to prevent over-selling
    const maxSell = wallet.availableBase * 0.5;
    sellAmountBtc = Math.min(sellAmountBtc, maxSell);

    // Round down to pair precision
    const factor = Math.pow(10, limits.basePrecision);
    sellAmountBtc = Math.floor(sellAmountBtc * factor) / factor;

    // Must meet minimum order size (may fail after 50% cap + rounding)
    if (sellAmountBtc < limits.minOrderSize) {
      this.logger.info("Rebalance sell too small for minimum order size", {
        sellAmountBtc,
        minOrderSize: limits.minOrderSize,
        availableBase: wallet.availableBase,
      });
      return null;
    }

    // Use the last trade price as the sell price — limit sell at market
    const sellPrice = ticks[ticks.length - 1].price;

    try {
      const response = await this.client.sellLimit(
        this.config.pair,
        sellAmountBtc,
        sellPrice,
      );
      const orderId = Number(response.data);

      this.logger.info("Rebalance sell placed", {
        orderId,
        sellAmountBtc,
        sellPrice,
        expectedCzk: sellAmountBtc * sellPrice,
        shortfall,
        availableBase: wallet.availableBase,
      });

      // Deduct the sold BTC from wallet immediately so that when the sell
      // fills and syncWallet() runs, the CZK increase is offset by the
      // expected BTC decrease — preventing a false "capital increase" trigger.
      await this.repo.updateWalletState({
        availableBase: wallet.availableBase - sellAmountBtc,
      });

      await this.repo.updateAutopilotState({
        lastRebalanceAt: new Date(),
        lastReason: `rebalancing: sold ${sellAmountBtc} BTC at ${sellPrice} to fund grid`,
        lastSupervisorDecision: "rebalance_sell",
      });

      return {
        action: "skipped",
        reason:
          `Rebalancing wallet: selling ${sellAmountBtc} BTC at ${sellPrice} CZK ` +
          `to fund grid (need ~${minCzkNeeded.toFixed(0)} CZK, have ${wallet.availableQuote.toFixed(0)} CZK)`,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error("Rebalance sell failed", {
        error: errMsg,
        sellAmountBtc,
        sellPrice,
      });
      return null; // fall through to normal skip
    }
  }

  private async saveState(
    config: AutopilotResult["config"] | null,
    reason: string,
  ): Promise<void> {
    try {
      const state: Partial<AutopilotState> = {
        lastActionAt: new Date(),
        lastReason: reason,
      };
      if (config !== undefined) {
        state.lastConfig = config as AutopilotState["lastConfig"];
      }
      await this.repo.updateAutopilotState(state);
    } catch (err) {
      // Non-fatal: don't fail the whole operation if state save fails
      this.logger.warn("Failed to save autopilot state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function isSuggestSkip(value: SuggestResult | SuggestSkip): value is SuggestSkip {
  return "skipped" in value && value.skipped === true;
}
