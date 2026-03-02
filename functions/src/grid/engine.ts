import { GridConfig, COINMATE_FEES, getPairLimits } from "../config";

/** A single grid level with its price */
export interface GridLevel {
  /** 0-based index of the level (0 = lowest price) */
  index: number;
  /** Price at this grid level */
  price: number;
}

/**
 * Calculate arithmetic grid levels given a grid configuration.
 * Returns levels sorted ascending by price (index 0 = lowest).
 */
export function calculateGridLevels(config: GridConfig): GridLevel[] {
  const { upperPrice, lowerPrice, levels } = config;
  const spacing = (upperPrice - lowerPrice) / (levels - 1);
  const result: GridLevel[] = [];

  for (let i = 0; i < levels; i++) {
    result.push({
      index: i,
      price: roundPrice(lowerPrice + i * spacing),
    });
  }

  return result;
}

/**
 * Calculate the spacing between grid levels.
 */
export function getGridSpacing(config: GridConfig): number {
  return (config.upperPrice - config.lowerPrice) / (config.levels - 1);
}

/**
 * Calculate the spacing as a percentage of the average price.
 */
export function getGridSpacingPercent(config: GridConfig): number {
  const spacing = getGridSpacing(config);
  const midPrice = (config.upperPrice + config.lowerPrice) / 2;
  return (spacing / midPrice) * 100;
}

/** Round price to 2 decimal places (CZK precision) */
function roundPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

/**
 * Calculate budget per grid level from a grid configuration.
 * Budget is divided among half the levels (buy side of the grid).
 */
export function getBudgetPerLevel(config: GridConfig): number {
  return config.budgetQuote / Math.ceil(config.levels / 2);
}

/**
 * Round a base-currency amount to the pair's precision and clamp to minimum.
 * Returns 0 if the amount is below the minimum order size (caller should skip).
 */
export function roundAmount(amount: number, pair?: string): number {
  if (!pair) {
    return Math.round(amount * 1e8) / 1e8;
  }
  const limits = getPairLimits(pair);
  const factor = Math.pow(10, limits.basePrecision);
  const rounded = Math.floor(amount * factor) / factor; // floor to avoid exceeding balance
  return rounded < limits.minOrderSize ? 0 : rounded;
}

// ─── Counter-order logic (shared between live engine and backtester) ──────────

/**
 * Determine the target grid level for a counter-order after a fill.
 *
 * - Buy filled at level N → counter sell at level N+1
 * - Sell filled at level N → counter buy at level N-1
 *
 * Returns undefined if there's no valid counter-level (e.g. buy at top level).
 */
export function getCounterOrderLevel(
  fillSide: "buy" | "sell",
  fillGridLevel: number,
  gridLevels: GridLevel[],
): GridLevel | undefined {
  if (fillSide === "buy" && fillGridLevel < gridLevels.length - 1) {
    return gridLevels[fillGridLevel + 1];
  }
  if (fillSide === "sell" && fillGridLevel > 0) {
    return gridLevels[fillGridLevel - 1];
  }
  return undefined;
}

// ─── Order actions ────────────────────────────────────────────────────────────

export type OrderAction =
  | { type: "place"; side: "buy" | "sell"; price: number; amount: number; gridLevel: number }
  | { type: "cancel"; orderId: number; reason: string };

/** Representation of an existing open order (from Coinmate) */
export interface ExistingOrder {
  id: number;
  side: "buy" | "sell";
  price: number;
  amount: number;
  /** Which grid level this order corresponds to (-1 if orphaned) */
  gridLevel: number;
}

/** A fill event — a matched buy or sell that completed */
export interface FillEvent {
  orderId: number;
  side: "buy" | "sell";
  price: number;
  amount: number;
  gridLevel: number;
  timestamp: number;
}

/**
 * Options for state-based reconciliation.
 */
export interface ReconcileOptions {
  /** Maker fee rate for fee-adjusted sell amounts (default: COINMATE_FEES.maker) */
  feeRate?: number;
  /** Trading pair, used for precision/minimum enforcement */
  pair?: string;
  /** Available base balance for sell orders. If undefined, sells are placed freely (legacy). */
  availableBase?: number;
  /** Available quote balance for buy orders. If undefined, buys are placed freely (legacy). */
  availableQuote?: number;
}

