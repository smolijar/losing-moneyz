import { describe, it, expect } from "vitest";
import {
  calculateGridLevels,
  getGridSpacing,
  getGridSpacingPercent,
  getCounterOrderLevel,
  reconcileOrders,
  validateGridConfig,
  computePnL,
  computeUnrealizedPnl,
  roundAmount,
  matchOrdersToGrid,
} from "../../src/grid/engine";
import type { GridLevel, ExistingOrder, FillEvent } from "../../src/grid/engine";
import type { GridConfig } from "../../src/config";

// ─── calculateGridLevels ──────────────────────────────────────────────────────

describe("calculateGridLevels", () => {
  const baseConfig: GridConfig = {
    lowerPrice: 2_000_000,
    upperPrice: 2_500_000,
    levels: 10,
    budgetQuote: 50_000,
    pair: "BTC_CZK",
  };

  it("should return correct number of levels", () => {
    const levels = calculateGridLevels(baseConfig);
    expect(levels).toHaveLength(10);
  });

  it("should have first level at lower price", () => {
    const levels = calculateGridLevels(baseConfig);
    expect(levels[0].price).toBe(2_000_000);
  });

  it("should have last level at upper price", () => {
    const levels = calculateGridLevels(baseConfig);
    expect(levels[9].price).toBe(2_500_000);
  });

  it("should produce evenly spaced levels", () => {
    const levels = calculateGridLevels(baseConfig);
    const expectedSpacing = 500_000 / 9; // ~55555.56
    for (let i = 1; i < levels.length; i++) {
      const spacing = levels[i].price - levels[i - 1].price;
      expect(Math.abs(spacing - expectedSpacing)).toBeLessThan(0.01);
    }
  });

  it("should assign correct indices", () => {
    const levels = calculateGridLevels(baseConfig);
    levels.forEach((level, i) => expect(level.index).toBe(i));
  });

  it("should handle 3 levels (minimum)", () => {
    const config: GridConfig = { ...baseConfig, levels: 3 };
    const levels = calculateGridLevels(config);
    expect(levels).toHaveLength(3);
    expect(levels[0].price).toBe(2_000_000);
    expect(levels[1].price).toBe(2_250_000);
    expect(levels[2].price).toBe(2_500_000);
  });

  it("should produce NaN price with levels=1 due to Infinity spacing (rejected by Zod)", () => {
    // The Zod schema rejects levels < 3, but if calculateGridLevels is called
    // directly with levels=1, spacing = (upper - lower) / 0 = Infinity.
    // lowerPrice + 0 * Infinity = NaN after rounding.
    // This test documents the behavior so we know it's guarded at the schema level.
    const config: GridConfig = { ...baseConfig, levels: 1 };
    const levels = calculateGridLevels(config);
    expect(levels).toHaveLength(1);
    expect(levels[0].price).toBeNaN();
  });

  it("should handle levels=2 (edge case)", () => {
    const config: GridConfig = { ...baseConfig, levels: 2 };
    const levels = calculateGridLevels(config);
    expect(levels).toHaveLength(2);
    expect(levels[0].price).toBe(2_000_000);
    expect(levels[1].price).toBe(2_500_000);
  });

  it("should handle very tight ranges", () => {
    const config: GridConfig = {
      ...baseConfig,
      lowerPrice: 2_400_000,
      upperPrice: 2_410_000,
      levels: 5,
    };
    const levels = calculateGridLevels(config);
    expect(levels).toHaveLength(5);
    expect(levels[0].price).toBe(2_400_000);
    expect(levels[4].price).toBe(2_410_000);
  });
});

// ─── getGridSpacing / getGridSpacingPercent ────────────────────────────────────

describe("getGridSpacing", () => {
  it("should calculate correct absolute spacing", () => {
    const config: GridConfig = {
      lowerPrice: 2_000_000,
      upperPrice: 2_500_000,
      levels: 11,
      budgetQuote: 50_000,
      pair: "BTC_CZK",
    };
    expect(getGridSpacing(config)).toBe(50_000);
  });
});

describe("getGridSpacingPercent", () => {
  it("should calculate correct percentage spacing", () => {
    const config: GridConfig = {
      lowerPrice: 2_000_000,
      upperPrice: 2_500_000,
      levels: 11,
      budgetQuote: 50_000,
      pair: "BTC_CZK",
    };
    const pct = getGridSpacingPercent(config);
    // spacing = 50000, mid = 2250000, pct = 50000/2250000*100 ≈ 2.22%
    expect(pct).toBeCloseTo(2.222, 2);
  });
});

