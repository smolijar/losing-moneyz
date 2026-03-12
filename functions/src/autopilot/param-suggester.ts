import {
  type GridConfig,
  type AutopilotConfig,
  COINMATE_FEES,
  AUTOPILOT_DEFAULTS,
  getPairLimits,
} from "../config";
import {
  validateGridConfig,
  getGridSpacingPercent,
  getBudgetPerLevel,
  calculateGridLevels,
} from "../grid";
import type { PriceTick } from "../backtest";

/** Result of parameter suggestion */
export interface SuggestResult {
  config: GridConfig;
  /** Metrics used to derive the suggestion */
  metrics: {
    currentPrice: number;
    dailyVolatility: number;
    halfRange: number;
    desiredSpacingPercent: number;
    adjustments: string[];
  };
}

/** A deliberate skip when market conditions are unsuitable for grid trading. */
export interface SuggestSkip {
  skipped: true;
  reason: string;
  trend?: TrendAnalysis;
}

/** Directionality analysis used to classify market regime for grid suitability. */
export interface TrendAnalysis {
  isTrending: boolean;
  directionality: number;
  consistency: number;
  direction: "up" | "down" | "neutral";
}

/**
 * Resample raw trade ticks into fixed-interval OHLC candles.
 *
 * @param ticks  Raw trades sorted by timestamp ascending
 * @param intervalMs  Candle interval in milliseconds (default 5 min)
 * @returns Array of candle close prices with timestamps
 */
export function resampleToCandles(
  ticks: PriceTick[],
  intervalMs: number = 5 * 60 * 1000,
): Array<{ timestamp: number; close: number }> {
  if (ticks.length === 0) return [];

  const candles: Array<{ timestamp: number; close: number }> = [];
  let bucketStart = ticks[0].timestamp;
  let lastPrice = ticks[0].price;

  for (const tick of ticks) {
    while (tick.timestamp >= bucketStart + intervalMs) {
      // Close previous candle
      candles.push({ timestamp: bucketStart, close: lastPrice });
      bucketStart += intervalMs;
    }
    lastPrice = tick.price;
  }
  // Close final candle
  candles.push({ timestamp: bucketStart, close: lastPrice });

  return candles;
}

/**
 * Compute daily volatility (standard deviation of log-returns, annualized to 1 day).
 *
 * @param candles  Array of candle close prices (assumed equally spaced)
 * @param intervalMs  Interval between candles in ms
 * @returns Daily volatility as a decimal (e.g. 0.03 = 3%)
 */
export function computeDailyVolatility(
  candles: Array<{ close: number }>,
  intervalMs: number = 5 * 60 * 1000,
): number {
  if (candles.length < 2) return 0;

  // Compute log-returns
  const logReturns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0 && candles[i].close > 0) {
      logReturns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
  }

  if (logReturns.length < 2) return 0;

  // Standard deviation of log-returns
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Scale to daily: periods per day = 24 * 60 * 60 * 1000 / intervalMs
  const periodsPerDay = (24 * 60 * 60 * 1000) / intervalMs;
  const dailyVol = stdDev * Math.sqrt(periodsPerDay);

  return dailyVol;
}

/**
 * Detect whether price action is strongly directional (trending), which is
 * generally unsuitable for symmetric grid strategies.
 */
