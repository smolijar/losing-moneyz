import { z } from "zod";
import { CoinmateCredentials, createSignature, generateNonce } from "./auth";
import type { ExchangeClient } from "./exchange-client";
import { RateLimiter } from "./rate-limiter";
import {
  TickerResponse,
  BalancesResponse,
  LimitOrderResponse,
  CancelOrderResponse,
  OpenOrdersResponse,
  TradeHistoryResponse,
  TransactionsResponse,
} from "./schemas";

const COINMATE_BASE_URL = "https://coinmate.io/api";

export class CoinmateApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly apiErrorMessage?: string,
  ) {
    super(message);
    this.name = "CoinmateApiError";
  }
}

export interface CoinmateClientOptions {
  credentials: CoinmateCredentials;
  baseUrl?: string;
  rateLimiter?: RateLimiter;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Custom fetch implementation (for testing) */
  fetchFn?: typeof fetch;
}

export class CoinmateClient implements ExchangeClient {
  private readonly credentials: CoinmateCredentials;
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: CoinmateClientOptions) {
    this.credentials = options.credentials;
    this.baseUrl = options.baseUrl ?? COINMATE_BASE_URL;
    this.rateLimiter = options.rateLimiter ?? new RateLimiter();
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  // ─── Public endpoints ───────────────────────────────────────────────

  /** Get ticker for a currency pair */
  async getTicker(currencyPair: string) {
    return this.publicGet("/ticker", { currencyPair }, TickerResponse);
  }

  /** Get public transactions (for backtesting) */
  async getTransactions(currencyPair: string, minutesIntoHistory?: number) {
    const params: Record<string, string> = { currencyPair };
    if (minutesIntoHistory !== undefined) {
      params.minutesIntoHistory = minutesIntoHistory.toString();
    }
    return this.publicGet("/transactions", params, TransactionsResponse);
  }

  // ─── Private endpoints ──────────────────────────────────────────────

  /** Get account balances */
  async getBalances() {
    return this.privatePost("/balances", {}, BalancesResponse);
  }

  /** Place a limit buy order */
  async buyLimit(currencyPair: string, amount: number, price: number) {
    return this.privatePost(
      "/buyLimit",
      {
        currencyPair,
        amount: amount.toString(),
        price: price.toString(),
      },
      LimitOrderResponse,
    );
  }

  /** Place a limit sell order */
  async sellLimit(currencyPair: string, amount: number, price: number) {
    return this.privatePost(
      "/sellLimit",
      {
        currencyPair,
        amount: amount.toString(),
        price: price.toString(),
      },
      LimitOrderResponse,
    );
  }

  /** Cancel an order by ID */
  async cancelOrder(orderId: number) {
    return this.privatePost(
      "/cancelOrder",
      { orderId: orderId.toString() },
      CancelOrderResponse,
    );
  }

  /** Get open orders for a currency pair */
  async getOpenOrders(currencyPair: string) {
    return this.privatePost("/openOrders", { currencyPair }, OpenOrdersResponse);
  }

  /** Get trade/order history */
  async getOrderHistory(currencyPair: string, limit: number = 1000) {
    return this.privatePost(
      "/orderHistory",
      { currencyPair, limit: limit.toString() },
      TradeHistoryResponse,
    );
  }

  // ─── Internal HTTP methods ──────────────────────────────────────────

  private async publicGet<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return this.executeWithRetry(async () => {
      await this.rateLimiter.acquire();
      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      return this.handleResponse(response, schema);
    });
  }

  private async privatePost<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.executeWithRetry(async () => {
      await this.rateLimiter.acquire();
      const nonce = generateNonce();
      const authParams = createSignature(this.credentials, nonce);

      const body = new URLSearchParams({
        ...params,
        clientId: authParams.clientId,
        publicKey: authParams.publicKey,
        nonce: authParams.nonce,
        signature: authParams.signature,
      });

      const response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      return this.handleResponse(response, schema);
    });
  }

  private async handleResponse<T>(response: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    if (response.status >= 500) {
      throw new CoinmateApiError(
        `Coinmate API server error: ${response.status}`,
        response.status,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await response.json();

    if (response.status >= 400) {
      throw new CoinmateApiError(
        `Coinmate API client error: ${response.status} — ${json?.errorMessage ?? "Unknown"}`,
        response.status,
        json?.errorMessage,
      );
    }

    // Coinmate can return 200 with error: true
    if (json?.error === true) {
      throw new CoinmateApiError(
        `Coinmate API error: ${json.errorMessage ?? "Unknown error"}`,
        response.status,
        json.errorMessage,
      );
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new CoinmateApiError(
        `Invalid API response schema: ${parsed.error.message}`,
        response.status,
      );
    }

    return parsed.data;
  }

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry client errors (4xx)
        if (error instanceof CoinmateApiError && error.statusCode && error.statusCode < 500) {
          throw error;
        }

        // Don't retry on last attempt
        if (attempt === this.maxRetries) {
          break;
        }

        // Exponential backoff
        const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