// ─── reconcileOrders ──────────────────────────────────────────────────────────

describe("reconcileOrders", () => {
  const config: GridConfig = {
    lowerPrice: 2_000_000,
    upperPrice: 2_100_000,
    levels: 6,
    budgetQuote: 30_000,
    pair: "BTC_CZK",
  };
  const levels = calculateGridLevels(config);
  const budgetPerLevel = config.budgetQuote / Math.ceil(config.levels / 2);

  it("should place initial grid orders when no existing orders", () => {
    const actions = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel);

    const buys = actions.filter((a) => a.type === "place" && a.side === "buy");
    const sells = actions.filter((a) => a.type === "place" && a.side === "sell");

    // Levels below 2_050_000: 2_000_000, 2_020_000, 2_040_000 → 3 buys
    expect(buys.length).toBe(3);
    // Levels above 2_050_000: 2_060_000, 2_080_000, 2_100_000 → 3 sells
    expect(sells.length).toBe(3);
  });

  it("should place sell order when a buy fills", () => {
    const existingOrders: ExistingOrder[] = [];
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.005, gridLevel: 0, timestamp: 1 },
    ];

    const actions = reconcileOrders(levels, existingOrders, fills, 2_000_000, budgetPerLevel);
    const places = actions.filter((a) => a.type === "place");

    // Should place a sell at level 1 (next up from level 0)
    const sellAtLevel1 = places.find((a) => a.type === "place" && a.gridLevel === 1);
    expect(sellAtLevel1).toBeDefined();
    expect(sellAtLevel1!.type === "place" && sellAtLevel1!.side).toBe("sell");
  });

  it("should place buy order when a sell fills", () => {
    const existingOrders: ExistingOrder[] = [];
    const fills: FillEvent[] = [
      { orderId: 2, side: "sell", price: 2_100_000, amount: 0.005, gridLevel: 5, timestamp: 1 },
    ];

    const actions = reconcileOrders(levels, existingOrders, fills, 2_100_000, budgetPerLevel);
    const places = actions.filter((a) => a.type === "place");

    // Should place a buy at level 4 (next down from level 5)
    const buyAtLevel4 = places.find((a) => a.type === "place" && a.gridLevel === 4);
    expect(buyAtLevel4).toBeDefined();
    expect(buyAtLevel4!.type === "place" && buyAtLevel4!.side).toBe("buy");
  });

  it("should cancel orphaned orders", () => {
    const existingOrders: ExistingOrder[] = [
      { id: 99, side: "buy", price: 1_900_000, amount: 0.001, gridLevel: -1 },
    ];

    const actions = reconcileOrders(levels, existingOrders, [], 2_050_000, budgetPerLevel);
    const cancels = actions.filter((a) => a.type === "cancel");

    expect(cancels.length).toBe(1);
    expect(cancels[0].type === "cancel" && cancels[0].orderId).toBe(99);
  });

  it("should not duplicate orders at the same level", () => {
    const existingOrders: ExistingOrder[] = [
      { id: 10, side: "sell", price: levels[3].price, amount: 0.005, gridLevel: 3 },
    ];
    const fills: FillEvent[] = [
      {
        orderId: 1,
        side: "buy",
        price: levels[2].price,
        amount: 0.005,
        gridLevel: 2,
        timestamp: 1,
      },
    ];

    const actions = reconcileOrders(levels, existingOrders, fills, 2_050_000, budgetPerLevel);
    const placesAtLevel3 = actions.filter(
      (a) => a.type === "place" && a.gridLevel === 3,
    );
    // Level 3 already has an order, so no new placement
    expect(placesAtLevel3.length).toBe(0);
  });

  it("should be idempotent: running twice with same input gives same output", () => {
    const existingOrders: ExistingOrder[] = [];
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.005, gridLevel: 0, timestamp: 1 },
    ];

    const actions1 = reconcileOrders(levels, existingOrders, fills, 2_050_000, budgetPerLevel);
    const actions2 = reconcileOrders(levels, existingOrders, fills, 2_050_000, budgetPerLevel);

    expect(actions1).toEqual(actions2);
  });

  it("should not place sell above highest level (edge case)", () => {
    const fills: FillEvent[] = [
      {
        orderId: 1,
        side: "buy",
        price: levels[levels.length - 1].price,
        amount: 0.005,
        gridLevel: levels.length - 1,
        timestamp: 1,
      },
    ];
    const actions = reconcileOrders(levels, [], fills, 2_100_000, budgetPerLevel);
    // No sell should be placed above the highest grid level
    const sells = actions.filter((a) => a.type === "place" && a.side === "sell");
    expect(sells.length).toBe(0);
  });

  it("should not place buy below lowest level (edge case)", () => {
    const fills: FillEvent[] = [
      { orderId: 2, side: "sell", price: levels[0].price, amount: 0.005, gridLevel: 0, timestamp: 1 },
    ];
    const actions = reconcileOrders(levels, [], fills, 2_000_000, budgetPerLevel);
    const buys = actions.filter((a) => a.type === "place" && a.side === "buy");
    // No buy below level 0
    const buysBelowZero = buys.filter((a) => a.type === "place" && a.gridLevel < 0);
    expect(buysBelowZero.length).toBe(0);
  });

  it("should handle all buys filled scenario", () => {
    const fills: FillEvent[] = levels
      .filter((l) => l.price < 2_060_000)
      .map((l, i) => ({
        orderId: i + 1,
        side: "buy" as const,
        price: l.price,
        amount: 0.005,
        gridLevel: l.index,
        timestamp: i,
      }));

    const actions = reconcileOrders(levels, [], fills, 2_000_000, budgetPerLevel);
    const sells = actions.filter((a) => a.type === "place" && a.side === "sell");
    // Each buy fill should produce a sell at the next level up
    expect(sells.length).toBeGreaterThan(0);
  });

  it("should handle empty state (no orders, no fills)", () => {
    const actions = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel);
    // Should produce initial grid
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.type === "place")).toBe(true);
  });
});

