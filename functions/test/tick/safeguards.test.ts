import { describe, it, expect } from "vitest";
import {
  checkPriceInRange,
  checkDrawdown,
  checkStaleTick,
  checkCircuitBreaker,
  checkMaxOrders,
  runAllSafeguards,
  DEFAULT_SAFEGUARD_CONFIG,
} from "../../src/tick";
import type { Experiment, ExperimentSnapshot } from "../../src/config";
import type { FillEvent } from "../../src/grid/engine";

const baseExperiment: Experiment = {
  id: "exp-1",
  status: "active",
  gridConfig: {
    pair: "BTC_CZK",
    lowerPrice: 2_000_000,
    upperPrice: 2_400_000,
    levels: 5,
    budgetQuote: 100_000,
  },
  allocatedQuote: 100_000,
  allocatedBase: 0,
  consecutiveFailures: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseSnapshot: ExperimentSnapshot = {
  timestamp: new Date(),
  balanceQuote: 90_000,
  balanceBase: 0.005,
  openOrders: 4,
  unrealizedPnl: 0,
  realizedPnl: 0,
  currentPrice: 2_200_000,
};

describe("checkPriceInRange", () => {
  it("returns ok when price is in range", () => {
    const result = checkPriceInRange(baseExperiment, 2_200_000);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("continue");
  });

  it("pauses when price is below range", () => {
    const result = checkPriceInRange(baseExperiment, 1_900_000);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
    expect(result.reason).toContain("outside grid range");
  });

  it("pauses when price is above range", () => {
    const result = checkPriceInRange(baseExperiment, 2_500_000);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
  });

  it("warns when price is near lower boundary", () => {
    // 5% of range (400k) = 20k. So 2_010_000 is within 5% of lower bound
    const result = checkPriceInRange(baseExperiment, 2_010_000);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("warn");
    expect(result.reason).toContain("near grid boundary");
  });

  it("warns when price is near upper boundary", () => {
    const result = checkPriceInRange(baseExperiment, 2_390_000);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("warn");
  });
});

describe("checkDrawdown", () => {
  it("returns ok when no snapshot exists", () => {
    const result = checkDrawdown(baseExperiment, undefined);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("continue");
  });

  it("returns ok when P&L is positive", () => {
    const snap = { ...baseSnapshot, unrealizedPnl: 1000, realizedPnl: 500 };
    const result = checkDrawdown(baseExperiment, snap);
    expect(result.ok).toBe(true);
  });

  it("pauses when drawdown exceeds threshold", () => {
    // -12% drawdown: -12000 / 100000 = 12% > 10% default
    const snap = { ...baseSnapshot, unrealizedPnl: -8000, realizedPnl: -4000 };
    const result = checkDrawdown(baseExperiment, snap);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
    expect(result.reason).toContain("Drawdown");
  });

  it("uses custom threshold", () => {
    const snap = { ...baseSnapshot, unrealizedPnl: -3000, realizedPnl: -2000 };
    const config = { ...DEFAULT_SAFEGUARD_CONFIG, maxDrawdownPercent: 3 };
    const result = checkDrawdown(baseExperiment, snap, config);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
  });

  it("recomputes unrealized P&L from fills when currentPrice and fills are provided", () => {
    // Snapshot has stale unrealizedPnl of 0, but fills + current price show a loss
    const snap = { ...baseSnapshot, unrealizedPnl: 0, realizedPnl: 0 };
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_200_000, amount: 0.01, gridLevel: 2, timestamp: 1 },
    ];
    // Price dropped to 1_000_000: unrealized = (1_000_000 - 2_200_000) * 0.01 = -12_000
    // Drawdown = 12_000 / 100_000 = 12% > 10% threshold
    const result = checkDrawdown(baseExperiment, snap, DEFAULT_SAFEGUARD_CONFIG, 1_000_000, fills);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
    expect(result.reason).toContain("Drawdown");
  });

  it("does NOT pause when fresh unrealized P&L from fills is within threshold", () => {
    // Snapshot has stale -15_000 unrealized but fills + current price show minor loss
    const snap = { ...baseSnapshot, unrealizedPnl: -15_000, realizedPnl: 0 };
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_200_000, amount: 0.01, gridLevel: 2, timestamp: 1 },
    ];
    // Current price 2_190_000: unrealized = (2_190_000 - 2_200_000) * 0.01 = -100
    // Drawdown = 100 / 100_000 = 0.1% — well below threshold
    const result = checkDrawdown(baseExperiment, snap, DEFAULT_SAFEGUARD_CONFIG, 2_190_000, fills);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("continue");
  });

  it("falls back to snapshot unrealizedPnl when currentPrice/fills not provided", () => {
    // Same as original behavior — snapshot P&L used directly
    const snap = { ...baseSnapshot, unrealizedPnl: -8000, realizedPnl: -4000 };
    const result = checkDrawdown(baseExperiment, snap);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
  });

  it("combines fresh unrealized with snapshot realized P&L", () => {
    // Realized P&L of -5_000 from snapshot + unrealized from fills
    const snap = { ...baseSnapshot, unrealizedPnl: 0, realizedPnl: -5_000 };
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_200_000, amount: 0.01, gridLevel: 2, timestamp: 1 },
    ];
    // Unrealized = (2_100_000 - 2_200_000) * 0.01 = -1_000
    // Total = -5_000 + (-1_000) = -6_000 → 6% < 10% threshold
    const result = checkDrawdown(baseExperiment, snap, DEFAULT_SAFEGUARD_CONFIG, 2_100_000, fills);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("continue");
  });
});

