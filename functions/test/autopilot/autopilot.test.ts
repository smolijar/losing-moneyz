import { describe, it, expect, vi, beforeEach } from "vitest";
import { Autopilot } from "../../src/autopilot";
import { InMemoryRepository } from "../storage/in-memory-repository";
import type { ExchangeClient } from "../../src/coinmate";
import { WalletManager } from "../../src/storage";
import type { Logger } from "../../src/tick";
import type { AutopilotConfig, GridConfig, WalletState } from "../../src/config";

// Mock validateWithBacktest so we can control the backtest gate independently
// of the actual price data. The autopilot tests focus on orchestration logic.
vi.mock("../../src/backtest/backtester", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/backtest/backtester")>();
  return {
    ...original,
    validateWithBacktest: vi.fn().mockReturnValue({
      approved: true,
      reasons: [],
      report: {
        config: { pair: "BTC_CZK", lowerPrice: 2_000_000, upperPrice: 2_400_000, levels: 5, budgetQuote: 100_000 } as GridConfig,
        periodDays: 1,
        startingQuote: 100_000,
        endingQuote: 101_000,
        endingBase: 0,
        totalReturn: 1_000,
        totalReturnPercent: 1.0,
        annualizedReturnPercent: 365,
        maxDrawdownPercent: 2,
        totalTrades: 10,
        completedCycles: 5,
        avgProfitPerCycle: 200,
        totalFees: 50,
        gridUtilizationPercent: 80,
        profitable: true,
        pnlTimeseries: [],
      },
    }),
  };
});

// Import the mocked function so we can control it per-test
import { validateWithBacktest } from "../../src/backtest/backtester";
const mockedValidateWithBacktest = vi.mocked(validateWithBacktest);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ONE_MIN = 60 * 1000;

/** Noop logger */
const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/**
 * Generate oscillating ticks at 1-min intervals centered around `center`
 * with amplitude `amplitude`. Ensures enough variety for backtest to
 * produce completed cycles.
 */
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
    price: center + amplitude * Math.sin((2 * Math.PI * i) / 50),
    amount: 0.001,
    currencyPair: "BTC_CZK",
    tradeType: (i % 2 === 0 ? "BUY" : "SELL") as "BUY" | "SELL",
  }));
}

/**
 * Create a flat transaction set — all at the same price.
 */
function makeFlatTransactions(
  price: number,
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
    price,
    amount: 0.001,
    currencyPair: "BTC_CZK",
    tradeType: "BUY" as const,
  }));
}

/**
 * Create a strongly directional transaction set for trend-skip testing.
 */
function makeTrendingTransactions(
  startPrice: number,
  stepPerMinute: number,
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
    price: startPrice + i * stepPerMinute,
    amount: 0.001,
    currencyPair: "BTC_CZK",
    tradeType: "BUY" as const,
  }));
}

function createMockClient(
  overrides: Partial<ExchangeClient> = {},
): ExchangeClient {
  return {
    getTicker: vi.fn().mockResolvedValue({ error: false, data: {} }),
    getOpenOrders: vi.fn().mockResolvedValue({ error: false, data: [] }),
    buyLimit: vi.fn().mockResolvedValue({ error: false, data: 1001 }),
    sellLimit: vi.fn().mockResolvedValue({ error: false, data: 1002 }),
    cancelOrder: vi.fn().mockResolvedValue({ error: false, data: true }),
    getBalances: vi.fn().mockResolvedValue({ error: false, data: {} }),
    getTransactions: vi.fn().mockResolvedValue({ error: false, data: [] }),
    getOrderHistory: vi.fn().mockResolvedValue({ error: false, data: [] }),
    ...overrides,
  } as ExchangeClient;
}

const DEFAULT_WALLET: WalletState = {
  totalAllocatedQuote: 0,
  totalAllocatedBase: 0,
  availableQuote: 100_000,
  availableBase: 0,
};