// ─── validateGridConfig ───────────────────────────────────────────────────────

describe("validateGridConfig", () => {
  const validConfig: GridConfig = {
    lowerPrice: 2_000_000,
    upperPrice: 2_500_000,
    levels: 10,
    budgetQuote: 50_000,
    pair: "BTC_CZK",
  };

  it("should accept valid config", () => {
    const result = validateGridConfig(validConfig, 2_250_000);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject when upper <= lower", () => {
    const config = { ...validConfig, upperPrice: 1_999_000 };
    const result = validateGridConfig(config, 2_000_000);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Upper price"))).toBe(true);
  });

  it("should reject when levels < 3", () => {
    const config = { ...validConfig, levels: 2 };
    const result = validateGridConfig(config, 2_250_000);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Minimum 3"))).toBe(true);
  });

  it("should reject spacing below fee threshold", () => {
    // Very tight grid: 100 levels in 1% range → spacing ≈ 0.01%
    const config: GridConfig = {
      lowerPrice: 2_400_000,
      upperPrice: 2_424_000, // only 1% range
      levels: 100,
      budgetQuote: 50_000,
      pair: "BTC_CZK",
    };
    const result = validateGridConfig(config, 2_412_000);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("spacing"))).toBe(true);
  });

  it("should reject insufficient budget per level", () => {
    const config = { ...validConfig, budgetQuote: 100 }; // only 100 CZK for 10 levels
    const result = validateGridConfig(config, 2_250_000);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Budget per level"))).toBe(true);
  });

  it("should warn when current price is outside range", () => {
    const result = validateGridConfig(validConfig, 3_000_000);
    expect(result.warnings.some((w) => w.includes("outside"))).toBe(true);
  });

  it("should compute correct metrics", () => {
    const result = validateGridConfig(validConfig, 2_250_000);
    expect(result.metrics.spacingCzk).toBeCloseTo(500_000 / 9);
    expect(result.metrics.spacingPercent).toBeGreaterThan(2);
    expect(result.metrics.budgetPerLevel).toBeGreaterThan(0);
    expect(result.metrics.minProfitPerTrade).toBeGreaterThan(0);
  });
});

// ─── computePnL ───────────────────────────────────────────────────────────────

