/**
 * CLI: Sync and validate wallet state
 *
 * Usage: pnpm wallet:sync
 *        pnpm wallet:sync --fix       Fix discrepancies
 *        pnpm wallet:sync --dry-run   Show what --fix would do without applying
 *
 * Recalculates expected wallet allocations by summing all active/paused experiment
 * budgets, then compares against the stored wallet state. Reports discrepancies.
 *
 * Requires Firebase credentials (see scripts/firebase-init.ts).
 */

import { getRepo } from "./firebase-init";

async function main() {
  const repo = getRepo();
  const dryRun = process.argv.includes("--dry-run");
  const fix = process.argv.includes("--fix") || dryRun;

  // Get all experiments (active + paused contribute to allocated wallet)
  const [active, paused, stopped] = await Promise.all([
    repo.getExperimentsByStatus("active"),
    repo.getExperimentsByStatus("paused"),
    repo.getExperimentsByStatus("stopped"),
  ]);

  const allocatingExperiments = [...active, ...paused];

  // Calculate expected totals
  let expectedAllocatedQuote = 0;
  let expectedAllocatedBase = 0;

  for (const exp of allocatingExperiments) {
    expectedAllocatedQuote += exp.allocatedQuote;
    expectedAllocatedBase += exp.allocatedBase;
  }

  // Get stored wallet state
  const wallet = await repo.getWalletState();

  console.log(`=== Wallet Sync ===`);
  console.log();
  console.log(`Experiments: ${allocatingExperiments.length} allocating (${active.length} active, ${paused.length} paused), ${stopped.length} stopped`);
  console.log();

  console.log(`--- Expected (from experiments) ---`);
  console.log(`  Allocated Quote: ${expectedAllocatedQuote.toLocaleString()} CZK`);
  console.log(`  Allocated Base:  ${expectedAllocatedBase.toFixed(8)} BTC`);
  console.log();

  console.log(`--- Stored (wallet state) ---`);
  console.log(`  Allocated Quote: ${wallet.totalAllocatedQuote.toLocaleString()} CZK`);
  console.log(`  Allocated Base:  ${wallet.totalAllocatedBase.toFixed(8)} BTC`);
  console.log(`  Available Quote: ${wallet.availableQuote.toLocaleString()} CZK`);
  console.log(`  Available Base:  ${wallet.availableBase.toFixed(8)} BTC`);
  console.log();

  // Check for discrepancies
  const quoteDiff = Math.abs(expectedAllocatedQuote - wallet.totalAllocatedQuote);
  const baseDiff = Math.abs(expectedAllocatedBase - wallet.totalAllocatedBase);
  const EPSILON = 0.01;

  let hasDiscrepancy = false;

  if (quoteDiff > EPSILON) {
    console.error(`DISCREPANCY: Quote allocation mismatch!`);
    console.error(`  Expected: ${expectedAllocatedQuote.toFixed(2)} CZK`);
    console.error(`  Stored:   ${wallet.totalAllocatedQuote.toFixed(2)} CZK`);
    console.error(`  Diff:     ${quoteDiff.toFixed(2)} CZK`);
    hasDiscrepancy = true;
  }

  if (baseDiff > 1e-8) {
    console.error(`DISCREPANCY: Base allocation mismatch!`);
    console.error(`  Expected: ${expectedAllocatedBase.toFixed(8)} BTC`);
    console.error(`  Stored:   ${wallet.totalAllocatedBase.toFixed(8)} BTC`);
    console.error(`  Diff:     ${baseDiff.toFixed(8)} BTC`);
    hasDiscrepancy = true;
  }

  if (hasDiscrepancy) {
    console.error();
    console.error("Wallet state is inconsistent! Run with --fix to update stored state.");

    if (fix) {
      console.log();

      // Recalculate available amounts: total balance stays the same,
      // available = (previous available + previous allocated) - new allocated
      const totalQuote = wallet.availableQuote + wallet.totalAllocatedQuote;
      const totalBase = wallet.availableBase + wallet.totalAllocatedBase;
      const newAvailableQuote = totalQuote - expectedAllocatedQuote;
      const newAvailableBase = totalBase - expectedAllocatedBase;

      if (dryRun) {
        console.log("[DRY RUN] Would update wallet state to:");
      } else {
        console.log("Fixing wallet state...");
        await repo.updateWalletState({
          totalAllocatedQuote: expectedAllocatedQuote,
          totalAllocatedBase: expectedAllocatedBase,
          availableQuote: newAvailableQuote,
          availableBase: newAvailableBase,
        });
        console.log("Wallet state updated:");
      }
      console.log(`  Allocated Quote: ${expectedAllocatedQuote.toLocaleString()} CZK`);
      console.log(`  Allocated Base:  ${expectedAllocatedBase.toFixed(8)} BTC`);
      console.log(`  Available Quote: ${newAvailableQuote.toLocaleString()} CZK`);
      console.log(`  Available Base:  ${newAvailableBase.toFixed(8)} BTC`);
    } else {
      process.exit(1);
    }
  } else {
    console.log("Wallet state is consistent. No discrepancies found.");
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
