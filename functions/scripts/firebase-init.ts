/**
 * Shared Firebase Admin initialization for CLI scripts.
 *
 * Usage: import { getRepo } from "./firebase-init";
 *
 * Uses the service account key at scripts/../.service-account.json by default,
 * or GOOGLE_APPLICATION_CREDENTIALS if set.
 */

import * as path from "node:path";
import { initializeApp, getApps, cert, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreRepository } from "../src/storage";

const DEFAULT_SA_PATH = path.resolve(__dirname, "../.service-account.json");

export function getRepo(): FirestoreRepository {
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? DEFAULT_SA_PATH;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const serviceAccount = require(credPath) as ServiceAccount;
    initializeApp({ credential: cert(serviceAccount) });
  }
  const db = getFirestore();
  return new FirestoreRepository(db);
}
