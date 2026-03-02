/**
 * Shared Firebase Admin initialization for CLI scripts.
 *
 * Usage: import { getRepo } from "./firebase-init";
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS environment variable pointing to
 * a service account JSON file, or running in a GCP environment.
 */

import { initializeApp, getApps, cert, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreRepository } from "../src/storage";

export function getRepo(): FirestoreRepository {
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const serviceAccount = require(credPath) as ServiceAccount;
      initializeApp({ credential: cert(serviceAccount) });
    } else {
      // Fallback: Application Default Credentials (e.g., running on GCP)
      initializeApp();
    }
  }
  const db = getFirestore();
  return new FirestoreRepository(db);
}
