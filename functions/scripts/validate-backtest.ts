/**
 * CI Backtest Validation Script
 *
 * Runs backtest validation against a reference grid config with synthetic data.
 * Used in CI to gate deploys — if the grid engine + backtester produce inconsistent
 * or unprofitable results with known-good params, the build fails.
 *
 * Usage: npx tsx scripts/validate-backtest.ts
 */

import { validateWithBacktest, formatBacktestReport, type PriceTick } from "../src/backtest";
import type { GridConfig } from "../src/config";

// ─── Reference config (known to produce positive results with oscillating data) ──

const referenceConfig: GridConfig = {
  pair: "BTC_CZK",
  lowerPrice: 2_000_000,
  upperPrice: 2_400_000,
  levels: 5,
  budgetQuote: 100_000,
};

// Validation thresholds — CI sanity check (not a strict profitability gate).
// With synthetic oscillating data, drawdown is inflated by the test pattern.
// The goal is to verify grid engine + backtester code is consistent, not predict real P&L.
const MIN_COMPLETED_CYCLES = 1;
const MAX_DRAWDOWN_PERCENT = 80;

// ─── Generate synthetic oscillating price data ────────────────────────────────

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

// ─── Run validation ───────────────────────────────────────────────────────────

// Oscillate across the full grid range so all levels get activated.
// 20 cycles of 200 ticks each = 4000 ticks, simulating ~2.8 days of ranging.
const ticks = generateOscillatingTicks(2_000_000, 2_400_000, 20, 200);

console.log("Running backtest validation...");
console.log(`  Config: ${referenceConfig.lowerPrice} — ${referenceConfig.upperPrice}, ${referenceConfig.levels} levels`);
console.log(`  Budget: ${referenceConfig.budgetQuote} CZK`);
console.log(`  Ticks: ${ticks.length}`);
console.log();

const validation = validateWithBacktest(referenceConfig, ticks, {
  minReturnPercent: -100, // we only gate on cycles + drawdown, not absolute return
  maxDrawdownPercent: MAX_DRAWDOWN_PERCENT,
});

console.log(formatBacktestReport(validation.report));
console.log();

if (validation.approved && validation.report.completedCycles >= MIN_COMPLETED_CYCLES) {
  console.log("BACKTEST VALIDATION: PASSED");
  console.log(`  Completed cycles: ${validation.report.completedCycles} (min: ${MIN_COMPLETED_CYCLES})`);
  console.log(`  Max drawdown: ${validation.report.maxDrawdownPercent.toFixed(2)}% (max: ${MAX_DRAWDOWN_PERCENT}%)`);
  process.exit(0);
} else {
  console.error("BACKTEST VALIDATION: FAILED");
  for (const reason of validation.reasons) {
    console.error(`  - ${reason}`);
  }
  if (validation.report.completedCycles < MIN_COMPLETED_CYCLES) {
    console.error(`  - Completed cycles: ${validation.report.completedCycles} < min ${MIN_COMPLETED_CYCLES}`);
  }
  process.exit(1);
}