export function detectTrend(
  candles: Array<{ close: number }>,
  options: {
    directionalityThreshold?: number;
    consistencyThreshold?: number;
  } = {},
): TrendAnalysis {
  const directionalityThreshold = options.directionalityThreshold ?? 0.85;
  const consistencyThreshold = options.consistencyThreshold ?? 0.75;

  if (candles.length < 3) {
    return {
      isTrending: false,
      directionality: 0,
      consistency: 0,
      direction: "neutral",
    };
  }

  const startPrice = candles[0].close;
  const endPrice = candles[candles.length - 1].close;
  const closes = candles.map((c) => c.close);
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const range = high - low;

  if (range <= 0 || startPrice <= 0 || endPrice <= 0) {
    return {
      isTrending: false,
      directionality: 0,
      consistency: 0,
      direction: "neutral",
    };
  }

  const netMove = endPrice - startPrice;
  const direction: TrendAnalysis["direction"] =
    netMove > 0 ? "up" : netMove < 0 ? "down" : "neutral";
  const directionality = Math.min(1, Math.abs(netMove) / range);

  if (direction === "neutral") {
    return {
      isTrending: false,
      directionality,
      consistency: 0,
      direction,
    };
  }

  let alignedMoves = 0;
  let nonZeroMoves = 0;
  const sign = Math.sign(netMove);
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].close - candles[i - 1].close;
    if (delta === 0) continue;
    nonZeroMoves++;
    if (Math.sign(delta) === sign) {
      alignedMoves++;
    }
  }

  const consistency = nonZeroMoves > 0 ? alignedMoves / nonZeroMoves : 0;
  const isTrending =
    directionality > directionalityThreshold && consistency > consistencyThreshold;

  return {
    isTrending,
    directionality,
    consistency,
    direction,
  };
}

/**
 * Suggest grid parameters based on recent price volatility and available capital.
 *
 * Algorithm:
 * 1. Resample ticks to 5-min candles
 * 2. Compute daily volatility (σ_daily) from log-returns
 * 3. Set range: currentPrice ± σ_daily * rangeMultiplier * currentPrice
 * 4. Set spacing: max(minProfitable, σ_daily * spacingMultiplier * 100)%
 * 5. Derive levels from range and spacing
 * 6. Clamp levels to [3, 50], budget = available capital
 * 7. Validate and adjust until config passes validateGridConfig()
 */
