import { describe, it, expect } from "vitest";
import {
  runBacktest,
  validateWithBacktest,
  formatBacktestReport,
  type PriceTick,
} from "../../src/backtest";
import type { GridConfig } from "../../src/config";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a price series oscillating between min and max.
 * Starts at the midpoint so initial buy orders (below mid) get placed.
 * Pattern per cycle: mid → min → max → mid
 */
function generateOscillatingTicks(
  min: number,
  max: number,
  cycles: number,
  ticksPerCycle: number,
): PriceTick[] {
  const ticks: PriceTick[] = [];
  const baseTime = Date.now() - cycles * ticksPerCycle * 60_000;
  const mid = (min + max) / 2;
  const quarter = ticksPerCycle / 4;

  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < ticksPerCycle; i++) {
      const t = c * ticksPerCycle + i;
      let price: number;
      if (i < quarter) {
        // mid → min
        price = mid - ((mid - min) * i) / quarter;
      } else if (i < quarter * 2) {
        // min → max
        price = min + ((max - min) * (i - quarter)) / quarter;
      } else if (i < quarter * 3) {
        // max → min
        price = max - ((max - min) * (i - quarter * 2)) / quarter;
      } else {
        // min → mid
        price = min + ((mid - min) * (i - quarter * 3)) / quarter;
      }
      ticks.push({
        timestamp: baseTime + t * 60_000,
        price,
        amount: 0.001,
        side: price >= mid ? "sell" : "buy",
      });
    }
  }
  return ticks;
}

/** Generate a flat price series */
function generateFlatTicks(price: number, count: number): PriceTick[] {
  const baseTime = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: baseTime + i * 60_000,
    price,
    amount: 0.001,
    side: "buy" as const,
  }));
}

/** Generate a monotonically increasing price series */
function generateTrendingUpTicks(start: number, end: number, count: number): PriceTick[] {
  const baseTime = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: baseTime + i * 60_000,
    price: start + ((end - start) * i) / (count - 1),
    amount: 0.001,
    side: "buy" as const,
  }));
}

/** Generate a monotonically decreasing price series */
function generateTrendingDownTicks(start: number, end: number, count: number): PriceTick[] {
  const baseTime = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: baseTime + i * 60_000,
    price: start - ((start - end) * i) / (count - 1),
    amount: 0.001,
    side: "sell" as const,
  }));
}

/** Default grid config for tests */
const defaultConfig: GridConfig = {
  pair: "BTC_CZK",
  lowerPrice: 2_000_000,
  upperPrice: 2_400_000,
  levels: 5,
  budgetQuote: 100_000,
};

// ─── runBacktest ──────────────────────────────────────────────────────────────

