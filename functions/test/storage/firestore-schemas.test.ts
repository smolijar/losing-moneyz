import { describe, it, expect } from "vitest";
import {
  ExperimentDocSchema,
  OrderRecordDocSchema,
  ExperimentSnapshotDocSchema,
  WalletStateDocSchema,
} from "../../src/config";

/** Fake Firestore Timestamp (has toDate()) */
function fakeTimestamp(date: Date) {
  return { toDate: () => date };
}

describe("Firestore document schemas", () => {
  describe("ExperimentDocSchema", () => {
    const validData = {
      status: "active",
      gridConfig: {
        upperPrice: 2500000,
        lowerPrice: 2000000,
        levels: 10,
        budgetQuote: 50000,
        pair: "BTC_CZK",
      },
      allocatedQuote: 50000,
      allocatedBase: 0.01,
      consecutiveFailures: 2,
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-02"),
    };

    it("should parse valid experiment data with Date objects", () => {
      const result = ExperimentDocSchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("active");
        expect(result.data.gridConfig.pair).toBe("BTC_CZK");
        expect(result.data.allocatedQuote).toBe(50000);
        expect(result.data.consecutiveFailures).toBe(2);
        expect(result.data.createdAt).toBeInstanceOf(Date);
      }
    });

    it("should parse experiment with Firestore Timestamps", () => {
      const data = {
        ...validData,
        createdAt: fakeTimestamp(new Date("2025-01-01")),
        updatedAt: fakeTimestamp(new Date("2025-01-02")),
      };
      const result = ExperimentDocSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.createdAt).toEqual(new Date("2025-01-01"));
        expect(result.data.updatedAt).toEqual(new Date("2025-01-02"));
      }
    });

    it("should parse experiment with ISO string dates", () => {
      const data = {
        ...validData,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
      };
      const result = ExperimentDocSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.createdAt).toEqual(new Date("2025-01-01"));
      }
    });

    it("should default consecutiveFailures to 0 when missing", () => {
      const dataWithout = {
        status: validData.status,
        gridConfig: validData.gridConfig,
        allocatedQuote: validData.allocatedQuote,
        allocatedBase: validData.allocatedBase,
        createdAt: validData.createdAt,
        updatedAt: validData.updatedAt,
      };
      const result = ExperimentDocSchema.safeParse(dataWithout);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.consecutiveFailures).toBe(0);
      }
    });

    it("should reject invalid experiment status", () => {
      const data = { ...validData, status: "unknown" };
      const result = ExperimentDocSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("should reject missing gridConfig", () => {
      const dataWithout = {
        status: validData.status,
        allocatedQuote: validData.allocatedQuote,
        allocatedBase: validData.allocatedBase,
        consecutiveFailures: validData.consecutiveFailures,
        createdAt: validData.createdAt,
        updatedAt: validData.updatedAt,
      };
      const result = ExperimentDocSchema.safeParse(dataWithout);
      expect(result.success).toBe(false);
    });

    it("should reject invalid gridConfig levels", () => {
      const data = {
        ...validData,
        gridConfig: { ...validData.gridConfig, levels: 1 },
      };
      const result = ExperimentDocSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe("OrderRecordDocSchema", () => {
    const validData = {
      coinmateOrderId: "12345",
      side: "buy",
      price: 2400000,
      amount: 0.001,
      status: "open",
      gridLevel: 3,
      createdAt: new Date("2025-01-01"),
    };

    it("should parse valid order data", () => {
      const result = OrderRecordDocSchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.coinmateOrderId).toBe("12345");
        expect(result.data.side).toBe("buy");
        expect(result.data.status).toBe("open");
      }
    });

    it("should coerce numeric coinmateOrderId to string", () => {
      const data = { ...validData, coinmateOrderId: 67890 };
      const result = OrderRecordDocSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.coinmateOrderId).toBe("67890");
      }
    });

    it("should parse order with filledAt date", () => {
      const data = { ...validData, status: "filled", filledAt: new Date("2025-01-02") };
      const result = OrderRecordDocSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filledAt).toEqual(new Date("2025-01-02"));
      }
    });

    it("should parse order without filledAt", () => {
      const result = OrderRecordDocSchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.filledAt).toBeUndefined();
      }
    });

    it("should parse order with Firestore Timestamp dates", () => {
      const data = {
        ...validData,
        createdAt: fakeTimestamp(new Date("2025-01-01")),
        filledAt: fakeTimestamp(new Date("2025-01-02")),
      };
      const result = OrderRecordDocSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.createdAt).toEqual(new Date("2025-01-01"));
        expect(result.data.filledAt).toEqual(new Date("2025-01-02"));
      }
    });

    it("should reject invalid order side", () => {
      const data = { ...validData, side: "swap" };
      const result = OrderRecordDocSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("should reject invalid order status", () => {
      const data = { ...validData, status: "pending" };
      const result = OrderRecordDocSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe("ExperimentSnapshotDocSchema", () => {
    const validData = {
      timestamp: new Date("2025-01-01"),
      balanceQuote: 45000,
      balanceBase: 0.02,
      openOrders: 8,
      unrealizedPnl: -500,
      realizedPnl: 200,
      currentPrice: 2400000,
    };

    it("should parse valid snapshot data", () => {
      const result = ExperimentSnapshotDocSchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timestamp).toEqual(new Date("2025-01-01"));
        expect(result.data.openOrders).toBe(8);
        expect(result.data.unrealizedPnl).toBe(-500);
      }
    });

    it("should parse snapshot with Firestore Timestamp", () => {
      const data = {
        ...validData,
        timestamp: fakeTimestamp(new Date("2025-01-01")),
      };
      const result = ExperimentSnapshotDocSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timestamp).toEqual(new Date("2025-01-01"));
      }
    });

    it("should reject missing required field", () => {
      const dataWithout = {
        timestamp: validData.timestamp,
        balanceQuote: validData.balanceQuote,
        balanceBase: validData.balanceBase,
        openOrders: validData.openOrders,
        unrealizedPnl: validData.unrealizedPnl,
        realizedPnl: validData.realizedPnl,
      };
      const result = ExperimentSnapshotDocSchema.safeParse(dataWithout);
      expect(result.success).toBe(false);
    });
  });

  describe("WalletStateDocSchema", () => {
    const validData = {
      totalAllocatedQuote: 50000,
      totalAllocatedBase: 0.01,
      availableQuote: 150000,
      availableBase: 0.09,
    };

    it("should parse valid wallet state", () => {
      const result = WalletStateDocSchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalAllocatedQuote).toBe(50000);
        expect(result.data.availableBase).toBe(0.09);
      }
    });

    it("should reject missing field", () => {
      const dataWithout = {
        totalAllocatedQuote: validData.totalAllocatedQuote,
        totalAllocatedBase: validData.totalAllocatedBase,
        availableBase: validData.availableBase,
      };
      const result = WalletStateDocSchema.safeParse(dataWithout);
      expect(result.success).toBe(false);
    });

    it("should reject non-numeric field", () => {
      const data = { ...validData, totalAllocatedQuote: "not a number" };
      const result = WalletStateDocSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });
});
