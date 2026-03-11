import { describe, it, expect } from "vitest";
import {
  detectTrend,
  resampleToCandles,
  computeDailyVolatility,
  suggestParams,
} from "../../src/autopilot";
import { calculateGridLevels } from "../../src/grid";
import type { PriceTick } from "../../src/backtest";
import { AUTOPILOT_DEFAULTS, type AutopilotConfig } from "../../src/config";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FIVE_MIN = 5 * 60 * 1000;
const ONE_MIN = 60 * 1000;

/**
 * Generate N equally-spaced ticks with a given price pattern.
 * @param prices  Array of prices to emit
 * @param intervalMs  Interval between ticks (default 1 min)
 */
function makeTicks(prices: number[], intervalMs = ONE_MIN): PriceTick[] {
  const baseTime = Date.now() - prices.length * intervalMs;
  return prices.map((price, i) => ({
    timestamp: baseTime + i * intervalMs,
    price,
    amount: 0.001,
    side: "buy" as const,
  }));
}

/**
 * Generate an oscillating price series between min and max.
 * Pattern: mid → min → max → mid (repeated for each cycle).
 */
function makeOscillatingTicks(
  min: number,
  max: number,
  count: number,
  intervalMs = ONE_MIN,
): PriceTick[] {
  const mid = (min + max) / 2;
  const amplitude = (max - min) / 2;
  const baseTime = Date.now() - count * intervalMs;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: baseTime + i * intervalMs,
    price: mid + amplitude * Math.sin((2 * Math.PI * i) / (count / 3)),
    amount: 0.001,
    side: "buy" as const,
  }));
}

function expectSuggested(result: ReturnType<typeof suggestParams>) {
  expect(result).not.toBeNull();
  expect(result && !("skipped" in result)).toBe(true);
  if (!result || "skipped" in result) {
    throw new Error("Expected suggestParams to return a config suggestion");
  }
  return result;
}

// ─── resampleToCandles ────────────────────────────────────────────────────────

describe("resampleToCandles", () => {
  it("returns empty array for empty input", () => {
    expect(resampleToCandles([], FIVE_MIN)).toEqual([]);
  });

  it("produces one candle for ticks within a single interval", () => {
    const ticks = makeTicks([100, 101, 102], ONE_MIN);
    // All 3 ticks fit in one 5-min bucket
    const candles = resampleToCandles(ticks, FIVE_MIN);
    expect(candles.length).toBe(1);
    expect(candles[0].close).toBe(102); // last price in bucket
  });

  it("produces multiple candles for ticks spanning several intervals", () => {
    // Generate 30 ticks at 1-min intervals → 6 five-minute candles
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const ticks = makeTicks(prices, ONE_MIN);
    const candles = resampleToCandles(ticks, FIVE_MIN);
    expect(candles.length).toBe(6);
    // Each candle close should be the last price in its 5-min bucket
    expect(candles[0].close).toBe(104); // ticks 0-4
    expect(candles[1].close).toBe(109); // ticks 5-9
    expect(candles[5].close).toBe(129); // ticks 25-29
  });

  it("carries forward price across empty buckets (gaps)", () => {
    // 2 ticks 15 minutes apart (3 five-minute gaps)
    const baseTime = Date.now();
    const ticks: PriceTick[] = [
      { timestamp: baseTime, price: 100, amount: 1, side: "buy" },
      { timestamp: baseTime + 15 * ONE_MIN, price: 200, amount: 1, side: "buy" },
    ];
    const candles = resampleToCandles(ticks, FIVE_MIN);
    // Should have candles at t=0, t=5, t=10, t=15
    expect(candles.length).toBe(4);
    expect(candles[0].close).toBe(100);
    expect(candles[1].close).toBe(100); // carried forward
    expect(candles[2].close).toBe(100); // carried forward
    expect(candles[3].close).toBe(200);
  });

  it("handles single tick", () => {
    const ticks = makeTicks([42]);
    const candles = resampleToCandles(ticks, FIVE_MIN);
    expect(candles.length).toBe(1);
    expect(candles[0].close).toBe(42);
  });
});

// ─── computeDailyVolatility ──────────────────────────────────────────────────

