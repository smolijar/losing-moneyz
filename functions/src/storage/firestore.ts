import {
  Firestore,
  FieldValue,
  type DocumentReference,
  type CollectionReference,
} from "firebase-admin/firestore";
import {
  ExperimentDocSchema,
  ExperimentSnapshotDocSchema,
  OrderRecordDocSchema,
  WalletStateDocSchema,
  AutopilotStateDocSchema,
} from "../config";
import type {
  AutopilotState,
  Experiment,
  ExperimentSnapshot,
  ExperimentStatus,
  OrderRecord,
  OrderStatus,
  WalletState,
} from "../config";
import type { Repository } from "./repository";

const WALLET_DOC_PATH = "globalState/wallets";
const AUTOPILOT_DOC_PATH = "globalState/autopilot";

/**
 * Firestore-backed implementation of the Repository interface.
 *
 * Collection structure:
 *   /experiments/{experimentId}
 *   /experiments/{experimentId}/orders/{orderId}
 *   /experiments/{experimentId}/snapshots/{timestamp}
 *   /globalState/wallets
 */
export class FirestoreRepository implements Repository {
  constructor(private readonly db: Firestore) {}

  // ─── Experiments ──────────────────────────────────────────────────────

  async getExperiment(experimentId: string): Promise<Experiment | undefined> {
    const doc = await this.experimentsCol().doc(experimentId).get();
    if (!doc.exists) return undefined;
    return this.toExperiment(doc.id, doc.data()!);
  }

  async getExperimentsByStatus(status: ExperimentStatus): Promise<Experiment[]> {
    const snap = await this.experimentsCol().where("status", "==", status).get();
    return snap.docs.map((d) => this.toExperiment(d.id, d.data()));
  }

  async createExperiment(
    experiment: Omit<Experiment, "id" | "createdAt" | "updatedAt">,
  ): Promise<string> {
    const now = FieldValue.serverTimestamp();
    const ref = await this.experimentsCol().add({
      ...experiment,
      createdAt: now,
      updatedAt: now,
    });
    return ref.id;
  }

