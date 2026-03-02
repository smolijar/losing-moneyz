import { GridConfig, COINMATE_FEES } from "../config";
import {
  calculateGridLevels,
  validateGridConfig,
  getBudgetPerLevel,
  getCounterOrderLevel,
  type FillEvent,
  computePnL,
} from "../grid";

/** A single price tick from historical data */
export interface PriceTick {
  timestamp: number;
  price: number;
  amount: number;
  side: "buy" | "sell";
}

/** Simulated order in the backtest */
interface SimOrder {
  id: number;
  side: "buy" | "sell";
  price: number;
  amount: number;
  gridLevel: number;
}

/** Backtest report */
export interface BacktestReport {
  config: GridConfig;
  periodDays: number;
  /** Starting and ending simulated balance */
  startingQuote: number;
  endingQuote: number;
  endingBase: number;
  /** P&L metrics */
  totalReturn: number;
  totalReturnPercent: number;
  annualizedReturnPercent: number;
  maxDrawdownPercent: number;
  /** Trade metrics */
  totalTrades: number;
  completedCycles: number;
  avgProfitPerCycle: number;
  totalFees: number;
  /** Grid utilization: what % of grid levels were ever triggered */
  gridUtilizationPercent: number;
  /** Validation: is this config profitable? */
  profitable: boolean;
  /** Detailed P&L over time for analysis */
  pnlTimeseries: Array<{ timestamp: number; cumulativePnl: number }>;
}

/** Backtest validation gate result */
export interface BacktestValidation {
  approved: boolean;
  reasons: string[];
  report: BacktestReport;
}

/**
 * Run a backtest simulation of the grid strategy on historical price ticks.
 *
 * This uses the same grid engine logic as live trading to ensure consistency.
 */
export function runBacktest(config: GridConfig, ticks: PriceTick[]): BacktestReport {
  if (ticks.length === 0) {
    throw new Error("No price ticks provided for backtest");
  }

  const gridLevels = calculateGridLevels(config);
  const feeRate = COINMATE_FEES.maker;

  // Simulation state
  let quoteBalance = config.budgetQuote;
  let baseBalance = 0;
  const budgetPerLevel = getBudgetPerLevel(config);
  let orderIdCounter = 0;
  const openOrders: Map<number, SimOrder> = new Map();
  const allFills: FillEvent[] = [];
  const levelsTriggered = new Set<number>();

  // Tracking for drawdown
  let peakValue = quoteBalance;
  let maxDrawdown = 0;
  const pnlTimeseries: Array<{ timestamp: number; cumulativePnl: number }> = [];

  // Place initial grid orders — only buy orders (we start with quote currency only).
  // Sell orders are placed after buys fill (counter-order logic).
  // This matches real-world behavior: we can't sell BTC we don't own.
  const startPrice = ticks[0].price;
  for (const level of gridLevels) {
    if (level.price < startPrice) {
      const amount = budgetPerLevel / level.price;
      // Reserve quote for buy
      if (quoteBalance >= budgetPerLevel) {
        quoteBalance -= budgetPerLevel;
        const order: SimOrder = {
          id: ++orderIdCounter,
          side: "buy",
          price: level.price,
          amount,
          gridLevel: level.index,
        };
        openOrders.set(order.id, order);
      }
    }
    // Levels above current price: no initial sell orders (no BTC yet).
    // Sells appear only as counter-orders after buys fill.
  }

  // Process each tick
  for (const tick of ticks) {
    const filledOrders: SimOrder[] = [];

    // Check which orders would be filled at this price
    for (const [, order] of openOrders) {
      if (order.side === "buy" && tick.price <= order.price) {
        filledOrders.push(order);
      } else if (order.side === "sell" && tick.price >= order.price) {
        filledOrders.push(order);
      }
    }

    // Process fills
    for (const order of filledOrders) {
      openOrders.delete(order.id);
      levelsTriggered.add(order.gridLevel);

      const fill: FillEvent = {
        orderId: order.id,
        side: order.side,
        price: order.price,
        amount: order.amount,
        gridLevel: order.gridLevel,
        timestamp: tick.timestamp,
      };
      allFills.push(fill);

      // Apply fill to balances
      if (order.side === "buy") {
        // We already reserved the quote when placing; now we get base
        const fee = order.price * order.amount * feeRate;
        baseBalance += order.amount;
        quoteBalance -= fee; // fee on buy
      } else {
        // Sell: we release base and get quote
        const quoteReceived = order.price * order.amount;
        const fee = quoteReceived * feeRate;
        baseBalance -= order.amount;
        quoteBalance += quoteReceived - fee;
      }

      // Place counter-order using shared grid engine logic
      const counterLevel = getCounterOrderLevel(order.side, order.gridLevel, gridLevels);
      if (counterLevel && !hasOrderAtLevel(openOrders, counterLevel.index)) {
        if (order.side === "buy") {
          // Counter sell at next level up — fee-adjusted amount to match engine logic.
          // After a buy fill, the actual sellable base is reduced by the maker fee.
          const sellAmount = order.amount * (1 - feeRate);
          const sellOrder: SimOrder = {
            id: ++orderIdCounter,
            side: "sell",
            price: counterLevel.price,
            amount: sellAmount,
            gridLevel: counterLevel.index,
          };
          openOrders.set(sellOrder.id, sellOrder);
        } else {
          // Counter buy at next level down
          const amount = budgetPerLevel / counterLevel.price;
          if (quoteBalance >= budgetPerLevel) {
            quoteBalance -= budgetPerLevel;
            const buyOrder: SimOrder = {
              id: ++orderIdCounter,
              side: "buy",
              price: counterLevel.price,
              amount,
              gridLevel: counterLevel.index,
            };
            openOrders.set(buyOrder.id, buyOrder);
          }
        }
      }
    }

    // Track portfolio value for drawdown
    const portfolioValue = quoteBalance + baseBalance * tick.price;
    if (portfolioValue > peakValue) {
      peakValue = portfolioValue;
    }
    const drawdown = ((peakValue - portfolioValue) / peakValue) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }

    // Record P&L timeseries (sample every ~100 ticks to keep size manageable)
    if (allFills.length % 10 === 0 || tick === ticks[ticks.length - 1]) {
      pnlTimeseries.push({
        timestamp: tick.timestamp,
        cumulativePnl: portfolioValue - config.budgetQuote,
      });
    }
  }

  // Final calculations
  const lastPrice = ticks[ticks.length - 1].price;
  const endingQuote = quoteBalance;
  const endingBase = baseBalance;
  const endingValue = endingQuote + endingBase * lastPrice;
  const totalReturn = endingValue - config.budgetQuote;
  const totalReturnPercent = (totalReturn / config.budgetQuote) * 100;

  const firstTimestamp = ticks[0].timestamp;
  const lastTimestamp = ticks[ticks.length - 1].timestamp;
  const periodDays = (lastTimestamp - firstTimestamp) / (1000 * 60 * 60 * 24);

  const annualizedReturnPercent =
    periodDays > 0 ? (totalReturnPercent / periodDays) * 365 : 0;

  const pnlResult = computePnL(allFills, feeRate);
  const avgProfitPerCycle =
    pnlResult.completedCycles > 0 ? pnlResult.realizedPnl / pnlResult.completedCycles : 0;

  return {
    config,
    periodDays,
    startingQuote: config.budgetQuote,
    endingQuote,
    endingBase,
    totalReturn,
    totalReturnPercent,
    annualizedReturnPercent,
    maxDrawdownPercent: maxDrawdown,
    totalTrades: allFills.length,
    completedCycles: pnlResult.completedCycles,
    avgProfitPerCycle,
    totalFees: pnlResult.totalFees,
    gridUtilizationPercent: (levelsTriggered.size / gridLevels.length) * 100,
    profitable: totalReturn > 0,
    pnlTimeseries,
  };
}