describe("computePnL", () => {
  it("should compute profit from a simple buy-sell cycle", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
      { orderId: 2, side: "sell", price: 2_050_000, amount: 0.01, gridLevel: 1, timestamp: 2 },
    ];

    const result = computePnL(fills, 0.004); // 0.4% maker fee
    expect(result.completedCycles).toBe(1);
    expect(result.grossProfit).toBe(500); // 50000 CZK * 0.01 BTC = 500 CZK
    expect(result.totalFees).toBeGreaterThan(0);
    expect(result.realizedPnl).toBeLessThan(result.grossProfit); // fees eat into profit
    expect(result.realizedPnl).toBeGreaterThan(0); // but still profitable
  });

  it("should handle multiple cycles", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
      { orderId: 2, side: "sell", price: 2_050_000, amount: 0.01, gridLevel: 1, timestamp: 2 },
      { orderId: 3, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 3 },
      { orderId: 4, side: "sell", price: 2_050_000, amount: 0.01, gridLevel: 1, timestamp: 4 },
    ];

    const result = computePnL(fills, 0.004);
    expect(result.completedCycles).toBe(2);
    expect(result.realizedPnl).toBeGreaterThan(0);
  });

  it("should handle unmatched fills (more buys than sells)", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
      { orderId: 2, side: "buy", price: 1_950_000, amount: 0.01, gridLevel: 0, timestamp: 2 },
      { orderId: 3, side: "sell", price: 2_050_000, amount: 0.01, gridLevel: 1, timestamp: 3 },
    ];

    const result = computePnL(fills, 0.004);
    expect(result.completedCycles).toBe(1);
    // Only first buy matched with sell
  });

  it("should return zero for empty fills", () => {
    const result = computePnL([], 0.004);
    expect(result.completedCycles).toBe(0);
    expect(result.realizedPnl).toBe(0);
    expect(result.totalFees).toBe(0);
  });

  it("should show loss when fees exceed profit", () => {
    // Very tight grid: profit smaller than fees
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
      { orderId: 2, side: "sell", price: 2_001_000, amount: 0.01, gridLevel: 1, timestamp: 2 },
    ];

    const result = computePnL(fills, 0.006); // taker fee
    expect(result.grossProfit).toBe(10); // 1000 CZK * 0.01 = 10 CZK
    // Fees: buy side = 20000*0.006=120, sell side = 20010*0.006≈120.06, total ≈ 240
    expect(result.realizedPnl).toBeLessThan(0);
  });
});

// ─── matchOrdersToGrid ────────────────────────────────────────────────────────

describe("matchOrdersToGrid", () => {
  const levels: GridLevel[] = [
    { index: 0, price: 2_000_000 },
    { index: 1, price: 2_050_000 },
    { index: 2, price: 2_100_000 },
  ];

  it("should match exact prices to grid levels", () => {
    const orders = [{ id: 1, type: "BUY" as const, price: 2_000_000, amount: 0.01 }];
    const matched = matchOrdersToGrid(orders, levels);
    expect(matched[0].gridLevel).toBe(0);
  });

  it("should match approximate prices within tolerance", () => {
    // Price 0.3% off from level 1 (2_050_000)
    const orders = [{ id: 1, type: "SELL" as const, price: 2_056_000, amount: 0.01 }];
    const matched = matchOrdersToGrid(orders, levels, 0.5);
    // 2056000 is about 0.29% from 2050000, within 0.5% tolerance
    expect(matched[0].gridLevel).toBe(1);
  });

  it("should mark orphaned orders with gridLevel -1", () => {
    const orders = [{ id: 1, type: "BUY" as const, price: 1_800_000, amount: 0.01 }];
    const matched = matchOrdersToGrid(orders, levels);
    expect(matched[0].gridLevel).toBe(-1);
  });

  it("should convert BUY/SELL types to lowercase", () => {
    const orders = [
      { id: 1, type: "BUY" as const, price: 2_000_000, amount: 0.01 },
      { id: 2, type: "SELL" as const, price: 2_100_000, amount: 0.01 },
    ];
    const matched = matchOrdersToGrid(orders, levels);
    expect(matched[0].side).toBe("buy");
    expect(matched[1].side).toBe("sell");
  });
});

// ─── getCounterOrderLevel ─────────────────────────────────────────────────────

