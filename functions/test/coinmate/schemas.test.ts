import { describe, it, expect } from "vitest";
import {
  TickerResponse,
  BalancesResponse,
  LimitOrderResponse,
  CancelOrderResponse,
  OpenOrdersResponse,
  TradeHistoryResponse,
  TransactionsResponse,
  OrderBookResponse,
  CoinmateErrorResponse,
} from "../../src/coinmate/schemas";

describe("Coinmate Zod schemas", () => {
  describe("TickerResponse", () => {
    it("should parse valid ticker", () => {
      const input = {
        error: false,
        data: {
          last: 2400000,
          high: 2450000,
          low: 2350000,
          amount: 10.5,
          bid: 2399000,
          ask: 2401000,
          change: 1.5,
          open: 2380000,
          timestamp: 1700000000000,
        },
      };
      const result = TickerResponse.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject ticker with missing data", () => {
      const result = TickerResponse.safeParse({ error: false });
      expect(result.success).toBe(false);
    });
  });

  describe("BalancesResponse", () => {
    it("should parse valid balances", () => {
      const input = {
        error: false,
        data: {
          CZK: { currency: "CZK", balance: 50000, reserved: 10000, available: 40000 },
        },
      };
      const result = BalancesResponse.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("LimitOrderResponse", () => {
    it("should parse numeric order ID", () => {
      const input = { error: false, data: 12345 };
      const result = LimitOrderResponse.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.data).toBe(12345);
    });

    it("should parse string order ID and transform to number", () => {
      const input = { error: false, data: "67890" };
      const result = LimitOrderResponse.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.data).toBe(67890);
    });
  });

  describe("CancelOrderResponse", () => {
    it("should parse cancel response", () => {
      const input = { error: false, data: true };
      const result = CancelOrderResponse.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("OpenOrdersResponse", () => {
    it("should parse open orders with mixed id types", () => {
      const input = {
        error: false,
        data: [
          { id: 1, timestamp: 1700000000, type: "BUY", currencyPair: "BTC_CZK", price: 2400000, amount: 0.001 },
          {
            id: "2",
            timestamp: 1700000001,
            type: "SELL",
            currencyPair: "BTC_CZK",
            price: 2500000,
            amount: 0.001,
          },
        ],
      };
      const result = OpenOrdersResponse.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data[0].id).toBe(1);
        expect(result.data.data[1].id).toBe(2);
      }
    });

    it("should reject invalid order type", () => {
      const input = {
        error: false,
        data: [
          { id: 1, timestamp: 1, type: "INVALID", currencyPair: "BTC_CZK", price: 1, amount: 1 },
        ],
      };
      const result = OpenOrdersResponse.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("TradeHistoryResponse", () => {
    it("should parse trade history", () => {
      const input = {
        error: false,
        data: [
          {
            transactionId: 100,
            createdTimestamp: 1700000000,
            currencyPair: "BTC_CZK",
            type: "BUY",
            price: 2400000,
            amount: 0.001,
            fee: 9.6,
            orderId: 1,
          },
        ],
      };
      const result = TradeHistoryResponse.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe("TransactionsResponse", () => {
    it("should parse public transactions", () => {
      const input = {
        error: false,
        data: [
          {
            timestamp: 1700000000,
            transactionId: 50,
            price: 2400000,
            amount: 0.5,
            currencyPair: "BTC_CZK",
            tradeType: "BUY",
          },
        ],
      };
      const result = TransactionsResponse.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject invalid tradeType", () => {
      const input = {
        error: false,
        data: [
          {
            timestamp: 1,
            transactionId: 1,
            price: 1,
            amount: 1,
            currencyPair: "BTC_CZK",
            tradeType: "SWAP",
          },
        ],
      };
      const result = TransactionsResponse.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("OrderBookResponse", () => {
    it("should parse valid order book", () => {
      const input = {
        error: false,
        data: {
          asks: [
            { price: 2401000, amount: 0.5 },
            { price: 2402000, amount: 1.0 },
          ],
          bids: [
            { price: 2399000, amount: 0.3 },
          ],
        },
      };
      const result = OrderBookResponse.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data.asks).toHaveLength(2);
        expect(result.data.data.bids).toHaveLength(1);
      }
    });

    it("should parse empty order book", () => {
      const input = {
        error: false,
        data: { asks: [], bids: [] },
      };
      const result = OrderBookResponse.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject order book with missing bids", () => {
      const input = {
        error: false,
        data: { asks: [{ price: 100, amount: 1 }] },
      };
      const result = OrderBookResponse.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe("CoinmateErrorResponse", () => {
    it("should parse error response", () => {
      const input = {
        error: true,
        errorMessage: "Invalid API key",
      };
      const result = CoinmateErrorResponse.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.errorMessage).toBe("Invalid API key");
      }
    });

    it("should parse error response with data field", () => {
      const input = {
        error: true,
        errorMessage: "Rate limited",
        data: null,
      };
      const result = CoinmateErrorResponse.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should reject non-error response", () => {
      const input = {
        error: false,
        errorMessage: "Not an error",
      };
      const result = CoinmateErrorResponse.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});