/** Check if there's already an order at a given grid level */
function hasOrderAtLevel(orders: Map<number, SimOrder>, gridLevel: number): boolean {
  for (const [, order] of orders) {
    if (order.gridLevel === gridLevel) return true;
  }
  return false;
}

/**
 * Validate a grid config using backtest results.
 * This is the "gate" that prevents deploying unprofitable configs.
 */
export function validateWithBacktest(
  config: GridConfig,
  ticks: PriceTick[],
  options: {
    minReturnPercent?: number;
    maxDrawdownPercent?: number;
  } = {},
): BacktestValidation {
  const minReturn = options.minReturnPercent ?? 0;
  const maxDrawdown = options.maxDrawdownPercent ?? 15;

  // First validate the config itself
  const configValidation = validateGridConfig(
    config,
    ticks.length > 0 ? ticks[0].price : config.lowerPrice,
  );
  if (!configValidation.valid) {
    return {
      approved: false,
      reasons: configValidation.errors,
      report: {
        config,
        periodDays: 0,
        startingQuote: config.budgetQuote,
        endingQuote: config.budgetQuote,
        endingBase: 0,
        totalReturn: 0,
        totalReturnPercent: 0,
        annualizedReturnPercent: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        completedCycles: 0,
        avgProfitPerCycle: 0,
        totalFees: 0,
        gridUtilizationPercent: 0,
        profitable: false,
        pnlTimeseries: [],
      },
    };
  }

  const report = runBacktest(config, ticks);
  const reasons: string[] = [];

  if (report.totalReturnPercent < minReturn) {
    reasons.push(
      `Return ${report.totalReturnPercent.toFixed(2)}% is below minimum ${minReturn}%`,
    );
  }

  if (report.maxDrawdownPercent > maxDrawdown) {
    reasons.push(
      `Max drawdown ${report.maxDrawdownPercent.toFixed(2)}% exceeds limit of ${maxDrawdown}%`,
    );
  }

  if (report.completedCycles === 0) {
    reasons.push("No completed trade cycles in backtest period");
  }

  return {
    approved: reasons.length === 0,
    reasons,
    report,
  };
}

/**
 * Format a backtest report for human-readable output.
 */
export function formatBacktestReport(report: BacktestReport): string {
  const lines = [
    `=== Backtest Report ===`,
    `Pair: ${report.config.pair}`,
    `Period: ${report.periodDays.toFixed(1)} days`,
    `Grid: ${report.config.lowerPrice} — ${report.config.upperPrice} (${report.config.levels} levels)`,
    ``,
    `--- Results ---`,
    `Starting balance: ${report.startingQuote.toFixed(2)} CZK`,
    `Ending quote: ${report.endingQuote.toFixed(2)} CZK`,
    `Ending base: ${report.endingBase.toFixed(8)} BTC`,
    `Total return: ${report.totalReturn.toFixed(2)} CZK (${report.totalReturnPercent.toFixed(2)}%)`,
    `Annualized return: ${report.annualizedReturnPercent.toFixed(2)}%`,
    `Max drawdown: ${report.maxDrawdownPercent.toFixed(2)}%`,
    ``,
    `--- Trades ---`,
    `Total fills: ${report.totalTrades}`,
    `Completed cycles: ${report.completedCycles}`,
    `Avg profit/cycle: ${report.avgProfitPerCycle.toFixed(2)} CZK`,
    `Total fees: ${report.totalFees.toFixed(2)} CZK`,
    `Grid utilization: ${report.gridUtilizationPercent.toFixed(1)}%`,
    ``,
    `Profitable: ${report.profitable ? "YES" : "NO"}`,
  ];
  return lines.join("\n");
}
