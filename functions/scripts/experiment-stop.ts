/**
 * CLI: Stop an experiment (emergency stop)
 *
 * Usage: pnpm experiment:stop <experimentId>
 *        pnpm experiment:stop <experimentId> --yes  (skip confirmation)
 *
 * Sets the experiment status to "stopped". On the next grid tick, the orchestrator
 * will cancel all open orders and transition it to "paused".
 *
 * Requires Firebase credentials (see scripts/firebase-init.ts).
 */

import * as readline from "node:readline";
import { getRepo } from "./firebase-init";

/** Prompt the user for confirmation and return their answer. */
function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const skipConfirmation = args.includes("--yes") || args.includes("-y");
  const experimentId = args.find((a) => !a.startsWith("-"));

  if (!experimentId) {
    console.error("Usage: pnpm experiment:stop <experimentId> [--yes]");
    process.exit(1);
  }

  const repo = getRepo();

  const experiment = await repo.getExperiment(experimentId);
  if (!experiment) {
    console.error(`Experiment "${experimentId}" not found.`);
    process.exit(1);
  }

  if (experiment.status === "stopped") {
    console.log(`Experiment "${experimentId}" is already stopped.`);
    return;
  }

  if (experiment.status === "paused") {
    console.log(`Experiment "${experimentId}" is already paused. Setting to stopped for cleanup.`);
  }

  console.log(`Experiment: ${experimentId}`);
  console.log(`  Status: ${experiment.status}`);
  console.log(`  Pair:   ${experiment.gridConfig.pair}`);
  console.log(`  Grid:   ${experiment.gridConfig.lowerPrice} — ${experiment.gridConfig.upperPrice} (${experiment.gridConfig.levels} levels)`);
  console.log(`  Budget: ${experiment.gridConfig.budgetQuote} CZK`);
  console.log();

  if (!skipConfirmation) {
    const ok = await confirm("Are you sure you want to STOP this experiment? This will cancel all open orders. (y/N): ");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  console.log(`Stopping experiment "${experimentId}"...`);
  await repo.updateExperimentStatus(experimentId, "stopped");

  console.log(`Experiment "${experimentId}" set to "stopped".`);
  console.log("On the next grid tick, all open orders will be cancelled.");
  console.log("The experiment will then transition to \"paused\".");
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
