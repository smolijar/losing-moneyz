import type {
  AutopilotState,
  Experiment,
  ExperimentSnapshot,
  ExperimentStatus,
  OrderRecord,
  OrderStatus,
  WalletState,
} from "../config";

/**
 * Abstract storage repository interface.
 *
 * All storage operations go through this interface so we can:
 * 1. Mock it in unit tests (no Firestore dependency)
 * 2. Swap implementations if needed
 */
export interface Repository {
  // ─── Experiments ──────────────────────────────────────────────────────

  /** Get an experiment by ID. Returns undefined if not found. */
  getExperiment(experimentId: string): Promise<Experiment | undefined>;

  /** Get all experiments with a given status. */
  getExperimentsByStatus(status: ExperimentStatus): Promise<Experiment[]>;

  /** Create a new experiment. Returns the created experiment ID. */
  createExperiment(experiment: Omit<Experiment, "id" | "createdAt" | "updatedAt">): Promise<string>;

  /** Update an experiment's status and updatedAt. */
  updateExperimentStatus(experimentId: string, status: ExperimentStatus): Promise<void>;

  /** Update arbitrary fields on an experiment. */
  updateExperiment(experimentId: string, data: Partial<Experiment>): Promise<void>;

  /** Delete an experiment and its subcollections (orders, snapshots). */
  deleteExperiment(experimentId: string): Promise<void>;

  // ─── Orders ───────────────────────────────────────────────────────────

  /** Get all orders for an experiment. */
  getOrders(experimentId: string): Promise<OrderRecord[]>;

  /** Get orders for an experiment filtered by status. */
  getOrdersByStatus(experimentId: string, status: OrderStatus): Promise<OrderRecord[]>;

  /** Get an order by its Coinmate exchange order ID. Returns undefined if not found. */
  getOrderByCoinmateId(experimentId: string, coinmateOrderId: string): Promise<OrderRecord | undefined>;

  /** Create a new order record. Returns the order document ID. */
  createOrder(experimentId: string, order: Omit<OrderRecord, "id">): Promise<string>;

  /** Update an order's status (e.g., open → filled). */
  updateOrderStatus(
    experimentId: string,
    orderId: string,
    status: OrderStatus,
    filledAt?: Date,
  ): Promise<void>;

  /** Batch create multiple orders (for initial grid placement). */
  createOrders(experimentId: string, orders: Omit<OrderRecord, "id">[]): Promise<string[]>;

  // ─── Snapshots ────────────────────────────────────────────────────────

  /** Save a point-in-time snapshot for an experiment. */
  saveSnapshot(experimentId: string, snapshot: ExperimentSnapshot): Promise<void>;

  /** Get the most recent snapshot for an experiment. */
  getLatestSnapshot(experimentId: string): Promise<ExperimentSnapshot | undefined>;

  /**
   * Delete old snapshots, keeping only the most recent `keep` snapshots.
   * Returns the number of deleted snapshots.
   */
  pruneSnapshots(experimentId: string, keep: number): Promise<number>;

  /**
   * Delete filled/cancelled orders older than `olderThan`.
   * Open orders are never pruned.
   * Returns the number of deleted orders.
   */
  pruneOldOrders(experimentId: string, olderThan: Date): Promise<number>;

  // ─── Wallet (Global State) ────────────────────────────────────────────

  /** Get the current global wallet state. */
  getWalletState(): Promise<WalletState>;

  /** Update wallet state atomically (used inside transactions). */
  updateWalletState(state: Partial<WalletState>): Promise<void>;

  /**
   * Allocate budget from the global wallet to an experiment.
   * This must be atomic (transactional) to prevent over-allocation.
   * Returns true if allocation succeeded, false if insufficient funds.
   */
  allocateWallet(quoteDelta: number, baseDelta: number): Promise<boolean>;

  /**
   * Release budget back from an experiment to the global wallet.
   * Used when stopping/pausing an experiment.
   */
  releaseWallet(quoteDelta: number, baseDelta: number): Promise<void>;

  /**
   * Atomically release an experiment's allocation back to the wallet and zero
   * the experiment allocation fields.
   */
  releaseExperimentAllocation(
    experimentId: string,
  ): Promise<{ quoteReleased: number; baseReleased: number }>;

  /**
   * Run a callback inside a transaction (read-then-write atomicity).
   * Implementations that don't support real transactions (e.g. InMemory) may
   * simply execute the callback directly.
   */
  runTransaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T>;

  // ─── Autopilot State ─────────────────────────────────────────────────

  /** Get the current autopilot state. Returns undefined if never set. */
  getAutopilotState(): Promise<AutopilotState | undefined>;

  /** Update (or create) the autopilot state. */
  updateAutopilotState(state: Partial<AutopilotState>): Promise<void>;
}
