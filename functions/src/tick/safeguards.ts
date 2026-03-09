import type { Experiment, ExperimentSnapshot } from "../config";
import { computeUnrealizedPnl, type FillEvent } from "../grid";

/** Safeguard check result */
export interface SafeguardResult {
  ok: boolean;
  action: "continue" | "pause" | "warn";
  reason?: string;
}

/** Safeguard configuration thresholds */
export interface SafeguardConfig {
  /** Maximum allowed drawdown percentage before pausing */
  maxDrawdownPercent: number;
  /** Number of consecutive API failures before circuit-breaking */
  maxConsecutiveApiFailures: number;
  /** Maximum time since last successful tick (ms) before stale warning */
  staleTicThresholdMs: number;
  /** Maximum time without any fills (ms) before pausing to allow Autopilot to recalibrate */
  maxIdleTimeMs: number;
}

export const DEFAULT_SAFEGUARD_CONFIG: SafeguardConfig = {
  maxDrawdownPercent: 10,
  maxConsecutiveApiFailures: 3,
  staleTicThresholdMs: 10 * 60 * 1000, // 10 minutes
  maxIdleTimeMs: 3 * 24 * 60 * 60 * 1000, // 3 days
};

/**
 * Check if current price is within the experiment's grid range.
 */
export function checkPriceInRange(
  experiment: Experiment,
  currentPrice: number,
): SafeguardResult {
  const { lowerPrice, upperPrice } = experiment.gridConfig;

  if (currentPrice < lowerPrice || currentPrice > upperPrice) {
    return {
      ok: false,
      action: "pause",
      reason:
        `Price ${currentPrice} is outside grid range ` +
        `[${lowerPrice}, ${upperPrice}]`,
    };
  }

  // Warn if within 5% of boundary
  const range = upperPrice - lowerPrice;
  const margin = range * 0.05;
  if (currentPrice < lowerPrice + margin || currentPrice > upperPrice - margin) {
    return {
      ok: true,
      action: "warn",
      reason: `Price ${currentPrice} is near grid boundary`,
    };
  }

  return { ok: true, action: "continue" };
}

/**
 * Check if drawdown exceeds threshold.
 *
 * When `currentPrice` and `fills` are provided, unrealized P&L is recomputed
 * in real-time using the quantity-aware FIFO engine instead of relying on the
 * potentially stale value from the last snapshot.
 */
export function checkDrawdown(
  experiment: Experiment,
  snapshot: ExperimentSnapshot | undefined,
  config: SafeguardConfig = DEFAULT_SAFEGUARD_CONFIG,
  currentPrice?: number,
  fills?: FillEvent[],
): SafeguardResult {
  if (!snapshot) {
    return { ok: true, action: "continue" };
  }

  // Use fresh unrealized P&L if we have the data to compute it; otherwise fall back to snapshot
  const unrealized =
    currentPrice !== undefined && fills !== undefined
      ? computeUnrealizedPnl(fills, currentPrice)
      : snapshot.unrealizedPnl;

  const totalPnl = unrealized + snapshot.realizedPnl;
  const drawdownPercent = (-totalPnl / experiment.allocatedQuote) * 100;

  if (drawdownPercent > config.maxDrawdownPercent) {
    return {
      ok: false,
      action: "pause",
      reason:
        `Drawdown ${drawdownPercent.toFixed(2)}% exceeds limit of ` +
        `${config.maxDrawdownPercent}%`,
    };
  }

  return { ok: true, action: "continue" };
}

/**
 * Check if last tick was too long ago (stale detection).
 */
export function checkStaleTick(
  lastSnapshot: ExperimentSnapshot | undefined,
  now: Date = new Date(),
  config: SafeguardConfig = DEFAULT_SAFEGUARD_CONFIG,
): SafeguardResult {
  if (!lastSnapshot) {
    return { ok: true, action: "continue" };
  }

  const elapsed = now.getTime() - lastSnapshot.timestamp.getTime();

  if (elapsed > config.staleTicThresholdMs) {
    return {
      ok: true,
      action: "warn",
      reason:
        `Last tick was ${(elapsed / 60_000).toFixed(1)} min ago ` +
        `(threshold: ${(config.staleTicThresholdMs / 60_000).toFixed(1)} min)`,
    };
  }

  return { ok: true, action: "continue" };
}

/**
 * Check consecutive API failure count (circuit breaker).
 */
export function checkCircuitBreaker(
  consecutiveFailures: number,
  config: SafeguardConfig = DEFAULT_SAFEGUARD_CONFIG,
): SafeguardResult {
  if (consecutiveFailures >= config.maxConsecutiveApiFailures) {
    return {
      ok: false,
      action: "pause",
      reason:
        `${consecutiveFailures} consecutive API failures ` +
        `(limit: ${config.maxConsecutiveApiFailures})`,
    };
  }

  return { ok: true, action: "continue" };
}

/**
 * Check if the experiment's open order count is within limits.
 */
export function checkMaxOrders(
  openOrderCount: number,
  maxLevels: number,
): SafeguardResult {
  const maxOrders = maxLevels * 2;

  if (openOrderCount >= maxOrders) {
    return {
      ok: false,
      action: "warn",
      reason: `Open orders (${openOrderCount}) at maximum (${maxOrders})`,
    };
  }

  return { ok: true, action: "continue" };
}

/**
 * Check if the experiment has been idle (no fills) for too long.
 */
export function checkIdleTime(
  experiment: Experiment,
  fills: FillEvent[] = [],
  now: Date = new Date(),
  config: SafeguardConfig = DEFAULT_SAFEGUARD_CONFIG,
): SafeguardResult {
  // Find the most recent fill timestamp, or fall back to experiment creation time
  let lastActivityMs = experiment.createdAt.getTime();
  for (const fill of fills) {
    if (fill.timestamp > lastActivityMs) {
      lastActivityMs = fill.timestamp;
    }
  }

  const elapsedMs = now.getTime() - lastActivityMs;
  if (elapsedMs > config.maxIdleTimeMs) {
    return {
      ok: false,
      action: "pause",
      reason:
        `Experiment idle for ${(elapsedMs / 86400000).toFixed(1)} days ` +
        `(limit: ${(config.maxIdleTimeMs / 86400000).toFixed(1)} days)`,
    };
  }

  return { ok: true, action: "continue" };
}

/**
 * Run all safeguards for an experiment.
 * Returns the most severe result.
 *
 * When `fills` is provided, drawdown check uses fresh unrealized P&L
 * computed from the fills and current price instead of the stale snapshot value.
 */
export function runAllSafeguards(
  experiment: Experiment,
  currentPrice: number,
  lastSnapshot: ExperimentSnapshot | undefined,
  consecutiveFailures: number,
  openOrderCount: number,
  config: SafeguardConfig = DEFAULT_SAFEGUARD_CONFIG,
  now: Date = new Date(),
  fills?: FillEvent[],
): { results: SafeguardResult[]; shouldPause: boolean; warnings: string[] } {
  const results = [
    checkPriceInRange(experiment, currentPrice),
    checkDrawdown(experiment, lastSnapshot, config, currentPrice, fills),
    checkStaleTick(lastSnapshot, now, config),
    checkCircuitBreaker(consecutiveFailures, config),
    checkMaxOrders(openOrderCount, experiment.gridConfig.levels),
    checkIdleTime(experiment, fills, now, config),
  ];

  const shouldPause = results.some((r) => r.action === "pause");
  const warnings = results
    .filter((r) => r.action === "warn" && r.reason)
    .map((r) => r.reason!);

  return { results, shouldPause, warnings };
}