  async updateExperimentStatus(experimentId: string, status: ExperimentStatus): Promise<void> {
    await this.experimentsCol().doc(experimentId).update({
      status,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  async updateExperiment(experimentId: string, data: Partial<Experiment>): Promise<void> {
    await this.experimentsCol().doc(experimentId).update({
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // ─── Orders ───────────────────────────────────────────────────────────

  async getOrders(experimentId: string): Promise<OrderRecord[]> {
    const snap = await this.ordersCol(experimentId).get();
    return snap.docs.map((d) => this.toOrder(d.id, d.data()));
  }

  async getOrdersByStatus(experimentId: string, status: OrderStatus): Promise<OrderRecord[]> {
    const snap = await this.ordersCol(experimentId).where("status", "==", status).get();
    return snap.docs.map((d) => this.toOrder(d.id, d.data()));
  }

  async getOrderByCoinmateId(experimentId: string, coinmateOrderId: string): Promise<OrderRecord | undefined> {
    const snap = await this.ordersCol(experimentId)
      .where("coinmateOrderId", "==", coinmateOrderId)
      .limit(1)
      .get();
    if (snap.empty) return undefined;
    const doc = snap.docs[0];
    return this.toOrder(doc.id, doc.data());
  }

  async createOrder(experimentId: string, order: Omit<OrderRecord, "id">): Promise<string> {
    const ref = await this.ordersCol(experimentId).add({
      ...order,
      createdAt: order.createdAt ?? FieldValue.serverTimestamp(),
    });
    return ref.id;
  }

  async createOrders(
    experimentId: string,
    orders: Omit<OrderRecord, "id">[],
  ): Promise<string[]> {
    const batch = this.db.batch();
    const ids: string[] = [];

    for (const order of orders) {
      const ref = this.ordersCol(experimentId).doc();
      ids.push(ref.id);
      batch.set(ref, {
        ...order,
        createdAt: order.createdAt ?? FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();
    return ids;
  }

  async updateOrderStatus(
    experimentId: string,
    orderId: string,
    status: OrderStatus,
    filledAt?: Date,
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (filledAt) {
      update.filledAt = filledAt;
    }
    await this.ordersCol(experimentId).doc(orderId).update(update);
  }

  // ─── Snapshots ────────────────────────────────────────────────────────

  async saveSnapshot(experimentId: string, snapshot: ExperimentSnapshot): Promise<void> {
    const id = snapshot.timestamp.toISOString();
    await this.snapshotsCol(experimentId).doc(id).set(snapshot);
  }

  async getLatestSnapshot(experimentId: string): Promise<ExperimentSnapshot | undefined> {
    const snap = await this.snapshotsCol(experimentId)
      .orderBy("timestamp", "desc")
      .limit(1)
      .get();
    if (snap.empty) return undefined;
    const doc = snap.docs[0];
    return this.toSnapshot(doc.data());
  }

  async pruneSnapshots(experimentId: string, keep: number): Promise<number> {
    // Get all snapshots ordered by timestamp desc, skip the first `keep`
    const allSnaps = await this.snapshotsCol(experimentId)
      .orderBy("timestamp", "desc")
      .get();

    if (allSnaps.size <= keep) return 0;

    const toDelete = allSnaps.docs.slice(keep);
    // Firestore batch limit is 500, so process in chunks
    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += 500) {
      const chunk = toDelete.slice(i, i + 500);
      const batch = this.db.batch();
      for (const doc of chunk) {
        batch.delete(doc.ref);
      }
      await batch.commit();
      deleted += chunk.length;
    }
    return deleted;
  }

  async pruneOldOrders(experimentId: string, olderThan: Date): Promise<number> {
    // Query filled orders older than threshold
    const filledSnap = await this.ordersCol(experimentId)
      .where("status", "in", ["filled", "cancelled"])
      .where("createdAt", "<", olderThan)
      .get();

    if (filledSnap.empty) return 0;

    let deleted = 0;
    for (let i = 0; i < filledSnap.docs.length; i += 500) {
      const chunk = filledSnap.docs.slice(i, i + 500);
      const batch = this.db.batch();
      for (const doc of chunk) {
        batch.delete(doc.ref);
      }
      await batch.commit();
      deleted += chunk.length;
    }
    return deleted;
  }

  // ─── Wallet ───────────────────────────────────────────────────────────

  async getWalletState(): Promise<WalletState> {
    const doc = await this.walletDoc().get();
    if (!doc.exists) {
      return {
        totalAllocatedQuote: 0,
        totalAllocatedBase: 0,
        availableQuote: 0,
        availableBase: 0,
      };
    }
    return WalletStateDocSchema.parse(doc.data());
  }

  async updateWalletState(state: Partial<WalletState>): Promise<void> {
    await this.walletDoc().set(state, { merge: true });
  }

  async allocateWallet(quoteDelta: number, baseDelta: number): Promise<boolean> {
    return this.db.runTransaction(async (tx) => {
      const walletRef = this.walletDoc();
      const doc = await tx.get(walletRef);

      const current: WalletState = doc.exists
        ? WalletStateDocSchema.parse(doc.data())
        : {
            totalAllocatedQuote: 0,
            totalAllocatedBase: 0,
            availableQuote: 0,
            availableBase: 0,
          };

      // Check if sufficient funds
      if (current.availableQuote < quoteDelta || current.availableBase < baseDelta) {
        return false;
      }

      tx.set(
        walletRef,
        {
          totalAllocatedQuote: current.totalAllocatedQuote + quoteDelta,
          totalAllocatedBase: current.totalAllocatedBase + baseDelta,
          availableQuote: current.availableQuote - quoteDelta,
          availableBase: current.availableBase - baseDelta,
        },
        { merge: false },
      );

      return true;
    });
  }

  async releaseWallet(quoteDelta: number, baseDelta: number): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const walletRef = this.walletDoc();
      const doc = await tx.get(walletRef);

      const current: WalletState = doc.exists
        ? WalletStateDocSchema.parse(doc.data())
        : {
            totalAllocatedQuote: 0,
            totalAllocatedBase: 0,
            availableQuote: 0,
            availableBase: 0,
          };

      tx.set(
        walletRef,
        {
          totalAllocatedQuote: Math.max(0, current.totalAllocatedQuote - quoteDelta),
          totalAllocatedBase: Math.max(0, current.totalAllocatedBase - baseDelta),
          availableQuote: current.availableQuote + quoteDelta,
          availableBase: current.availableBase + baseDelta,
        },
        { merge: false },
      );
    });
  }

  async releaseExperimentAllocation(
    experimentId: string,
  ): Promise<{ quoteReleased: number; baseReleased: number }> {
    return this.db.runTransaction(async (tx) => {
      const walletRef = this.walletDoc();
      const experimentRef = this.experimentsCol().doc(experimentId);

      const [walletDoc, experimentDoc] = await Promise.all([tx.get(walletRef), tx.get(experimentRef)]);
      if (!experimentDoc.exists) {
        throw new Error(`Experiment ${experimentId} not found`);
      }

      const experiment = this.toExperiment(experimentDoc.id, experimentDoc.data()!);
      const current: WalletState = walletDoc.exists
        ? WalletStateDocSchema.parse(walletDoc.data())
        : {
            totalAllocatedQuote: 0,
            totalAllocatedBase: 0,
            availableQuote: 0,
            availableBase: 0,
          };

      const quoteReleased = experiment.allocatedQuote;
      const baseReleased = experiment.allocatedBase;

      tx.set(
        walletRef,
        {
          totalAllocatedQuote: Math.max(0, current.totalAllocatedQuote - quoteReleased),
          totalAllocatedBase: Math.max(0, current.totalAllocatedBase - baseReleased),
          availableQuote: current.availableQuote + quoteReleased,
          availableBase: current.availableBase + baseReleased,
        },
        { merge: false },
      );

      tx.update(experimentRef, {
        allocatedQuote: 0,
        allocatedBase: 0,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { quoteReleased, baseReleased };
    });
  }

  async runTransaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T> {
    // For Firestore, we pass `this` since individual methods already
    // use Firestore transactions where needed (wallet ops).
    // A full transactional repo wrapper would require deeper refactoring.
    return fn(this);
  }

  // ─── Autopilot ────────────────────────────────────────────────────────

  async getAutopilotState(): Promise<AutopilotState | undefined> {
    const doc = await this.autopilotDoc().get();
    if (!doc.exists) return undefined;
    return AutopilotStateDocSchema.parse(doc.data());
  }

  async updateAutopilotState(state: Partial<AutopilotState>): Promise<void> {
    await this.autopilotDoc().set(state, { merge: true });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private experimentsCol(): CollectionReference {
    return this.db.collection("experiments");
  }

  private ordersCol(experimentId: string): CollectionReference {
    return this.db.collection(`experiments/${experimentId}/orders`);
  }

  private snapshotsCol(experimentId: string): CollectionReference {
    return this.db.collection(`experiments/${experimentId}/snapshots`);
  }

  private walletDoc(): DocumentReference {
    return this.db.doc(WALLET_DOC_PATH);
  }

  private autopilotDoc(): DocumentReference {
    return this.db.doc(AUTOPILOT_DOC_PATH);
  }

  private toExperiment(id: string, data: Record<string, unknown>): Experiment {
    const parsed = ExperimentDocSchema.parse(data);
    return { id, ...parsed };
  }

  private toOrder(id: string, data: Record<string, unknown>): OrderRecord {
    const parsed = OrderRecordDocSchema.parse(data);
    return { id, ...parsed };
  }

  private toSnapshot(data: Record<string, unknown>): ExperimentSnapshot {
    return ExperimentSnapshotDocSchema.parse(data);
  }
}
