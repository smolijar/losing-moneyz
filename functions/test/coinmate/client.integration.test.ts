import { describe, it, expect } from "vitest";
import { CoinmateClient } from "../../src/coinmate/client";

/**
 * Integration tests for Coinmate API.
 * Requires real API credentials in environment variables.
 *
 * Run with: pnpm test:integration
 *
 * Required env vars:
 *   COINMATE_CLIENT_ID
 *   COINMATE_PUBLIC_KEY
 *   COINMATE_PRIVATE_KEY
 */

const clientId = process.env.COINMATE_CLIENT_ID;
const publicKey = process.env.COINMATE_PUBLIC_KEY;
const privateKey = process.env.COINMATE_PRIVATE_KEY;

const hasCredentials = clientId && publicKey && privateKey;

describe.skipIf(!hasCredentials)("Coinmate API integration", () => {
  const client = new CoinmateClient({
    credentials: {
      clientId: clientId!,
      publicKey: publicKey!,
      privateKey: privateKey!,
    },
    maxRetries: 1,
  });

  it("should fetch BTC_CZK ticker (public endpoint)", async () => {
    const ticker = await client.getTicker("BTC_CZK");
    expect(ticker.error).toBe(false);
    expect(ticker.data.last).toBeGreaterThan(0);
    expect(ticker.data.bid).toBeGreaterThan(0);
    expect(ticker.data.ask).toBeGreaterThan(0);
    console.log(`BTC_CZK last: ${ticker.data.last}, bid: ${ticker.data.bid}, ask: ${ticker.data.ask}`);
  });

  it("should fetch public transactions (public endpoint)", async () => {
    const txs = await client.getTransactions("BTC_CZK", 60);
    expect(txs.error).toBe(false);
    expect(txs.data.length).toBeGreaterThan(0);
    console.log(`Got ${txs.data.length} transactions in last 60 minutes`);
  });

  it("should fetch account balances (private endpoint)", async () => {
    const balances = await client.getBalances();
    expect(balances.error).toBe(false);
    // Should have at least CZK and BTC entries
    expect(balances.data).toHaveProperty("CZK");
    expect(balances.data).toHaveProperty("BTC");
    console.log(`CZK available: ${balances.data.CZK.available}`);
    console.log(`BTC available: ${balances.data.BTC.available}`);
  });

  it("should fetch open orders (private endpoint)", async () => {
    const orders = await client.getOpenOrders("BTC_CZK");
    expect(orders.error).toBe(false);
    expect(Array.isArray(orders.data)).toBe(true);
    console.log(`Open orders: ${orders.data.length}`);
  });

  // NOTE: We deliberately do NOT test buyLimit/sellLimit/cancelOrder in
  // automated integration tests to avoid placing real orders accidentally.
  // These should be tested manually with very small amounts.
});