describe("computeDailyVolatility", () => {
  it("returns 0 for fewer than 2 candles", () => {
    expect(computeDailyVolatility([], FIVE_MIN)).toBe(0);
    expect(computeDailyVolatility([{ close: 100 }], FIVE_MIN)).toBe(0);
  });

  it("returns 0 for identical candle prices (zero volatility)", () => {
    const candles = Array.from({ length: 50 }, () => ({ close: 100 }));
    expect(computeDailyVolatility(candles, FIVE_MIN)).toBe(0);
  });

  it("computes positive volatility for varying prices", () => {
    // Alternating: 100, 102, 100, 102, ...
    const candles = Array.from({ length: 100 }, (_, i) => ({
      close: i % 2 === 0 ? 100 : 102,
    }));
    const vol = computeDailyVolatility(candles, FIVE_MIN);
    expect(vol).toBeGreaterThan(0);
    // 2% swings on 5-min candles → should be significant daily vol
    expect(vol).toBeGreaterThan(0.1);
    expect(vol).toBeLessThan(5); // sanity upper bound
  });

  it("higher price swings produce higher volatility", () => {
    const smallSwing = Array.from({ length: 100 }, (_, i) => ({
      close: 100 + (i % 2 === 0 ? 0 : 1),
    }));
    const bigSwing = Array.from({ length: 100 }, (_, i) => ({
      close: 100 + (i % 2 === 0 ? 0 : 10),
    }));
    const volSmall = computeDailyVolatility(smallSwing, FIVE_MIN);
    const volBig = computeDailyVolatility(bigSwing, FIVE_MIN);
    expect(volBig).toBeGreaterThan(volSmall);
  });

  it("scales with candle interval (shorter intervals → more periods → higher scaled vol)", () => {
    const candles = Array.from({ length: 100 }, (_, i) => ({
      close: 100 + (i % 2 === 0 ? 0 : 2),
    }));
    const vol5min = computeDailyVolatility(candles, FIVE_MIN);
    const vol1min = computeDailyVolatility(candles, ONE_MIN);
    // Same raw stddev, but 1-min has more periods per day → higher daily vol
    expect(vol1min).toBeGreaterThan(vol5min);
  });

  it("handles candles with zero prices gracefully (skips those returns)", () => {
    const candles = [{ close: 100 }, { close: 0 }, { close: 100 }, { close: 102 }];
    // Should skip any pair with a zero, but still return something
    const vol = computeDailyVolatility(candles, FIVE_MIN);
    // With only 1 valid return (100→102), returns 0 since < 2 returns
    expect(vol).toBe(0);
  });
});

// ─── detectTrend ──────────────────────────────────────────────────────────────

describe("detectTrend", () => {
  it("returns non-trending for flat candles", () => {
    const candles = Array.from({ length: 50 }, () => ({ close: 100 }));
    const trend = detectTrend(candles);
    expect(trend.isTrending).toBe(false);
    expect(trend.direction).toBe("neutral");
    expect(trend.directionality).toBe(0);
  });

  it("returns non-trending for oscillating candles", () => {
    const candles = Array.from({ length: 120 }, (_, i) => ({
      close: 100 + 5 * Math.sin((2 * Math.PI * i) / 20),
    }));
    const trend = detectTrend(candles);
    expect(trend.isTrending).toBe(false);
    expect(trend.directionality).toBeLessThan(0.7);
  });

  it("detects strong uptrend", () => {
    const candles = Array.from({ length: 120 }, (_, i) => ({ close: 100 + i * 1.2 }));
    const trend = detectTrend(candles);
    expect(trend.isTrending).toBe(true);
    expect(trend.direction).toBe("up");
    expect(trend.directionality).toBeGreaterThan(0.7);
    expect(trend.consistency).toBeGreaterThan(0.65);
  });

  it("detects strong downtrend", () => {
    const candles = Array.from({ length: 120 }, (_, i) => ({ close: 400 - i * 2.0 }));
    const trend = detectTrend(candles);
    expect(trend.isTrending).toBe(true);
    expect(trend.direction).toBe("down");
    expect(trend.directionality).toBeGreaterThan(0.7);
    expect(trend.consistency).toBeGreaterThan(0.65);
  });

  it("returns non-trending when movement is too mixed", () => {
    const candles = Array.from({ length: 120 }, (_, i) => ({
      close: 100 + i * 0.3 + 8 * Math.sin((2 * Math.PI * i) / 6),
    }));
    const trend = detectTrend(candles);
    expect(trend.isTrending).toBe(false);
  });

  it("does not flag moderate consistency as trending with raised thresholds", () => {
    const candles = Array.from({ length: 200 }, (_, i) => ({
      close: 1000 - i * 1.8 + (i % 3 === 0 ? 3.0 : -0.8),
    }));
    const trend = detectTrend(candles);
    expect(trend.direction).toBe("down");
    expect(trend.directionality).toBeGreaterThan(0.9);
    expect(trend.consistency).toBeGreaterThan(0.5);
    // With raised thresholds (0.85/0.75) and no 0.9/0.5 override,
    // moderate consistency (~0.67) no longer triggers trend skip.
    expect(trend.consistency).toBeLessThan(0.75);
    expect(trend.isTrending).toBe(false);
  });
});

