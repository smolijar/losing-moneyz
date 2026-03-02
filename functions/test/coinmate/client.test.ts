import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoinmateClient, CoinmateApiError } from "../../src/coinmate/client";
import { RateLimiter } from "../../src/coinmate/rate-limiter";

/** Helper to create a mock fetch that returns a given response */
function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

/** Helper to create a mock fetch that rejects (network error) */
function mockFetchError(error: Error): typeof fetch {
  return vi.fn().mockRejectedValue(error);
}

const credentials = {
  clientId: "123",
  publicKey: "pub",
  privateKey: "priv",
};

function createClient(fetchFn: typeof fetch) {
  return new CoinmateClient({
    credentials,
    fetchFn,
    rateLimiter: new RateLimiter(1000), // high limit so it doesn't interfere
    maxRetries: 0, // no retries in most tests
    retryBaseDelayMs: 1,
  });
}

describe("CoinmateClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ─── getTicker ────────────────────────────────────────────────────

  describe("getTicker", () => {
    it("should return parsed ticker data", async () => {
      const body = {
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
      const client = createClient(mockFetch(200, body));
      const result = await client.getTicker("BTC_CZK");
      expect(result.data.last).toBe(2400000);
      expect(result.data.bid).toBe(2399000);
      expect(result.error).toBe(false);
    });

    it("should reject malformed ticker response", async () => {
      const body = { error: false, data: { last: "not a number" } };
      const client = createClient(mockFetch(200, body));
      await expect(client.getTicker("BTC_CZK")).rejects.toThrow(CoinmateApiError);
    });
  });

  // ─── getBalances ──────────────────────────────────────────────────

  describe("getBalances", () => {
    it("should return parsed balances", async () => {
      const body = {
        error: false,
        data: {
          CZK: { currency: "CZK", balance: 50000, reserved: 10000, available: 40000 },
          BTC: { currency: "BTC", balance: 0.5, reserved: 0.1, available: 0.4 },
        },
      };
      const client = createClient(mockFetch(200, body));
      const result = await client.getBalances();
      expect(result.data.CZK.available).toBe(40000);
      expect(result.data.BTC.balance).toBe(0.5);
    });

    it("should send auth params in POST body", async () => {
      const fetchFn = mockFetch(200, {
        error: false,
        data: { CZK: { currency: "CZK", balance: 0, reserved: 0, available: 0 } },
      });
      const client = createClient(fetchFn);
      await client.getBalances();

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/balances");
      expect(init.method).toBe("POST");
      expect(init.body).toContain("clientId=123");
      expect(init.body).toContain("publicKey=pub");
      expect(init.body).toContain("signature=");
      expect(init.body).toContain("nonce=");
    });
  });

  // ─── buyLimit ─────────────────────────────────────────────────────

  describe("buyLimit", () => {
    it("should return order ID", async () => {
      const body = { error: false, data: 12345 };
      const client = createClient(mockFetch(200, body));
      const result = await client.buyLimit("BTC_CZK", 0.001, 2400000);
      expect(result.data).toBe(12345);
    });

    it("should send correct params", async () => {
      const fetchFn = mockFetch(200, { error: false, data: 1 });
      const client = createClient(fetchFn);
      await client.buyLimit("BTC_CZK", 0.001, 2400000);

      const body = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      expect(body).toContain("currencyPair=BTC_CZK");
      expect(body).toContain("amount=0.001");
      expect(body).toContain("price=2400000");
    });
  });

  // ─── sellLimit ────────────────────────────────────────────────────

  describe("sellLimit", () => {
    it("should return order ID", async () => {
      const body = { error: false, data: 67890 };
      const client = createClient(mockFetch(200, body));
      const result = await client.sellLimit("BTC_CZK", 0.001, 2500000);
      expect(result.data).toBe(67890);
    });
  });

  // ─── cancelOrder ──────────────────────────────────────────────────

  describe("cancelOrder", () => {
    it("should return success boolean", async () => {
      const body = { error: false, data: true };
      const client = createClient(mockFetch(200, body));
      const result = await client.cancelOrder(12345);
      expect(result.data).toBe(true);
    });
  });

  // ─── getOpenOrders ────────────────────────────────────────────────

  describe("getOpenOrders", () => {
    it("should return array of open orders", async () => {
      const body = {
        error: false,
        data: [
          {
            id: 1,
            timestamp: 1700000000000,
            type: "BUY",
            currencyPair: "BTC_CZK",
            price: 2400000,
            amount: 0.001,
          },
          {
            id: 2,
            timestamp: 1700000001000,
            type: "SELL",
            currencyPair: "BTC_CZK",
            price: 2500000,
            amount: 0.001,
          },
        ],
      };
      const client = createClient(mockFetch(200, body));
      const result = await client.getOpenOrders("BTC_CZK");
      expect(result.data).toHaveLength(2);
      expect(result.data[0].type).toBe("BUY");
      expect(result.data[1].type).toBe("SELL");
    });
  });

  // ─── getOrderHistory ──────────────────────────────────────────────

  describe("getOrderHistory", () => {
    it("should return trade history", async () => {
      const body = {
        error: false,
        data: [
          {
            transactionId: 100,
            createdTimestamp: 1700000000000,
            currencyPair: "BTC_CZK",
            type: "BUY",
            price: 2400000,
            amount: 0.001,
            fee: 9.6,
            orderId: 1,
          },
        ],
      };
      const client = createClient(mockFetch(200, body));
      const result = await client.getOrderHistory("BTC_CZK", 100);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].price).toBe(2400000);
    });
  });

  // ─── getTransactions ──────────────────────────────────────────────

  describe("getTransactions", () => {
    it("should return public transactions", async () => {
      const body = {
        error: false,
        data: [
          {
            timestamp: 1700000000000,
            transactionId: 50,
            price: 2400000,
            amount: 0.5,
            currencyPair: "BTC_CZK",
            tradeType: "BUY",
          },
        ],
      };
      const client = createClient(mockFetch(200, body));
      const result = await client.getTransactions("BTC_CZK", 60);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].price).toBe(2400000);
    });
  });

  // ─── Error handling ───────────────────────────────────────────────

  describe("error handling", () => {
    it("should throw on 4xx with error message", async () => {
      const body = { error: true, errorMessage: "Invalid API key" };
      const client = createClient(mockFetch(400, body));
      await expect(client.getBalances()).rejects.toThrow("Invalid API key");
    });

    it("should throw on 5xx", async () => {
      const client = createClient(mockFetch(500, {}));
      await expect(client.getTicker("BTC_CZK")).rejects.toThrow("server error");
    });

    it("should throw on API-level error (200 with error: true)", async () => {
      const body = { error: true, errorMessage: "Insufficient funds" };
      const client = createClient(mockFetch(200, body));
      await expect(client.buyLimit("BTC_CZK", 100, 2400000)).rejects.toThrow(
        "Insufficient funds",
      );
    });

    it("should throw on schema validation failure", async () => {
      const body = { error: false, data: { completely: "wrong" } };
      const client = createClient(mockFetch(200, body));
      await expect(client.getTicker("BTC_CZK")).rejects.toThrow("Invalid API response");
    });

    it("should throw CoinmateApiError with statusCode", async () => {
      const body = { error: true, errorMessage: "Bad request" };
      const client = createClient(mockFetch(400, body));
      try {
        await client.getBalances();
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(CoinmateApiError);
        expect((e as CoinmateApiError).statusCode).toBe(400);
      }
    });
  });

  // ─── Retry logic ──────────────────────────────────────────────────

  describe("retry logic", () => {
    it("should retry on 5xx errors", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({ status: 500, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({
          status: 200,
          json: () =>
            Promise.resolve({
              error: false,
              data: {
                last: 1,
                high: 1,
                low: 1,
                amount: 1,
                bid: 1,
                ask: 1,
                change: 0,
                open: 1,
                timestamp: 1,
              },
            }),
        });

      const client = new CoinmateClient({
        credentials,
        fetchFn: fetchFn as unknown as typeof fetch,
        rateLimiter: new RateLimiter(1000),
        maxRetries: 2,
        retryBaseDelayMs: 1,
      });

      const result = await client.getTicker("BTC_CZK");
      expect(result.data.last).toBe(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should NOT retry on 4xx errors", async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        status: 400,
        json: () => Promise.resolve({ error: true, errorMessage: "Bad" }),
      });

      const client = new CoinmateClient({
        credentials,
        fetchFn: fetchFn as unknown as typeof fetch,
        rateLimiter: new RateLimiter(1000),
        maxRetries: 3,
        retryBaseDelayMs: 1,
      });

      await expect(client.getTicker("BTC_CZK")).rejects.toThrow();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("should retry on network errors", async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({
          status: 200,
          json: () =>
            Promise.resolve({
              error: false,
              data: {
                last: 1,
                high: 1,
                low: 1,
                amount: 1,
                bid: 1,
                ask: 1,
                change: 0,
                open: 1,
                timestamp: 1,
              },
            }),
        });

      const client = new CoinmateClient({
        credentials,
        fetchFn: fetchFn as unknown as typeof fetch,
        rateLimiter: new RateLimiter(1000),
        maxRetries: 2,
        retryBaseDelayMs: 1,
      });

      const result = await client.getTicker("BTC_CZK");
      expect(result.data.last).toBe(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should exhaust retries and throw last error", async () => {
      const fetchFn = mockFetchError(new Error("Network down"));
      const client = new CoinmateClient({
        credentials,
        fetchFn,
        rateLimiter: new RateLimiter(1000),
        maxRetries: 2,
        retryBaseDelayMs: 1,
      });

      await expect(client.getTicker("BTC_CZK")).rejects.toThrow("Network down");
      expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  // ─── Zod validation ───────────────────────────────────────────────

  describe("Zod schema validation", () => {
    it("should reject ticker with missing fields", async () => {
      const body = { error: false, data: { last: 100 } }; // missing other fields
      const client = createClient(mockFetch(200, body));
      await expect(client.getTicker("BTC_CZK")).rejects.toThrow("Invalid API response");
    });

    it("should reject balances with wrong type", async () => {
      const body = { error: false, data: "not an object" };
      const client = createClient(mockFetch(200, body));
      await expect(client.getBalances()).rejects.toThrow("Invalid API response");
    });

    it("should accept open orders with string IDs (transforms to number)", async () => {
      const body = {
        error: false,
        data: [
          {
            id: "12345",
            timestamp: 1700000000000,
            type: "BUY",
            currencyPair: "BTC_CZK",
            price: 2400000,
            amount: 0.001,
          },
        ],
      };
      const client = createClient(mockFetch(200, body));
      const result = await client.getOpenOrders("BTC_CZK");
      expect(result.data[0].id).toBe(12345);
      expect(typeof result.data[0].id).toBe("number");
    });
  });
});
