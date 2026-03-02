import { z } from "zod";

// ─── Ticker ───────────────────────────────────────────────────────────────────

export const TickerResponse = z.object({
  error: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  data: z.object({
    last: z.number(),
    high: z.number(),
    low: z.number(),
    amount: z.number(),
    bid: z.number(),
    ask: z.number(),
    change: z.number(),
    open: z.number(),
    timestamp: z.number(),
  }),
});
export type TickerResponse = z.infer<typeof TickerResponse>;

// ─── Balances ─────────────────────────────────────────────────────────────────

const BalanceEntry = z.object({
  currency: z.string(),
  balance: z.number(),
  reserved: z.number(),
  available: z.number(),
});

export const BalancesResponse = z.object({
  error: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  data: z.record(z.string(), BalanceEntry),
});
export type BalancesResponse = z.infer<typeof BalancesResponse>;

// ─── Order Book ───────────────────────────────────────────────────────────────

const OrderBookEntry = z.object({
  price: z.number(),
  amount: z.number(),
});

export const OrderBookResponse = z.object({
  error: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  data: z.object({
    asks: z.array(OrderBookEntry),
    bids: z.array(OrderBookEntry),
  }),
});
export type OrderBookResponse = z.infer<typeof OrderBookResponse>;

// ─── Limit Order (buy/sell) ───────────────────────────────────────────────────

export const LimitOrderResponse = z.object({
  error: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  data: z.union([z.number(), z.string()]).transform(Number),
});
export type LimitOrderResponse = z.infer<typeof LimitOrderResponse>;

// ─── Cancel Order ─────────────────────────────────────────────────────────────

export const CancelOrderResponse = z.object({
  error: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  data: z.boolean(),
});
export type CancelOrderResponse = z.infer<typeof CancelOrderResponse>;

// ─── Open Orders ──────────────────────────────────────────────────────────────

const OpenOrder = z.object({
  id: z.union([z.number(), z.string()]).transform(Number),
  timestamp: z.number(),
  type: z.enum(["BUY", "SELL"]),
  currencyPair: z.string(),
  price: z.number(),
  amount: z.number(),
  originalAmount: z.number().optional(),
});
export type OpenOrder = z.infer<typeof OpenOrder>;

export const OpenOrdersResponse = z.object({
  error: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  data: z.array(OpenOrder),
});
export type OpenOrdersResponse = z.infer<typeof OpenOrdersResponse>;

// ─── Order History / Trade History ────────────────────────────────────────────

const TradeHistoryEntry = z.object({
  transactionId: z.union([z.number(), z.string()]).transform(Number),
  createdTimestamp: z.number(),
  currencyPair: z.string(),
  type: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["BUY", "SELL"]).optional(),
  price: z.number(),
  amount: z.number(),
  fee: z.number().optional(),
  feeType: z.string().optional(),
  orderId: z.union([z.number(), z.string()]).transform(Number),
});
export type TradeHistoryEntry = z.infer<typeof TradeHistoryEntry>;

export const TradeHistoryResponse = z.object({
  error: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  data: z.array(TradeHistoryEntry),
});
export type TradeHistoryResponse = z.infer<typeof TradeHistoryResponse>;

// ─── Transactions (public) ────────────────────────────────────────────────────

const TransactionEntry = z.object({
  timestamp: z.number(),
  transactionId: z.union([z.number(), z.string()]).transform(Number),
  price: z.number(),
  amount: z.number(),
  currencyPair: z.string(),
  tradeType: z.enum(["BUY", "SELL"]),
});
export type TransactionEntry = z.infer<typeof TransactionEntry>;

export const TransactionsResponse = z.object({
  error: z.boolean(),
  errorMessage: z.string().nullable().optional(),
  data: z.array(TransactionEntry),
});
export type TransactionsResponse = z.infer<typeof TransactionsResponse>;

// ─── Generic error wrapper ────────────────────────────────────────────────────

export const CoinmateErrorResponse = z.object({
  error: z.literal(true),
  errorMessage: z.string(),
  data: z.unknown().optional(),
});
export type CoinmateErrorResponse = z.infer<typeof CoinmateErrorResponse>;
