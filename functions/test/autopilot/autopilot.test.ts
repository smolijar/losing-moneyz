import { describe, it, expect, vi, beforeEach } from "vitest";
import { Autopilot } from "../../src/autopilot";
import { InMemoryRepository } from "../storage/in-memory-repository";
import type { ExchangeClient } from "../../src/coinmate";
import { WalletManager } from "../../src/storage";
import type { Logger } from "../../src/tick";
import type { AutopilotConfig, GridConfig, WalletState } from "../../src/config";
import { calculateGridLevels } from "../../src/grid";

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

      // The paused experiment should have been deleted after wallet release
      const exp = await repo.getExperiment(expId);
      expect(exp).toBeUndefined();
    });

    it("deletes paused experiments with zero allocation", async () => {
      const expId = await repo.createExperiment({
        status: "paused",
        gridConfig: {
          pair: "BTC_CZK",
          lowerPrice: 2_000_000,
          upperPrice: 2_400_000,
          levels: 5,
          budgetQuote: 50_000,
        },
        allocatedQuote: 0,
        allocatedBase: 0,
        consecutiveFailures: 0,
      });
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 100_000,
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

      // Experiment should be deleted from the repository
      const exp = await repo.getExperiment(expId);
      expect(exp).toBeUndefined();
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

    it("does not skip when quote is low but mixed inventory has enough total value", async () => {
      // Needs enough CZK to fund at least 3 levels after level clamping.
      // At ~1.54M price, 3 levels need bpl/upperPrice >= 0.0002 BTC,
      // i.e. ~1000 CZK / 2 = 500 bpl ≈ 0.000316 BTC per level. ✓
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 1_000,
        availableBase: 0.00275881,
      });

      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: makeOscillatingTransactions(1_540_000, 40_000, 500),
        }),
      });
      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);

      const result = await autopilot.engage();

      expect(result.action).toBe("created");
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

    it("sets lastReplacementAt on new experiment to protect 6h regrid cooldown", async () => {
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
      const before = new Date();
      const result = await autopilot.engage();

      expect(result.action).toBe("created");

      const state = await repo.getAutopilotState();
      expect(state!.lastReplacementAt).toBeInstanceOf(Date);
      expect(state!.lastReplacementAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
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

    it("allocates mixed wallet balances for a base-aware restart", async () => {
      const transactions = makeOscillatingTransactions(1_540_000, 40_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      // Enough CZK for 3+ levels after level clamping
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 1_000,
        availableBase: 0.00275881,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      const exp = await repo.getExperiment(result.experimentId!);
      expect(exp!.allocatedQuote).toBeCloseTo(1_000);
      expect(exp!.allocatedBase).toBeCloseTo(0.00275881);

      const wallet = await walletManager.getState();
      expect(wallet.availableQuote).toBeCloseTo(0);
      expect(wallet.availableBase).toBeCloseTo(0);
      expect(wallet.totalAllocatedBase).toBeCloseTo(0.00275881);
    });

    it("sets budgetQuote to actual CZK (not total equivalent) in mixed-wallet mode", async () => {
      const transactions = makeOscillatingTransactions(1_540_000, 40_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      // Enough CZK for 3+ levels after level clamping
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 1_000,
        availableBase: 0.00275881,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      const exp = await repo.getExperiment(result.experimentId!);
      // budgetQuote should match the CZK-only portion (level clamping sets it
      // before experiment creation, not via post-creation reconciliation).
      expect(exp!.gridConfig.budgetQuote).toBeCloseTo(1_000);
      expect(exp!.allocatedQuote).toBeCloseTo(1_000);
    });

    it("shapes mixed-wallet restart config so the nearest sell is near market", async () => {
      const transactions = makeOscillatingTransactions(1_540_000, 40_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      // Enough CZK for 3+ levels after level clamping
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 1_000,
        availableBase: 0.00275881,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      const currentPrice = transactions[transactions.length - 1].price;
      const exp = await repo.getExperiment(result.experimentId!);
      const levels = calculateGridLevels(exp!.gridConfig).map((l) => l.price);
      const nearestSell = levels.filter((price) => price > currentPrice).sort((a, b) => a - b)[0];
      const gapPercent = ((nearestSell - currentPrice) / currentPrice) * 100;
      expect(gapPercent).toBeLessThanOrEqual(0.8);
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

  // ─── Dust wallet handling ──────────────────────────────────────────

  describe("dust wallet handling", () => {
    it("treats BTC dust (<10% of capital) as quote_only and uses buy_bootstrap", async () => {
      // Simulates the production scenario: 0.00021523 BTC dust (~317 CZK)
      // with ~4,421 CZK available — BTC is ~6.7% of total, below 10% threshold.
      const transactions = makeOscillatingTransactions(1_480_000, 40_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 4_421,
        availableBase: 0.00021523, // dust: ~317 CZK at 1.48M, ~6.7% of capital
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      const currentPrice = transactions[transactions.length - 1].price;
      const exp = await repo.getExperiment(result.experimentId!);

      // With buy_bootstrap, the nearest buy should be close to market (within ~1%),
      // NOT 8+% below market as with sell_resume + dust.
      const levels = [
        exp!.gridConfig.lowerPrice,
        (exp!.gridConfig.lowerPrice + exp!.gridConfig.upperPrice) / 2,
        exp!.gridConfig.upperPrice,
      ];
      const nearestBuy = levels.filter((price) => price < currentPrice).sort((a, b) => b - a)[0];
      const buyGapPercent = ((currentPrice - nearestBuy) / currentPrice) * 100;
      expect(buyGapPercent).toBeLessThanOrEqual(1.5);
    });

    it("uses sell_resume when base is genuinely sufficient for sells (>10% of capital)", async () => {
      // This mirrors the mixed-wallet test — wallet with significant BTC
      // should still use sell_resume mode. Enough CZK for 3+ levels.
      const transactions = makeOscillatingTransactions(1_540_000, 40_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 1_000,
        availableBase: 0.00275881,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      const currentPrice = transactions[transactions.length - 1].price;
      const exp = await repo.getExperiment(result.experimentId!);

      // With sell_resume, the nearest sell should be near market (within 0.8%).
      const levels = calculateGridLevels(exp!.gridConfig).map((l) => l.price);
      const nearestSell = levels.filter((price) => price > currentPrice).sort((a, b) => a - b)[0];
      const gapPercent = ((nearestSell - currentPrice) / currentPrice) * 100;
      expect(gapPercent).toBeLessThanOrEqual(0.8);
    });

    it("falls back to buy_bootstrap when wallet is mixed but base cannot cover a sell order", async () => {
      // Wallet has >10% base by value but the absolute amount is too small to
      // fill even one grid-level sell order.
      const priceCenter = 1_500_000;
      const transactions = makeOscillatingTransactions(priceCenter, 40_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      // ~750 CZK in BTC (50% of 1500 total) → walletMode=mixed
      // but 0.0005 BTC is less than estimated sell size (~0.0005 at this budget),
      // and the estimatedSellSize scales with managedQuoteEquivalent.
      // With 750 + 750 = 1500 CZK total, sell size = 1500 / 2 / 1_500_000 = 0.0005
      // Make base slightly below the estimated sell size.
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 750,
        availableBase: 0.00045, // ~675 CZK at 1.5M, ~47% of capital but too small for sells
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      const currentPrice = transactions[transactions.length - 1].price;
      const exp = await repo.getExperiment(result.experimentId!);

      // Should use buy_bootstrap (nearest BUY within ~1.5% of market)
      const levels = calculateGridLevels(exp!.gridConfig).map((l) => l.price);
      const nearestBuy = levels.filter((price) => price < currentPrice).sort((a, b) => b - a)[0];
      const buyGapPercent = ((currentPrice - nearestBuy) / currentPrice) * 100;
      expect(buyGapPercent).toBeLessThanOrEqual(1.5);
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

  // ─── Level clamping ─────────────────────────────────────────────────

  describe("level clamping", () => {
    it("reduces grid levels to meet minimum order size when CZK is limited", async () => {
      // Wallet has 2,000 CZK + some BTC. The param search sizes the grid on
      // the full equivalent (~6,000+) which may yield 7+ levels. With only
      // 2,000 CZK, levels should be clamped so budgetPerLevel/upperPrice >= 0.0002.
      const transactions = makeOscillatingTransactions(1_500_000, 50_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 2_000,
        availableBase: 0.003, // ~4,500 CZK in BTC → total ~6,500
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      const exp = await repo.getExperiment(result.experimentId!);
      // budgetQuote should equal the CZK portion, not total equivalent
      expect(exp!.gridConfig.budgetQuote).toBeCloseTo(2_000);
      // The grid should still have valid levels (3–50)
      expect(exp!.gridConfig.levels).toBeGreaterThanOrEqual(3);
      expect(exp!.gridConfig.levels).toBeLessThanOrEqual(50);
      // Budget per level should be enough for minimum order size at upper price
      const bpl = exp!.gridConfig.budgetQuote / Math.ceil(exp!.gridConfig.levels / 2);
      const minAmount = bpl / exp!.gridConfig.upperPrice;
      expect(minAmount).toBeGreaterThanOrEqual(0.0002);
    });

    it("creates experiment with full levels when CZK alone is sufficient", async () => {
      // 100,000 CZK wallet — no clamping needed
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
      const exp = await repo.getExperiment(result.experimentId!);
      // With 100k CZK, the grid should have many levels, no clamping needed
      expect(exp!.gridConfig.budgetQuote).toBe(100_000);
      expect(exp!.gridConfig.levels).toBeGreaterThanOrEqual(3);
    });

    it("re-applies market bias after level clamping so nearest order stays near market", async () => {
      // Small CZK budget with BTC → level clamping will reduce levels.
      // After clamping, the grid should still be centered around market price
      // thanks to bias re-application (Fix #1).
      const transactions = makeOscillatingTransactions(1_500_000, 50_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 2_000,
        availableBase: 0.003, // ~4,500 CZK in BTC → total ~6,500
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
      const currentPrice = transactions[transactions.length - 1].price;
      const exp = await repo.getExperiment(result.experimentId!);

      // After clamping + bias re-application, the nearest grid level should be
      // close to market price (within one spacing). Without bias, the grid
      // would drift far from market after clamping.
      const levels = calculateGridLevels(exp!.gridConfig).map((l) => l.price);
      const nearestGapPercent = Math.min(
        ...levels.map((p) => (Math.abs(p - currentPrice) / currentPrice) * 100),
      );
      // Bias targets ~0.5% gap; allow generous 2% margin for rounding and spacing
      expect(nearestGapPercent).toBeLessThanOrEqual(2);
    });
  });

  // ─── Exponential cooldown ──────────────────────────────────────────

  describe("exponential cooldown", () => {
    it("applies exponential backoff based on consecutiveRecycles", async () => {
      // Simulate 3 consecutive recycles → cooldown = 10 * 2^3 = 80 min
      await repo.updateAutopilotState({
        enabled: true,
        lastActionAt: new Date(Date.now() - 50 * ONE_MIN), // 50 min ago
        consecutiveRecycles: 3,
      });

      const transactions = makeOscillatingTransactions(2_200_000, 100_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, {
        ...TEST_AUTOPILOT_CONFIG,
        cooldownMinutes: 10,
        cooldownMaxMinutes: 480,
      });
      const result = await autopilot.engage();

      // 10 * 2^3 = 80 min cooldown, only 50 min elapsed → still in cooldown
      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("cooldown");
    });

    it("allows engagement when exponential cooldown has elapsed", async () => {
      // 3 consecutive recycles → cooldown = 80 min. 90 min elapsed → past cooldown.
      await repo.updateAutopilotState({
        enabled: true,
        lastActionAt: new Date(Date.now() - 90 * ONE_MIN),
        consecutiveRecycles: 3,
      });

      const transactions = makeOscillatingTransactions(2_200_000, 100_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, {
        ...TEST_AUTOPILOT_CONFIG,
        cooldownMinutes: 10,
        cooldownMaxMinutes: 480,
      });
      const result = await autopilot.engage();

      expect(result.action).toBe("created");
    });

    it("caps cooldown at cooldownMaxMinutes", async () => {
      // 10 consecutive recycles → cooldown = 10 * 2^10 = 10240, capped at 480 min
      await repo.updateAutopilotState({
        enabled: true,
        lastActionAt: new Date(Date.now() - 400 * ONE_MIN), // 400 min ago
        consecutiveRecycles: 10,
      });

      const transactions = makeOscillatingTransactions(2_200_000, 100_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, {
        ...TEST_AUTOPILOT_CONFIG,
        cooldownMinutes: 10,
        cooldownMaxMinutes: 480,
      });
      const result = await autopilot.engage();

      // Capped at 480 min, only 400 elapsed → still in cooldown
      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("cooldown");
    });

    it("increments consecutiveRecycles on experiment creation", async () => {
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
      expect(state!.consecutiveRecycles).toBe(1);
    });
  });

  // ─── Auto-rebalance ────────────────────────────────────────────────

  describe("auto-rebalance", () => {
    it("places a sell order when CZK is too low for 3 levels but BTC is sufficient", async () => {
      // 200 CZK + 0.003 BTC (~4,500 CZK). Can't fund 3 levels with 200 CZK
      // at 1.5M price: need bpl = 0.0002 * 1.55M * 2 ≈ 620 CZK.
      const transactions = makeOscillatingTransactions(1_500_000, 50_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 200,
        availableBase: 0.003,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      // Should place a rebalance sell and skip this tick
      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Rebalancing wallet");
      expect(result.reason).toContain("selling");

      // sellLimit should have been called
      expect(client.sellLimit).toHaveBeenCalledTimes(1);
      const [pair, amount, price] = (client.sellLimit as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(pair).toBe("BTC_CZK");
      expect(amount).toBeGreaterThanOrEqual(0.0002); // at least minOrderSize
      expect(amount).toBeLessThanOrEqual(0.003 * 0.5); // capped at 50% of base
      expect(price).toBeGreaterThan(0);

      // State should record rebalance
      const state = await repo.getAutopilotState();
      expect(state!.lastRebalanceAt).toBeInstanceOf(Date);
      expect(state!.lastSupervisorDecision).toBe("rebalance_sell");
    });

    it("respects rebalance cooldown (10 min)", async () => {
      // Set a recent rebalance timestamp → should NOT sell again
      await repo.updateAutopilotState({
        lastRebalanceAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
      });

      const transactions = makeOscillatingTransactions(1_500_000, 50_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 200,
        availableBase: 0.003,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      // Should skip without selling — rebalance cooldown prevents it
      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("CZK budget too low");
      expect(client.sellLimit).not.toHaveBeenCalled();
    });

    it("skips rebalance when base is too small to meet minimum order size", async () => {
      // 450 CZK + 0.0003 BTC. Total ~899 CZK (above minBudgetQuote 500).
      // CZK too low for 3 levels → rebalance triggered. But the computed sell
      // amount (~0.000119 BTC) is below minOrderSize (0.0002), so rebalance
      // is skipped and we fall through to the "CZK budget too low" skip.
      const transactions = makeOscillatingTransactions(1_500_000, 50_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 450,
        availableBase: 0.0003, // sell amount would be ~0.000119, below 0.0002 minOrderSize
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      // Should skip without selling — base too small for a sell order
      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("CZK budget too low");
      expect(client.sellLimit).not.toHaveBeenCalled();
    });

    it("caps sell amount at 50% of available base", async () => {
      // 100 CZK + 0.001 BTC. Shortfall is large relative to base, so the
      // 50% cap should kick in.
      const transactions = makeOscillatingTransactions(1_500_000, 50_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 100,
        availableBase: 0.001, // ~1,500 CZK total, 0.0005 max sell
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      if (result.reason.includes("Rebalancing")) {
        const [, amount] = (client.sellLimit as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(amount).toBeLessThanOrEqual(0.001 * 0.5);
      }
      // If sell amount after capping was below minOrderSize, it skips gracefully
      expect(result.action).toBe("skipped");
    });

    it("deducts sold BTC from wallet availableBase after rebalance sell", async () => {
      // 200 CZK + 0.003 BTC — same as the basic rebalance test
      const transactions = makeOscillatingTransactions(1_500_000, 50_000, 500);
      const client = createMockClient({
        getTransactions: vi.fn().mockResolvedValue({
          error: false,
          data: transactions,
        }),
      });

      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 200,
        availableBase: 0.003,
      });

      const autopilot = new Autopilot(client, repo, walletManager, noopLogger, TEST_AUTOPILOT_CONFIG);
      const result = await autopilot.engage();

      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("Rebalancing wallet");

      // The sell amount should have been deducted from wallet.availableBase
      const [, sellAmount] = (client.sellLimit as ReturnType<typeof vi.fn>).mock.calls[0];
      const wallet = await walletManager.getState();
      expect(wallet.availableBase).toBeCloseTo(0.003 - sellAmount, 8);
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
