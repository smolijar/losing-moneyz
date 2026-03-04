import { z } from "zod";

// ─── Branded types ────────────────────────────────────────────────────────────
// These provide compile-time safety to prevent mixing up numeric/string values
// that represent different domain concepts. They are structurally compatible
// with their underlying type at runtime (zero overhead).

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Price in quote currency (e.g. CZK per BTC) */
export type PriceCZK = Brand<number, "PriceCZK">;
/** Amount in base currency (e.g. BTC) */
export type AmountBTC = Brand<number, "AmountBTC">;
/** Amount in quote currency (e.g. CZK) */
export type AmountCZK = Brand<number, "AmountCZK">;
/** Coinmate exchange order ID */
export type CoinmateOrderId = Brand<number, "CoinmateOrderId">;

// Constructor helpers — identity functions at runtime
export const PriceCZK = (v: number): PriceCZK => v as PriceCZK;
export const AmountBTC = (v: number): AmountBTC => v as AmountBTC;
export const AmountCZK = (v: number): AmountCZK => v as AmountCZK;
export const CoinmateOrderId = (v: number): CoinmateOrderId => v as CoinmateOrderId;

/** Coinmate trading pair */
export const TradingPair = z.enum([
  "BTC_CZK",
  "BTC_EUR",
  "ETH_CZK",
  "ETH_EUR",
  "LTC_CZK",
  "LTC_EUR",
  "XRP_CZK",
  "XRP_EUR",
  "DASH_CZK",
  "DASH_EUR",
  "SOL_CZK",
  "SOL_EUR",
  "ADA_CZK",
  "ADA_EUR",
  "USDT_CZK",
  "USDT_EUR",
]);
export type TradingPair = z.infer<typeof TradingPair>;

/** Grid configuration for a single experiment */
export const GridConfig = z.object({
  /** Upper price boundary of the grid */
  upperPrice: z.number().positive(),
  /** Lower price boundary of the grid */
  lowerPrice: z.number().positive(),
  /** Number of grid levels (>= 3) */
  levels: z.number().int().min(3),
  /** Total budget in quote currency (e.g. CZK) */
  budgetQuote: z.number().positive(),
  /** Trading pair */
  pair: TradingPair,
});
export type GridConfig = z.infer<typeof GridConfig>;

/** Experiment status */
export const ExperimentStatus = z.enum(["active", "paused", "stopped"]);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;

/** Order side */
export const OrderSide = z.enum(["buy", "sell"]);
export type OrderSide = z.infer<typeof OrderSide>;