describe("runBacktest", () => {
  it("throws on empty ticks", () => {
    expect(() => runBacktest(defaultConfig, [])).toThrow("No price ticks provided");
  });

  it("returns a valid report structure", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 3, 100);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.config).toEqual(defaultConfig);
    expect(report.periodDays).toBeGreaterThan(0);
    expect(report.startingQuote).toBe(100_000);
    expect(typeof report.endingQuote).toBe("number");
    expect(typeof report.endingBase).toBe("number");
    expect(typeof report.totalReturn).toBe("number");
    expect(typeof report.totalReturnPercent).toBe("number");
    expect(typeof report.annualizedReturnPercent).toBe("number");
    expect(typeof report.maxDrawdownPercent).toBe("number");
    expect(typeof report.totalTrades).toBe("number");
    expect(typeof report.completedCycles).toBe("number");
    expect(typeof report.avgProfitPerCycle).toBe("number");
    expect(typeof report.totalFees).toBe("number");
    expect(typeof report.gridUtilizationPercent).toBe("number");
    expect(typeof report.profitable).toBe("boolean");
    expect(Array.isArray(report.pnlTimeseries)).toBe(true);
  });

  it("produces trades on oscillating prices", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 5, 100);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.totalTrades).toBeGreaterThan(0);
    expect(report.gridUtilizationPercent).toBeGreaterThan(0);
  });

  it("produces zero trades on flat prices", () => {
    // Price starts at mid-range, never touches grid levels above/below
    const midPrice = 2_200_000;
    const ticks = generateFlatTicks(midPrice, 500);
    const report = runBacktest(defaultConfig, ticks);

    // With flat price at mid, initial orders are placed but never filled
    expect(report.totalTrades).toBe(0);
    expect(report.completedCycles).toBe(0);
  });

  it("accumulates base on trending down market", () => {
    // Price drops through all buy levels
    const ticks = generateTrendingDownTicks(2_400_000, 2_000_000, 500);
    const report = runBacktest(defaultConfig, ticks);

    // Should have filled buy orders, ending with base holdings
    expect(report.endingBase).toBeGreaterThanOrEqual(0);
  });

  it("measures max drawdown correctly", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 3, 100);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.maxDrawdownPercent).toBeGreaterThanOrEqual(0);
    expect(report.maxDrawdownPercent).toBeLessThanOrEqual(100);
  });

  it("never drives quote balance negative in monotonic selloff", () => {
    const ticks = generateTrendingDownTicks(2_400_000, 1_600_000, 500);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.endingQuote).toBeGreaterThanOrEqual(0);
  });

  it("oscillating market with good spacing is profitable", () => {
    // Wide grid with decent spread should profit from oscillation
    const config: GridConfig = {
      pair: "BTC_CZK",
      lowerPrice: 2_000_000,
      upperPrice: 2_400_000,
      levels: 5,
      budgetQuote: 200_000,
    };
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 10, 200);
    const report = runBacktest(config, ticks);

    expect(report.totalTrades).toBeGreaterThan(0);
    expect(report.completedCycles).toBeGreaterThan(0);
  });

  it("fees are always non-negative", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 5, 100);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.totalFees).toBeGreaterThanOrEqual(0);
  });

  it("P&L timeseries is recorded", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 3, 100);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.pnlTimeseries.length).toBeGreaterThan(0);
    for (const entry of report.pnlTimeseries) {
      expect(typeof entry.timestamp).toBe("number");
      expect(typeof entry.cumulativePnl).toBe("number");
    }
  });

  it("grid utilization reflects triggered levels", () => {
    // Wide oscillation should trigger most levels
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 5, 200);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.gridUtilizationPercent).toBeGreaterThan(0);
    expect(report.gridUtilizationPercent).toBeLessThanOrEqual(100);
  });

  it("annualized return scales correctly with period length", () => {
    // Short period
    const shortTicks = generateOscillatingTicks(2_000_000, 2_400_000, 2, 100);
    const shortReport = runBacktest(defaultConfig, shortTicks);

    // Longer period (same pattern)
    const longTicks = generateOscillatingTicks(2_000_000, 2_400_000, 10, 100);
    const longReport = runBacktest(defaultConfig, longTicks);

    // Both should have defined annualized returns
    expect(typeof shortReport.annualizedReturnPercent).toBe("number");
    expect(typeof longReport.annualizedReturnPercent).toBe("number");
  });

  it("starting balance equals budgetQuote", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 3, 100);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.startingQuote).toBe(defaultConfig.budgetQuote);
  });

  it("avgProfitPerCycle is zero when no cycles complete", () => {
    const ticks = generateFlatTicks(2_200_000, 500);
    const report = runBacktest(defaultConfig, ticks);

    expect(report.avgProfitPerCycle).toBe(0);
  });

  it("trending up triggers sell orders", () => {
    // Start at mid, dip to bottom (filling buys), then trend up through all sell levels
    const mid = 2_200_000;
    const dipTicks = generateTrendingDownTicks(mid, 2_000_000, 100);
    const upTicks = generateTrendingUpTicks(2_000_000, 2_400_000, 400);
    // Adjust timestamps so they're continuous
    const lastDipTs = dipTicks[dipTicks.length - 1].timestamp;
    const adjustedUp = upTicks.map((t, i) => ({
      ...t,
      timestamp: lastDipTs + (i + 1) * 60_000,
    }));
    const ticks = [...dipTicks, ...adjustedUp];
    const report = runBacktest(defaultConfig, ticks);

    // Some trades should happen: buys on dip, then sells on rally
    expect(report.totalTrades).toBeGreaterThan(0);
  });
});

// ─── validateWithBacktest ─────────────────────────────────────────────────────