describe("getCounterOrderLevel", () => {
  const levels: GridLevel[] = [
    { index: 0, price: 2_000_000 },
    { index: 1, price: 2_100_000 },
    { index: 2, price: 2_200_000 },
    { index: 3, price: 2_300_000 },
    { index: 4, price: 2_400_000 },
  ];

  it("should return next level up after a buy fill", () => {
    const result = getCounterOrderLevel("buy", 1, levels);
    expect(result).toEqual({ index: 2, price: 2_200_000 });
  });

  it("should return next level down after a sell fill", () => {
    const result = getCounterOrderLevel("sell", 3, levels);
    expect(result).toEqual({ index: 2, price: 2_200_000 });
  });

  it("should return undefined for buy fill at top level", () => {
    const result = getCounterOrderLevel("buy", 4, levels);
    expect(result).toBeUndefined();
  });

  it("should return undefined for sell fill at bottom level", () => {
    const result = getCounterOrderLevel("sell", 0, levels);
    expect(result).toBeUndefined();
  });
});

// ─── roundAmount ──────────────────────────────────────────────────────────────

describe("roundAmount", () => {
  it("rounds to 8 decimal places by default (no pair)", () => {
    expect(roundAmount(0.123456789012)).toBe(0.12345679);
  });

  it("returns exact value when already at 8 decimals", () => {
    expect(roundAmount(0.00100000)).toBe(0.001);
  });

  describe("with pair-specific precision", () => {
    it("floors BTC_CZK amounts to 8 decimal places", () => {
      // floor: 0.00123456789 → 0.00123456
      expect(roundAmount(0.00123456789, "BTC_CZK")).toBe(0.00123456);
    });

    it("returns 0 when BTC_CZK amount is below minimum (0.0002)", () => {
      expect(roundAmount(0.00019999, "BTC_CZK")).toBe(0);
    });

    it("returns the amount when BTC_CZK amount is exactly at minimum", () => {
      expect(roundAmount(0.0002, "BTC_CZK")).toBe(0.0002);
    });

    it("floors XRP_CZK amounts to 6 decimal places", () => {
      expect(roundAmount(1.12345678, "XRP_CZK")).toBe(1.123456);
    });

    it("returns 0 when XRP_CZK amount is below minimum (1)", () => {
      expect(roundAmount(0.999999, "XRP_CZK")).toBe(0);
    });

    it("floors (never rounds up) to avoid exceeding balance", () => {
      // Due to floating-point: 0.00029999 * 1e8 = 29998.999..., floor → 29998 → 0.00029998
      expect(roundAmount(0.00029999, "BTC_CZK")).toBe(0.00029998);
      // 0.000200005 * 1e8 = 20000.5, floor → 20000 → 0.0002
      expect(roundAmount(0.000200005, "BTC_CZK")).toBe(0.0002);
    });

    it("uses fallback limits for unknown pair", () => {
      // Unknown pair → fallback: minOrderSize=0.0002, basePrecision=8
      // 0.0003 * 1e8 = 29999.999..., floor → 29999 → 0.00029999
      expect(roundAmount(0.0003, "UNKNOWN_PAIR")).toBe(0.00029999);
      expect(roundAmount(0.0001, "UNKNOWN_PAIR")).toBe(0);
    });
  });
});

// ─── computeUnrealizedPnl ─────────────────────────────────────────────────────