export function suggestParams(
  ticks: PriceTick[],
  availableQuote: number,
  autopilotConfig: AutopilotConfig = AUTOPILOT_DEFAULTS,
): SuggestResult | SuggestSkip | null {
  if (ticks.length < 10) return null;

  const adjustments: string[] = [];
  const currentPrice = ticks[ticks.length - 1].price;

  if (currentPrice <= 0) return null;

  // Step 1: Resample to 5-min candles
  const candleIntervalMs = 5 * 60 * 1000;
  const candles = resampleToCandles(ticks, candleIntervalMs);

  if (candles.length < 2) return null;

  // Step 2: Compute daily volatility
  let dailyVol = computeDailyVolatility(candles, candleIntervalMs);

  // Floor volatility: if market is extremely flat, use a minimum
  const feeRate = COINMATE_FEES.maker;
  const minSpacingPercent = feeRate * 2 * 100 * COINMATE_FEES.minSpacingMultiplier; // 2.4%
  const minVolFloor = (minSpacingPercent / 100) * 2; // Enough for at least a few levels
  if (dailyVol < minVolFloor) {
    dailyVol = minVolFloor;
    adjustments.push(`Volatility floored to ${(minVolFloor * 100).toFixed(2)}%`);
  }

  const trend = detectTrend(candles);
  if (trend.isTrending) {
    return {
      skipped: true,
      reason:
        `strong ${trend.direction}trend detected ` +
        `(directionality ${(trend.directionality * 100).toFixed(0)}%, ` +
        `consistency ${(trend.consistency * 100).toFixed(0)}%)`,
      trend,
    };
  }

  // Step 3: Derive grid range
  const halfRange = currentPrice * dailyVol * autopilotConfig.rangeMultiplier;
  let lowerPrice = Math.max(1, Math.round((currentPrice - halfRange) * 100) / 100);
  let upperPrice = Math.round((currentPrice + halfRange) * 100) / 100;

  // Ensure upper > lower
  if (upperPrice <= lowerPrice) {
    upperPrice = lowerPrice + currentPrice * 0.05;
    adjustments.push("Range widened: upper was <= lower");
  }

  // Step 4: Derive spacing and levels
  let desiredSpacingPercent = Math.max(
    minSpacingPercent,
    dailyVol * autopilotConfig.spacingMultiplier * 100,
  );
  const spacingAbs = (desiredSpacingPercent / 100) * currentPrice;
  let levels = Math.floor((upperPrice - lowerPrice) / spacingAbs) + 1;

  // Step 5: Clamp levels
  if (levels < 3) {
    levels = 3;
    adjustments.push("Levels clamped to minimum 3");
  }
  if (levels > 50) {
    levels = 50;
    // Recalculate range to fit 50 levels at current spacing
    const maxRange = spacingAbs * 49;
    lowerPrice = Math.max(1, Math.round((currentPrice - maxRange / 2) * 100) / 100);
    upperPrice = Math.round((currentPrice + maxRange / 2) * 100) / 100;
    adjustments.push("Levels clamped to 50, range adjusted");
  }

  // Step 6: Build config
  let config: GridConfig = {
    pair: autopilotConfig.pair,
    lowerPrice,
    upperPrice,
    levels,
    budgetQuote: availableQuote,
  };

  // Step 7: Iterative validation — widen spacing / reduce levels until valid
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const validation = validateGridConfig(config, currentPrice);
    if (validation.valid) break;

    // Try to fix common errors
    const errors = validation.errors.join("; ");
    if (errors.includes("spacing") && config.levels > 3) {
      // Spacing too tight — reduce levels
      config = { ...config, levels: config.levels - 1 };
      adjustments.push(`Reduced levels to ${config.levels} (spacing too tight)`);
    } else if (errors.includes("Budget per level") || errors.includes("order size")) {
      // Budget too low per level — reduce levels
      if (config.levels > 3) {
        config = { ...config, levels: config.levels - 1 };
        adjustments.push(`Reduced levels to ${config.levels} (budget per level too low)`);
      } else {
        // Can't reduce further — config is not viable
        return null;
      }
    } else {
      // Unknown error — bail
      return null;
    }
  }

  // Final validation
  const finalValidation = validateGridConfig(config, currentPrice);
  if (!finalValidation.valid) return null;

  config = biasInitialEntryTowardMarket(config, currentPrice, minSpacingPercent / 100);

  // Verify budget per level meets pair minimum
  const limits = getPairLimits(config.pair);
  const budgetPerLevel = getBudgetPerLevel(config);
  const minAmount = budgetPerLevel / config.upperPrice;
  if (minAmount < limits.minOrderSize) return null;

  desiredSpacingPercent = getGridSpacingPercent(config);

  return {
    config,
    metrics: {
      currentPrice,
      dailyVolatility: dailyVol,
      halfRange,
      desiredSpacingPercent,
      adjustments,
    },
  };
}

function biasInitialEntryTowardMarket(
  config: GridConfig,
  currentPrice: number,
  minSpacingRatio: number,
): GridConfig {
  const levels = calculateGridLevels(config);
  const nearestBelow = [...levels]
    .filter((level) => level.price < currentPrice)
    .sort((a, b) => b.price - a.price)[0];

  const targetGapRatio = Math.max(minSpacingRatio, 0.01);
  const currentGapRatio = nearestBelow
    ? (currentPrice - nearestBelow.price) / currentPrice
    : Number.POSITIVE_INFINITY;

  if (currentGapRatio <= targetGapRatio) {
    return config;
  }

  const spacing = (config.upperPrice - config.lowerPrice) / (config.levels - 1);
  const targetIndex = Math.floor((config.levels - 1) / 2);
  const targetBuyPrice = Math.round(currentPrice * (1 - targetGapRatio) * 100) / 100;
  const lowerPrice = Math.max(1, Math.round((targetBuyPrice - targetIndex * spacing) * 100) / 100);
  const upperPrice = Math.round((lowerPrice + spacing * (config.levels - 1)) * 100) / 100;

  return {
    ...config,
    lowerPrice,
    upperPrice,
  };
}
