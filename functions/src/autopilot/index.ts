export { Autopilot, type AutopilotResult } from "./autopilot";
export {
  suggestParams,
  searchBestParams,
  scoreBacktestReport,
  detectTrend,
  resampleToCandles,
  computeDailyVolatility,
  biasInitialEntryTowardMarket,
  type SuggestResult,
  type SearchResult,
  type SuggestSkip,
  type TrendAnalysis,
  type EntryBiasMode,
} from "./param-suggester";
