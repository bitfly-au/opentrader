/**
 * @opentrader/telegram — Telegram notifications for OpenTrader
 *
 * Usage in strategy templates:
 *   import { telegram } from "@opentrader/telegram";
 *
 *   // Inside a generator strategy (fire-and-forget):
 *   yield telegram.notify(formatTradeEntry({ ... }));
 */
export { telegram } from "./notifier.js";
export {
  formatTradeEntry,
  formatTakeProfit,
  formatStopLoss,
  formatMissedOpportunity,
  formatBotStarted,
  formatBotStopped,
  formatNewRange,
  formatRangeReplaced,
  formatCircuitBreaker,
} from "./formatter.js";

export type {
  TradeEntryParams,
  TakeProfitParams,
  StopLossParams,
  MissedOpportunityParams,
  BotLifecycleParams,
  RangeEventParams,
  CircuitBreakerParams,
} from "./formatter.js";
