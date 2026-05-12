/**
 * CLI: Heal wallet/experiment allocation drift by trusting the exchange.
 *
 * Usage:
 *   pnpm wallet:heal --dry-run    Show what would change
 *   pnpm wallet:heal --apply      Apply changes
 *
 * Recovers from drift where persisted experiment.allocatedBase/Quote disagrees
 * with what's actually reserved on the exchange. Strategy:
 *
 *   1. Query exchange balances (available + reserved per currency).
 *   2. Sum allocations across active+paused experiments to get current weights.
 *   3. Rewrite each experiment's allocatedBase/Quote so the sum equals what's
 *      reserved on exchange, distributing proportionally to current weights.
 *   4. Rewrite global wallet state so available* = exchange.available* and
 *      totalAllocated* = exchange.reserved*.
 *
 * Requires Coinmate creds (COINMATE_CLIENT_ID/PUBLIC_KEY/PRIVATE_KEY) AND
 * Firebase creds (.service-account.json or GOOGLE_APPLICATION_CREDENTIALS).
 */

import { CoinmateClient } from "../src/coinmate/client";
import { getRepo } from "./firebase-init";

const QUOTE_EPSILON = 0.01;
const BASE_EPSILON = 1e-8;

async function main() {
  const dry = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (!dry && !apply) {
    console.error("Specify --dry-run or --apply");
    process.exit(1);
  }

  const clientId = process.env.COINMATE_CLIENT_ID;
  const publicKey = process.env.COINMATE_PUBLIC_KEY;
  const privateKey = process.env.COINMATE_PRIVATE_KEY;
  if (!clientId || !publicKey || !privateKey) {
    console.error("Missing COINMATE_{CLIENT_ID,PUBLIC_KEY,PRIVATE_KEY} env vars");
    process.exit(1);
  }
  const client = new CoinmateClient({ credentials: { clientId, publicKey, privateKey } });
  const repo = getRepo();

  // 1. Exchange truth
  const balances = await client.getBalances();
  const czkAvailable = balances.data["CZK"]?.available ?? 0;
  const czkReserved = balances.data["CZK"]?.reserved ?? 0;
  const btcAvailable = balances.data["BTC"]?.available ?? 0;
  const btcReserved = balances.data["BTC"]?.reserved ?? 0;

  console.log("=== Exchange truth ===");
  console.log(`  CZK: available=${czkAvailable.toFixed(2)}  reserved=${czkReserved.toFixed(2)}`);
  console.log(`  BTC: available=${btcAvailable.toFixed(8)}  reserved=${btcReserved.toFixed(8)}`);

  // 2. Persisted state
  const [active, paused] = await Promise.all([
    repo.getExperimentsByStatus("active"),
    repo.getExperimentsByStatus("paused"),
  ]);
  const allocating = [...active, ...paused];
  const wallet = await repo.getWalletState();

  const sumQuote = allocating.reduce((s, e) => s + e.allocatedQuote, 0);
  const sumBase = allocating.reduce((s, e) => s + e.allocatedBase, 0);

  console.log();
  console.log("=== Persisted state ===");
  console.log(`  Experiments allocating: ${allocating.length}`);
  console.log(`  Sum allocatedQuote: ${sumQuote.toFixed(2)}`);
  console.log(`  Sum allocatedBase:  ${sumBase.toFixed(8)}`);
  console.log(`  wallet.totalAllocatedQuote: ${wallet.totalAllocatedQuote.toFixed(2)}`);
  console.log(`  wallet.totalAllocatedBase:  ${wallet.totalAllocatedBase.toFixed(8)}`);
  console.log(`  wallet.availableQuote:      ${wallet.availableQuote.toFixed(2)}`);
  console.log(`  wallet.availableBase:       ${wallet.availableBase.toFixed(8)}`);

  // 3. Compute target allocations per experiment (proportional to current weights)
  //    If sum is zero, distribute equally.
  const updates: Array<{
    id: string;
    fromQuote: number;
    toQuote: number;
    fromBase: number;
    toBase: number;
  }> = [];

  for (const exp of allocating) {
    const weightQ = sumQuote > 0 ? exp.allocatedQuote / sumQuote : 1 / allocating.length;
    const weightB = sumBase > 0 ? exp.allocatedBase / sumBase : 1 / allocating.length;
    const targetQuote = czkReserved * weightQ;
    const targetBase = btcReserved * weightB;
    updates.push({
      id: exp.id,
      fromQuote: exp.allocatedQuote,
      toQuote: targetQuote,
      fromBase: exp.allocatedBase,
      toBase: targetBase,
    });
  }

  console.log();
  console.log("=== Per-experiment changes ===");
  for (const u of updates) {
    const dq = u.toQuote - u.fromQuote;
    const db = u.toBase - u.fromBase;
    const changedQ = Math.abs(dq) > QUOTE_EPSILON;
    const changedB = Math.abs(db) > BASE_EPSILON;
    console.log(`  ${u.id}`);
    console.log(
      `    quote: ${u.fromQuote.toFixed(2)} -> ${u.toQuote.toFixed(2)}` +
        (changedQ ? `  (Δ ${dq >= 0 ? "+" : ""}${dq.toFixed(2)})` : "  (unchanged)"),
    );
    console.log(
      `    base:  ${u.fromBase.toFixed(8)} -> ${u.toBase.toFixed(8)}` +
        (changedB ? `  (Δ ${db >= 0 ? "+" : ""}${db.toFixed(8)})` : "  (unchanged)"),
    );
  }

  // 4. New global wallet state
  const newWallet = {
    availableQuote: czkAvailable,
    availableBase: btcAvailable,
    totalAllocatedQuote: czkReserved,
    totalAllocatedBase: btcReserved,
  };
  console.log();
  console.log("=== New wallet state ===");
  console.log(`  availableQuote:      ${newWallet.availableQuote.toFixed(2)}`);
  console.log(`  availableBase:       ${newWallet.availableBase.toFixed(8)}`);
  console.log(`  totalAllocatedQuote: ${newWallet.totalAllocatedQuote.toFixed(2)}`);
  console.log(`  totalAllocatedBase:  ${newWallet.totalAllocatedBase.toFixed(8)}`);

  if (dry) {
    console.log();
    console.log("[DRY RUN] No changes applied. Re-run with --apply to commit.");
    return;
  }

  console.log();
  console.log("Applying changes...");
  for (const u of updates) {
    await repo.updateExperiment(u.id, {
      allocatedQuote: u.toQuote,
      allocatedBase: u.toBase,
    });
  }
  await repo.updateWalletState(newWallet);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