// Permissive config to make backtest validation easier to pass in tests
const TEST_AUTOPILOT_CONFIG: Partial<AutopilotConfig> = {
  pair: "BTC_CZK",
  cooldownMinutes: 0, // no cooldown in tests
  minBudgetQuote: 100,
  backtestMinReturnPercent: -100, // extremely permissive
  backtestMaxDrawdownPercent: 100, // extremely permissive
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Autopilot", () => {
  let repo: InMemoryRepository;
  let walletManager: WalletManager;

  beforeEach(() => {
    repo = new InMemoryRepository();
    repo.setWallet({ ...DEFAULT_WALLET });
    walletManager = new WalletManager(repo);
    vi.clearAllMocks();
  });

  // ─── Kill switch ────────────────────────────────────────────────────

  describe("kill switch", () => {
    it("skips when kill switch is disabled", async () => {
      await repo.updateAutopilotState({ enabled: false });
      const client = createMockClient();
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toBe("disabled");
    });

    it("proceeds when kill switch is enabled", async () => {
      await repo.updateAutopilotState({ enabled: true });
      // No transactions → will skip for another reason, but won't skip for kill switch
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeFlatTransactions(2_200_000, 200),
        }),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      // Should NOT be "disabled"
      expect(result.reason).not.toBe("disabled");
    });

    it("proceeds when no autopilot state exists (first run)", async () => {
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeFlatTransactions(2_200_000, 200),
        }),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.reason).not.toBe("disabled");
    });
  });

  // ─── Cooldown ───────────────────────────────────────────────────────

  describe("cooldown", () => {
    it("skips when within cooldown period", async () => {
      // Set last action to 1 minute ago, cooldown = 10 minutes
      await repo.updateAutopilotState({
        enabled: true,
        lastActionAt: new Date(Date.now() - 1 * 60 * 1000),
        lastReason: "created",
      });
      const client = createMockClient();
      const config: Partial<AutopilotConfig> = {
        ...TEST_AUTOPILOT_CONFIG,
        cooldownMinutes: 10,
      };
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, config);

      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("cooldown");
    });

    it("proceeds after cooldown has expired", async () => {
      // Set last action to 15 minutes ago, cooldown = 10 minutes
      await repo.updateAutopilotState({
        enabled: true,
        lastActionAt: new Date(Date.now() - 15 * 60 * 1000),
        lastReason: "created",
      });
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeFlatTransactions(2_200_000, 200),
        }),
      });
      const config: Partial<AutopilotConfig> = {
        ...TEST_AUTOPILOT_CONFIG,
        cooldownMinutes: 10,
      };
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, config);

      const result = await autopilot.engage();

      expect(result.reason).not.toContain("cooldown");
    });
  });

  // ─── Stopped experiments ────────────────────────────────────────────

  describe("stopped experiments", () => {
    it("skips when stopped experiments exist (pending cleanup)", async () => {
      await repo.createExperiment({
        status: "stopped",
        gridConfig: {
          pair: "BTC_CZK",
          lowerPrice: 2_000_000,
          upperPrice: 2_400_000,
          levels: 5,
          budgetQuote: 50_000,
        },
        allocatedQuote: 50_000,
        allocatedBase: 0,
        consecutiveFailures: 0,
      });

      const client = createMockClient();
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("stopped experiments");
    });
  });

  // ─── Paused experiment cleanup ──────────────────────────────────────

  describe("paused experiment cleanup", () => {
    it("releases wallet for paused experiments with allocations", async () => {
      const expId = await repo.createExperiment({
        status: "paused",
        gridConfig: {
          pair: "BTC_CZK",
          lowerPrice: 2_000_000,
          upperPrice: 2_400_000,
          levels: 5,
          budgetQuote: 50_000,
        },
        allocatedQuote: 50_000,
        allocatedBase: 0,
        consecutiveFailures: 0,
      });
      repo.setWallet({
        totalAllocatedQuote: 50_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeOscillatingTransactions(2_200_000, 100_000, 500),
        }),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      await autopilot.engage();

      // The paused experiment should have had its wallet released
      const exp = await repo.getExperiment(expId);
      expect(exp!.allocatedQuote).toBe(0);
    });

    it("promotes paused experiments with open orders to stopped", async () => {
      const expId = await repo.createExperiment({
        status: "paused",
        gridConfig: {
          pair: "BTC_CZK",
          lowerPrice: 2_000_000,
          upperPrice: 2_400_000,
          levels: 5,
          budgetQuote: 50_000,
        },
        allocatedQuote: 50_000,
        allocatedBase: 0,
        consecutiveFailures: 0,
      });
      await repo.createOrder(expId, {
        coinmateOrderId: "3816395949",
        side: "buy",
        price: 2_000_000,
        amount: 0.001,
        status: "open",
        gridLevel: 0,
        createdAt: new Date(),
      });
      repo.setWallet({
        totalAllocatedQuote: 50_000,
        totalAllocatedBase: 0,
        availableQuote: 0,
        availableBase: 0,
      });

      const client = createMockClient();
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("order cleanup");

      const exp = await repo.getExperiment(expId);
      expect(exp!.status).toBe("stopped");

      const wallet = await walletManager.getState();
      expect(wallet.totalAllocatedQuote).toBe(50_000);
      expect(wallet.availableQuote).toBe(0);
    });
  });

  // ─── Insufficient capital ──────────────────────────────────────────

  describe("insufficient capital", () => {
    it("skips when available capital is below minimum budget", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 50, // Way below minBudgetQuote (100 in TEST_AUTOPILOT_CONFIG)
        availableBase: 0,
      });

      const client = createMockClient();
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Insufficient capital");
    });
  });

  // ─── Exchange errors ───────────────────────────────────────────────

  describe("exchange errors", () => {
    it("skips when exchange returns an error", async () => {
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: true,
          errorMessage: "Rate limit exceeded",
          data: [],
        }),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Exchange error");
    });

    it("skips when exchange throws an exception", async () => {
      const client = createMockClient({
        getTransactions: vi.fn().mockRejectedValue(new Error("Network timeout")),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Failed to fetch transactions");
    });
  });

  // ─── Insufficient price data ───────────────────────────────────────

  describe("insufficient price data", () => {
    it("skips when fewer than 100 ticks are available", async () => {
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeFlatTransactions(2_200_000, 50), // only 50 ticks
        }),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Insufficient price data");
    });
  });

  // ─── Successful creation ───────────────────────────────────────────

  describe("successful experiment creation", () => {
    it("creates an experiment when all conditions are met", async () => {
      const transactions = makeOscillatingTransactions(2_200_000, 100_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 100_000,
        availableBase: 0,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      expect(result.experimentId).toBeDefined();
      expect(result.config).toBeDefined();
      expect(result.config!.pair).toBe("BTC_CZK");
      expect(result.config!.budgetQuote).toBe(100_000);

      // Verify the experiment was actually created in the repo
      const exp = await repo.getExperiment(result.experimentId!);
      expect(exp).toBeDefined();
      expect(exp!.status).toBe("active");
      expect(exp!.gridConfig.pair).toBe("BTC_CZK");
    });

    it("allocates wallet capital for the new experiment", async () => {
      const transactions = makeOscillatingTransactions(2_200_000, 100_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 100_000,
        availableBase: 0,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");

      // Wallet should now have allocated the budget
      const wallet = await walletManager.getState();
      expect(wallet.totalAllocatedQuote).toBe(100_000);
      expect(wallet.availableQuote).toBe(0);
    });

    it("saves autopilot state after creating experiment", async () => {
      const transactions = makeOscillatingTransactions(2_200_000, 100_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 100_000,
        availableBase: 0,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      await autopilot.engage();

      const state = await repo.getAutopilotState();
      expect(state).toBeDefined();
      expect(state!.lastReason).toBe("created");
      expect(state!.lastActionAt).toBeInstanceOf(Date);
    });
  });

  // ─── Wallet allocation failure ─────────────────────────────────────

  describe("wallet allocation failure", () => {
    it("rolls back experiment to stopped if wallet allocation fails", async () => {
      const transactions = makeOscillatingTransactions(2_200_000, 100_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      // Set wallet with enough for the check but rig allocateWallet to fail
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 100_000,
        availableBase: 0,
      });

      // After the initial check, drain the wallet so allocation fails
      const origAllocate = repo.allocateWallet.bind(repo);
      let callCount = 0;
      vi.spyOn(repo, "allocateWallet").mockImplementation(async (q, b) => {
        callCount++;
        if (callCount === 1) {
          // First call from WalletManager.allocateForExperiment → force failure
          return false;
        }
        return origAllocate(q, b);
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Wallet allocation failed");
    });
  });

  // ─── Parameter suggestion failure ──────────────────────────────────

  describe("parameter suggestion failure", () => {
    it("skips when suggestParams returns null (e.g., too few ticks after filtering)", async () => {
      // Provide exactly 100 ticks but all with negative prices → suggestParams returns null
      // Actually, make 100 ticks at price 0 to trigger null from suggestParams
      const zeroTicks = Array.from({ length: 100 }, (_, i) => ({
        timestamp: Date.now() - (100 - i) * ONE_MIN,
        transactionId: i + 1,
        price: 0,
        amount: 0.001,
        currencyPair: "BTC_CZK",
        tradeType: "BUY" as const,
      }));

      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: zeroTicks,
        }),
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Parameter suggestion failed");
    });

    it("skips with trend reason and logs structured trend metrics", async () => {
      const trendingDown = makeTrendingTransactions(3_000_000, -2_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: trendingDown,
        }),
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Parameter suggestion skipped");
      expect(result.reason).toContain("strong downtrend detected");

      expect(noopLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Autopilot skipped: Parameter suggestion skipped"),
        expect.objectContaining({
          pair: "BTC_CZK",
          availableQuote: 100_000,
          trend: expect.objectContaining({
            isTrending: true,
            direction: "down",
          }),
        }),
      );
    });
  });

  // ─── Backtest rejection ────────────────────────────────────────────

  describe("backtest rejection", () => {
    it("skips when backtest validation fails", async () => {
      const transactions = makeOscillatingTransactions(2_200_000, 100_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      // Override mock to reject
      mockedValidateWithBacktest.mockReturnValueOnce({
        approved: false,
        reasons: ["Return -10.00% is below minimum 5%"],
        report: {
          config: { pair: "BTC_CZK", lowerPrice: 2_000_000, upperPrice: 2_400_000, levels: 5, budgetQuote: 100_000 } as GridConfig,
          periodDays: 1,
          startingQuote: 100_000,
          endingQuote: 90_000,
          endingBase: 0,
          totalReturn: -10_000,
          totalReturnPercent: -10,
          annualizedReturnPercent: -100,
          maxDrawdownPercent: 15,
          totalTrades: 2,
          completedCycles: 0,
          avgProfitPerCycle: 0,
          totalFees: 10,
          gridUtilizationPercent: 20,
          profitable: false,
          pnlTimeseries: [],
        },
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Backtest rejected");
    });
  });

  // ─── State persistence ─────────────────────────────────────────────

  describe("state persistence", () => {
    it("saves state on skip due to insufficient capital", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 10,
        availableBase: 0,
      });

      const client = createMockClient();
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      await autopilot.engage();

      const state = await repo.getAutopilotState();
      expect(state).toBeDefined();
      expect(state!.lastReason).toContain("skipped");
      expect(state!.lastReason).toContain("Insufficient capital");
    });

    it("does not fail if state save throws (non-fatal)", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 10,
        availableBase: 0,
      });

      // Make updateAutopilotState throw
      vi.spyOn(repo, "updateAutopilotState").mockRejectedValue(new Error("Firestore down"));

      const client = createMockClient();
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      // Should still return a valid skip result, not throw
      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Insufficient capital");
    });
  });

  // ─── Config merging ────────────────────────────────────────────────

  describe("config merging", () => {
    it("uses defaults when no overrides provided", async () => {
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeFlatTransactions(2_200_000, 200),
        }),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger);

      // Trigger engage — it will use AUTOPILOT_DEFAULTS
      const result = await autopilot.engage();

      // With default minBudgetQuote=500 and our 100_000 wallet, should proceed past capital check
      // Won't be "Insufficient capital" with defaults
      expect(result.reason).not.toContain("disabled");
    });

    it("merges partial overrides with defaults", async () => {
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeOscillatingTransactions(2_200_000, 100_000, 500),
        }),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, {
        pair: "ETH_CZK",
      });

      // The pair should be ETH_CZK but cooldownMinutes should still be the default 10
      // We can verify by checking that the exchange call uses the right pair
      await autopilot.engage();
      expect(client.getTransactions).toHaveBeenCalledWith("ETH_CZK", 1440);
    });
  });
});