/**
 * Core STATE-BASED reconciliation: determines the desired grid state and diffs
 * it against current reality to produce order actions.
 *
 * For every grid level the desired state is:
 *   - Levels below currentPrice → should have a BUY order
 *   - Levels above currentPrice → should have a SELL order
 *   - Level at exactly currentPrice → no order (on the line)
 *
 * This is SELF-HEALING: if a counter-order placement failed on a previous tick,
 * the missing order will be detected and re-placed on the next tick.
 *
 * Sells are fee-adjusted: the amount is reduced by the maker fee to reflect the
 * actual base received after a buy fill. When availableBase is provided, sell
 * placement is capped by what base we actually hold.
 *
 * This function is PURE — no side effects, no API calls.
 */
export function reconcileOrders(
  gridLevels: GridLevel[],
  existingOrders: ExistingOrder[],
  recentFills: FillEvent[],
  currentPrice: number,
  budgetPerLevel: number,
  options: ReconcileOptions = {},
): OrderAction[] {
  const feeRate = options.feeRate ?? COINMATE_FEES.maker;
  const pair = options.pair;
  const actions: OrderAction[] = [];

  // Build a map of grid level → existing order (for occupied-level tracking)
  const ordersByLevel = new Map<number, ExistingOrder>();
  for (const order of existingOrders) {
    if (order.gridLevel >= 0) {
      ordersByLevel.set(order.gridLevel, order);
    }
  }

  // Cancel orphaned orders (not matching any valid grid level)
  const validLevelIndices = new Set(gridLevels.map((l) => l.index));
  for (const order of existingOrders) {
    if (order.gridLevel < 0 || !validLevelIndices.has(order.gridLevel)) {
      actions.push({ type: "cancel", orderId: order.id, reason: "orphaned" });
    }
  }

  // Cancel orders on the wrong side (buy above price, sell below price).
  // This can happen if price moved significantly since last tick.
  for (const order of existingOrders) {
    if (order.gridLevel < 0) continue; // already handled as orphan
    const level = gridLevels[order.gridLevel];
    if (!level) continue;
    if (order.side === "buy" && level.price > currentPrice) {
      actions.push({ type: "cancel", orderId: order.id, reason: "buy above current price" });
      ordersByLevel.delete(order.gridLevel);
    } else if (order.side === "sell" && level.price < currentPrice) {
      actions.push({ type: "cancel", orderId: order.id, reason: "sell below current price" });
      ordersByLevel.delete(order.gridLevel);
    }
  }

  // Track available base for sell placement (if provided)
  let remainingBase = options.availableBase;
  // Track available quote for buy placement (if provided)
  let remainingQuote = options.availableQuote;

  // Compute desired state and diff against actual
  for (const level of gridLevels) {
    if (ordersByLevel.has(level.index)) {
      // Level already has an order — no action needed
      continue;
    }

    if (level.price < currentPrice) {
      // Desired: BUY order at this level
      const rawAmount = budgetPerLevel / level.price;
      const amount = roundAmount(rawAmount, pair);
      if (amount <= 0) continue;

      // Enforce available quote constraint
      const orderCost = amount * level.price;
      if (remainingQuote !== undefined) {
        if (remainingQuote < orderCost) {
          // Not enough quote to place this buy — skip
          continue;
        }
        remainingQuote -= orderCost;
      }

      actions.push({
        type: "place",
        side: "buy",
        price: level.price,
        amount,
        gridLevel: level.index,
      });
    } else if (level.price > currentPrice) {
      // Desired: SELL order at this level
      // Fee-adjusted amount: we received (1 - feeRate) of the base from the buy fill
      const rawAmount = (budgetPerLevel / level.price) * (1 - feeRate);
      const amount = roundAmount(rawAmount, pair);
      if (amount <= 0) continue;

      // Enforce available base constraint
      if (remainingBase !== undefined) {
        if (remainingBase < amount) {
          // Not enough base to place this sell — skip
          continue;
        }
        remainingBase -= amount;
      }

      actions.push({
        type: "place",
        side: "sell",
        price: level.price,
        amount,
        gridLevel: level.index,
      });
    }
    // level.price === currentPrice → skip (right on the line)
  }

  return actions;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    spacingCzk: number;
    spacingPercent: number;
    budgetPerLevel: number;
    minProfitPerTrade: number;
    levelsBelow: number;
    levelsAbove: number;
  };
}

