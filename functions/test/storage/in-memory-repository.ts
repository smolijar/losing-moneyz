import type {
  AutopilotState,
  Experiment,
  ExperimentSnapshot,
  ExperimentStatus,
  OrderRecord,
  OrderStatus,
  WalletState,
} from "../../src/config";
import type { Repository } from "../../src/storage";

/**
 * In-memory implementation of Repository for unit testing.
 * No Firestore dependency — all data stored in Maps.
 */
export class InMemoryRepository implements Repository {
  private experiments = new Map<string, Experiment>();
  private orders = new Map<string, Map<string, OrderRecord>>();
  private snapshots = new Map<string, ExperimentSnapshot[]>();
  private wallet: WalletState = {
    totalAllocatedQuote: 0,
    totalAllocatedBase: 0,
    availableQuote: 0,
    availableBase: 0,
  };
  private autopilotState: AutopilotState | undefined;
  private idCounter = 0;

  private nextId(): string {
    return `mock-${++this.idCounter}`;
  }

  // ─── Experiments ──────────────────────────────────────────────────────

  async getExperiment(experimentId: string): Promise<Experiment | undefined> {
    return this.experiments.get(experimentId);
  }

  async getExperimentsByStatus(status: ExperimentStatus): Promise<Experiment[]> {
    return [...this.experiments.values()].filter((e) => e.status === status);
  }

  async createExperiment(
    data: Omit<Experiment, "id" | "createdAt" | "updatedAt">,
  ): Promise<string> {
    const id = this.nextId();
    const now = new Date();
    const experiment: Experiment = {
      ...data,
      id,
      consecutiveFailures: data.consecutiveFailures ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.experiments.set(id, experiment);
    return id;
  }

  async updateExperimentStatus(experimentId: string, status: ExperimentStatus): Promise<void> {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`Experiment ${experimentId} not found`);
    exp.status = status;
    exp.updatedAt = new Date();
  }