describe("checkStaleTick", () => {
  it("returns ok when no snapshot exists", () => {
    const result = checkStaleTick(undefined);
    expect(result.ok).toBe(true);
  });

  it("returns ok when tick is recent", () => {
    const snap = { ...baseSnapshot, timestamp: new Date() };
    const result = checkStaleTick(snap);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("continue");
  });

  it("warns when tick is stale", () => {
    const staleTime = new Date(Date.now() - 15 * 60 * 1000); // 15 min ago
    const snap = { ...baseSnapshot, timestamp: staleTime };
    const result = checkStaleTick(snap);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("warn");
    expect(result.reason).toContain("Last tick was");
  });
});

describe("checkCircuitBreaker", () => {
  it("returns ok when no failures", () => {
    const result = checkCircuitBreaker(0);
    expect(result.ok).toBe(true);
  });

  it("returns ok under threshold", () => {
    const result = checkCircuitBreaker(2);
    expect(result.ok).toBe(true);
  });

  it("pauses at threshold", () => {
    const result = checkCircuitBreaker(3);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
    expect(result.reason).toContain("consecutive API failures");
  });

  it("pauses above threshold", () => {
    const result = checkCircuitBreaker(5);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
  });
});

describe("checkMaxOrders", () => {
  it("returns ok when under limit", () => {
    const result = checkMaxOrders(4, 5);
    expect(result.ok).toBe(true);
  });

  it("warns at limit", () => {
    const result = checkMaxOrders(10, 5); // 10 orders, max = 5*2 = 10
    expect(result.ok).toBe(false);
    expect(result.action).toBe("warn");
  });
});

