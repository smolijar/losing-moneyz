import type { GridConfig, WalletState } from "../config";
import type { Repository } from "./repository";

/** Result of a wallet operation */
export interface WalletOperationResult {
  success: boolean;
  reason?: string;
  walletState?: WalletState;
}

/**
 * Wallet Manager — soft isolation layer for concurrent experiments.
 *
 * Enforces that the sum of all experiment allocations never exceeds
 * the available balance. Uses transactional Firestore operations to
 * prevent race conditions between concurrent tick executions.
 */
export class WalletManager {
  constructor(private readonly repo: Repository) {}

  /**
   * Allocate budget for a new experiment.
   * Checks that sufficient quote currency is available.
   */
  async allocateForExperiment(
    experimentId: string,
    config: GridConfig,
  ): Promise<WalletOperationResult> {
    const quoteDelta = config.budgetQuote;
    const baseDelta = 0; // Grid bot starts with quote only

    const success = await this.repo.allocateWallet(quoteDelta, baseDelta);

    if (!success) {
      const wallet = await this.repo.getWalletState();
      return {
        success: false,
        reason:
          `Insufficient funds: need ${quoteDelta} quote, ` +
          `available ${wallet.availableQuote} quote`,
        walletState: wallet,
      };
    }

    // Update experiment with allocation
    await this.repo.updateExperiment(experimentId, {
      allocatedQuote: quoteDelta,
      allocatedBase: baseDelta,
    });

    const wallet = await this.repo.getWalletState();
    return { success: true, walletState: wallet };
  }

  /**
   * Release budget when an experiment is stopped.
   * Returns the allocated amounts back to the available pool.
   */
  async releaseForExperiment(experimentId: string): Promise<WalletOperationResult> {
    const experiment = await this.repo.getExperiment(experimentId);
    if (!experiment) {
      return { success: false, reason: `Experiment ${experimentId} not found` };
    }

    await this.repo.releaseWallet(experiment.allocatedQuote, experiment.allocatedBase);

    // Zero out experiment allocation
    await this.repo.updateExperiment(experimentId, {
      allocatedQuote: 0,
      allocatedBase: 0,
    });

    const wallet = await this.repo.getWalletState();
    return { success: true, walletState: wallet };
  }

  /**
   * Initialize the global wallet with actual exchange balances.
   * Called during setup or when syncing with Coinmate.
   */
  async initializeWallet(totalQuote: number, totalBase: number): Promise<void> {
    // Get current allocations to compute available
    const current = await this.repo.getWalletState();

    await this.repo.updateWalletState({
      availableQuote: totalQuote - current.totalAllocatedQuote,
      availableBase: totalBase - current.totalAllocatedBase,
      totalAllocatedQuote: current.totalAllocatedQuote,
      totalAllocatedBase: current.totalAllocatedBase,
    });
  }

  /**
   * Sync wallet state with actual Coinmate balances.
   * Detects discrepancies and returns them.
   */
  async syncWallet(
    actualQuote: number,
    actualBase: number,
  ): Promise<{
    discrepancy: boolean;
    quoteDiscrepancy: number;
    baseDiscrepancy: number;
    walletState: WalletState;
  }> {
    const wallet = await this.repo.getWalletState();
    const expectedQuote = wallet.availableQuote + wallet.totalAllocatedQuote;
    const expectedBase = wallet.availableBase + wallet.totalAllocatedBase;

    const quoteDiscrepancy = actualQuote - expectedQuote;
    const baseDiscrepancy = actualBase - expectedBase;

    // Update available to match actual minus allocated
    if (Math.abs(quoteDiscrepancy) > 0.01 || Math.abs(baseDiscrepancy) > 0.00000001) {
      await this.repo.updateWalletState({
        availableQuote: actualQuote - wallet.totalAllocatedQuote,
        availableBase: actualBase - wallet.totalAllocatedBase,
        totalAllocatedQuote: wallet.totalAllocatedQuote,
        totalAllocatedBase: wallet.totalAllocatedBase,
      });
    }

    const updated = await this.repo.getWalletState();
    return {
      discrepancy: Math.abs(quoteDiscrepancy) > 0.01 || Math.abs(baseDiscrepancy) > 0.00000001,
      quoteDiscrepancy,
      baseDiscrepancy,
      walletState: updated,
    };
  }

  /** Get current wallet state. */
  async getState(): Promise<WalletState> {
    return this.repo.getWalletState();
  }
}