/**
 * Validate grid configuration for safety and profitability.
 */
export function validateGridConfig(
  config: GridConfig,
  currentPrice: number,
  feeRate: number = COINMATE_FEES.maker,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Basic validation
  if (config.upperPrice <= config.lowerPrice) {
    errors.push("Upper price must be greater than lower price");
  }

  if (config.levels < 3) {
    errors.push("Minimum 3 grid levels required");
  }

  const spacing = getGridSpacing(config);
  const spacingPercent = getGridSpacingPercent(config);
  const minSpacingPercent = feeRate * 2 * 100 * COINMATE_FEES.minSpacingMultiplier;

  if (spacingPercent < minSpacingPercent) {
    errors.push(
      `Grid spacing ${spacingPercent.toFixed(2)}% is below minimum ${minSpacingPercent.toFixed(2)}% ` +
        `(3x round-trip fees of ${(feeRate * 2 * 100).toFixed(2)}%)`,
    );
  }

  // Budget check: need enough to place buy orders on levels below current price
  const levelsBelow = Math.floor((currentPrice - config.lowerPrice) / spacing);
  const levelsAbove = config.levels - 1 - levelsBelow;
  const budgetPerLevel = getBudgetPerLevel(config);

  if (budgetPerLevel < 100) {
    errors.push(`Budget per level (${budgetPerLevel.toFixed(0)} CZK) is too low; minimum ~100 CZK`);
  }

  // Check against pair-specific minimum order size
  const limits = getPairLimits(config.pair);
  const minAmount = budgetPerLevel / config.upperPrice; // smallest possible order amount
  if (minAmount < limits.minOrderSize) {
    errors.push(
      `Budget per level produces order size ${minAmount.toFixed(limits.basePrecision)} ` +
        `which is below minimum ${limits.minOrderSize} for ${config.pair}`,
    );
  }

  // Warning checks
  if (currentPrice < config.lowerPrice || currentPrice > config.upperPrice) {
    warnings.push("Current price is outside the grid range");
  }

  if (config.levels > 50) {
    warnings.push("High number of grid levels (>50) may generate many orders");
  }

  // Profit per completed buy-sell cycle (after fees)
  const minProfitPerTrade = spacing - spacing * feeRate * 2;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    metrics: {
      spacingCzk: spacing,
      spacingPercent,
      budgetPerLevel,
      minProfitPerTrade,
      levelsBelow,
      levelsAbove,
    },
  };
}

// ─── P&L calculation ──────────────────────────────────────────────────────────

export interface PnLResult {
  /** Total realized P&L from completed buy-sell cycles */
  realizedPnl: number;
  /** Number of completed round-trip trades (may be fractional for partial fills) */
  completedCycles: number;
  /** Total fees paid */
  totalFees: number;
  /** Gross profit before fees */
  grossProfit: number;
}

/**
 * Compute realized P&L from a list of fills using QUANTITY-AWARE FIFO.
 *
 * Unlike the previous version which assumed 1:1 buy/sell matching, this
 * properly tracks residual quantities: a single buy can be matched by
 * multiple sells, and vice versa.
 */