/** Internal order status */
export const OrderStatus = z.enum(["open", "filled", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** Experiment document in Firestore */
export interface Experiment {
  id: string;
  status: ExperimentStatus;
  gridConfig: GridConfig;
  allocatedQuote: number;
  allocatedBase: number;
  /** Number of consecutive tick failures (for circuit breaker) */
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Order record in Firestore */
export interface OrderRecord {
  id: string;
  coinmateOrderId: string;
  side: OrderSide;
  price: number;
  amount: number;
  status: OrderStatus;
  gridLevel: number;
  createdAt: Date;
  filledAt?: Date;
}

/** Snapshot for observability */
export interface ExperimentSnapshot {
  timestamp: Date;
  balanceQuote: number;
  balanceBase: number;
  openOrders: number;
  unrealizedPnl: number;
  realizedPnl: number;
  currentPrice: number;
}

/** Global wallet state */
export interface WalletState {
  totalAllocatedQuote: number;
  totalAllocatedBase: number;
  availableQuote: number;
  availableBase: number;
}

// ─── Firestore document schemas (for runtime validation of reads) ─────────

/** Coerce Firestore Timestamp / Date / string / number to JS Date */
const FirestoreDate = z.unknown().transform((val): Date => {
  if (val instanceof Date) return val;
  // Firestore Timestamp has toDate()
  if (val && typeof val === "object" && "toDate" in val) {
    return (val as { toDate(): Date }).toDate();
  }
  return new Date(val as string | number);
});

/** Schema for Experiment document data (without `id`, which comes from doc.id) */
export const ExperimentDocSchema = z.object({
  status: ExperimentStatus,
  gridConfig: GridConfig,
  allocatedQuote: z.number(),
  allocatedBase: z.number(),
  consecutiveFailures: z.number().default(0),
  createdAt: FirestoreDate,
  updatedAt: FirestoreDate,
});

/** Schema for OrderRecord document data (without `id`, which comes from doc.id) */
export const OrderRecordDocSchema = z.object({
  coinmateOrderId: z.union([z.string(), z.number()]).transform(String),
  side: OrderSide,
  price: z.number(),
  amount: z.number(),
  status: OrderStatus,
  gridLevel: z.number(),
  createdAt: FirestoreDate,
  filledAt: FirestoreDate.optional(),
});

/** Schema for ExperimentSnapshot document data */
export const ExperimentSnapshotDocSchema = z.object({
  timestamp: FirestoreDate,
  balanceQuote: z.number(),
  balanceBase: z.number(),
  openOrders: z.number(),
  unrealizedPnl: z.number(),
  realizedPnl: z.number(),
  currentPrice: z.number(),
});

/** Schema for WalletState document data */
export const WalletStateDocSchema = z.object({
  totalAllocatedQuote: z.number().default(0),
  totalAllocatedBase: z.number().default(0),
  availableQuote: z.number(),
  availableBase: z.number(),
});

/** Coinmate fee structure */
export const COINMATE_FEES = {
  /** Maker fee for volume < 10,000 EUR (lowest tier) */
  maker: 0.004,
  /** Taker fee for volume < 10,000 EUR (lowest tier) */
  taker: 0.006,
  /** Minimum grid spacing multiplier over fee to ensure profitability */
  minSpacingMultiplier: 3,
} as const;

/** Pair-specific precision and minimum order size for Coinmate */
export interface PairLimits {
  /** Minimum base-currency order size (e.g. 0.0002 BTC) */
  minOrderSize: number;
  /** Base-currency decimal precision (e.g. 8 for BTC) */
  basePrecision: number;
  /** Quote-currency decimal precision (e.g. 2 for CZK) */
  quotePrecision: number;
}

/** Known Coinmate pair limits. Values from Coinmate docs / empirical observation. */
export const PAIR_LIMITS: Record<string, PairLimits> = {
  BTC_CZK: { minOrderSize: 0.0002, basePrecision: 8, quotePrecision: 2 },
  BTC_EUR: { minOrderSize: 0.0002, basePrecision: 8, quotePrecision: 2 },
  ETH_CZK: { minOrderSize: 0.001, basePrecision: 8, quotePrecision: 2 },
  ETH_EUR: { minOrderSize: 0.001, basePrecision: 8, quotePrecision: 2 },
  LTC_CZK: { minOrderSize: 0.01, basePrecision: 8, quotePrecision: 2 },
  LTC_EUR: { minOrderSize: 0.01, basePrecision: 8, quotePrecision: 2 },
  XRP_CZK: { minOrderSize: 1, basePrecision: 6, quotePrecision: 4 },
  XRP_EUR: { minOrderSize: 1, basePrecision: 6, quotePrecision: 4 },
  DASH_CZK: { minOrderSize: 0.01, basePrecision: 8, quotePrecision: 2 },
  DASH_EUR: { minOrderSize: 0.01, basePrecision: 8, quotePrecision: 2 },
  SOL_CZK: { minOrderSize: 0.01, basePrecision: 8, quotePrecision: 2 },
  SOL_EUR: { minOrderSize: 0.01, basePrecision: 8, quotePrecision: 2 },
  ADA_CZK: { minOrderSize: 1, basePrecision: 6, quotePrecision: 4 },
  ADA_EUR: { minOrderSize: 1, basePrecision: 6, quotePrecision: 4 },
  USDT_CZK: { minOrderSize: 1, basePrecision: 6, quotePrecision: 4 },
  USDT_EUR: { minOrderSize: 1, basePrecision: 6, quotePrecision: 4 },
};

/** Get pair limits for a trading pair, with safe fallback */
export function getPairLimits(pair: string): PairLimits {
  return PAIR_LIMITS[pair] ?? { minOrderSize: 0.0002, basePrecision: 8, quotePrecision: 2 };
}

/** Coinmate API rate limit */
export const COINMATE_RATE_LIMIT = {
  maxRequestsPerMinute: 100,
  /** Target to stay safely under limit */
  targetRequestsPerMinute: 60,
} as const;

// ─── Autopilot ────────────────────────────────────────────────────────────────

/** Configuration for the self-regulating autopilot */
export interface AutopilotConfig {
  /** Trading pair to trade */
  pair: TradingPair;
  /** Multiplier for volatility-based range (e.g. 2.0 ≈ 95% daily coverage) */
  rangeMultiplier: number;
  /** Multiplier for volatility-based grid spacing */
  spacingMultiplier: number;
  /** Minimum minutes of price history required before suggesting params */
  minHistoryMinutes: number;
  /** Minimum return % the backtest must produce to approve a config */
  backtestMinReturnPercent: number;
  /** Maximum drawdown % the backtest is allowed before rejecting */
  backtestMaxDrawdownPercent: number;
  /** Minimum minutes between experiment replacements (prevents churn) */
  cooldownMinutes: number;
  /** Minimum viable budget in quote currency (below this, skip) */
  minBudgetQuote: number;
}

/** Default autopilot configuration */
export const AUTOPILOT_DEFAULTS: AutopilotConfig = {
  pair: "BTC_CZK",
  rangeMultiplier: 2.0,
  spacingMultiplier: 1.5,
  minHistoryMinutes: 1440, // 24 hours
  backtestMinReturnPercent: -15, // permissive — grid profits come from oscillation over time,
  // not from a single trending lookback window
  backtestMaxDrawdownPercent: 30, // with correct accounting drawdown is realistic;
  // live safeguards (10%) still protect real capital
  cooldownMinutes: 10,
  minBudgetQuote: 500,
};

/** Autopilot state persisted to Firestore */
export interface AutopilotState {
  /** When the autopilot last took action */
  lastActionAt?: Date;
  /** The grid config that was last created */
  lastConfig?: GridConfig | null;
  /** Why the last action was taken (or skipped) */
  lastReason?: string;
  /** Kill switch — set to false to disable autopilot */
  enabled: boolean;
}

/** Schema for AutopilotState document data */
export const AutopilotStateDocSchema = z.object({
  lastActionAt: FirestoreDate.optional(),
  lastConfig: GridConfig.nullable().default(null).optional(),
  lastReason: z.string().optional(),
  enabled: z.boolean().default(true),
});
