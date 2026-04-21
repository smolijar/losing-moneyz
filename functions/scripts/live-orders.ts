/**
 * CLI: Query live orders on Coinmate exchange.
 * Usage: COINMATE_CLIENT_ID=... COINMATE_PUBLIC_KEY=... COINMATE_PRIVATE_KEY=... pnpm --filter functions exec tsx scripts/live-orders.ts
 */
import { CoinmateClient } from "../src/coinmate/client";

async function main() {
  const clientId = process.env.COINMATE_CLIENT_ID!;
  const publicKey = process.env.COINMATE_PUBLIC_KEY!;
  const privateKey = process.env.COINMATE_PRIVATE_KEY!;
  if (!clientId || !publicKey || !privateKey) {
    console.error("Missing COINMATE credentials in env");
    process.exit(1);
  }
  const client = new CoinmateClient({ credentials: { clientId, publicKey, privateKey } });

  const [orders, balances, ticker] = await Promise.all([
    client.getOpenOrders("BTC_CZK"),
    client.getBalances(),
    client.getTicker("BTC_CZK"),
  ]);

  console.log("=== Live Ticker ===");
  console.log(`Last: ${ticker.data.last} CZK  Bid: ${ticker.data.bid}  Ask: ${ticker.data.ask}`);

  console.log("\n=== Balances ===");
  for (const [k, v] of Object.entries(balances.data)) {
    const b = v as { balance: number; available: number; reserved: number; currency: string };
    if (b.balance > 0 || b.reserved > 0) {
      console.log(`  ${b.currency}: balance=${b.balance}  available=${b.available}  reserved=${b.reserved}`);
    }
  }

  console.log(`\n=== Open Orders (${orders.data.length}) ===`);
  for (const o of orders.data) {
    console.log(
      `  id=${o.id}  ${o.type}  price=${o.price}  amount=${o.amount}  pair=${o.currencyPair}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
