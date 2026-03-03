# Losing Moneyz

Grid trading bot for **BTC/CZK** on [Coinmate.io](https://coinmate.io), deployed to GCP via Firebase.

Runs as a Cloud Function triggered every 2 minutes by Cloud Scheduler. Uses Firestore for state, soft wallet isolation for concurrent experiments, and automatic safeguards (price range, drawdown, circuit breaker).

Target cost: **$0/mo** (GCP free tier).

## Architecture

```
Cloud Scheduler (2 min) --> Cloud Function "gridTick"
                                |
                    +-----------+-----------+
                    |           |           |
               Coinmate    Firestore    Cloud
               REST API    (state)     Logging
```

Each tick:
1. Reads active experiments from Firestore
2. Fetches current price from Coinmate
3. Runs safeguard checks (price range, drawdown, stale tick, circuit breaker)
4. Detects filled orders by comparing DB state with Coinmate open orders
5. Runs grid reconciliation (pure logic) to determine new orders
6. Places/cancels orders on Coinmate
7. Saves state snapshot to Firestore

## Prerequisites

Before deploying, you need:

| # | Prerequisite | How |
|---|-------------|-----|
| P1 | Coinmate account (verified, CZK deposited) | [coinmate.io/register](https://coinmate.io) |
| P2 | Coinmate API keys | Coinmate dashboard > API > Create key with trading permissions |
| P3 | GCP project (Blaze plan) | [console.cloud.google.com](https://console.cloud.google.com) |
| P4 | Firebase project linked to GCP | [console.firebase.google.com](https://console.firebase.google.com) |
| P5 | GitHub Secrets | See [Secrets Setup](#secrets-setup) below |
| P6 | Node.js >= 20 + pnpm 10 | `corepack enable && corepack prepare pnpm@10 --activate` |

## Quick Start

```bash
# Clone and install
git clone <repo-url> && cd losing-moneyz
pnpm install

# Run tests (183 tests)
pnpm test

# Run lint + typecheck
pnpm lint && pnpm typecheck

# Run backtest validation
pnpm backtest:validate

# Build for deployment
pnpm build
```

## Project Structure

```
losing-moneyz/
  functions/
    src/
      index.ts              # Cloud Function entry point
      config/types.ts       # Shared types (GridConfig, Experiment, OrderRecord, etc.)
      coinmate/             # Coinmate API client (HMAC auth, rate limiter, Zod schemas)
      grid/engine.ts        # Pure grid logic (levels, reconciliation, P&L, validation)
      backtest/             # Backtester (simulates grid on historical price data)
      storage/              # Repository pattern (Firestore + in-memory mock)
      tick/                 # Orchestrator + safeguards (the core tick loop)
    test/                   # 183 unit tests (vitest)
    scripts/                # CLI tools (status, stop, wallet sync, backtest validation)
  .github/workflows/        # CI + deploy pipelines
  firebase.json             # Firebase IaC
  firestore.rules           # Deny all client access
```

## CLI Commands

All CLI commands require Firebase credentials. Set `GOOGLE_APPLICATION_CREDENTIALS` to your service account JSON path.

```bash
# Show all experiments with P&L
pnpm status

# Emergency stop an experiment (cancels all orders on next tick)
pnpm experiment:stop <experimentId>

# Check wallet consistency (detects allocation discrepancies)
pnpm wallet:sync

# Fix wallet discrepancies
pnpm wallet:sync -- --fix
```

## Secrets Setup

### GCP Secret Manager (runtime secrets)

Coinmate API credentials must be provisioned **once** directly in GCP Secret Manager.
The Cloud Functions declare these secrets in their configuration, and Firebase auto-injects
them as `process.env.*` at runtime.

| Secret | Description |
|--------|-------------|
| `COINMATE_CLIENT_ID` | Coinmate API client ID |
| `COINMATE_PUBLIC_KEY` | Coinmate API public key |
| `COINMATE_PRIVATE_KEY` | Coinmate API private key |

```bash
# Create (first time only)
gcloud secrets create COINMATE_CLIENT_ID --project="$PROJECT" --replication-policy="automatic"
printf '%s' "$VALUE" | gcloud secrets versions add COINMATE_CLIENT_ID --project="$PROJECT" --data-file=-
# Repeat for COINMATE_PUBLIC_KEY and COINMATE_PRIVATE_KEY
```

### GitHub Secrets (for CI/CD)

| Secret | Description |
|--------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase service account JSON (for deployment) |

### GitHub Variables

| Variable | Description |
|----------|-------------|
| `FIREBASE_PROJECT_ID` | Firebase project ID (for `firebase deploy`) |

### Local Development

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

## Creating an Experiment

Experiments are Firestore documents. Create one in the `/experiments` collection:

```json
{
  "status": "active",
  "gridConfig": {
    "pair": "BTC_CZK",
    "lowerPrice": 2000000,
    "upperPrice": 2400000,
    "levels": 5,
    "budgetQuote": 100000
  },
  "allocatedQuote": 100000,
  "allocatedBase": 0
}
```

Key parameters:
- **levels**: Number of grid lines (3-50). More levels = more trades, lower profit each.
- **lowerPrice / upperPrice**: Grid boundaries in CZK. Bot pauses if price exits range.
- **budgetQuote**: Total CZK allocated. Split evenly across buy levels.

Grid spacing must be >= 2.4% (3x round-trip maker fees of 0.8%).

## Safeguards

| Safeguard | Trigger | Action |
|-----------|---------|--------|
| Price out of range | Price exits grid bounds | Pause experiment |
| Drawdown | Unrealized + realized P&L < -10% of budget | Pause experiment |
| Stale tick | Last tick > 10 min ago | Log warning |
| Circuit breaker | 3 consecutive API failures | Pause experiment |
| Max orders | Orders exceed `levels * 2` | Log warning |
| Emergency stop | Status set to "stopped" | Cancel all orders |

## Deployment

Deployment is automated via GitHub Actions on push to `main`.

Manual deployment:

```bash
# Build
pnpm build

# Deploy (requires firebase-tools and authentication)
npx firebase-tools deploy --project <your-project-id>
```

## Firestore Free Tier Analysis

Per tick (2 experiments, 5 grid levels each):
- **Reads**: ~20 (experiment queries, snapshots, order queries)
- **Writes**: ~12 (order updates, new orders, snapshots)

Daily usage at 2-min intervals (720 ticks/day):
- **Reads**: ~14,400 / 50,000 daily free (29%)
- **Writes**: ~8,640 / 20,000 daily free (43%)
- **Storage**: < 10 MB / 1 GB free

100-tick simulation: ~2,000 reads, ~1,200 writes. Well within free tier.

## Development

```bash
# Run tests in watch mode
pnpm --filter functions test:watch

# Run only a specific test file
pnpm --filter functions exec vitest run test/tick/orchestrator.test.ts

# Lint with auto-fix
pnpm --filter functions lint:fix
```

## License

Private project. Not licensed for redistribution.
