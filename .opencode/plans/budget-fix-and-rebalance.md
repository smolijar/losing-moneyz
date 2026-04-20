# Budget/Levels Fix + Auto-Rebalance

## Problem

The autopilot sizes the grid using `managedQuoteEquivalent` (~4,500 CZK = 437 CZK + BTC value), producing 7 levels. After creation, it reconciles `budgetQuote` down to 437 CZK. With 7 levels, `getBudgetPerLevel()` = 437/4 = ~109 CZK. At BTC ~1.45M CZK, that's 0.0000753 BTC — below the 0.0002 BTC minimum. The bot can't place any orders.

Root cause: levels are sized for total equivalent, but budgetQuote is clamped to CZK-only after creation.

## Part 1: Level Clamping

**File: `functions/src/autopilot/autopilot.ts`**

After backtest validation (line 266) and before experiment creation (line 273):

1. Compute `effectiveBudgetQuote = wallet.availableQuote`
2. Create `adjustedConfig` with `budgetQuote = effectiveBudgetQuote`
3. Reduce levels until `getBudgetPerLevel(adjustedConfig) / adjustedConfig.upperPrice >= limits.minOrderSize`
4. If levels < 3, trigger auto-rebalance (Part 2)
5. Validate adjusted config with `validateGridConfig()`
6. Remove post-creation reconciliation (lines 303-317)
7. Add imports for `getBudgetPerLevel`, `validateGridConfig` from `"../grid"`

## Part 2: Auto-Rebalance Sell

**New method `rebalanceWallet()` in Autopilot class:**

1. Compute `minCzkNeeded = limits.minOrderSize * estimatedUpperPrice * ceil(3/2)`
2. Compute `shortfall = minCzkNeeded - wallet.availableQuote`
3. `sellAmount = (shortfall / currentPrice) * 1.05` (5% slippage buffer)
4. Cap at 50% of `wallet.availableBase`
5. Verify `sellAmount >= limits.minOrderSize`
6. Get ticker for bid price
7. Place limit sell at bid price via `this.client.sellLimit()`
8. Save `lastRebalanceAt` in autopilot state
9. Return `skipped` with reason "rebalancing wallet" — next tick will have more CZK

**Integration in `engage()`:**
- After level clamping determines "CZK too low for 3 levels"
- Before returning `skipped`, check if rebalance could fix it
- Execute rebalance if: `managedQuoteEquivalent >= minBudgetQuote` AND base is sufficient AND cooldown elapsed

**Safeguards:**
- Only rebalance if total value is enough
- Sell minimum needed + 5% buffer
- Cap at 50% of availableBase
- 10-minute cooldown between rebalance attempts
- Clear logging

## Part 3: Config Changes

**File: `functions/src/config/types.ts`**
- Add `lastRebalanceAt?: Date` to `AutopilotState` interface
- Add `lastRebalanceAt: FirestoreDate.optional()` to `AutopilotStateDocSchema`

## Part 4: Tests

**File: `functions/test/autopilot/autopilot.test.ts`**

1. Level clamping: mixed wallet with enough total but low CZK -> levels reduced
2. Level clamping skip -> triggers rebalance
3. Rebalance sell: verify sellLimit called with correct amount/price
4. Rebalance cooldown: prevents repeated sells
5. Rebalance insufficient base: skips gracefully
6. Update existing "reconciles budgetQuote" test

## Part 5: Post-Deploy

1. Push to main -> CI/CD deploys
2. `pnpm experiment:stop SNyrHHAUK5j1EECMKs3z`
3. `pnpm experiment:cleanup --yes`
4. Next tick: rebalance sell -> following tick: properly-sized grid