  async updateExperiment(experimentId: string, data: Partial<Experiment>): Promise<void> {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`Experiment ${experimentId} not found`);
    Object.assign(exp, data, { updatedAt: new Date() });
  }

  async deleteExperiment(experimentId: string): Promise<void> {
    this.experiments.delete(experimentId);
    this.orders.delete(experimentId);
    this.snapshots.delete(experimentId);
  }

  // ─── Orders ───────────────────────────────────────────────────────────

  async getOrders(experimentId: string): Promise<OrderRecord[]> {
    const map = this.orders.get(experimentId);
    return map ? [...map.values()] : [];
  }

  async getOrdersByStatus(experimentId: string, status: OrderStatus): Promise<OrderRecord[]> {
    const all = await this.getOrders(experimentId);
    return all.filter((o) => o.status === status);
  }

  async getOrderByCoinmateId(experimentId: string, coinmateOrderId: string): Promise<OrderRecord | undefined> {
    const all = await this.getOrders(experimentId);
    return all.find((o) => o.coinmateOrderId === coinmateOrderId);
  }

  async createOrder(experimentId: string, order: Omit<OrderRecord, "id">): Promise<string> {
    const id = this.nextId();
    if (!this.orders.has(experimentId)) {
      this.orders.set(experimentId, new Map());
    }
    this.orders.get(experimentId)!.set(id, { ...order, id });
    return id;
  }

  async createOrders(
    experimentId: string,
    orders: Omit<OrderRecord, "id">[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const order of orders) {
      const id = await this.createOrder(experimentId, order);
      ids.push(id);
    }
    return ids;
  }

  async updateOrderStatus(
    experimentId: string,
    orderId: string,
    status: OrderStatus,
    filledAt?: Date,
  ): Promise<void> {
    const map = this.orders.get(experimentId);
    if (!map) throw new Error(`No orders for experiment ${experimentId}`);
    const order = map.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    order.status = status;
    if (filledAt) order.filledAt = filledAt;
  }

  // ─── Snapshots ────────────────────────────────────────────────────────

  async saveSnapshot(experimentId: string, snapshot: ExperimentSnapshot): Promise<void> {
    if (!this.snapshots.has(experimentId)) {
      this.snapshots.set(experimentId, []);
    }
    this.snapshots.get(experimentId)!.push(snapshot);
  }

  async getLatestSnapshot(experimentId: string): Promise<ExperimentSnapshot | undefined> {
    const snaps = this.snapshots.get(experimentId);
    if (!snaps || snaps.length === 0) return undefined;
    return [...snaps].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
  }

  async pruneSnapshots(experimentId: string, keep: number): Promise<number> {
    const snaps = this.snapshots.get(experimentId);
    if (!snaps || snaps.length <= keep) return 0;
    const sorted = [...snaps].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const toKeep = sorted.slice(0, keep);
    const deleted = snaps.length - toKeep.length;
    this.snapshots.set(experimentId, toKeep);
    return deleted;
  }

  async pruneOldOrders(experimentId: string, olderThan: Date): Promise<number> {
    const map = this.orders.get(experimentId);
    if (!map) return 0;
    let deleted = 0;
    for (const [id, order] of map) {
      if (order.status === "open") continue; // never prune open orders
      if (order.createdAt < olderThan) {
        map.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  // ─── Wallet ───────────────────────────────────────────────────────────

  async getWalletState(): Promise<WalletState> {
    return { ...this.wallet };
  }

  async updateWalletState(state: Partial<WalletState>): Promise<void> {
    Object.assign(this.wallet, state);
  }

  async allocateWallet(quoteDelta: number, baseDelta: number): Promise<boolean> {
    if (this.wallet.availableQuote < quoteDelta || this.wallet.availableBase < baseDelta) {
      return false;
    }
    this.wallet.totalAllocatedQuote += quoteDelta;
    this.wallet.totalAllocatedBase += baseDelta;
    this.wallet.availableQuote -= quoteDelta;
    this.wallet.availableBase -= baseDelta;
    return true;
  }

  async releaseWallet(quoteDelta: number, baseDelta: number): Promise<void> {
    this.wallet.totalAllocatedQuote = Math.max(0, this.wallet.totalAllocatedQuote - quoteDelta);
    this.wallet.totalAllocatedBase = Math.max(0, this.wallet.totalAllocatedBase - baseDelta);
    this.wallet.availableQuote += quoteDelta;
    this.wallet.availableBase += baseDelta;
  }

  async releaseExperimentAllocation(
    experimentId: string,
  ): Promise<{ quoteReleased: number; baseReleased: number }> {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`Experiment ${experimentId} not found`);

    const quoteReleased = exp.allocatedQuote;
    const baseReleased = exp.allocatedBase;

    this.wallet.totalAllocatedQuote = Math.max(0, this.wallet.totalAllocatedQuote - quoteReleased);
    this.wallet.totalAllocatedBase = Math.max(0, this.wallet.totalAllocatedBase - baseReleased);
    this.wallet.availableQuote += quoteReleased;
    this.wallet.availableBase += baseReleased;

    exp.allocatedQuote = 0;
    exp.allocatedBase = 0;
    exp.updatedAt = new Date();

    return { quoteReleased, baseReleased };
  }

  async runTransaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T> {
    // InMemory implementation: just execute directly (no real transaction support)
    return fn(this);
  }

  // ─── Autopilot ────────────────────────────────────────────────────────

  async getAutopilotState(): Promise<AutopilotState | undefined> {
    return this.autopilotState ? { ...this.autopilotState } : undefined;
  }

  async updateAutopilotState(state: Partial<AutopilotState>): Promise<void> {
    if (!this.autopilotState) {
      this.autopilotState = {
        lastActionAt: new Date(),
        lastConfig: null,
        lastReason: "",
        enabled: true,
        consecutiveRecycles: 0,
        ...state,
      };
    } else {
      Object.assign(this.autopilotState, state);
    }
  }

  // ─── Test helpers ─────────────────────────────────────────────────────

  /** Set initial wallet state for testing */
  setWallet(state: WalletState): void {
    this.wallet = { ...state };
  }

  /** Reset all data */
  reset(): void {
    this.experiments.clear();
    this.orders.clear();
    this.snapshots.clear();
    this.wallet = {
      totalAllocatedQuote: 0,
      totalAllocatedBase: 0,
      availableQuote: 0,
      availableBase: 0,
    };
    this.autopilotState = undefined;
    this.idCounter = 0;
  }
}