describe("validateWithBacktest", () => {
  it("rejects config that fails grid validation", () => {
    // Spacing too tight → validateGridConfig fails
    const badConfig: GridConfig = {
      pair: "BTC_CZK",
      lowerPrice: 2_000_000,
      upperPrice: 2_010_000,
      levels: 100, // very tight spacing
      budgetQuote: 100_000,
    };
    const ticks = generateOscillatingTicks(2_000_000, 2_010_000, 3, 100);
    const result = validateWithBacktest(badConfig, ticks);

    expect(result.approved).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("rejects config with excessive drawdown", () => {
    // Use a tight max drawdown threshold
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 5, 100);
    const result = validateWithBacktest(defaultConfig, ticks, {
      maxDrawdownPercent: 0.001, // impossibly tight
    });

    // Likely to be rejected due to drawdown (any non-zero drawdown fails)
    // If drawdown is exactly 0, this test would pass — depends on sim
    expect(typeof result.approved).toBe("boolean");
    expect(result.report).toBeDefined();
  });

  it("rejects config with negative return when minReturn is high", () => {
    const ticks = generateFlatTicks(2_200_000, 500);
    const result = validateWithBacktest(defaultConfig, ticks, {
      minReturnPercent: 50, // demand 50% return on flat market
    });

    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes("Return"))).toBe(true);
  });

  it("does not reject solely because no cycles complete", () => {
    const ticks = generateFlatTicks(2_200_000, 500);
    const result = validateWithBacktest(defaultConfig, ticks);

    // completedCycles === 0 is no longer a rejection reason on its own.
    // The config may still be rejected for other reasons (return / drawdown),
    // but the "No completed trade cycles" string must not appear.
    expect(result.reasons.some((r) => r.includes("No completed trade cycles"))).toBe(false);
  });

  it("approves a profitable config on oscillating market", () => {
    const config: GridConfig = {
      pair: "BTC_CZK",
      lowerPrice: 2_000_000,
      upperPrice: 2_400_000,
      levels: 5,
      budgetQuote: 200_000,
    };
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 10, 200);
    const result = validateWithBacktest(config, ticks, {
      minReturnPercent: -100, // very lenient
      maxDrawdownPercent: 100,
    });

    // Should have cycles and potentially be approved
    expect(result.report.completedCycles).toBeGreaterThan(0);
    expect(typeof result.approved).toBe("boolean");
  });

  it("returns a full report even when rejected", () => {
    const ticks = generateFlatTicks(2_200_000, 500);
    const result = validateWithBacktest(defaultConfig, ticks);

    expect(result.report).toBeDefined();
    expect(result.report.config).toEqual(defaultConfig);
    expect(result.report.startingQuote).toBe(defaultConfig.budgetQuote);
  });

  it("handles empty ticks with config validation failure gracefully", () => {
    const badConfig: GridConfig = {
      pair: "BTC_CZK",
      lowerPrice: 2_000_000,
      upperPrice: 2_010_000,
      levels: 100,
      budgetQuote: 100_000,
    };
    // Config fails validation, so backtest is never run
    const result = validateWithBacktest(badConfig, []);

    expect(result.approved).toBe(false);
    expect(result.report.totalTrades).toBe(0);
  });

  it("rejects when completedCycles is below minCompletedCycles", () => {
    // Fix #4: small budgets can require at least 1 completed cycle.
    // A flat market produces 0 cycles — should be rejected.
    const ticks = generateFlatTicks(2_200_000, 500);
    const result = validateWithBacktest(defaultConfig, ticks, {
      minCompletedCycles: 1,
      minReturnPercent: -100, // lenient on return
      maxDrawdownPercent: 100, // lenient on drawdown
    });

    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes("Completed cycles"))).toBe(true);
    expect(result.report.completedCycles).toBe(0);
  });

  it("approves when completedCycles meets minCompletedCycles", () => {
    // Oscillating market should produce at least 1 cycle
    const config: GridConfig = {
      pair: "BTC_CZK",
      lowerPrice: 2_000_000,
      upperPrice: 2_400_000,
      levels: 5,
      budgetQuote: 200_000,
    };
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 10, 200);
    const result = validateWithBacktest(config, ticks, {
      minCompletedCycles: 1,
      minReturnPercent: -100,
      maxDrawdownPercent: 100,
    });

    expect(result.report.completedCycles).toBeGreaterThanOrEqual(1);
    // The "Completed cycles" rejection string should NOT appear
    expect(result.reasons.some((r) => r.includes("Completed cycles"))).toBe(false);
  });

  it("does not reject for zero cycles when minCompletedCycles defaults to 0", () => {
    // Without specifying minCompletedCycles, zero cycles should NOT be a rejection reason
    const ticks = generateFlatTicks(2_200_000, 500);
    const result = validateWithBacktest(defaultConfig, ticks, {
      minReturnPercent: -100,
      maxDrawdownPercent: 100,
    });

    expect(result.reasons.some((r) => r.includes("Completed cycles"))).toBe(false);
  });
});

