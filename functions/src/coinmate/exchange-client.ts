import type { z } from "zod";
import type {
  TickerResponse as TickerResponseSchema,
  BalancesResponse as BalancesResponseSchema,
  LimitOrderResponse as LimitOrderResponseSchema,
  CancelOrderResponse as CancelOrderResponseSchema,
  OpenOrdersResponse as OpenOrdersResponseSchema,
  TradeHistoryResponse as TradeHistoryResponseSchema,
  TransactionsResponse as TransactionsResponseSchema,
} from "./schemas";

/** Resolved output types from Zod schemas (post-transform) */
type TickerResult = z.output<typeof TickerResponseSchema>;
type BalancesResult = z.output<typeof BalancesResponseSchema>;
type LimitOrderResult = z.output<typeof LimitOrderResponseSchema>;
type CancelOrderResult = z.output<typeof CancelOrderResponseSchema>;
type OpenOrdersResult = z.output<typeof OpenOrdersResponseSchema>;
type TradeHistoryResult = z.output<typeof TradeHistoryResponseSchema>;
type TransactionsResult = z.output<typeof TransactionsResponseSchema>;

/**
 * Abstract exchange client interface.
 *
 * The orchestrator depends on this interface (not the concrete CoinmateClient)
 * so we can:
 * 1. Mock it easily in unit tests
 * 2. Swap exchange implementations if needed
 */
export interface ExchangeClient {
  getTicker(currencyPair: string): Promise<TickerResult>;
  getOpenOrders(currencyPair: string): Promise<OpenOrdersResult>;
  buyLimit(currencyPair: string, amount: number, price: number): Promise<LimitOrderResult>;
  sellLimit(currencyPair: string, amount: number, price: number): Promise<LimitOrderResult>;
  cancelOrder(orderId: number): Promise<CancelOrderResult>;
  getBalances(): Promise<BalancesResult>;
  getTransactions(currencyPair: string, minutesIntoHistory?: number): Promise<TransactionsResult>;
  getOrderHistory(currencyPair: string, limit?: number): Promise<TradeHistoryResult>;
}
