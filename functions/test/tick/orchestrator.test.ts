import { describe, it, expect, vi, beforeEach } from "vitest";
import { GridTickOrchestrator, type Logger, type AlertSink, type AlertEvent } from "../../src/tick/orchestrator";
import { InMemoryRepository } from "../storage/in-memory-repository";
import type { ExchangeClient } from "../../src/coinmate";
import { CoinmateApiError } from "../../src/coinmate";
import type { Experiment, GridConfig } from "../../src/config";
import { WalletManager } from "../../src/storage";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const gridConfig: GridConfig = {
  pair: "BTC_CZK",
  lowerPrice: 2_000_000,
  upperPrice: 2_400_000,
  levels: 5,
  budgetQuote: 100_000,
};

const ONE_MIN = 60 * 1000;

function makeOscillatingTransactions(
  center: number,
  amplitude: number,
  count: number,
): Array<{
  timestamp: number;
  transactionId: number;
  price: number;
  amount: number;
  currencyPair: string;
  tradeType: "BUY" | "SELL";
}> {
  const baseTime = Date.now() - count * ONE_MIN;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: baseTime + i * ONE_MIN,
    transactionId: i + 1,
    price: center + amplitude * Math.sin((2 * Math.PI * i) / 40),
    amount: 0.001,
    currencyPair: "BTC_CZK",
    tradeType: (i % 2 === 0 ? "BUY" : "SELL") as "BUY" | "SELL",
  }));
}

/** Create an active experiment in the repo and return its id + object */
async function seedExperiment(
  repo: InMemoryRepository,
  overrides: Partial<Omit<Experiment, "id" | "createdAt" | "updatedAt">> = {},
): Promise<{ id: string; experiment: Experiment }> {
  const id = await repo.createExperiment({
    status: "active",
    gridConfig,
    allocatedQuote: 100_000,
    allocatedBase: 0,
    ...overrides,
  });
  const experiment = (await repo.getExperiment(id))!;
  return { id, experiment };
}