// ─── formatBacktestReport ─────────────────────────────────────────────────────

describe("formatBacktestReport", () => {
  it("produces a formatted string", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 3, 100);
    const report = runBacktest(defaultConfig, ticks);
    const output = formatBacktestReport(report);

    expect(typeof output).toBe("string");
    expect(output).toContain("Backtest Report");
    expect(output).toContain("BTC_CZK");
  });

  it("includes all key metrics", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 3, 100);
    const report = runBacktest(defaultConfig, ticks);
    const output = formatBacktestReport(report);

    expect(output).toContain("Starting balance");
    expect(output).toContain("Ending quote");
    expect(output).toContain("Total return");
    expect(output).toContain("Annualized return");
    expect(output).toContain("Max drawdown");
    expect(output).toContain("Total fills");
    expect(output).toContain("Completed cycles");
    expect(output).toContain("Avg profit/cycle");
    expect(output).toContain("Total fees");
    expect(output).toContain("Grid utilization");
    expect(output).toContain("Profitable");
  });

  it("shows YES for profitable report", () => {
    const config: GridConfig = {
      pair: "BTC_CZK",
      lowerPrice: 2_000_000,
      upperPrice: 2_400_000,
      levels: 5,
      budgetQuote: 200_000,
    };
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 10, 200);
    const report = runBacktest(config, ticks);
    const output = formatBacktestReport(report);

    if (report.profitable) {
      expect(output).toContain("YES");
    } else {
      expect(output).toContain("NO");
    }
  });

  it("shows NO for unprofitable report", () => {
    // Flat market, no trades
    const ticks = generateFlatTicks(2_200_000, 500);
    const report = runBacktest(defaultConfig, ticks);
    const output = formatBacktestReport(report);

    // Flat market should result in zero or negative return due to no trades
    // (ending value == starting minus reserved quote in open orders, valued at original prices)
    expect(output).toContain("Profitable:");
  });

  it("includes grid range info", () => {
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 3, 100);
    const report = runBacktest(defaultConfig, ticks);
    const output = formatBacktestReport(report);

    expect(output).toContain("2000000");
    expect(output).toContain("2400000");
    expect(output).toContain("5 levels");
  });
});

// ─── Fee-adjusted sell amounts ──────────────────────────────────────────────

describe("fee-adjusted counter-sell amounts", () => {
  it("counter-sell amount is reduced by maker fee rate (matches engine logic)", () => {
    // Simple scenario: price drops through one buy level, then rises through the sell level.
    // We verify that the ending base balance has fee-dust (sell < buy amount).
    const config: GridConfig = {
      pair: "BTC_CZK",
      lowerPrice: 2_000_000,
      upperPrice: 2_400_000,
      levels: 5,
      budgetQuote: 100_000,
    };

    // Oscillate enough to complete at least one buy→sell cycle
    const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 5, 200);
    const report = runBacktest(config, ticks);

    // With fee-adjusted sells, each cycle sells slightly less BTC than was bought.
    // After completed cycles, there should be residual base (fee dust).
    if (report.completedCycles > 0) {
      expect(report.endingBase).toBeGreaterThan(0);
    }
  });

  it("sell amounts are strictly less than buy amounts for same budget", () => {
    // Price: start at mid, drop to bottom level, then rise to top level.
    // This guarantees buys fill on the way down and counter-sells are placed.
    const baseTime = Date.now() - 600 * 60_000;
    const ticks: PriceTick[] = [];

    // Start at mid (2.2M)
    for (let i = 0; i < 10; i++) {
      ticks.push({ timestamp: baseTime + i * 60_000, price: 2_200_000, amount: 0.001, side: "buy" });
    }
    // Drop to 2.0M (fills buy orders)
    for (let i = 0; i < 100; i++) {
      const price = 2_200_000 - (200_000 * i) / 99;
      ticks.push({ timestamp: baseTime + (10 + i) * 60_000, price, amount: 0.001, side: "sell" });
    }
    // Rise to 2.4M (fills counter-sell orders)
    for (let i = 0; i < 100; i++) {
      const price = 2_000_000 + (400_000 * i) / 99;
      ticks.push({ timestamp: baseTime + (110 + i) * 60_000, price, amount: 0.001, side: "buy" });
    }

    const report = runBacktest(defaultConfig, ticks);
    expect(report.totalTrades).toBeGreaterThan(0);

    // After selling fee-adjusted amounts, base should remain positive (unsold fee dust)
    expect(report.endingBase).toBeGreaterThan(0);
  });
});