describe("computeUnrealizedPnl", () => {
  it("returns 0 when there are no fills", () => {
    expect(computeUnrealizedPnl([], 2_000_000)).toBe(0);
  });

  it("returns 0 when all buys are matched by sells", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
      { orderId: 2, side: "sell", price: 2_050_000, amount: 0.01, gridLevel: 1, timestamp: 2 },
    ];
    expect(computeUnrealizedPnl(fills, 2_100_000)).toBe(0);
  });

  it("computes positive unrealized P&L when price is above buy price", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
    ];
    // Unrealized = (2_100_000 - 2_000_000) * 0.01 = 1000
    expect(computeUnrealizedPnl(fills, 2_100_000)).toBe(1000);
  });

  it("computes negative unrealized P&L when price is below buy price", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
    ];
    // Unrealized = (1_900_000 - 2_000_000) * 0.01 = -1000
    expect(computeUnrealizedPnl(fills, 1_900_000)).toBe(-1000);
  });

  it("handles partial sell — only unmatched buy quantity remains", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.02, gridLevel: 0, timestamp: 1 },
      { orderId: 2, side: "sell", price: 2_050_000, amount: 0.01, gridLevel: 1, timestamp: 2 },
    ];
    // 0.01 BTC remaining at buy price 2_000_000
    // Unrealized = (2_100_000 - 2_000_000) * 0.01 = 1000
    expect(computeUnrealizedPnl(fills, 2_100_000)).toBe(1000);
  });

  it("handles multiple unmatched buys at different prices (FIFO)", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
      { orderId: 2, side: "buy", price: 1_950_000, amount: 0.01, gridLevel: 1, timestamp: 2 },
    ];
    // Both buys unmatched
    // Unrealized = (2_100_000 - 2_000_000) * 0.01 + (2_100_000 - 1_950_000) * 0.01
    //            = 1000 + 1500 = 2500
    expect(computeUnrealizedPnl(fills, 2_100_000)).toBe(2500);
  });

  it("FIFO: sells consume earliest buys first", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "buy", price: 2_000_000, amount: 0.01, gridLevel: 0, timestamp: 1 },
      { orderId: 2, side: "buy", price: 1_900_000, amount: 0.01, gridLevel: 1, timestamp: 2 },
      { orderId: 3, side: "sell", price: 2_050_000, amount: 0.01, gridLevel: 2, timestamp: 3 },
    ];
    // FIFO: sell consumes first buy (2_000_000). Second buy (1_900_000) remains.
    // Unrealized = (2_100_000 - 1_900_000) * 0.01 = 2000
    expect(computeUnrealizedPnl(fills, 2_100_000)).toBe(2000);
  });

  it("returns 0 when there are only sells (no buys)", () => {
    const fills: FillEvent[] = [
      { orderId: 1, side: "sell", price: 2_050_000, amount: 0.01, gridLevel: 1, timestamp: 1 },
    ];
    expect(computeUnrealizedPnl(fills, 2_000_000)).toBe(0);
  });
});

// ─── reconcileOrders: fee-adjusted sells ──────────────────────────────────────

describe("reconcileOrders fee-adjusted sells", () => {
  const config: GridConfig = {
    lowerPrice: 2_000_000,
    upperPrice: 2_100_000,
    levels: 6,
    budgetQuote: 30_000,
    pair: "BTC_CZK",
  };
  const levels = calculateGridLevels(config);
  const budgetPerLevel = config.budgetQuote / Math.ceil(config.levels / 2);

  it("sells are reduced by the fee rate", () => {
    const actions = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
    });

    const buys = actions.filter((a) => a.type === "place" && a.side === "buy");
    const sells = actions.filter((a) => a.type === "place" && a.side === "sell");

    expect(buys.length).toBeGreaterThan(0);
    expect(sells.length).toBeGreaterThan(0);

    // For the same budget, sell amounts should be (1 - 0.004) = 0.996x of equivalent buy amounts
    for (const sell of sells) {
      if (sell.type !== "place") continue;
      const rawAmount = budgetPerLevel / sell.price;
      const expectedAmount = roundAmount(rawAmount * (1 - 0.004));
      expect(sell.amount).toBe(expectedAmount);
    }
  });

  it("sell amounts differ with different fee rates", () => {
    const actions004 = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
    });
    const actions006 = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.006,
    });

    const sells004 = actions004.filter((a) => a.type === "place" && a.side === "sell");
    const sells006 = actions006.filter((a) => a.type === "place" && a.side === "sell");

    // Higher fee → smaller sell amount
    for (let i = 0; i < sells004.length; i++) {
      const s004 = sells004[i];
      const s006 = sells006[i];
      if (s004.type === "place" && s006.type === "place") {
        expect(s004.amount).toBeGreaterThan(s006.amount);
      }
    }
  });

  it("uses default maker fee when feeRate not specified", () => {
    const actions = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel);

    const sells = actions.filter((a) => a.type === "place" && a.side === "sell");
    // Default fee is COINMATE_FEES.maker = 0.004
    for (const sell of sells) {
      if (sell.type !== "place") continue;
      const rawAmount = budgetPerLevel / sell.price;
      const expectedAmount = roundAmount(rawAmount * (1 - 0.004));
      expect(sell.amount).toBe(expectedAmount);
    }
  });

  it("buy amounts are NOT fee-adjusted", () => {
    const actions = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
    });

    const buys = actions.filter((a) => a.type === "place" && a.side === "buy");
    for (const buy of buys) {
      if (buy.type !== "place") continue;
      const rawAmount = budgetPerLevel / buy.price;
      const expectedAmount = roundAmount(rawAmount);
      expect(buy.amount).toBe(expectedAmount);
    }
  });
});

