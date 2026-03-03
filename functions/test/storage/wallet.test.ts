import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRepository } from "./in-memory-repository";
import { WalletManager } from "../../src/storage";
import type { GridConfig } from "../../src/config";

describe("WalletManager", () => {
  let repo: InMemoryRepository;
  let wallet: WalletManager;

  const gridConfig: GridConfig = {
    pair: "BTC_CZK",
    lowerPrice: 2_000_000,
    upperPrice: 2_400_000,
    levels: 5,
    budgetQuote: 100_000,
  };

  beforeEach(() => {
    repo = new InMemoryRepository();
    wallet = new WalletManager(repo);
  });

  describe("allocateForExperiment", () => {
    it("allocates budget from available wallet", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 200_000,
        availableBase: 0,
      });

      const expId = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
      });

      const result = await wallet.allocateForExperiment(expId, gridConfig);

      expect(result.success).toBe(true);
      expect(result.walletState).toBeDefined();
      expect(result.walletState!.availableQuote).toBe(100_000);
      expect(result.walletState!.totalAllocatedQuote).toBe(100_000);

      // Experiment should be updated with allocation
      const exp = await repo.getExperiment(expId);
      expect(exp!.allocatedQuote).toBe(100_000);
    });

    it("rejects when insufficient funds", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      const expId = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
      });

      const result = await wallet.allocateForExperiment(expId, gridConfig);

      expect(result.success).toBe(false);
      expect(result.reason).toContain("Insufficient funds");
    });

    it("prevents two experiments from over-allocating", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 150_000,
        availableBase: 0,
      });

      const exp1 = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
      });
      const exp2 = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
      });

      const result1 = await wallet.allocateForExperiment(exp1, gridConfig);
      expect(result1.success).toBe(true);

      const result2 = await wallet.allocateForExperiment(exp2, gridConfig);
      expect(result2.success).toBe(false);
      expect(result2.reason).toContain("Insufficient funds");
    });
  });

  describe("releaseForExperiment", () => {
    it("releases budget back to available pool", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 50_000,
        availableBase: 0,
      });

      const expId = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 100_000,
        allocatedBase: 0,
      });

      const result = await wallet.releaseForExperiment(expId);

      expect(result.success).toBe(true);
      expect(result.walletState!.availableQuote).toBe(150_000);
      expect(result.walletState!.totalAllocatedQuote).toBe(0);

      // Experiment allocation zeroed
      const exp = await repo.getExperiment(expId);
      expect(exp!.allocatedQuote).toBe(0);
    });

    it("returns error for non-existent experiment", async () => {
      const result = await wallet.releaseForExperiment("bad-id");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  describe("initializeWallet", () => {
    it("sets available balance accounting for existing allocations", async () => {
      // Simulate: already have one experiment allocated 100k
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0.01,
        availableQuote: 0,
        availableBase: 0,
      });

      // Real exchange shows 300k CZK and 0.05 BTC
      await wallet.initializeWallet(300_000, 0.05);

      const state = await wallet.getState();
      expect(state.availableQuote).toBe(200_000); // 300k - 100k allocated
      expect(state.availableBase).toBe(0.04); // 0.05 - 0.01 allocated
      expect(state.totalAllocatedQuote).toBe(100_000); // unchanged
    });

    it("works with no prior allocations", async () => {
      await wallet.initializeWallet(500_000, 0.1);

      const state = await wallet.getState();
      expect(state.availableQuote).toBe(500_000);
      expect(state.availableBase).toBe(0.1);
      expect(state.totalAllocatedQuote).toBe(0);
    });
  });

  describe("syncWallet", () => {
    it("detects no discrepancy when balanced", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0.01,
        availableQuote: 200_000,
        availableBase: 0.04,
      });

      // Actual matches expected (100k + 200k = 300k)
      const result = await wallet.syncWallet(300_000, 0.05);

      expect(result.discrepancy).toBe(false);
      expect(result.quoteDiscrepancy).toBeCloseTo(0);
      expect(result.baseDiscrepancy).toBeCloseTo(0);
    });

    it("detects discrepancy when actual differs", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0.01,
        availableQuote: 200_000,
        availableBase: 0.04,
      });

      // Actual is 310k instead of expected 300k (maybe external deposit)
      const result = await wallet.syncWallet(310_000, 0.05);

      expect(result.discrepancy).toBe(true);
      expect(result.quoteDiscrepancy).toBeCloseTo(10_000);

      // Available should be updated
      const state = await wallet.getState();
      expect(state.availableQuote).toBe(210_000); // 310k - 100k allocated
    });

    it("handles negative discrepancy (withdrawal)", async () => {
      repo.setWallet({
        totalAllocatedQuote: 100_000,
        totalAllocatedBase: 0,
        availableQuote: 200_000,
        availableBase: 0,
      });

      // Someone withdrew 50k → actual is 250k
      const result = await wallet.syncWallet(250_000, 0);

      expect(result.discrepancy).toBe(true);
      expect(result.quoteDiscrepancy).toBeCloseTo(-50_000);
      expect(result.walletState!.availableQuote).toBe(150_000);
    });

    it("syncs correctly from fresh/empty wallet state", async () => {
      // Default InMemoryRepository wallet has all zeros — simulates a fresh
      // deployment where the Firestore document doesn't exist yet.
      // This is the exact scenario that caused the production bug:
      // syncWallet writes a partial update, and the next read must still
      // return a valid WalletState with all fields present.
      const result = await wallet.syncWallet(500_000, 0.1);

      expect(result.discrepancy).toBe(true);
      expect(result.quoteDiscrepancy).toBeCloseTo(500_000);
      expect(result.baseDiscrepancy).toBeCloseTo(0.1);

      // Wallet state must have all four fields populated
      const state = await wallet.getState();
      expect(state.availableQuote).toBe(500_000);
      expect(state.availableBase).toBe(0.1);
      expect(state.totalAllocatedQuote).toBe(0);
      expect(state.totalAllocatedBase).toBe(0);
    });
  });

  describe("getState", () => {
    it("returns current wallet state", async () => {
      repo.setWallet({
        totalAllocatedQuote: 50_000,
        totalAllocatedBase: 0.01,
        availableQuote: 150_000,
        availableBase: 0.04,
      });

      const state = await wallet.getState();
      expect(state.totalAllocatedQuote).toBe(50_000);
      expect(state.availableQuote).toBe(150_000);
    });
  });

  describe("concurrent allocation safety", () => {
    it("prevents double allocation via sequential requests on same pool", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 100_000,
        availableBase: 0,
      });

      const exp1 = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
      });
      const exp2 = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
      });

      // Allocate for both — only one should succeed since budget = gridConfig.budgetQuote = 100k
      const result1 = await wallet.allocateForExperiment(exp1, gridConfig);
      const result2 = await wallet.allocateForExperiment(exp2, gridConfig);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(false);

      const state = await wallet.getState();
      expect(state.totalAllocatedQuote).toBe(100_000);
      expect(state.availableQuote).toBe(0);
    });

    it("handles concurrent allocation and release correctly", async () => {
      repo.setWallet({
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 100_000,
        availableBase: 0,
      });

      const exp1 = await repo.createExperiment({
        status: "active",
        gridConfig,
        allocatedQuote: 0,
        allocatedBase: 0,
      });

      // Allocate
      const allocResult = await wallet.allocateForExperiment(exp1, gridConfig);
      expect(allocResult.success).toBe(true);

      // Release
      const releaseResult = await wallet.releaseForExperiment(exp1);
      expect(releaseResult.success).toBe(true);

      // Should be fully available again
      const state = await wallet.getState();
      expect(state.totalAllocatedQuote).toBe(0);
      expect(state.availableQuote).toBe(100_000);
    });
  });
});