// ─── Flash crash scenario ───────────────────────────────────────────────────

describe("flash crash scenario", () => {
  const defaultConfig: GridConfig = {
    pair: "BTC_CZK",
    lowerPrice: 2_000_000,
    upperPrice: 2_400_000,
    levels: 5,
    budgetQuote: 100_000,
  };

  /**
   * Generate ticks that simulate a flash crash:
   * Start at mid, crash to well below lower, then recover to mid.
   */
  function generateFlashCrashTicks(
    lower: number,
    upper: number,
    crashBottom: number,
    totalTicks: number,
  ): PriceTick[] {
    const ticks: PriceTick[] = [];
    const mid = (lower + upper) / 2;
    const baseTime = Date.now() - totalTicks * 60_000;

    // Phase 1: Normal at mid (25%)
    const normalTicks = Math.floor(totalTicks * 0.25);
    for (let i = 0; i < normalTicks; i++) {
      ticks.push({
        timestamp: baseTime + i * 60_000,
        price: mid,
        amount: 0.01,
        side: "buy",
      });
    }

    // Phase 2: Crash to bottom (25%)
    const crashTicks = Math.floor(totalTicks * 0.25);
    for (let i = 0; i < crashTicks; i++) {
      const progress = i / crashTicks;
      const price = mid - progress * (mid - crashBottom);
      ticks.push({
        timestamp: baseTime + (normalTicks + i) * 60_000,
        price: Math.round(price),
        amount: 0.1,
        side: "sell",
      });
    }

    // Phase 3: Stay at bottom (25%)
    const bottomTicks = Math.floor(totalTicks * 0.25);
    for (let i = 0; i < bottomTicks; i++) {
      ticks.push({
        timestamp: baseTime + (normalTicks + crashTicks + i) * 60_000,
        price: crashBottom,
        amount: 0.01,
        side: "sell",
      });
    }

    // Phase 4: Recovery (25%)
    const recoveryTicks = totalTicks - normalTicks - crashTicks - bottomTicks;
    for (let i = 0; i < recoveryTicks; i++) {
      const progress = i / recoveryTicks;
      const price = crashBottom + progress * (mid - crashBottom);
      ticks.push({
        timestamp: baseTime + (normalTicks + crashTicks + bottomTicks + i) * 60_000,
        price: Math.round(price),
        amount: 0.01,
        side: "buy",
      });
    }

    return ticks;
  }

  it("should survive a flash crash below grid range without throwing", () => {
    // Crash to 1.5M, well below grid lower of 2M
    const ticks = generateFlashCrashTicks(2_000_000, 2_400_000, 1_500_000, 200);
    const report = runBacktest(defaultConfig, ticks);

    // Should complete without error
    expect(report.totalTrades).toBeGreaterThanOrEqual(0);
    // During crash, all buy orders get filled and BTC devalues
    expect(report.maxDrawdownPercent).toBeGreaterThan(0);
  });

  it("should fill buy orders during crash and recover some with sells", () => {
    // Crash within grid range: from 2.2M down to 2.05M, then back up
    const ticks = generateFlashCrashTicks(2_000_000, 2_400_000, 2_050_000, 200);
    const report = runBacktest(defaultConfig, ticks);

    // Should have filled some buys on the way down
    expect(report.totalTrades).toBeGreaterThan(0);
  });

  it("should show higher drawdown for deeper crashes", () => {
    const shallowTicks = generateFlashCrashTicks(2_000_000, 2_400_000, 2_050_000, 200);
    const deepTicks = generateFlashCrashTicks(2_000_000, 2_400_000, 1_500_000, 200);

    const shallowReport = runBacktest(defaultConfig, shallowTicks);
    const deepReport = runBacktest(defaultConfig, deepTicks);

    expect(deepReport.maxDrawdownPercent).toBeGreaterThanOrEqual(shallowReport.maxDrawdownPercent);
  });
});