describe("runAllSafeguards", () => {
  it("returns shouldPause=false when all checks pass", () => {
    const { shouldPause, warnings } = runAllSafeguards(
      baseExperiment,
      2_200_000,
      baseSnapshot,
      0,
      4,
    );
    expect(shouldPause).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("returns shouldPause=true when price is out of range", () => {
    const { shouldPause } = runAllSafeguards(
      baseExperiment,
      1_800_000,
      baseSnapshot,
      0,
      4,
    );
    expect(shouldPause).toBe(true);
  });

  it("collects warnings from multiple checks", () => {
    const staleSnap = {
      ...baseSnapshot,
      timestamp: new Date(Date.now() - 15 * 60 * 1000),
    };
    const { shouldPause, warnings } = runAllSafeguards(
      baseExperiment,
      2_010_000, // near boundary → warn
      staleSnap, // stale tick → warn
      0,
      4,
    );
    expect(shouldPause).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Boundary value tests ──────────────────────────────────────────────────────

describe("boundary value tests", () => {
  it("checkPriceInRange: exactly at lower boundary is in range (no pause)", () => {
    const result = checkPriceInRange(baseExperiment, 2_000_000);
    expect(result.ok).toBe(true);
    // At lowerPrice exactly → within 5% margin → warn
    expect(result.action).toBe("warn");
  });

  it("checkPriceInRange: exactly at upper boundary is in range (no pause)", () => {
    const result = checkPriceInRange(baseExperiment, 2_400_000);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("warn");
  });

  it("checkPriceInRange: exactly 1 below lower boundary triggers pause", () => {
    const result = checkPriceInRange(baseExperiment, 1_999_999);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
  });

  it("checkPriceInRange: exactly 1 above upper boundary triggers pause", () => {
    const result = checkPriceInRange(baseExperiment, 2_400_001);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
  });

  it("checkDrawdown: exactly at threshold does not pause", () => {
    // 10% drawdown = 10_000 on 100_000
    const snap = { ...baseSnapshot, unrealizedPnl: -10_000, realizedPnl: 0 };
    const result = checkDrawdown(baseExperiment, snap);
    // 10% equals max, should NOT pause (only strictly greater pauses)
    expect(result.ok).toBe(true);
    expect(result.action).toBe("continue");
  });

  it("checkDrawdown: just over threshold triggers pause", () => {
    const snap = { ...baseSnapshot, unrealizedPnl: -10_001, realizedPnl: 0 };
    const result = checkDrawdown(baseExperiment, snap);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
  });

  it("checkCircuitBreaker: exactly 1 below threshold does not pause", () => {
    const result = checkCircuitBreaker(2); // default max is 3
    expect(result.ok).toBe(true);
    expect(result.action).toBe("continue");
  });

  it("checkCircuitBreaker: exactly at threshold pauses", () => {
    const result = checkCircuitBreaker(3);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("pause");
  });

  it("checkStaleTick: exactly at threshold does not warn", () => {
    const config = { ...DEFAULT_SAFEGUARD_CONFIG, staleTicThresholdMs: 10_000 };
    const now = new Date();
    const snap = { ...baseSnapshot, timestamp: new Date(now.getTime() - 10_000) };
    const result = checkStaleTick(snap, now, config);
    // Elapsed exactly equals threshold → should NOT warn (only strictly greater)
    expect(result.action).toBe("continue");
  });

  it("checkStaleTick: 1ms over threshold warns", () => {
    const config = { ...DEFAULT_SAFEGUARD_CONFIG, staleTicThresholdMs: 10_000 };
    const now = new Date();
    const snap = { ...baseSnapshot, timestamp: new Date(now.getTime() - 10_001) };
    const result = checkStaleTick(snap, now, config);
    expect(result.action).toBe("warn");
  });

  it("checkMaxOrders: 1 below limit does not warn", () => {
    const result = checkMaxOrders(9, 5); // max = 5*2 = 10
    expect(result.ok).toBe(true);
    expect(result.action).toBe("continue");
  });
});

// ─── runAllSafeguards `now` parameter ─────────────────────────────────────────

describe("runAllSafeguards deterministic now", () => {
  it("uses injected `now` for stale tick detection", () => {
    const snapshotTime = new Date("2025-01-01T00:00:00Z");
    const snapshot = { ...baseSnapshot, timestamp: snapshotTime };

    // 5 minutes after snapshot — should NOT warn (threshold is 10 min)
    const fiveMinLater = new Date(snapshotTime.getTime() + 5 * 60_000);
    const result1 = runAllSafeguards(
      baseExperiment, 2_200_000, snapshot, 0, 4,
      DEFAULT_SAFEGUARD_CONFIG, fiveMinLater,
    );
    const staleWarnings1 = result1.warnings.filter((w) => w.includes("Last tick was"));
    expect(staleWarnings1).toHaveLength(0);

    // 15 minutes after snapshot — should warn
    const fifteenMinLater = new Date(snapshotTime.getTime() + 15 * 60_000);
    const result2 = runAllSafeguards(
      baseExperiment, 2_200_000, snapshot, 0, 4,
      DEFAULT_SAFEGUARD_CONFIG, fifteenMinLater,
    );
    const staleWarnings2 = result2.warnings.filter((w) => w.includes("Last tick was"));
    expect(staleWarnings2).toHaveLength(1);
  });
});
