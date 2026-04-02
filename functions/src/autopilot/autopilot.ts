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
    }

    // 3b. Double-check that no paused experiments still have open orders after cleanup.
    for (const exp of paused) {
      const openOrders = await this.repo.getOrdersByStatus(exp.id, "open");
      if (openOrders.length > 0) {
        this.logger.info("Autopilot waiting: paused experiments still have open orders", {
          experimentId: exp.id,
          openOrders: openOrders.length,
        });
        return { action: "skipped", reason: "paused experiments pending order cleanup" };
      }
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

    // 8. Create experiment
    const experimentId = await this.repo.createExperiment({
      status: "active",
      gridConfig: suggested.config,
      allocatedQuote: suggested.config.budgetQuote,
      allocatedBase: 0,
      consecutiveFailures: 0,
    });

    // 9. Allocate wallet
    const allocation = await this.walletManager.allocateForExperiment(
      experimentId,
      suggested.config,
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
      await this.saveState(suggested.config, `skipped:${reason}`);
      return { action: "skipped", reason };
    }

    // 10. Reconcile budgetQuote to match actual CZK allocation.
    // In mixed-wallet mode, suggestParams used managedQuoteEquivalent (CZK + BTC value)
    // as budgetQuote, but allocateForExperiment sets allocatedQuote to just the CZK portion.
    // Without this, budgetPerLevel is computed from the inflated budgetQuote, sizing orders
    // too large for the actual CZK available, so fewer buy orders can be placed.
    if (wallet.availableQuote < suggested.config.budgetQuote - 0.01) {
      const reconciledConfig = { ...suggested.config, budgetQuote: wallet.availableQuote };
      await this.repo.updateExperiment(experimentId, { gridConfig: reconciledConfig });
      this.logger.info("Reconciled budgetQuote to match actual CZK allocation", {
        experimentId,
        originalBudgetQuote: suggested.config.budgetQuote,
        reconciledBudgetQuote: wallet.availableQuote,
        allocatedBase: wallet.availableBase,
      });
    }

    await this.saveState(suggested.config, "created");

    this.logger.info("Autopilot created experiment", {
      experimentId,
      pair: suggested.config.pair,
      lowerPrice: suggested.config.lowerPrice,
      upperPrice: suggested.config.upperPrice,
      levels: suggested.config.levels,
      budgetQuote: suggested.config.budgetQuote,
      dailyVolatility: (suggested.metrics.dailyVolatility * 100).toFixed(2) + "%",
    });

    return {
      action: "created",
      reason: "Experiment created successfully",
      experimentId,
      config: suggested.config,
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