// ─── suggestParams ────────────────────────────────────────────────────────────

describe("suggestParams", () => {
  it("returns null for fewer than 10 ticks", () => {
    const ticks = makeTicks([100, 101, 102]);
    expect(suggestParams(ticks, 10_000)).toBeNull();
  });

  it("returns null for zero or negative last price", () => {
    const prices = Array.from({ length: 20 }, () => 0);
    const ticks = makeTicks(prices);
    expect(suggestParams(ticks, 10_000)).toBeNull();
  });

  it("returns a valid grid config for typical BTC_CZK oscillation", () => {
    // BTC at ~2.2M CZK, moderate oscillation
    const ticks = makeOscillatingTicks(2_100_000, 2_300_000, 500);
    const result = suggestParams(ticks, 100_000);

    const { config, metrics } = expectSuggested(result);

    // Basic structure
    expect(config.pair).toBe("BTC_CZK");
    expect(config.levels).toBeGreaterThanOrEqual(3);
    expect(config.levels).toBeLessThanOrEqual(50);
    expect(config.lowerPrice).toBeLessThan(config.upperPrice);
    expect(config.budgetQuote).toBe(100_000);

    // Range should be centered around current price
    expect(config.lowerPrice).toBeLessThan(metrics.currentPrice);
    expect(config.upperPrice).toBeGreaterThan(metrics.currentPrice);

    // Metrics should be populated
    expect(metrics.dailyVolatility).toBeGreaterThan(0);
    expect(metrics.halfRange).toBeGreaterThan(0);
    expect(metrics.desiredSpacingPercent).toBeGreaterThan(0);
  });

  it("floors volatility for a flat market", () => {
    // 500 ticks all at the same price
    const ticks = makeTicks(Array.from({ length: 500 }, () => 2_200_000));
    const result = suggestParams(ticks, 100_000);

    // Should still produce a result (floored volatility)
    const { metrics } = expectSuggested(result);
    expect(metrics.adjustments.some((a: string) => a.includes("Volatility floored"))).toBe(true);
  });

  it("returns a skip reason for strongly trending markets", () => {
    const prices = Array.from({ length: 500 }, (_, i) => 3_000_000 - i * 2_000);
    const ticks = makeTicks(prices);
    const result = suggestParams(ticks, 100_000);

    expect(result).not.toBeNull();
    expect(result && "skipped" in result).toBe(true);
    if (!result || !("skipped" in result)) {
      throw new Error("Expected suggestParams to skip in trending markets");
    }
    expect(result.reason).toContain("strong downtrend detected");
    expect(result.trend?.isTrending).toBe(true);
  });

  it("clamps levels to maximum 50", () => {
    // Very high volatility with wide range but enough budget for many levels
    // Use a config with high rangeMultiplier + low spacingMultiplier
    const ticks = makeOscillatingTicks(1_500_000, 3_000_000, 500);
    const wideConfig: AutopilotConfig = {
      ...AUTOPILOT_DEFAULTS,
      rangeMultiplier: 5.0,
      spacingMultiplier: 0.5,
    };
    const result = suggestParams(ticks, 5_000_000, wideConfig);

    if (result && !("skipped" in result)) {
      expect(result.config.levels).toBeLessThanOrEqual(50);
    }
  });

  it("clamps levels to minimum 3", () => {
    // Tight range → few levels
    const ticks = makeOscillatingTicks(2_190_000, 2_210_000, 500);
    const tightConfig: AutopilotConfig = {
      ...AUTOPILOT_DEFAULTS,
      rangeMultiplier: 0.3,
      spacingMultiplier: 5.0,
    };
    const result = suggestParams(ticks, 100_000, tightConfig);

    if (result && !("skipped" in result)) {
      expect(result.config.levels).toBeGreaterThanOrEqual(3);
      expect(result.metrics.adjustments.some((a: string) => a.includes("Levels clamped to minimum 3"))).toBe(true);
    }
  });

  it("biases the nearest bootstrap buy toward market for sparse grids", () => {
    const ticks = makeOscillatingTicks(1_450_000, 1_550_000, 500);
    const sparseConfig: AutopilotConfig = {
      ...AUTOPILOT_DEFAULTS,
      rangeMultiplier: 2.0,
      spacingMultiplier: 5.0,
    };
    const result = suggestParams(ticks, 5_000, sparseConfig);

    const suggested = expectSuggested(result);
    const currentPrice = suggested.metrics.currentPrice;
    const nearestBelow = calculateGridLevels(suggested.config)
      .filter((level) => level.price < currentPrice)
      .sort((a, b) => b.price - a.price)[0];

    expect(nearestBelow).toBeDefined();
    const gapPercent = ((currentPrice - nearestBelow.price) / currentPrice) * 100;
    expect(gapPercent).toBeLessThanOrEqual(3.1);
  });

  it("returns null if budget too low to meet minimum order size", () => {
    // With BTC_CZK at 2.2M, minOrderSize=0.0002 → need at least ~440 CZK per level
    // With 3 levels, need ~1320 CZK. So 100 CZK should fail.
    const ticks = makeOscillatingTicks(2_100_000, 2_300_000, 500);
    const result = suggestParams(ticks, 100);
    expect(result).toBeNull();
  });

  it("iteratively reduces levels if spacing is too tight", () => {
    // High levels + tight range → validation may complain about spacing
    const ticks = makeOscillatingTicks(2_190_000, 2_210_000, 500);
    const result = suggestParams(ticks, 100_000);

    if (result && !("skipped" in result)) {
      // Whatever it returns should pass validation (internally tested)
      expect(result.config.lowerPrice).toBeLessThan(result.config.upperPrice);
      expect(result.config.levels).toBeGreaterThanOrEqual(3);
    }
  });

  it("respects custom autopilot config overrides", () => {
    const ticks = makeOscillatingTicks(2_100_000, 2_300_000, 500);
    const customConfig: AutopilotConfig = {
      ...AUTOPILOT_DEFAULTS,
      pair: "ETH_CZK",
      rangeMultiplier: 3.0,
    };
    const result = suggestParams(ticks, 100_000, customConfig);

    if (result && !("skipped" in result)) {
      expect(result.config.pair).toBe("ETH_CZK");
    }
  });

  it("uses entire available budget", () => {
    const ticks = makeOscillatingTicks(2_100_000, 2_300_000, 500);
    const budget = 250_000;
    const result = suggestParams(ticks, budget);

    const suggested = expectSuggested(result);
    expect(suggested.config.budgetQuote).toBe(budget);
  });

  it("handles very high volatility without crashing", () => {
    // Extreme swings: 500K to 5M
    const ticks = makeOscillatingTicks(500_000, 5_000_000, 500);
    const result = suggestParams(ticks, 500_000);
    // May return null or a valid config — shouldn't throw
    if (result && !("skipped" in result)) {
      expect(result.config.levels).toBeGreaterThanOrEqual(3);
      expect(result.config.levels).toBeLessThanOrEqual(50);
    }
  });

  it("desiredSpacingPercent is above the fee threshold", () => {
    const ticks = makeOscillatingTicks(2_100_000, 2_300_000, 500);
    const result = suggestParams(ticks, 100_000);

    if (result && !("skipped" in result)) {
      // COINMATE_FEES.maker * 2 * 100 * minSpacingMultiplier = 0.004 * 2 * 100 * 3 = 2.4%
      expect(result.metrics.desiredSpacingPercent).toBeGreaterThanOrEqual(2.4);
    }
  });
});