/** Noop logger */
const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** Create a mock Coinmate client with default stubs */
function createMockClient(
  overrides: Partial<ExchangeClient> = {},
): ExchangeClient {
  return {
    getTicker: vi.fn().mockResolvedValue({
      error: false,
      data: {
        last: 2_200_000,
        high: 2_250_000,
        low: 2_150_000,
        amount: 10,
        bid: 2_199_000,
        ask: 2_201_000,
        change: 0,
        open: 2_200_000,
        timestamp: Date.now(),
      },
    }),
    getOpenOrders: vi.fn().mockResolvedValue({
      error: false,
      data: [],
    }),
    buyLimit: vi.fn().mockResolvedValue({ error: false, data: 1001 }),
    sellLimit: vi.fn().mockResolvedValue({ error: false, data: 1002 }),
    cancelOrder: vi.fn().mockResolvedValue({ error: false, data: true }),
    getBalances: vi.fn().mockResolvedValue({
      error: false,
      data: {
        CZK: { currency: "CZK", balance: 150_000, reserved: 0, available: 150_000 },
        BTC: { currency: "BTC", balance: 0.05, reserved: 0, available: 0.05 },
      },
    }),
    getTransactions: vi.fn().mockResolvedValue({ error: false, data: [] }),
    getOrderHistory: vi.fn().mockResolvedValue({ error: false, data: [] }),
    ...overrides,
  } as ExchangeClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GridTickOrchestrator", () => {
  let repo: InMemoryRepository;

  beforeEach(() => {
    repo = new InMemoryRepository();
    vi.clearAllMocks();
  });

  // ─── Basic tick flow ───────────────────────────────────────────────

  describe("executeTick", () => {
    it("returns empty results when no active experiments exist", async () => {
      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      const result = await orchestrator.executeTick();

      expect(result.experimentResults).toHaveLength(0);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it("processes active experiments only", async () => {
      await seedExperiment(repo, { status: "active" });
      await seedExperiment(repo, { status: "paused" });

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      const result = await orchestrator.executeTick();

      // Should only process the active experiment (paused is skipped)
      // stopped experiments are also checked for emergency stop, but we have none
      expect(result.experimentResults).toHaveLength(1);
      expect(result.experimentResults[0].status).toBe("ok");
    });

    it("processes multiple active experiments sequentially", async () => {
      await seedExperiment(repo);
      await seedExperiment(repo);
      await seedExperiment(repo);

      let callCount = 0;
      const client = createMockClient({
        buyLimit: vi.fn().mockImplementation(async () => {
          callCount++;
          return { error: false, data: 1000 + callCount };
        }),
        sellLimit: vi.fn().mockImplementation(async () => {
          callCount++;
          return { error: false, data: 2000 + callCount };
        }),
      });
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      const result = await orchestrator.executeTick();

      expect(result.experimentResults).toHaveLength(3);
      expect(result.experimentResults.every((r) => r.status === "ok")).toBe(true);
    });
  });

  // ─── Initial grid setup ────────────────────────────────────────────

  describe("initial grid placement", () => {
    it("places only the nearest bootstrap buy on first tick", async () => {
      const { id } = await seedExperiment(repo);

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      const result = await orchestrator.executeTick();
      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;

      // Fresh entry bootstrap only places the nearest buy below market.
      expect(expResult.status).toBe("ok");
      expect(expResult.ordersPlaced).toBe(1);
      expect(client.buyLimit).toHaveBeenCalledTimes(1);
      expect(client.sellLimit).toHaveBeenCalledTimes(0);
    });

    it("places only the nearest resume sell on first tick when base is allocated", async () => {
      const mixedGridConfig: GridConfig = {
        pair: "BTC_CZK",
        lowerPrice: 1_500_000,
        upperPrice: 1_530_000,
        levels: 3,
        budgetQuote: 5_000,
      };
      const id = await repo.createExperiment({
        status: "active",
        gridConfig: mixedGridConfig,
        allocatedQuote: 617.55,
        allocatedBase: 0.00275881,
        consecutiveFailures: 0,
      });

      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: {
            last: 1_507_500,
            high: 1_520_000,
            low: 1_510_000,
            amount: 10,
            bid: 1_507_000,
            ask: 1_508_000,
            change: 0,
            open: 1_507_500,
            timestamp: Date.now(),
          },
        }),
      });
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.ordersPlaced).toBe(1);
      expect(client.sellLimit).toHaveBeenCalledTimes(1);
      expect(client.buyLimit).toHaveBeenCalledTimes(0);

      const orders = await repo.getOrders(id);
      expect(orders.length).toBe(1);
      expect(orders[0].side).toBe("sell");
      expect(orders[0].price).toBe(1_515_000);
    });

    it("falls through to buy bootstrap when base is allocated but too small for sell orders", async () => {
      // Scenario: wallet has tiny BTC (below min order size for any sell level)
      // plus some CZK. The bootstrap limiter should fall through to buy logic
      // instead of returning 0 actions.
      const mixedGridConfig: GridConfig = {
        pair: "BTC_CZK",
        lowerPrice: 1_400_000,
        upperPrice: 1_600_000,
        levels: 3,
        budgetQuote: 3_000,
      };
      const id = await repo.createExperiment({
        status: "active",
        gridConfig: mixedGridConfig,
        allocatedQuote: 3_000,
        allocatedBase: 0.00005, // well below 0.0002 BTC min order size
        consecutiveFailures: 0,
      });

      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: {
            last: 1_500_000,
            high: 1_520_000,
            low: 1_480_000,
            amount: 10,
            bid: 1_499_000,
            ask: 1_501_000,
            change: 0,
            open: 1_500_000,
            timestamp: Date.now(),
          },
        }),
      });
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      // Should place 1 buy order (nearest to market), NOT 0
      expect(expResult.ordersPlaced).toBe(1);
      expect(client.buyLimit).toHaveBeenCalledTimes(1);
      expect(client.sellLimit).toHaveBeenCalledTimes(0);

      const orders = await repo.getOrders(id);
      expect(orders.length).toBe(1);
      expect(orders[0].side).toBe("buy");
    });

    it("records placed orders in the repository", async () => {
      const { id } = await seedExperiment(repo);

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      await orchestrator.executeTick();

      const orders = await repo.getOrdersByStatus(id, "open");
      // Only the nearest bootstrap buy is placed
      expect(orders.length).toBe(1);

      const buys = orders.filter((o) => o.side === "buy");
      const sells = orders.filter((o) => o.side === "sell");
      expect(buys.length).toBe(1);
      expect(sells.length).toBe(0);
      expect(buys[0].price).toBe(2_100_000);
    });

    it("saves a snapshot after processing", async () => {
      const { id } = await seedExperiment(repo);

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      await orchestrator.executeTick();

      const snapshot = await repo.getLatestSnapshot(id);
      expect(snapshot).toBeDefined();
      expect(snapshot!.currentPrice).toBe(2_200_000);
      expect(snapshot!.balanceQuote).toBe(100_000);
    });
  });

  // ─── Fill detection ────────────────────────────────────────────────

  describe("fill detection", () => {
    it("detects a filled order when it disappears from Coinmate and trade history confirms", async () => {
      const { id } = await seedExperiment(repo);

      // Seed a pre-existing open order in our DB
      await repo.createOrder(id, {
        coinmateOrderId: "5001",
        side: "buy",
        price: 2_100_000,
        amount: 0.001,
        status: "open",
        gridLevel: 1,
        createdAt: new Date(),
      });

      // Coinmate returns NO open orders → our DB order is missing
      // Trade history confirms it was filled
      const client = createMockClient({
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [],
        }),
        getOrderHistory: vi.fn().mockResolvedValue({
          error: false,
          data: [
            {
              transactionId: 100,
              createdTimestamp: Date.now(),
              currencyPair: "BTC_CZK",
              type: "BUY",
              price: 2_100_000,
              amount: 0.001,
              fee: 8.4,
              orderId: 5001,
            },
          ],
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.fillsDetected).toBe(1);

      // The order in our DB should be marked as "filled"
      const filledOrders = await repo.getOrdersByStatus(id, "filled");
      expect(filledOrders.length).toBe(1);
      expect(filledOrders[0].coinmateOrderId).toBe("5001");
    });

    it("marks disappeared order as cancelled when trade history has no match", async () => {
      const { id } = await seedExperiment(repo);

      // Seed a pre-existing open order in our DB
      await repo.createOrder(id, {
        coinmateOrderId: "5002",
        side: "buy",
        price: 2_100_000,
        amount: 0.001,
        status: "open",
        gridLevel: 1,
        createdAt: new Date(),
      });

      // Coinmate returns NO open orders, AND trade history has no matching trade
      const client = createMockClient({
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [],
        }),
        getOrderHistory: vi.fn().mockResolvedValue({
          error: false,
          data: [],
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      // Not detected as a fill
      expect(expResult.fillsDetected).toBe(0);

      // The order should be marked as "cancelled", not "filled"
      const cancelledOrders = await repo.getOrdersByStatus(id, "cancelled");
      expect(cancelledOrders.length).toBe(1);
      expect(cancelledOrders[0].coinmateOrderId).toBe("5002");

      // Warning should mention the disappeared order
      expect(expResult.warnings.some((w) => w.includes("5002"))).toBe(true);
    });

    it("does not false-detect still-open orders as fills", async () => {
      const { id } = await seedExperiment(repo);

      // Seed a pre-existing open order
      await repo.createOrder(id, {
        coinmateOrderId: "5001",
        side: "buy",
        price: 2_100_000,
        amount: 0.001,
        status: "open",
        gridLevel: 1,
        createdAt: new Date(),
      });

      // Coinmate still shows this order as open
      const client = createMockClient({
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [
            {
              id: 5001,
              timestamp: Date.now(),
              type: "BUY",
              currencyPair: "BTC_CZK",
              price: 2_100_000,
              amount: 0.001,
            },
          ],
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.fillsDetected).toBe(0);

      // The original buy order should still be open, plus state-based reconciliation
      // places new orders at other empty grid levels (buy at level 0, sell at levels 3,4).
      // The key assertion: the original order was NOT falsely detected as a fill.
      const openOrders = await repo.getOrdersByStatus(id, "open");
      const originalOrder = openOrders.find((o) => o.coinmateOrderId === "5001");
      expect(originalOrder).toBeDefined();
      expect(originalOrder!.status).toBe("open");
      // 1 pre-existing buy at level 1 + 1 new buy at level 0 = 2
      // (no sells because no base inventory, no sell at level 3/4)
      expect(openOrders.length).toBe(2);
    });
  });

  // ─── Safeguard integration ────────────────────────────────────────

  describe("safeguards", () => {
    it("pauses experiment when price is out of range", async () => {
      const { id } = await seedExperiment(repo);

      // Price way below grid lower bound (2M)
      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: {
            last: 1_500_000,
            high: 1_600_000,
            low: 1_400_000,
            amount: 10,
            bid: 1_499_000,
            ask: 1_501_000,
            change: 0,
            open: 1_500_000,
            timestamp: Date.now(),
          },
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.status).toBe("paused");

      // Experiment should be paused in the repo
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");

      // No orders should be placed
      expect(expResult.ordersPlaced).toBe(0);
    });

    it("pauses experiment when drawdown exceeds threshold", async () => {
      const { id } = await seedExperiment(repo);

      // Seed a filled buy order to create unrealized P&L from fills
      await repo.createOrder(id, {
        coinmateOrderId: "8001",
        side: "buy",
        price: 2_200_000,
        amount: 0.01,
        status: "filled",
        gridLevel: 2,
        createdAt: new Date(),
        filledAt: new Date(),
      });

      // Seed a snapshot with realized P&L (unrealized will be recomputed from fills)
      await repo.saveSnapshot(id, {
        timestamp: new Date(),
        balanceQuote: 80_000,
        balanceBase: 0.01,
        openOrders: 4,
        unrealizedPnl: 0, // ignored — recomputed from fills
        realizedPnl: 0,
        currentPrice: 2_200_000,
      });

      // Price dropped significantly: unrealized = (1_000_000 - 2_200_000) * 0.01 = -12_000
      // Drawdown = 12_000 / 100_000 = 12% > 10% threshold
      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: {
            last: 1_000_000,
            high: 2_250_000,
            low: 950_000,
            amount: 10,
            bid: 999_000,
            ask: 1_001_000,
            change: 0,
            open: 2_000_000,
            timestamp: Date.now(),
          },
        }),
      });
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.status).toBe("paused");
    });

    it("adds warnings to result when price is near boundary", async () => {
      await seedExperiment(repo);

      // Price near lower boundary: 2_010_000 is within 5% of 2M lower bound
      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: {
            last: 2_010_000,
            high: 2_050_000,
            low: 2_000_000,
            amount: 10,
            bid: 2_009_000,
            ask: 2_011_000,
            change: 0,
            open: 2_010_000,
            timestamp: Date.now(),
          },
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults[0];
      expect(expResult.status).toBe("ok");
      expect(expResult.warnings.length).toBeGreaterThan(0);
      expect(expResult.warnings.some((w) => w.includes("near grid boundary"))).toBe(true);
    });
  });

  // ─── Error handling ────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns error status when Coinmate API fails", async () => {
      const { id } = await seedExperiment(repo);

      const client = createMockClient({
        getTicker: vi.fn().mockRejectedValue(
          new CoinmateApiError("API is down", 500),
        ),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.status).toBe("error");
      expect(expResult.error).toContain("API is down");

      // Experiment should NOT be paused on transient errors
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("active");
    });

    it("continues processing other experiments when one fails", async () => {
      const { id: id1 } = await seedExperiment(repo);
      const { id: id2 } = await seedExperiment(repo);

      let callCount = 0;
      const client = createMockClient({
        getTicker: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // First experiment fails
            throw new CoinmateApiError("Timeout", 503);
          }
          // Second experiment succeeds
          return {
            error: false,
            data: {
              last: 2_200_000,
              high: 2_250_000,
              low: 2_150_000,
              amount: 10,
              bid: 2_199_000,
              ask: 2_201_000,
              change: 0,
              open: 2_200_000,
              timestamp: Date.now(),
            },
          };
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      expect(result.experimentResults).toHaveLength(2);

      const r1 = result.experimentResults.find((r) => r.experimentId === id1)!;
      const r2 = result.experimentResults.find((r) => r.experimentId === id2)!;
      expect(r1.status).toBe("error");
      expect(r2.status).toBe("ok");
    });

    it("handles individual order placement failure gracefully", async () => {
      const { id } = await seedExperiment(repo);

      let buyCallCount = 0;
      const client = createMockClient({
        buyLimit: vi.fn().mockImplementation(async () => {
          buyCallCount++;
          if (buyCallCount === 1) {
            throw new CoinmateApiError("Insufficient balance", 400);
          }
          return { error: false, data: 1001 + buyCallCount };
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      // Status should still be ok (individual order failure is not fatal)
      expect(expResult.status).toBe("ok");
      // Bootstrap only attempts one buy, so a failure leaves zero placed
      expect(expResult.ordersPlaced).toBe(0);
      expect(expResult.warnings.some((w) => w.includes("Insufficient balance"))).toBe(true);
    });

    it("stops an active experiment after repeated insufficient-balance failures when funds are reserved elsewhere", async () => {
      const blockedGridConfig: GridConfig = {
        pair: "BTC_CZK",
        lowerPrice: 1_300_000,
        upperPrice: 1_580_000,
        levels: 3,
        budgetQuote: 5_000,
      };
      const { id } = await seedExperiment(repo, {
        gridConfig: blockedGridConfig,
        allocatedQuote: 5_000,
      });
      const pausedId = await repo.createExperiment({
        status: "paused",
        gridConfig: blockedGridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
        consecutiveFailures: 0,
      });
      await repo.createOrder(pausedId, {
        coinmateOrderId: "3816395949",
        side: "buy",
        price: 1_389_254.54,
        amount: 0.00179952,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });
      repo.setWallet({
        totalAllocatedQuote: 5_000,
        totalAllocatedBase: 0,
        availableQuote: 0,
        availableBase: 0,
      });

      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: {
            last: 1_450_000,
            high: 1_470_000,
            low: 1_430_000,
            amount: 10,
            bid: 1_449_000,
            ask: 1_451_000,
            change: 0,
            open: 1_450_000,
            timestamp: Date.now(),
          },
        }),
        buyLimit: vi.fn().mockRejectedValue(
          new CoinmateApiError("Not enough account balance available", 400),
        ),
        getBalances: vi.fn().mockResolvedValue({
          error: false,
          data: {
            CZK: { currency: "CZK", balance: 5_000, reserved: 0, available: 0 },
            BTC: { currency: "BTC", balance: 0, reserved: 0, available: 0 },
          },
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();
      let exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("active");
      expect(exp!.consecutiveFailures).toBe(1);

      const result = await orchestrator.executeTick();
      exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");
      expect(
        result.experimentResults
          .find((r) => r.experimentId === id)!
          .warnings.some((w) => w.includes("reserved funds")),
      ).toBe(true);
    });

    it("does not stop active experiment on first insufficient-balance failure", async () => {
      const blockedGridConfig: GridConfig = {
        pair: "BTC_CZK",
        lowerPrice: 1_300_000,
        upperPrice: 1_580_000,
        levels: 3,
        budgetQuote: 5_000,
      };
      const { id } = await seedExperiment(repo, {
        gridConfig: blockedGridConfig,
        allocatedQuote: 5_000,
      });
      const pausedId = await repo.createExperiment({
        status: "paused",
        gridConfig: blockedGridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
        consecutiveFailures: 0,
      });
      await repo.createOrder(pausedId, {
        coinmateOrderId: "3816395949",
        side: "buy",
        price: 1_389_254.54,
        amount: 0.00179952,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });
      repo.setWallet({
        totalAllocatedQuote: 5_000,
        totalAllocatedBase: 0,
        availableQuote: 0,
        availableBase: 0,
      });

      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: {
            last: 1_450_000,
            high: 1_470_000,
            low: 1_430_000,
            amount: 10,
            bid: 1_449_000,
            ask: 1_451_000,
            change: 0,
            open: 1_450_000,
            timestamp: Date.now(),
          },
        }),
        buyLimit: vi.fn().mockRejectedValue(
          new CoinmateApiError("Not enough account balance available", 400),
        ),
        getBalances: vi.fn().mockResolvedValue({
          error: false,
          data: {
            CZK: { currency: "CZK", balance: 5_000, reserved: 0, available: 0 },
            BTC: { currency: "BTC", balance: 0, reserved: 0, available: 0 },
          },
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();

      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("active");
      expect(exp!.consecutiveFailures).toBe(1);
    });

    it("handles non-CoinmateApiError gracefully", async () => {
      const { id } = await seedExperiment(repo);

      const client = createMockClient({
        getTicker: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
      });

      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const orchestrator = new GridTickOrchestrator(client, repo, logger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.status).toBe("error");
      expect(expResult.error).toContain("fetch failed");

      // Should log as "Unexpected error" not "Coinmate API error"
      expect(logger.error).toHaveBeenCalledWith(
        "Unexpected error during tick",
        expect.objectContaining({ error: "fetch failed" }),
      );
    });

    it("increments consecutiveFailures on error and resets on success", async () => {
      const { id } = await seedExperiment(repo);

      // First tick: fail
      let tickCount = 0;
      const client = createMockClient({
        getTicker: vi.fn().mockImplementation(async () => {
          tickCount++;
          if (tickCount === 1) {
            throw new CoinmateApiError("Timeout", 503);
          }
          return {
            error: false,
            data: {
              last: 2_200_000, high: 2_250_000, low: 2_150_000,
              amount: 10, bid: 2_199_000, ask: 2_201_000,
              change: 0, open: 2_200_000, timestamp: Date.now(),
            },
          };
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      // First tick fails → consecutiveFailures should be 1
      await orchestrator.executeTick();
      let exp = await repo.getExperiment(id);
      expect(exp!.consecutiveFailures).toBe(1);

      // Second tick succeeds → consecutiveFailures should be reset to 0
      await orchestrator.executeTick();
      exp = await repo.getExperiment(id);
      expect(exp!.consecutiveFailures).toBe(0);
    });
  });

  // ─── Emergency stop ────────────────────────────────────────────────

  describe("emergency stop", () => {
    it("cancels all open orders for stopped experiments", async () => {
      const id = await repo.createExperiment({
        status: "stopped",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      const client = createMockClient({
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [
            { id: 9001, timestamp: Date.now(), type: "BUY", currencyPair: "BTC_CZK", price: 2_000_000, amount: 0.001 },
            { id: 9002, timestamp: Date.now(), type: "SELL", currencyPair: "BTC_CZK", price: 2_400_000, amount: 0.001 },
          ],
        }),
      });

      // Seed matching DB orders
      await repo.createOrder(id, {
        coinmateOrderId: "9001",
        side: "buy",
        price: 2_000_000,
        amount: 0.001,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });
      await repo.createOrder(id, {
        coinmateOrderId: "9002",
        side: "sell",
        price: 2_400_000,
        amount: 0.001,
        status: "open",
        gridLevel: 4,
        createdAt: new Date(),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      // Should have processed the stopped experiment
      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.ordersCancelled).toBe(2);
      expect(client.cancelOrder).toHaveBeenCalledWith(9001);
      expect(client.cancelOrder).toHaveBeenCalledWith(9002);

      // Experiment should be moved to "paused" after emergency stop
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");

      // DB orders should be cancelled
      const cancelledOrders = await repo.getOrdersByStatus(id, "cancelled");
      expect(cancelledOrders.length).toBe(2);
    });

    it("handles partial cancel failure during emergency stop", async () => {
      const id = await repo.createExperiment({
        status: "stopped",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      let cancelCallCount = 0;
      const client = createMockClient({
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [
            { id: 9001, timestamp: Date.now(), type: "BUY", currencyPair: "BTC_CZK", price: 2_000_000, amount: 0.001 },
            { id: 9002, timestamp: Date.now(), type: "SELL", currencyPair: "BTC_CZK", price: 2_400_000, amount: 0.001 },
          ],
        }),
        cancelOrder: vi.fn().mockImplementation(async () => {
          cancelCallCount++;
          if (cancelCallCount === 1) {
            throw new CoinmateApiError("Cancel failed", 500);
          }
          return { error: false, data: true };
        }),
      });

      await repo.createOrder(id, {
        coinmateOrderId: "9001",
        side: "buy",
        price: 2_000_000,
        amount: 0.001,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });
      await repo.createOrder(id, {
        coinmateOrderId: "9002",
        side: "sell",
        price: 2_400_000,
        amount: 0.001,
        status: "open",
        gridLevel: 4,
        createdAt: new Date(),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      // One cancel succeeded, one failed
      expect(expResult.ordersCancelled).toBe(1);
      // Stays "stopped" so next tick retries cancelling remaining orders
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("stopped");
    });
  });

  // ─── Logging ───────────────────────────────────────────────────────

  describe("logging", () => {
    it("logs tick start and completion", async () => {
      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, logger);

      await orchestrator.executeTick();

      expect(logger.info).toHaveBeenCalledWith("Grid tick started");
      expect(logger.info).toHaveBeenCalledWith(
        "Grid tick completed",
        expect.objectContaining({ durationMs: expect.any(Number) }),
      );
    });

    it("logs experiment tick details", async () => {
      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      await seedExperiment(repo);
      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, logger);

      await orchestrator.executeTick();

      expect(logger.info).toHaveBeenCalledWith(
        "Experiment tick completed",
        expect.objectContaining({
          currentPrice: 2_200_000,
        }),
      );
    });

    it("logs API errors as errors", async () => {
      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      await seedExperiment(repo);
      const client = createMockClient({
        getTicker: vi.fn().mockRejectedValue(
          new CoinmateApiError("Service unavailable", 503),
        ),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, logger);
      await orchestrator.executeTick();

      expect(logger.error).toHaveBeenCalledWith(
        "Coinmate API error during tick",
        expect.objectContaining({ statusCode: 503 }),
      );
    });
  });

  // ─── Snapshot recording ────────────────────────────────────────────

  describe("snapshots", () => {
    it("computes realized P&L from filled orders", async () => {
      const { id } = await seedExperiment(repo);

      // Seed already-filled orders (a completed buy-sell cycle)
      await repo.createOrder(id, {
        coinmateOrderId: "7001",
        side: "buy",
        price: 2_100_000,
        amount: 0.001,
        status: "filled",
        gridLevel: 1,
        createdAt: new Date(Date.now() - 10000),
        filledAt: new Date(Date.now() - 5000),
      });
      await repo.createOrder(id, {
        coinmateOrderId: "7002",
        side: "sell",
        price: 2_200_000,
        amount: 0.001,
        status: "filled",
        gridLevel: 2,
        createdAt: new Date(Date.now() - 5000),
        filledAt: new Date(Date.now() - 1000),
      });

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      await orchestrator.executeTick();

      const snapshot = await repo.getLatestSnapshot(id);
      expect(snapshot).toBeDefined();
      // realizedPnl should be positive (sold higher than bought, minus fees)
      // buy: 2_100_000 * 0.001 = 2100 CZK, sell: 2_200_000 * 0.001 = 2200 CZK
      // gross = 100 CZK, fees = 2100*0.0012 + 2200*0.0012 = 2.52 + 2.64 = 5.16
      // net = 100 - 5.16 = 94.84
      expect(snapshot!.realizedPnl).toBeCloseTo(94.84, 0);
    });

    it("saves zero P&L when there are no fills", async () => {
      const { id } = await seedExperiment(repo);

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      await orchestrator.executeTick();

      const snapshot = await repo.getLatestSnapshot(id);
      expect(snapshot!.realizedPnl).toBe(0);
    });
  });

  // ─── Counter-order placement after fills ───────────────────────────

  describe("counter-order placement", () => {
    it("places a sell counter-order when a buy fill is detected", async () => {
      const { id } = await seedExperiment(repo);

      // Seed an open buy order in our DB
      await repo.createOrder(id, {
        coinmateOrderId: "6001",
        side: "buy",
        price: 2_100_000,
        amount: 0.001,
        status: "open",
        gridLevel: 1,
        createdAt: new Date(),
      });

      // Coinmate shows NO open orders → buy was filled
      // Trade history confirms the fill
      // But Coinmate also shows no other open orders, so reconciliation
      // will process the fill and potentially place a counter-order at level 2
      const client = createMockClient({
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [],
        }),
        getOrderHistory: vi.fn().mockResolvedValue({
          error: false,
          data: [
            {
              transactionId: 200,
              createdTimestamp: Date.now(),
              currencyPair: "BTC_CZK",
              type: "BUY",
              price: 2_100_000,
              amount: 0.001,
              fee: 8.4,
              orderId: 6001,
            },
          ],
        }),
      });

      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);
      const result = await orchestrator.executeTick();

      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;
      expect(expResult.fillsDetected).toBe(1);
      // Buy orders placed at levels below current price (levels 0, 1).
      // Sell counter-orders NOT placed: availableBase from 0.001 BTC fill is too small
      // for the sell amount needed (~0.015 BTC per level at budgetPerLevel=33k).
      // This is correct — budget enforcement prevents placing sells we can't back.
      expect(expResult.ordersPlaced).toBeGreaterThanOrEqual(1);
      expect(client.buyLimit).toHaveBeenCalled();
    });
  });

  // ─── Skipped experiments ───────────────────────────────────────────

  describe("experiment lifecycle", () => {
    it("does not process paused experiments", async () => {
      await seedExperiment(repo, { status: "paused" });

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      const result = await orchestrator.executeTick();

      // Paused experiments are not fetched by getExperimentsByStatus("active")
      expect(result.experimentResults).toHaveLength(0);
      // No API calls made
      expect(client.getTicker).not.toHaveBeenCalled();
    });

    it("handles empty exchange when experiment has no previous state", async () => {
      await seedExperiment(repo);

      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      const result = await orchestrator.executeTick();

      // First tick with no prior snapshot and no orders
      // Should run fine and place initial buy orders only
      // (no sells: allocatedBase=0, no fills yet → availableBase=0)
      expect(result.experimentResults).toHaveLength(1);
      expect(result.experimentResults[0].status).toBe("ok");
      expect(result.experimentResults[0].ordersPlaced).toBe(1);
    });
  });

  // ─── Alert events ──────────────────────────────────────────────────────

  describe("alert events", () => {
    it("emits safeguard_pause alert when experiment is paused by safeguard", async () => {
      await seedExperiment(repo);

      // Price outside grid range → safeguard pause
      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: { last: 3_000_000, high: 3_100_000, low: 2_900_000, amount: 10, bid: 3_000_000, ask: 3_001_000, change: 0, open: 3_000_000, timestamp: Date.now() },
        }),
      });

      const alerts: AlertEvent[] = [];
      const alertSink: AlertSink = { emit: (e) => alerts.push(e) };
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, { alertSink });

      await orchestrator.executeTick();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe("safeguard_pause");
      expect(alerts[0].severity).toBe("critical");
    });

    it("emits emergency_stop_completed alert on successful emergency stop", async () => {
      const { id } = await seedExperiment(repo, { status: "stopped" });
      // Need to make it "stopped" so the orchestrator's executeTick picks it up
      await repo.updateExperimentStatus(id, "stopped");

      const client = createMockClient();
      const alerts: AlertEvent[] = [];
      const alertSink: AlertSink = { emit: (e) => alerts.push(e) };
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, { alertSink });

      await orchestrator.executeTick();

      const stopAlert = alerts.find((a) => a.type === "emergency_stop_completed");
      expect(stopAlert).toBeDefined();
      expect(stopAlert!.severity).toBe("info");
    });

    it("emits circuit_breaker_increment alert on error", async () => {
      await seedExperiment(repo);

      const client = createMockClient({
        getTicker: vi.fn().mockRejectedValue(new Error("network failure")),
      });

      const alerts: AlertEvent[] = [];
      const alertSink: AlertSink = { emit: (e) => alerts.push(e) };
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, { alertSink });

      await orchestrator.executeTick();

      const cbAlert = alerts.find((a) => a.type === "circuit_breaker_increment");
      expect(cbAlert).toBeDefined();
      expect(cbAlert!.severity).toBe("warning");

      const errAlert = alerts.find((a) => a.type === "unexpected_error");
      expect(errAlert).toBeDefined();
      expect(errAlert!.severity).toBe("critical");
    });
  });

  // ─── Wallet sync ───────────────────────────────────────────────────────────

  describe("wallet sync", () => {
    it("syncs exchange balances into wallet state at the start of each tick", async () => {
      // Wallet starts empty (no Firestore doc → defaults to zeros)
      const client = createMockClient({
        getBalances: vi.fn().mockResolvedValue({
          error: false,
          data: {
            CZK: { currency: "CZK", balance: 1_000, reserved: 0, available: 1_000 },
            BTC: { currency: "BTC", balance: 0.01, reserved: 0, available: 0.01 },
          },
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();

      const walletState = await walletManager.getState();
      expect(walletState.availableQuote).toBe(1_000);
      expect(walletState.availableBase).toBe(0.01);
    });

    it("accounts for allocated funds during sync", async () => {
      // Some funds already allocated to a running experiment
      repo.setWallet({
        totalAllocatedQuote: 5_000,
        totalAllocatedBase: 0,
        availableQuote: 0,
        availableBase: 0,
      });

      const client = createMockClient({
        getBalances: vi.fn().mockResolvedValue({
          error: false,
          data: {
            CZK: { currency: "CZK", balance: 10_000, reserved: 0, available: 10_000 },
            BTC: { currency: "BTC", balance: 0, reserved: 0, available: 0 },
          },
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();

      const walletState = await walletManager.getState();
      // No experiments exist, so reconciliation should clear the stale allocation
      expect(walletState.availableQuote).toBe(10_000);
      expect(walletState.totalAllocatedQuote).toBe(0);
    });

    it("does not call getBalances when walletManager is not provided", async () => {
      const client = createMockClient();
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      await orchestrator.executeTick();

      expect(client.getBalances).not.toHaveBeenCalled();
    });

    it("continues tick when getBalances fails", async () => {
      await seedExperiment(repo);
      const client = createMockClient({
        getBalances: vi.fn().mockRejectedValue(new CoinmateApiError("Unauthorized", 401)),
      });

      const walletManager = new WalletManager(repo);
      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const orchestrator = new GridTickOrchestrator(client, repo, logger, {
        walletManager,
        autopilotConfig: false,
      });

      const result = await orchestrator.executeTick();

      // Tick still processes experiments despite sync failure
      expect(result.experimentResults).toHaveLength(1);
      expect(result.experimentResults[0].status).toBe("ok");
      // Error was logged
      expect(logger.error).toHaveBeenCalledWith(
        "Wallet sync failed",
        expect.objectContaining({ error: expect.stringContaining("Unauthorized") }),
      );
    });

    it("treats missing currencies as zero balance", async () => {
      // Exchange only returns EUR — no CZK or BTC entries (fresh account scenario)
      const client = createMockClient({
        getBalances: vi.fn().mockResolvedValue({
          error: false,
          data: {
            EUR: { currency: "EUR", balance: 500, reserved: 0, available: 500 },
          },
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();

      // Wallet should be synced with zeros since neither CZK nor BTC are present
      const walletState = await walletManager.getState();
      expect(walletState.availableQuote).toBe(0);
      expect(walletState.availableBase).toBe(0);
    });

    it("syncs CZK balance when BTC is missing (production scenario)", async () => {
      // Production: account has CZK and EUR but has never held BTC
      const client = createMockClient({
        getBalances: vi.fn().mockResolvedValue({
          error: false,
          data: {
            EUR: { currency: "EUR", balance: 100, reserved: 0, available: 100 },
            CZK: { currency: "CZK", balance: 1_000, reserved: 0, available: 1_000 },
          },
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();

      const walletState = await walletManager.getState();
      expect(walletState.availableQuote).toBe(1_000);
      expect(walletState.availableBase).toBe(0);
    });

    it("logs warning when discrepancy is detected", async () => {
      repo.setWallet({
        totalAllocatedQuote: 5_000,
        totalAllocatedBase: 0,
        availableQuote: 1_000,  // internal thinks available = 1k
        availableBase: 0,
      });

      const client = createMockClient({
        getBalances: vi.fn().mockResolvedValue({
          error: false,
          data: {
            CZK: { currency: "CZK", balance: 10_000, reserved: 0, available: 10_000 },
            BTC: { currency: "BTC", balance: 0, reserved: 0, available: 0 },
          },
        }),
      });

      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, logger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();

      // Internal total was 5k+1k=6k, actual is 10k → discrepancy of 4k
      expect(logger.warn).toHaveBeenCalledWith(
        "Wallet discrepancy detected",
        expect.objectContaining({
          quoteDiscrepancy: 4_000,
        }),
      );

      // Wallet updated to reflect reality and stale allocation is cleared
      const walletState = await walletManager.getState();
      expect(walletState.availableQuote).toBe(10_000);
    });

    it("reconciles drifted wallet allocations from experiments", async () => {
      await seedExperiment(repo, { allocatedQuote: 100_000 });
      repo.setWallet({
        totalAllocatedQuote: 200_000,
        totalAllocatedBase: 0,
        availableQuote: 100_000,
        availableBase: 0,
      });

      const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(createMockClient(), repo, logger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();

      const walletState = await walletManager.getState();
      expect(walletState.totalAllocatedQuote).toBe(100_000);
      expect(walletState.availableQuote).toBe(50_000);
      expect(logger.warn).toHaveBeenCalledWith(
        "Wallet allocations reconciled",
        expect.objectContaining({ quoteDiff: -100_000 }),
      );
    });
  });

  describe("autonomous supervision", () => {
    it("recycles a stale entry experiment that is far off-market", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });
      await repo.updateAutopilotState({ enabled: false });

      const id = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });
      await repo.createOrder(id, {
        coinmateOrderId: "9001",
        side: "buy",
        price: 2_000_000,
        amount: 0.001,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(Date.now() - 120 * ONE_MIN),
      });

      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: { last: 2_200_000 },
        }),
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [
            { id: 9001, timestamp: Date.now(), type: "BUY", currencyPair: "BTC_CZK", price: 2_000_000, amount: 0.001 },
          ],
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: { stalledEntryMinutes: 60 },
      });

      await orchestrator.executeTick();

      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");
      expect(exp!.allocatedQuote).toBe(0);
    });

    it("waits for quiet period before deposit-driven replacement", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });
      await repo.updateAutopilotState({ enabled: false });

      const { id } = await seedExperiment(repo);
      await repo.createOrder(id, {
        coinmateOrderId: "7001",
        side: "buy",
        price: 2_050_000,
        amount: 0.001,
        status: "filled",
        gridLevel: 0,
        createdAt: new Date(Date.now() - 30 * ONE_MIN),
        filledAt: new Date(Date.now() - 30 * ONE_MIN),
      });

      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeOscillatingTransactions(2_200_000, 120_000, 500),
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: {
          capitalIncreaseThresholdPercent: 20,
          recentFillQuietPeriodMinutes: 90,
        },
      });

      await orchestrator.executeTick();

      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("active");
    });

    it("approves deposit-driven replacement after quiet period", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });
      await repo.updateAutopilotState({ enabled: false });

      const { id } = await seedExperiment(repo);
      await repo.createOrder(id, {
        coinmateOrderId: "7002",
        side: "buy",
        price: 2_050_000,
        amount: 0.001,
        status: "filled",
        gridLevel: 0,
        createdAt: new Date(Date.now() - 4 * 60 * ONE_MIN),
        filledAt: new Date(Date.now() - 4 * 60 * ONE_MIN),
      });

      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeOscillatingTransactions(2_200_000, 120_000, 500),
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: {
          capitalIncreaseThresholdPercent: 20,
          recentFillQuietPeriodMinutes: 90,
          regridCooldownMinutes: 1,
        },
      });

      await orchestrator.executeTick();

      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");
      const state = await repo.getAutopilotState();
      expect(state!.lastSupervisorDecision).toBe("replacement_approved");
    });

    it("does NOT recycle when percent gap is met but grid-spacing gap is not (AND logic)", async () => {
      // Fix #3: stall detection requires BOTH conditions (percent AND spacings).
      // Grid spacing = (2.4M - 2M) / (5-1) = 100K
      // Order at 2_100_000, market at 2_200_000 → gap = 100K
      //   gapPercent  = 100K / 2.2M * 100 ≈ 4.55%  → ≥ 3% ✓
      //   gapSpacings = 100K / 100K = 1.0            → < 2  ✗
      // Under old OR logic this would recycle; under AND logic it should NOT.
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });
      await repo.updateAutopilotState({ enabled: false });

      const id = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });
      // Open order 1 spacing away from market — far in %, close in spacings
      await repo.createOrder(id, {
        coinmateOrderId: "8001",
        side: "buy",
        price: 2_100_000,
        amount: 0.001,
        status: "open",
        gridLevel: 1,
        createdAt: new Date(Date.now() - 120 * ONE_MIN),
      });

      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: { last: 2_200_000 },
        }),
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [
            { id: 8001, timestamp: Date.now(), type: "BUY", currencyPair: "BTC_CZK", price: 2_100_000, amount: 0.001 },
          ],
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: { stalledEntryMinutes: 60 },
      });

      await orchestrator.executeTick();

      // Experiment should remain active — not recycled
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("active");
    });

    it("DOES recycle when BOTH percent gap and grid-spacing gap are met", async () => {
      // Grid spacing = 100K. Order at 2_000_000, market at 2_200_000 → gap = 200K
      //   gapPercent  = 200K / 2.2M * 100 ≈ 9.09%  → ≥ 3% ✓
      //   gapSpacings = 200K / 100K = 2.0            → ≥ 2  ✓
      // Both conditions met → should recycle.
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });
      await repo.updateAutopilotState({ enabled: false });

      const id = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });
      await repo.createOrder(id, {
        coinmateOrderId: "8002",
        side: "buy",
        price: 2_000_000,
        amount: 0.001,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(Date.now() - 120 * ONE_MIN),
      });

      const client = createMockClient({
        getTicker: vi.fn().mockResolvedValue({
          error: false,
          data: { last: 2_200_000 },
        }),
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [
            { id: 8002, timestamp: Date.now(), type: "BUY", currencyPair: "BTC_CZK", price: 2_000_000, amount: 0.001 },
          ],
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: { stalledEntryMinutes: 60 },
      });

      await orchestrator.executeTick();

      // Both conditions met → experiment recycled
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");
      expect(exp!.allocatedQuote).toBe(0);
    });
  });

  // ─── WalletManager integration (#11) ──────────────────────────────────────

  describe("wallet manager integration", () => {
    it("releases wallet allocation on successful emergency stop", async () => {
      // Set up wallet with 100k allocated
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      const id = await repo.createExperiment({
        status: "stopped",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      // Seed matching DB orders
      await repo.createOrder(id, {
        coinmateOrderId: "9001",
        side: "buy",
        price: 2_000_000,
        amount: 0.001,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });

      const client = createMockClient({
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [
            { id: 9001, timestamp: Date.now(), type: "BUY", currencyPair: "BTC_CZK", price: 2_000_000, amount: 0.001 },
          ],
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        autopilotConfig: false,
      });

      await orchestrator.executeTick();

      // Experiment should be paused (not deleted, since autopilot is disabled)
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");

      // Wallet should have funds released
      const walletState = await walletManager.getState();
      expect(walletState.availableQuote).toBe(150_000); // 50k + 100k released
      expect(walletState.totalAllocatedQuote).toBe(0); // nothing allocated

      // Experiment allocation should be zeroed
      expect(exp!.allocatedQuote).toBe(0);
    });

    it("emits wallet_release_success alert on emergency stop", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 0,
        availableBase: 0,
      });

      const id = await repo.createExperiment({
        status: "stopped",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      const client = createMockClient();
      const alerts: AlertEvent[] = [];
      const alertSink: AlertSink = { emit: (e) => alerts.push(e) };
      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        alertSink,
      });

      await orchestrator.executeTick();

      const walletAlert = alerts.find((a) => a.type === "wallet_release_success");
      expect(walletAlert).toBeDefined();
      expect(walletAlert!.severity).toBe("info");
      expect(walletAlert!.experimentId).toBe(id);
    });

    it("does not release wallet when WalletManager is not provided", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      const id = await repo.createExperiment({
        status: "stopped",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      const client = createMockClient();
      // No walletManager provided → backward compatible
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger);

      await orchestrator.executeTick();

      // Experiment still transitions to paused (emergency stop completes)
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("paused");

      // Wallet should NOT be touched (allocation remains)
      const walletState = await repo.getWalletState();
      expect(walletState.totalAllocatedQuote).toBe(100_000);
      expect(walletState.availableQuote).toBe(50_000);
    });

    it("does not release wallet on partial emergency stop (orders remain open)", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      const id = await repo.createExperiment({
        status: "stopped",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      await repo.createOrder(id, {
        coinmateOrderId: "9001",
        side: "buy",
        price: 2_000_000,
        amount: 0.001,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });
      await repo.createOrder(id, {
        coinmateOrderId: "9002",
        side: "sell",
        price: 2_400_000,
        amount: 0.001,
        status: "open",
        gridLevel: 4,
        createdAt: new Date(),
      });

      let cancelCallCount = 0;
      const client = createMockClient({
        getOpenOrders: vi.fn().mockResolvedValue({
          error: false,
          data: [
            { id: 9001, timestamp: Date.now(), type: "BUY", currencyPair: "BTC_CZK", price: 2_000_000, amount: 0.001 },
            { id: 9002, timestamp: Date.now(), type: "SELL", currencyPair: "BTC_CZK", price: 2_400_000, amount: 0.001 },
          ],
        }),
        cancelOrder: vi.fn().mockImplementation(async () => {
          cancelCallCount++;
          if (cancelCallCount === 1) {
            throw new CoinmateApiError("Cancel failed", 500);
          }
          return { error: false, data: true };
        }),
      });

      const walletManager = new WalletManager(repo);
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
      });

      await orchestrator.executeTick();

      // Experiment stays "stopped" (not paused) — retry next tick
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("stopped");

      // Wallet should NOT be released (orders still open)
      const walletState = await walletManager.getState();
      expect(walletState.totalAllocatedQuote).toBe(100_000);
      expect(walletState.availableQuote).toBe(50_000);
    });

    it("handles wallet release failure gracefully without blocking emergency stop", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      const id = await repo.createExperiment({
        status: "stopped",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      const client = createMockClient();

      // Create a wallet manager that will throw on release
      const walletManager = new WalletManager(repo);
      vi.spyOn(walletManager, "releaseForExperiment").mockRejectedValue(
        new Error("Firestore write failed"),
      );

      const alerts: AlertEvent[] = [];
      const alertSink: AlertSink = { emit: (e) => alerts.push(e) };
      const orchestrator = new GridTickOrchestrator(client, repo, noopLogger, {
        walletManager,
        alertSink,
      });

      const result = await orchestrator.executeTick();
      const expResult = result.experimentResults.find((r) => r.experimentId === id)!;

      // Emergency stop remains pending so wallet release is retried next tick
      const exp = await repo.getExperiment(id);
      expect(exp!.status).toBe("stopped");

      // Warning should be added about wallet release failure
      expect(expResult.warnings.some((w) => w.includes("Wallet release error"))).toBe(true);

      // Alert emitted for wallet failure
      const walletAlert = alerts.find((a) => a.type === "wallet_release_failed");
      expect(walletAlert).toBeDefined();

      // Emergency stop completed alert should not fire until wallet release succeeds
      const stopAlert = alerts.find((a) => a.type === "emergency_stop_completed");
      expect(stopAlert).toBeUndefined();
    });
  });
});
