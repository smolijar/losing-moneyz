import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../../src/coinmate/rate-limiter";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("should allow immediate acquisition when tokens are available", async () => {
    const limiter = new RateLimiter(60);
    const waitMs = await limiter.acquire();
    expect(waitMs).toBe(0);
  });

  it("should report correct available tokens", () => {
    const limiter = new RateLimiter(10);
    expect(limiter.available).toBe(10);
  });

  it("should decrease tokens on acquire", async () => {
    const limiter = new RateLimiter(10);
    await limiter.acquire();
    expect(limiter.available).toBe(9);
  });

  it("should delay when no tokens are available", async () => {
    const limiter = new RateLimiter(2);
    // Drain all tokens
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.available).toBe(0);

    // Next acquire should wait
    const acquirePromise = limiter.acquire();
    // Advance time past one refill interval (60000/2 = 30000ms)
    vi.advanceTimersByTime(30001);
    const waited = await acquirePromise;
    expect(waited).toBeGreaterThan(0);
  });

  it("should refill tokens over time", async () => {
    const limiter = new RateLimiter(10);
    // Drain all
    for (let i = 0; i < 10; i++) {
      await limiter.acquire();
    }
    expect(limiter.available).toBe(0);

    // Advance time: at 10/min, refill interval is 6000ms per token
    vi.advanceTimersByTime(12001);
    expect(limiter.available).toBe(2);
  });

  it("should not exceed max tokens on refill", () => {
    const limiter = new RateLimiter(5);
    // Advance a long time
    vi.advanceTimersByTime(600_000);
    expect(limiter.available).toBe(5);
  });

  it("should reset correctly", async () => {
    const limiter = new RateLimiter(5);
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.available).toBe(3);
    limiter.reset();
    expect(limiter.available).toBe(5);
  });

  it("should not allow tokens to go negative under concurrent burst", async () => {
    const limiter = new RateLimiter(3);

    // Drain tokens
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.available).toBe(0);

    // Fire multiple concurrent acquire calls
    const promises = [limiter.acquire(), limiter.acquire()];

    // Advance time enough for exactly 1 token refill
    vi.advanceTimersByTime(20_001); // 60000/3 = 20000ms per token

    // Only one should complete, the other should still wait
    // Advance more time for the second
    vi.advanceTimersByTime(20_001);

    const results = await Promise.all(promises);
    // Both waited
    expect(results[0]).toBeGreaterThan(0);
    expect(results[1]).toBeGreaterThan(0);

    // Tokens should never be negative
    expect(limiter.available).toBeGreaterThanOrEqual(0);
  });
});