export function computePnL(fills: FillEvent[], feeRate: number = COINMATE_FEES.maker): PnLResult {
  // Separate buys and sells, sorted by timestamp
  const buys = fills.filter((f) => f.side === "buy").sort((a, b) => a.timestamp - b.timestamp);
  const sells = fills.filter((f) => f.side === "sell").sort((a, b) => a.timestamp - b.timestamp);

  let realizedPnl = 0;
  let completedCycles = 0;
  let totalFees = 0;
  let grossProfit = 0;

  // Build a queue of buy lots with remaining quantities
  const buyQueue: Array<{ price: number; remaining: number }> = buys.map((b) => ({
    price: b.price,
    remaining: b.amount,
  }));

  let buyIdx = 0;

  for (const sell of sells) {
    let sellRemaining = sell.amount;

    while (sellRemaining > 0 && buyIdx < buyQueue.length) {
      const buy = buyQueue[buyIdx];
      const matchQty = Math.min(buy.remaining, sellRemaining);

      const buyValue = buy.price * matchQty;
      const sellValue = sell.price * matchQty;
      const buyFee = buyValue * feeRate;
      const sellFee = sellValue * feeRate;

      const profit = sellValue - buyValue;
      const netProfit = profit - buyFee - sellFee;

      grossProfit += profit;
      totalFees += buyFee + sellFee;
      realizedPnl += netProfit;

      buy.remaining -= matchQty;
      sellRemaining -= matchQty;

      // Count cycles proportionally: if a buy of 0.01 BTC is fully consumed, that's 1 cycle
      // A partial match counts as a fractional cycle
      if (buy.remaining <= 1e-12) {
        completedCycles++;
        buyIdx++;
      }
    }
  }

  return { realizedPnl, completedCycles, totalFees, grossProfit };
}

/**
 * Compute unrealized P&L from open positions using QUANTITY-AWARE FIFO.
 *
 * Matches sells to buys (FIFO) to find unmatched buy quantities,
 * then computes (currentPrice - buyPrice) * remainingQty for each.
 */
export function computeUnrealizedPnl(fills: FillEvent[], currentPrice: number): number {
  const buys = fills.filter((f) => f.side === "buy").sort((a, b) => a.timestamp - b.timestamp);
  const sells = fills.filter((f) => f.side === "sell").sort((a, b) => a.timestamp - b.timestamp);

  // Build buy lots with remaining quantities
  const buyLots: Array<{ price: number; remaining: number }> = buys.map((b) => ({
    price: b.price,
    remaining: b.amount,
  }));

  // Consume buys with sells (FIFO)
  let buyIdx = 0;
  for (const sell of sells) {
    let sellRemaining = sell.amount;
    while (sellRemaining > 0 && buyIdx < buyLots.length) {
      const lot = buyLots[buyIdx];
      const matchQty = Math.min(lot.remaining, sellRemaining);
      lot.remaining -= matchQty;
      sellRemaining -= matchQty;
      if (lot.remaining <= 1e-12) {
        buyIdx++;
      }
    }
  }

  // Unrealized P&L: unmatched buy positions valued at current price
  let unrealized = 0;
  for (let i = buyIdx; i < buyLots.length; i++) {
    const lot = buyLots[i];
    if (lot.remaining > 1e-12) {
      unrealized += (currentPrice - lot.price) * lot.remaining;
    }
  }

  return unrealized;
}

// ─── Utility: match existing orders to grid levels ────────────────────────────

/**
 * Match existing Coinmate open orders to grid levels.
 * Uses price proximity (within 0.5% of level price) to assign grid levels.
 */
export function matchOrdersToGrid(
  orders: Array<{ id: number; type: "BUY" | "SELL"; price: number; amount: number }>,
  gridLevels: GridLevel[],
  tolerancePercent: number = 0.5,
): ExistingOrder[] {
  return orders.map((order) => {
    let matchedLevel = -1;
    let closestDistance = Infinity;

    for (const level of gridLevels) {
      const distance = Math.abs(order.price - level.price);
      const toleranceAbs = level.price * (tolerancePercent / 100);
      if (distance <= toleranceAbs && distance < closestDistance) {
        closestDistance = distance;
        matchedLevel = level.index;
      }
    }

    return {
      id: order.id,
      side: order.type === "BUY" ? ("buy" as const) : ("sell" as const),
      price: order.price,
      amount: order.amount,
      gridLevel: matchedLevel,
    };
  });
}