// ─── reconcileOrders: availableBase constraint ────────────────────────────────

describe("reconcileOrders availableBase constraint", () => {
  const config: GridConfig = {
    lowerPrice: 2_000_000,
    upperPrice: 2_100_000,
    levels: 6,
    budgetQuote: 30_000,
    pair: "BTC_CZK",
  };
  const levels = calculateGridLevels(config);
  const budgetPerLevel = config.budgetQuote / Math.ceil(config.levels / 2);

  it("caps sell orders when availableBase is insufficient", () => {
    // With no constraint, expect 3 sells (levels above 2_050_000)
    const unconstrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
    });
    const uncSells = unconstrained.filter((a) => a.type === "place" && a.side === "sell");
    expect(uncSells.length).toBe(3);

    // Provide only enough base for ~1 sell
    const firstSellAmount = uncSells[0].type === "place" ? uncSells[0].amount : 0;
    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
      availableBase: firstSellAmount,
    });
    const conSells = constrained.filter((a) => a.type === "place" && a.side === "sell");

    // Should only place 1 sell (the first one), skip the rest
    expect(conSells.length).toBe(1);
    expect(conSells[0].type === "place" && conSells[0].amount).toBe(firstSellAmount);
  });

  it("places no sells when availableBase is 0", () => {
    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
      availableBase: 0,
    });
    const sells = constrained.filter((a) => a.type === "place" && a.side === "sell");
    expect(sells.length).toBe(0);
  });

  it("places all sells when availableBase is undefined (legacy mode)", () => {
    const actions = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
    });
    const sells = actions.filter((a) => a.type === "place" && a.side === "sell");
    expect(sells.length).toBe(3);
  });

  it("does not affect buy orders regardless of availableBase", () => {
    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
      availableBase: 0,
    });
    const buys = constrained.filter((a) => a.type === "place" && a.side === "buy");
    // Should still place all buy orders below price
    expect(buys.length).toBe(3);
  });

  it("decrements remaining base across multiple sells", () => {
    // Provide exactly enough for 2 of the 3 sells
    const unconstrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
    });
    const uncSells = unconstrained.filter((a) => a.type === "place" && a.side === "sell");

    let firstTwoTotal = 0;
    for (let i = 0; i < 2 && i < uncSells.length; i++) {
      if (uncSells[i].type === "place") firstTwoTotal += uncSells[i].amount;
    }

    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
      availableBase: firstTwoTotal,
    });
    const conSells = constrained.filter((a) => a.type === "place" && a.side === "sell");
    expect(conSells.length).toBe(2);
  });
});

// ─── reconcileOrders: availableQuote constraint (#12) ──────────────────────────

