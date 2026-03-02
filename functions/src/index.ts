import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { CoinmateClient } from "./coinmate";
import { RateLimiter } from "./coinmate/rate-limiter";
import { FirestoreRepository, WalletManager } from "./storage";
import { GridTickOrchestrator, type Logger } from "./tick";

// Initialize Firebase Admin (idempotent)
if (getApps().length === 0) {
  initializeApp();
}

/** Adapter: Firebase logger → orchestrator Logger interface */
const tickLogger: Logger = {
  info: (msg, data) => logger.info(msg, data),
  warn: (msg, data) => logger.warn(msg, data),
  error: (msg, data) => logger.error(msg, data),
};

// ─── GCP Secret Manager secret names ───────────────────────────────────────
// These are referenced in the function options below. Firebase automatically
// injects them as process.env.<SECRET_NAME> at runtime.

const COINMATE_SECRETS = [
  "COINMATE_CLIENT_ID",
  "COINMATE_PUBLIC_KEY",
  "COINMATE_PRIVATE_KEY",
];

// ─── Module-level lazy singletons ──────────────────────────────────────────
// Reuse across warm invocations to avoid re-creating on every request.

let _rateLimiter: RateLimiter | undefined;
let _coinmateClient: CoinmateClient | undefined;

function getCoinmateClient(): CoinmateClient {
  const clientId = process.env.COINMATE_CLIENT_ID;
  const publicKey = process.env.COINMATE_PUBLIC_KEY;
  const privateKey = process.env.COINMATE_PRIVATE_KEY;

  if (!clientId || !publicKey || !privateKey) {
    throw new Error("Missing Coinmate API credentials in environment");
  }

  if (!_rateLimiter) {
    _rateLimiter = new RateLimiter();
  }
  if (!_coinmateClient) {
    _coinmateClient = new CoinmateClient({
      credentials: { clientId, publicKey, privateKey },
      rateLimiter: _rateLimiter,
    });
  }
  return _coinmateClient;
}

/** Shared tick execution logic used by both the scheduler and HTTP triggers. */
async function executeGridTick() {
  logger.info("Grid tick triggered");

  const client = getCoinmateClient();
  const db = getFirestore();
  const repo = new FirestoreRepository(db);
  const walletManager = new WalletManager(repo);
  const orchestrator = new GridTickOrchestrator(client, repo, tickLogger, {
    walletManager,
  });

  return orchestrator.executeTick();
}

/**
 * Scheduled grid tick — triggered by Cloud Scheduler every 2 minutes.
 * The scheduler job is auto-provisioned on `firebase deploy`.
 */
export const gridTick = onSchedule(
  {
    schedule: "every 2 minutes",
    timeZone: "UTC",
    timeoutSeconds: 60,
    memory: "256MiB",
    region: "europe-west1",
    maxInstances: 1,
    retryCount: 0,
    secrets: COINMATE_SECRETS,
  },
  async () => {
    try {
      const result = await executeGridTick();
      logger.info("Grid tick completed", {
        durationMs: result.totalDurationMs,
        experiments: result.experimentResults.length,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Grid tick failed", { error: errMsg });
      throw err;
    }
  },
);

/**
 * HTTP endpoint for manual tick invocation and debugging.
 * Call via: curl https://<region>-<project>.cloudfunctions.net/gridTickHttp
 */
export const gridTickHttp = onRequest(
  {
    timeoutSeconds: 60,
    memory: "256MiB",
    region: "europe-west1",
    maxInstances: 1,
    secrets: COINMATE_SECRETS,
  },
  async (_req, res) => {
    try {
      const result = await executeGridTick();

      res.json({
        status: "ok",
        timestamp: result.timestamp.toISOString(),
        durationMs: result.totalDurationMs,
        experiments: result.experimentResults.map((r) => ({
          id: r.experimentId,
          status: r.status,
          ordersPlaced: r.ordersPlaced,
          ordersCancelled: r.ordersCancelled,
          fillsDetected: r.fillsDetected,
          warnings: r.warnings,
          error: r.error,
        })),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Grid tick failed", { error: errMsg });
      res.status(500).json({
        status: "error",
        message: errMsg,
      });
    }
  },
);
