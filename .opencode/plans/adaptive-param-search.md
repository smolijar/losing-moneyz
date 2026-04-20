# Adaptive Grid Parameter Search

## Problem
`suggestParams()` generates one deterministic config using hardcoded multipliers (`spacingMultiplier: 1.5`, `rangeMultiplier: 2.0`). This produces a grid that's too wide for current market conditions (9.5% spacing when the market only moves ~2.6%/day), resulting in zero fills over 5 days.

## Solution
Generate N candidate configs by varying spacing and range multipliers, backtest each against the same recent price history, and return the best-scoring config.

## Changes

### 1. `functions/src/config/types.ts` — Add config fields

Add to `AutopilotConfig` interface (after `replacementImprovementThreshold`):
```ts
  enableParamSearch: boolean;
  paramSearchMinCompletedCycles: number;
  paramSearchSpacingMultiplierRange: [number, number];
  paramSearchRangeMultiplierRange: [number, number];
  paramSearchSpacingStep: number;
  paramSearchRangeStep: number;
```

Add to `AUTOPILOT_DEFAULTS`:
```ts
  enableParamSearch: true,
  paramSearchMinCompletedCycles: 1,
  paramSearchSpacingMultiplierRange: [1.0, 2.5],
  paramSearchRangeMultiplierRange: [1.0, 3.0],
  paramSearchSpacingStep: 0.25,
  paramSearchRangeStep: 0.5,
```

### 2. `functions/src/autopilot/param-suggester.ts` — Add search + scoring

Add scoring function:
```ts
export function scoreBacktestReport(report: BacktestReport): number {
  return (
    report.totalReturnPercent
    - Math.max(0, report.maxDrawdownPercent - 15) * 0.5
    + Math.min(report.completedCycles, 20) * 0.1
  );
}
```

Add `searchBestParams()` that:
1. Generates candidate (spacingMultiplier, rangeMultiplier) pairs from the configured ranges/steps
2. For each pair, calls `suggestParams()` with overridden config
3. Runs `runBacktest()` on each valid candidate
4. Filters to candidates with `completedCycles >= paramSearchMinCompletedCycles`
5. Scores remaining with `scoreBacktestReport()`
6. Returns highest-scoring, or falls back to original `suggestParams()` if none qualify

### 3. `functions/src/autopilot/autopilot.ts` — Use searchBestParams

Replace `suggestParams()` call at line 210 with `searchBestParams()`.

### 4. `functions/src/tick/orchestrator.ts` — Use searchBestParams

Replace `suggestParams()` call at line 1009 with `searchBestParams()`.

### 5. `functions/src/autopilot/index.ts` — Export new function

Add `searchBestParams` and `scoreBacktestReport` to exports.

### 6. `functions/test/autopilot/param-suggester.test.ts` — Add tests

- Scoring function unit tests
- searchBestParams selects tighter grid for range-bound market
- Fallback to suggestParams when enableParamSearch=false
- Edge cases: trending, budget too low, zero-cycle candidates

## Verification
```
pnpm tsc --noEmit && pnpm test
```
