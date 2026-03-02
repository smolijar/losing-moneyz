import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRepository } from "./in-memory-repository";
import type { GridConfig } from "../../src/config";

describe("InMemoryRepository", () => {
  let repo: InMemoryRepository;

  beforeEach(() => {
    repo = new InMemoryRepository();
  });

  // ─── Experiments ──────────────────────────────────────────────────────

  describe("experiments", () => {
    const gridConfig: GridConfig = {
      pair: "BTC_CZK",
      lowerPrice: 2_000_000,
      upperPrice: 2_400_000,
      levels: 5,
      budgetQuote: 100_000,
    };

    it("creates and retrieves an experiment", async () => {
      const id = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      const exp = await repo.getExperiment(id);
      expect(exp).toBeDefined();
      expect(exp!.id).toBe(id);
      expect(exp!.status).toBe("active");
      expect(exp!.gridConfig).toEqual(gridConfig);
      expect(exp!.createdAt).toBeInstanceOf(Date);
      expect(exp!.updatedAt).toBeInstanceOf(Date);
    });

    it("returns undefined for non-existent experiment", async () => {
      const exp = await repo.getExperiment("nonexistent");
      expect(exp).toBeUndefined();
    });

    it("filters experiments by status", async () => {
      await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });
      await repo.createExperiment({
        status: "paused",
        gridConfig,
        allocatedQuote: 50_000,
        allocatedBase: 0,
      });
      await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 75_000,
        allocatedBase: 0,
      });

      const active = await repo.getExperimentsByStatus("active");
      expect(active).toHaveLength(2);

      const paused = await repo.getExperimentsByStatus("paused");
      expect(paused).toHaveLength(1);

      const stopped = await repo.getExperimentsByStatus("stopped");
      expect(stopped).toHaveLength(0);
    });

    it("updates experiment status", async () => {
      const id = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      await repo.updateExperimentStatus(id, "paused");
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");
    });

    it("updates experiment fields", async () => {
      const id = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      await repo.updateExperiment(id, { allocatedQuote: 50_000 });
      const exp = await repo.getExperiment(id);
      expect(exp!.allocatedQuote).toBe(50_000);
    });

    it("throws on updating non-existent experiment", async () => {
      await expect(repo.updateExperimentStatus("bad-id", "stopped")).rejects.toThrow();
    });
  });

  // ─── Orders ───────────────────────────────────────────────────────────

  describe("orders", () => {
    let experimentId: string;

    beforeEach(async () => {
      experimentId = await repo.createExperiment({
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
      });
    });

    it("creates and retrieves orders", async () => {
      const orderId = await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-123",
        side: "buy",
        price: 2_000_000,
        amount: 0.005,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });

      const orders = await repo.getOrders(experimentId);
      expect(orders).toHaveLength(1);
      expect(orders[0].id).toBe(orderId);
      expect(orders[0].coinmateOrderId).toBe("CM-123");
    });

    it("returns empty array for experiment with no orders", async () => {
      const orders = await repo.getOrders(experimentId);
      expect(orders).toHaveLength(0);
    });

    it("filters orders by status", async () => {
      await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-1",
        side: "buy",
        price: 2_000_000,
        amount: 0.005,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });
      await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-2",
        side: "sell",
        price: 2_100_000,
        amount: 0.005,
        status: "filled",
        gridLevel: 1,
        createdAt: new Date(),
        filledAt: new Date(),
      });

      const open = await repo.getOrdersByStatus(experimentId, "open");
      expect(open).toHaveLength(1);
      expect(open[0].coinmateOrderId).toBe("CM-1");

      const filled = await repo.getOrdersByStatus(experimentId, "filled");
      expect(filled).toHaveLength(1);
      expect(filled[0].coinmateOrderId).toBe("CM-2");
    });

    it("batch creates orders", async () => {
      const ids = await repo.createOrders(experimentId, [
        {
          coinmateOrderId: "CM-A",
          side: "buy",
          price: 2_000_000,
          amount: 0.005,
          status: "open",
          gridLevel: 0,
          createdAt: new Date(),
        },
        {
          coinmateOrderId: "CM-B",
          side: "buy",
          price: 2_100_000,
          amount: 0.005,
          status: "open",
          gridLevel: 1,
          createdAt: new Date(),
        },
        {
          coinmateOrderId: "CM-C",
          side: "sell",
          price: 2_300_000,
          amount: 0.005,
          status: "open",
          gridLevel: 3,
          createdAt: new Date(),
        },
      ]);

      expect(ids).toHaveLength(3);

      const orders = await repo.getOrders(experimentId);
      expect(orders).toHaveLength(3);
    });

    it("updates order status to filled", async () => {
      const orderId = await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-1",
        side: "buy",
        price: 2_000_000,
        amount: 0.005,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });

      const filledAt = new Date();
      await repo.updateOrderStatus(experimentId, orderId, "filled", filledAt);

      const orders = await repo.getOrders(experimentId);
      expect(orders[0].status).toBe("filled");
      expect(orders[0].filledAt).toEqual(filledAt);
    });

    it("finds an order by coinmate ID", async () => {
      await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-100",
        side: "buy",
        price: 2_000_000,
        amount: 0.005,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });
      await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-200",
        side: "sell",
        price: 2_100_000,
        amount: 0.005,
        status: "open",
        gridLevel: 1,
        createdAt: new Date(),
      });

      const found = await repo.getOrderByCoinmateId(experimentId, "CM-200");
      expect(found).toBeDefined();
      expect(found!.coinmateOrderId).toBe("CM-200");
      expect(found!.side).toBe("sell");
    });

    it("returns undefined when coinmate ID not found", async () => {
      const found = await repo.getOrderByCoinmateId(experimentId, "CM-NONEXISTENT");
      expect(found).toBeUndefined();
    });
  });

  // ─── Snapshots ────────────────────────────────────────────────────────

  describe("snapshots", () => {
    let experimentId: string;

    beforeEach(async () => {
      experimentId = await repo.createExperiment({
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
      });
    });

    it("saves and retrieves latest snapshot", async () => {
      const snap1 = {
        timestamp: new Date("2025-01-01T00:00:00Z"),
        balanceQuote: 90_000,
        balanceBase: 0.005,
        openOrders: 4,
        unrealizedPnl: -500,
        realizedPnl: 0,
        currentPrice: 2_200_000,
      };
      const snap2 = {
        timestamp: new Date("2025-01-01T01:00:00Z"),
        balanceQuote: 91_000,
        balanceBase: 0.004,
        openOrders: 4,
        unrealizedPnl: -200,
        realizedPnl: 300,
        currentPrice: 2_250_000,
      };

      await repo.saveSnapshot(experimentId, snap1);
      await repo.saveSnapshot(experimentId, snap2);

      const latest = await repo.getLatestSnapshot(experimentId);
      expect(latest).toBeDefined();
      expect(latest!.timestamp).toEqual(snap2.timestamp);
      expect(latest!.realizedPnl).toBe(300);
    });

    it("returns undefined when no snapshots exist", async () => {
      const latest = await repo.getLatestSnapshot(experimentId);
      expect(latest).toBeUndefined();
    });

    it("prunes old snapshots keeping only the most recent N", async () => {
      for (let i = 0; i < 5; i++) {
        await repo.saveSnapshot(experimentId, {
          timestamp: new Date(`2025-01-0${i + 1}T00:00:00Z`),
          balanceQuote: 90_000,
          balanceBase: 0.005,
          openOrders: 4,
          unrealizedPnl: 0,
          realizedPnl: 0,
          currentPrice: 2_200_000,
        });
      }

      const deleted = await repo.pruneSnapshots(experimentId, 2);
      expect(deleted).toBe(3);

      // Latest should still be the most recent one
      const latest = await repo.getLatestSnapshot(experimentId);
      expect(latest!.timestamp).toEqual(new Date("2025-01-05T00:00:00Z"));
    });

    it("prune returns 0 when fewer snapshots than keep", async () => {
      await repo.saveSnapshot(experimentId, {
        timestamp: new Date("2025-01-01T00:00:00Z"),
        balanceQuote: 90_000,
        balanceBase: 0.005,
        openOrders: 4,
        unrealizedPnl: 0,
        realizedPnl: 0,
        currentPrice: 2_200_000,
      });

      const deleted = await repo.pruneSnapshots(experimentId, 5);
      expect(deleted).toBe(0);
    });
  });

  // ─── Order pruning ─────────────────────────────────────────────────────

  describe("pruneOldOrders", () => {
    let experimentId: string;

    beforeEach(async () => {
      experimentId = await repo.createExperiment({
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
      });
    });

    it("deletes filled/cancelled orders older than cutoff", async () => {
      const old = new Date("2025-01-01T00:00:00Z");
      const recent = new Date("2025-06-01T00:00:00Z");
      const cutoff = new Date("2025-03-01T00:00:00Z");

      // Old filled order — should be deleted
      await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-OLD-FILLED",
        side: "buy",
        price: 2_000_000,
        amount: 0.005,
        status: "filled",
        gridLevel: 0,
        createdAt: old,
        filledAt: old,
      });
      // Old cancelled order — should be deleted
      await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-OLD-CANCELLED",
        side: "sell",
        price: 2_100_000,
        amount: 0.005,
        status: "cancelled",
        gridLevel: 1,
        createdAt: old,
      });
      // Recent filled order — should be kept
      await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-RECENT-FILLED",
        side: "buy",
        price: 2_200_000,
        amount: 0.005,
        status: "filled",
        gridLevel: 2,
        createdAt: recent,
        filledAt: recent,
      });

      const deleted = await repo.pruneOldOrders(experimentId, cutoff);
      expect(deleted).toBe(2);

      const remaining = await repo.getOrders(experimentId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].coinmateOrderId).toBe("CM-RECENT-FILLED");
    });

    it("never prunes open orders regardless of age", async () => {
      const old = new Date("2024-01-01T00:00:00Z");
      const cutoff = new Date("2025-06-01T00:00:00Z");

      await repo.createOrder(experimentId, {
        coinmateOrderId: "CM-OLD-OPEN",
        side: "buy",
        price: 2_000_000,
        amount: 0.005,
        status: "open",
        gridLevel: 0,
        createdAt: old,
      });

      const deleted = await repo.pruneOldOrders(experimentId, cutoff);
      expect(deleted).toBe(0);

      const remaining = await repo.getOrders(experimentId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe("open");
    });

    it("returns 0 when no orders exist", async () => {
      const deleted = await repo.pruneOldOrders(experimentId, new Date());
      expect(deleted).toBe(0);
    });
  });

  // ─── Wallet ───────────────────────────────────────────────────────────

  describe("wallet", () => {
    it("returns zero wallet state initially", async () => {
      const wallet = await repo.getWalletState();
      expect(wallet.totalAllocatedQuote).toBe(0);
      expect(wallet.totalAllocatedBase).toBe(0);
      expect(wallet.availableQuote).toBe(0);
      expect(wallet.availableBase).toBe(0);
    });

    it("allocates from available balance", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 200_000,
        availableBase: 0.1,
      });

      const result = await repo.allocateWallet(100_000, 0);
      expect(result).toBe(true);

      const wallet = await repo.getWalletState();
      expect(wallet.totalAllocatedQuote).toBe(100_000);
      expect(wallet.availableQuote).toBe(100_000);
    });

    it("rejects allocation when insufficient funds", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      const result = await repo.allocateWallet(100_000, 0);
      expect(result).toBe(false);

      // Wallet unchanged
      const wallet = await repo.getWalletState();
      expect(wallet.availableQuote).toBe(50_000);
      expect(wallet.totalAllocatedQuote).toBe(0);
    });

    it("releases allocation back to available", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      await repo.releaseWallet(100_000, 0);

      const wallet = await repo.getWalletState();
      expect(wallet.totalAllocatedQuote).toBe(0);
      expect(wallet.availableQuote).toBe(150_000);
    });

    it("release does not go below zero for allocated", async () => {
      repo.setWallet({
        totalAllocatedQuote: 50_000,
        totalAllocatedBase: 0,
        availableQuote: 0,
        availableBase: 0,
      });

      await repo.releaseWallet(100_000, 0);

      const wallet = await repo.getWalletState();
      expect(wallet.totalAllocatedQuote).toBe(0);
      expect(wallet.availableQuote).toBe(100_000);
    });

    it("updates wallet state partially", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      await repo.updateWalletState({ availableQuote: 75_000 });

      const wallet = await repo.getWalletState();
      expect(wallet.availableQuote).toBe(75_000);
      expect(wallet.totalAllocatedQuote).toBe(100_000); // unchanged
    });
  });
});
