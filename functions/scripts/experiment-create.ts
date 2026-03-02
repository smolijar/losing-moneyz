/**
 * CLI: Create a new grid trading experiment
 *
 * Usage:
 *   pnpm experiment:create --pair BTC_CZK --lower 2000000 --upper 2400000 --levels 5 --budget 100000
 *   pnpm experiment:create --pair BTC_CZK --lower 2000000 --upper 2400000 --levels 5 --budget 100000 --yes
 *
 * Options:
 *   --pair      Trading pair (default: BTC_CZK)
 *   --lower     Lower price boundary
 *   --upper     Upper price boundary
 *   --levels    Number of grid levels (min 3)
 *   --budget    Total budget in quote currency
 *   --wallet    Initialize wallet with this total quote amount (first-time setup)
 *   --yes / -y  Skip confirmation prompt
 *
 * If the global wallet has not been initialized yet, you must pass --wallet to set
 * the total available quote balance. On subsequent runs the wallet is already set.
 *
 * Requires Firebase credentials (see scripts/firebase-init.ts).
 */

import * as readline from "node:readline";
import { getRepo } from "./firebase-init";
import { GridConfig, TradingPair } from "../src/config";
import { validateGridConfig } from "../src/grid";
import { WalletManager } from "../src/storage";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      args.set(arg.slice(2), argv[i + 1]);
      i++;
    } else if (arg === "-y") {
      args.set("yes", "true");
    } else if (arg === "--yes") {
      args.set("yes", "true");
    }
  }
  return args;
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

function usage(): never {
  console.log(`
Usage:
  pnpm experiment:create --pair BTC_CZK --lower <price> --upper <price> --levels <n> --budget <amount> [--wallet <total>] [--yes]

Required:
  --lower     Lower price boundary (quote currency)
  --upper     Upper price boundary (quote currency)
  --levels    Number of grid levels (min 3)
  --budget    Total budget for this experiment (quote currency)

Optional:
  --pair      Trading pair (default: BTC_CZK)
  --wallet    Initialize the global wallet with this total quote amount (first-time setup)
  --yes, -y   Skip confirmation prompt

Example:
  pnpm experiment:create --lower 2000000 --upper 2400000 --levels 5 --budget 100000 --wallet 200000
`.trim());
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const skipConfirmation = args.has("yes");

  // Parse required arguments
  const lowerStr = args.get("lower");
  const upperStr = args.get("upper");
  const levelsStr = args.get("levels");
  const budgetStr = args.get("budget");

  if (!lowerStr || !upperStr || !levelsStr || !budgetStr) {
    console.error("Error: --lower, --upper, --levels, and --budget are required.\n");
    usage();
  }

  const pair = args.get("pair") ?? "BTC_CZK";
  const lower = Number(lowerStr);
  const upper = Number(upperStr);
  const levels = Number(levelsStr);
  const budget = Number(budgetStr);
  const walletInit = args.get("wallet") ? Number(args.get("wallet")) : undefined;

  // Validate pair
  const pairResult = TradingPair.safeParse(pair);
  if (!pairResult.success) {
    console.error(`Error: Invalid trading pair "${pair}". Valid pairs: ${TradingPair.options.join(", ")}`);
    process.exit(1);
  }

  // Validate grid config via Zod schema
  const configResult = GridConfig.safeParse({
    pair: pairResult.data,
    lowerPrice: lower,
    upperPrice: upper,
    levels,
    budgetQuote: budget,
  });

  if (!configResult.success) {
    console.error("Error: Invalid grid config:");
    for (const issue of configResult.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const config = configResult.data;

  // Validate grid parameters (spacing, budget per level, minimums)
  const midPrice = (config.lowerPrice + config.upperPrice) / 2;
  const validation = validateGridConfig(config, midPrice);
  if (!validation.valid) {
    console.error("Error: Grid config validation failed:");
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  if (validation.warnings.length > 0) {
    console.log("Warnings:");
    for (const warn of validation.warnings) {
      console.log(`  - ${warn}`);
    }
  }

  // Connect to Firestore
  const repo = getRepo();
  const walletManager = new WalletManager(repo);

  // Initialize wallet if requested
  if (walletInit !== undefined) {
    if (walletInit <= 0) {
      console.error("Error: --wallet amount must be positive.");
      process.exit(1);
    }
    console.log(`Initializing global wallet with ${walletInit} quote...`);
    await walletManager.initializeWallet(walletInit, 0);
    console.log("Wallet initialized.");
  }

  // Check wallet state
  const walletState = await walletManager.getState();
  const totalAvailable = walletState.availableQuote;

  if (totalAvailable === 0 && walletInit === undefined) {
    console.error(
      "Error: Global wallet has 0 available quote. Use --wallet <amount> to initialize it first.",
    );
    process.exit(1);
  }

  if (budget > totalAvailable) {
    console.error(
      `Error: Insufficient wallet funds. Need ${budget} quote, available: ${totalAvailable} quote.`,
    );
    process.exit(1);
  }

  // Display summary
  const spacing = (config.upperPrice - config.lowerPrice) / (config.levels - 1);
  const spacingPct = (spacing / config.lowerPrice) * 100;
  const budgetPerLevel = config.budgetQuote / (config.levels - 1);

  console.log();
  console.log("=== New Experiment ===");
  console.log(`  Pair:             ${config.pair}`);
  console.log(`  Lower price:      ${config.lowerPrice.toLocaleString()}`);
  console.log(`  Upper price:      ${config.upperPrice.toLocaleString()}`);
  console.log(`  Levels:           ${config.levels}`);
  console.log(`  Grid spacing:     ${spacing.toLocaleString()} (${spacingPct.toFixed(2)}%)`);
  console.log(`  Budget (total):   ${config.budgetQuote.toLocaleString()}`);
  console.log(`  Budget per level: ${budgetPerLevel.toLocaleString()}`);
  console.log();
  console.log("=== Wallet ===");
  console.log(`  Available quote:  ${totalAvailable.toLocaleString()}`);
  console.log(`  After allocation: ${(totalAvailable - budget).toLocaleString()}`);
  console.log();

  if (!skipConfirmation) {
    const ok = await confirm("Create this experiment and allocate funds? (y/N): ");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  // Create experiment
  console.log("Creating experiment...");
  const experimentId = await repo.createExperiment({
    status: "active",
    gridConfig: config,
    allocatedQuote: 0, // Will be set by walletManager.allocateForExperiment
    allocatedBase: 0,
    consecutiveFailures: 0,
  });

  // Allocate wallet
  const allocResult = await walletManager.allocateForExperiment(experimentId, config);
  if (!allocResult.success) {
    // Rollback: set experiment to stopped
    console.error(`Wallet allocation failed: ${allocResult.reason}`);
    console.error("Setting experiment to stopped...");
    await repo.updateExperimentStatus(experimentId, "stopped");
    process.exit(1);
  }

  console.log();
  console.log(`Experiment created: ${experimentId}`);
  console.log(`Status: active`);
  console.log(`Allocated: ${config.budgetQuote} quote`);
  console.log();
  console.log("The grid tick will pick up this experiment on its next run (within 2 minutes).");
  console.log(`To stop: pnpm experiment:stop ${experimentId}`);
  console.log(`To view: pnpm status`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
