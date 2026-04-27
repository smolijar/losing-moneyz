/**
 * CLI: Reset autopilot exponential backoff counter.
 *
 * Usage: pnpm tsx scripts/autopilot-reset-cooldown.ts
 *
 * Sets `consecutiveRecycles` to 0 and clears `lastActionAt` so the autopilot
 * can engage on the next grid tick. Use after fixing the underlying cause of
 * a recycle loop so we don't have to wait out a multi-hour exponential
 * backoff that no longer reflects real risk.
 */

import { getRepo } from "./firebase-init";

async function main() {
  const repo = getRepo();
  const before = await repo.getAutopilotState();
  console.log("Before:", {
    consecutiveRecycles: before?.consecutiveRecycles,
    lastActionAt: before?.lastActionAt?.toISOString(),
    lastReason: before?.lastReason,
  });

  await repo.updateAutopilotState({
    consecutiveRecycles: 0,
    lastReason: "manual cooldown reset",
  });

  const after = await repo.getAutopilotState();
  console.log("After:", {
    consecutiveRecycles: after?.consecutiveRecycles,
    lastActionAt: after?.lastActionAt?.toISOString(),
    lastReason: after?.lastReason,
  });
  console.log("Cooldown reset. Autopilot will engage on next tick.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
