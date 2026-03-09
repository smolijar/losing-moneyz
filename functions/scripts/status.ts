/**
 * CLI: Show experiment status with P&L
 *
 * Usage: pnpm status
 *
 * Lists all experiments with their current status, grid config, allocated
 * budget, latest snapshot (P&L, open orders, current price), and wallet state.
 *
 * Requires Firebase credentials (see scripts/firebase-init.ts).
 */

import { getRepo } from "./firebase-init";

async function main() {
  const repo = getRepo();

  // Fetch all experiments (active, paused, stopped)
  const [active, paused, stopped] = await Promise.all([
    repo.getExperimentsByStatus("active"),
    repo.getExperimentsByStatus("paused"),
    repo.getExperimentsByStatus("stopped"),
  ]);

  const allExperiments = [...active, ...paused, ...stopped];

  if (allExperiments.length === 0) {
    console.log("No experiments found.");
    console.log();
    console.log("Create one by adding a document to Firestore /experiments collection.");
    return;
  }

  console.log(`=== Grid Trading Bot Status ===`);
  console.log(`Total experiments: ${allExperiments.length} (${active.length} active, ${paused.length} paused, ${stopped.length} stopped)`);
  console.log();

  for (const exp of allExperiments) {
    const statusIcon =
      exp.status === "active" ? "[ACTIVE]" :
      exp.status === "paused" ? "[PAUSED]" :
      "[STOPPED]";

    console.log(`${statusIcon} ${exp.id}`);
    console.log(`  Pair:     ${exp.gridConfig.pair}`);
    console.log(`  Grid:     ${exp.gridConfig.lowerPrice.toLocaleString()} — ${exp.gridConfig.upperPrice.toLocaleString()} (${exp.gridConfig.levels} levels)`);
    console.log(`  Budget:   ${exp.gridConfig.budgetQuote.toLocaleString()} CZK`);
    console.log(`  Alloc:    ${exp.allocatedQuote.toLocaleString()} CZK / ${exp.allocatedBase} BTC`);

    // Latest snapshot
    const snapshot = await repo.getLatestSnapshot(exp.id);
    if (snapshot) {
      console.log(`  --- Latest Snapshot (${snapshot.timestamp.toISOString()}) ---`);
      console.log(`  Price:    ${snapshot.currentPrice.toLocaleString()} CZK`);
      console.log(`  Open:     ${snapshot.openOrders} orders`);
      console.log(`  P&L:      realized ${snapshot.realizedPnl.toFixed(2)} CZK / unrealized ${snapshot.unrealizedPnl.toFixed(2)} CZK`);
      console.log(`  Balance:  ${snapshot.balanceQuote.toFixed(2)} CZK / ${snapshot.balanceBase.toFixed(8)} BTC`);
    } else {
      console.log(`  (no snapshots yet)`);
    }

    // Open orders count
    const openOrders = await repo.getOrdersByStatus(exp.id, "open");
    const filledOrders = await repo.getOrdersByStatus(exp.id, "filled");
    console.log(`  Orders:   ${openOrders.length} open, ${filledOrders.length} filled`);
    console.log();
  }

  // Global wallet
  const wallet = await repo.getWalletState();
  console.log(`=== Wallet ===`);
  console.log(`  Allocated: ${wallet.totalAllocatedQuote.toLocaleString()} CZK / ${wallet.totalAllocatedBase} BTC`);
  console.log(`  Available: ${wallet.availableQuote.toLocaleString()} CZK / ${wallet.availableBase} BTC`);

  const autopilotState = await repo.getAutopilotState();
  if (autopilotState) {
    console.log();
    console.log(`=== Supervisor ===`);
    console.log(`  Enabled:   ${autopilotState.enabled ? "yes" : "no"}`);
    if (autopilotState.lastReason) {
      console.log(`  Reason:    ${autopilotState.lastReason}`);
    }
    if (autopilotState.lastSupervisorDecision) {
      console.log(`  Decision:  ${autopilotState.lastSupervisorDecision}`);
    }
    if (autopilotState.lastCapitalIncreasePercent !== undefined) {
      console.log(`  Capital+:  ${autopilotState.lastCapitalIncreasePercent.toFixed(2)}%`);
    }
    if (autopilotState.lastActionAt) {
      console.log(`  Last act:  ${autopilotState.lastActionAt.toISOString()}`);
    }
    if (autopilotState.lastReplacementAt) {
      console.log(`  Last swap: ${autopilotState.lastReplacementAt.toISOString()}`);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
