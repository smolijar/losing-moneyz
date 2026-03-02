import { COINMATE_RATE_LIMIT } from "../config";

/**
 * Simple token-bucket rate limiter.
 * Enqueues requests and drains them at the configured rate.
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private lastRefill: number;

  constructor(maxPerMinute: number = COINMATE_RATE_LIMIT.targetRequestsPerMinute) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.refillIntervalMs = 60_000 / maxPerMinute;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  /**
   * Wait until a token is available, then consume it.
   * Returns the total wait time in ms (0 if token was immediately available).
   */
  async acquire(): Promise<number> {
    let totalWait = 0;

    // Loop until we successfully acquire a token
    // This prevents tokens going negative under concurrent burst
    while (true) {
      this.refill();
      if (this.tokens > 0) {
        this.tokens--;
        return totalWait;
      }
      const waitMs = this.refillIntervalMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      totalWait += waitMs;
    }
  }

  /** Current available tokens (for testing/logging) */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** Reset the limiter (for testing) */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}
