/**
 * CLI: Clean up paused experiments with zero allocation.
 *
 * Usage: pnpm experiment:cleanup           (dry run — shows what would be deleted)
 *        pnpm experiment:cleanup --yes     (actually delete)
 *
 * Deletes paused experiments where allocatedQuote == 0 and allocatedBase == 0,
 * along with their subcollections (orders, snapshots). These accumulate when the
 * supervisor/autopilot cycles through experiments and are no longer useful.
 *
 * Requires Firebase credentials (see scripts/firebase-init.ts).
 */

import { getRepo } from "./firebase-init";
import { getFirestore } from "firebase-admin/firestore";

async function deleteSubcollection(
  db: FirebaseFirestore.Firestore,
  collectionPath: string,
): Promise<number> {
  const snap = await db.collection(collectionPath).limit(500).get();
  if (snap.empty) return 0;

  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();
  return snap.size + (snap.size === 500 ? await deleteSubcollection(db, collectionPath) : 0);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--yes") && !args.includes("-y");

  const repo = getRepo();
  const db = getFirestore();

  const paused = await repo.getExperimentsByStatus("paused");
  const candidates = paused.filter(
    (exp) => exp.allocatedQuote === 0 && exp.allocatedBase === 0,
  );

  console.log(`Found ${paused.length} paused experiments, ${candidates.length} with zero allocation.`);

  if (candidates.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  if (dryRun) {
    console.log("\nDRY RUN — the following experiments would be deleted:");
    for (const exp of candidates) {
      console.log(`  ${exp.id}  (${exp.gridConfig.pair}, budget ${exp.gridConfig.budgetQuote} CZK)`);
    }
    console.log(`\nRun with --yes to actually delete ${candidates.length} experiments.`);
    return;
  }

  let deleted = 0;
  let ordersDeleted = 0;
  let snapshotsDeleted = 0;

  for (const exp of candidates) {
    // Delete subcollections first
    const oCount = await deleteSubcollection(db, `experiments/${exp.id}/orders`);
    const sCount = await deleteSubcollection(db, `experiments/${exp.id}/snapshots`);
    ordersDeleted += oCount;
    snapshotsDeleted += sCount;

    // Delete the experiment document
    await db.collection("experiments").doc(exp.id).delete();
    deleted++;

    if (deleted % 10 === 0) {
      console.log(`  ...deleted ${deleted}/${candidates.length}`);
    }
  }

  console.log(`\nDone. Deleted ${deleted} experiments, ${ordersDeleted} orders, ${snapshotsDeleted} snapshots.`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