describe("reconcileOrders availableQuote constraint", () => {
  const config: GridConfig = {
    lowerPrice: 2_000_000,
    upperPrice: 2_100_000,
    levels: 6,
    budgetQuote: 30_000,
    pair: "BTC_CZK",
  };
  const levels = calculateGridLevels(config);
  const budgetPerLevel = config.budgetQuote / Math.ceil(config.levels / 2);

  it("caps buy orders when availableQuote is insufficient", () => {
    // With no constraint, expect 3 buys (levels below 2_050_000)
    const unconstrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
    });
    const uncBuys = unconstrained.filter((a) => a.type === "place" && a.side === "buy");
    expect(uncBuys.length).toBe(3);

    // Provide only enough quote for ~1 buy (including fee reservation)
    const feeRate = 0.004;
    const firstBuyCost =
      uncBuys[0].type === "place" ? uncBuys[0].amount * uncBuys[0].price * (1 + feeRate) : 0;
    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate,
      availableQuote: firstBuyCost,
    });
    const conBuys = constrained.filter((a) => a.type === "place" && a.side === "buy");

    // Should only place 1 buy, prioritizing the nearest level below market.
    expect(conBuys.length).toBe(1);
    expect(conBuys[0].type === "place" ? conBuys[0].price : 0).toBe(2_040_000);
  });

  it("places no buys when availableQuote is 0", () => {
    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
      availableQuote: 0,
    });
    const buys = constrained.filter((a) => a.type === "place" && a.side === "buy");
    expect(buys.length).toBe(0);
  });

  it("places all buys when availableQuote is undefined (legacy mode)", () => {
    const actions = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
    });
    const buys = actions.filter((a) => a.type === "place" && a.side === "buy");
    expect(buys.length).toBe(3);
  });

  it("does not affect sell orders regardless of availableQuote", () => {
    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate: 0.004,
      availableQuote: 0,
    });
    const sells = constrained.filter((a) => a.type === "place" && a.side === "sell");
    // Should still place all sell orders above price
    expect(sells.length).toBe(3);
  });

  it("decrements remaining quote across multiple buys", () => {
    // Provide exactly enough for 2 of the 3 buys (including fee reservation)
    const feeRate = 0.004;
    const unconstrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate,
    });
    const uncBuys = unconstrained.filter((a) => a.type === "place" && a.side === "buy");

    let firstTwoCost = 0;
    for (let i = 0; i < 2 && i < uncBuys.length; i++) {
      if (uncBuys[i].type === "place")
        firstTwoCost += uncBuys[i].amount * uncBuys[i].price * (1 + feeRate);
    }

    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate,
      availableQuote: firstTwoCost,
    });
    const conBuys = constrained.filter((a) => a.type === "place" && a.side === "buy");
    expect(conBuys.length).toBe(2);
    expect(conBuys[0].type === "place" ? conBuys[0].price : 0).toBe(2_040_000);
  });

  it("prioritizes nearest buy levels below market when quote is constrained", () => {
    const feeRate = 0.004;
    const unconstrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate,
    });
    const uncBuys = unconstrained.filter((a) => a.type === "place" && a.side === "buy");
    const firstBuyCost =
      uncBuys[0].type === "place" ? uncBuys[0].amount * uncBuys[0].price * (1 + feeRate) : 0;
    const constrained = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      feeRate,
      availableQuote: firstBuyCost,
    });
    const conBuys = constrained.filter((a) => a.type === "place" && a.side === "buy");

    expect(conBuys.length).toBe(1);
    expect(conBuys[0].type === "place" ? conBuys[0].gridLevel : -1).toBe(2);
    expect(conBuys[0].type === "place" ? conBuys[0].price : 0).toBe(2_040_000);
  });
});

// ─── reconcileOrders: pair-specific precision ─────────────────────────────────

describe("reconcileOrders with pair-specific precision", () => {
  it("uses pair precision when pair is specified in options", () => {
    const config: GridConfig = {
      lowerPrice: 2_000_000,
      upperPrice: 2_100_000,
      levels: 6,
      budgetQuote: 30_000,
      pair: "BTC_CZK",
    };
    const levels = calculateGridLevels(config);
    const budgetPerLevel = config.budgetQuote / Math.ceil(config.levels / 2);

    const actions = reconcileOrders(levels, [], [], 2_050_000, budgetPerLevel, {
      pair: "BTC_CZK",
    });

    const places = actions.filter((a) => a.type === "place");
    for (const action of places) {
      if (action.type !== "place") continue;
      // BTC_CZK precision = 8 decimal places. Verify amount fits.
      const str = action.amount.toString();
      const decimalPart = str.split(".")[1] || "";
      expect(decimalPart.length).toBeLessThanOrEqual(8);
      // Must be >= 0.0002 minimum or 0 (skipped)
      if (action.amount > 0) {
        expect(action.amount).toBeGreaterThanOrEqual(0.0002);
      }
    }
  });

  it("skips orders below pair minimum order size", () => {
    // Use XRP_CZK which has minOrderSize=1 — with a tiny budget, amounts may fall below
    const config: GridConfig = {
      lowerPrice: 10,
      upperPrice: 20,
      levels: 6,
      budgetQuote: 5, // tiny budget → amount per level = 5/3 ≈ 1.67 CZK → 1.67/price ≈ 0.1 XRP
      pair: "XRP_CZK",
    };
    const levels = calculateGridLevels(config);
    const budgetPerLevel = config.budgetQuote / Math.ceil(config.levels / 2);

    const actions = reconcileOrders(levels, [], [], 15, budgetPerLevel, {
      pair: "XRP_CZK",
    });

    const places = actions.filter((a) => a.type === "place");
    // All amounts should be 0 (below XRP min of 1) → no orders placed
    expect(places.length).toBe(0);
  });
});
