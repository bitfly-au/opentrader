/**
 * Message formatting utilities for Telegram notifications.
 * Uses Telegram MarkdownV2 formatting.
 */

/** Escape special characters for Telegram MarkdownV2 */
function esc(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/** Format a number to a given number of decimal places, escaped for MD */
function num(value: number, decimals = 2): string {
  return esc(value.toFixed(decimals));
}

// ════════════════════════════════════════════════════════════════════════════
// Trade Events
// ════════════════════════════════════════════════════════════════════════════

export interface TradeEntryParams {
  botName: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  tpPrice?: number;
  slPrice?: number;
  quantity: number;
  ref?: string;
  extraInfo?: string;
}

export function formatTradeEntry(p: TradeEntryParams): string {
  const lines = [
    `🚨 *TRADE ENTRY*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
    `Direction: *${esc(p.direction)}*`,
    `Entry: ${num(p.entryPrice)} \\| Qty: ${num(p.quantity, 6)}`,
  ];
  if (p.tpPrice != null) lines.push(`TP Target: ${num(p.tpPrice)}`);
  if (p.slPrice != null) lines.push(`SL Target: ${num(p.slPrice)}`);
  if (p.ref) lines.push(`Ref: ${esc(p.ref)}`);
  if (p.extraInfo) lines.push(esc(p.extraInfo));
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────

export interface TakeProfitParams {
  botName: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  ref?: string;
  extraInfo?: string;
}

export function formatTakeProfit(p: TakeProfitParams): string {
  const pnl = p.direction === "SHORT"
    ? (p.entryPrice - p.exitPrice) * p.quantity
    : (p.exitPrice - p.entryPrice) * p.quantity;
  const pnlPct = p.direction === "SHORT"
    ? ((p.entryPrice - p.exitPrice) / p.entryPrice) * 100
    : ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100;

  const lines = [
    `✅ *TAKE PROFIT HIT*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
    `Direction: *${esc(p.direction)}*`,
    `Entry: ${num(p.entryPrice)} → Exit: ${num(p.exitPrice)}`,
    `P&L: ${pnl >= 0 ? "\\+" : ""}${num(pnl)} \\(${pnl >= 0 ? "\\+" : ""}${num(pnlPct)}%\\)`,
  ];
  if (p.ref) lines.push(`Ref: ${esc(p.ref)}`);
  if (p.extraInfo) lines.push(esc(p.extraInfo));
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────

export interface StopLossParams {
  botName: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  ref?: string;
  extraInfo?: string;
}

export function formatStopLoss(p: StopLossParams): string {
  const pnl = p.direction === "SHORT"
    ? (p.entryPrice - p.exitPrice) * p.quantity
    : (p.exitPrice - p.entryPrice) * p.quantity;
  const pnlPct = p.direction === "SHORT"
    ? ((p.entryPrice - p.exitPrice) / p.entryPrice) * 100
    : ((p.exitPrice - p.entryPrice) / p.entryPrice) * 100;

  const lines = [
    `🛑 *STOP LOSS HIT*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
    `Direction: *${esc(p.direction)}*`,
    `Entry: ${num(p.entryPrice)} → Exit: ${num(p.exitPrice)}`,
    `P&L: ${pnl >= 0 ? "\\+" : ""}${num(pnl)} \\(${pnl >= 0 ? "\\+" : ""}${num(pnlPct)}%\\)`,
  ];
  if (p.ref) lines.push(`Ref: ${esc(p.ref)}`);
  if (p.extraInfo) lines.push(esc(p.extraInfo));
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// Missed Opportunities
// ════════════════════════════════════════════════════════════════════════════

export interface MissedOpportunityParams {
  botName: string;
  symbol: string;
  reason: string;
  details?: string;
}

export function formatMissedOpportunity(p: MissedOpportunityParams): string {
  const lines = [
    `⚠️ *MISSED OPPORTUNITY*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
    `Reason: ${esc(p.reason)}`,
  ];
  if (p.details) lines.push(esc(p.details));
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// Bot Lifecycle
// ════════════════════════════════════════════════════════════════════════════

export interface BotLifecycleParams {
  botName: string;
  symbol: string;
  extraInfo?: string;
}

export function formatBotStarted(p: BotLifecycleParams): string {
  const lines = [
    `🟢 *BOT STARTED*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
  ];
  if (p.extraInfo) lines.push(esc(p.extraInfo));
  return lines.join("\n");
}

export function formatBotStopped(p: BotLifecycleParams): string {
  const lines = [
    `🔴 *BOT STOPPED*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
  ];
  if (p.extraInfo) lines.push(esc(p.extraInfo));
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// Range Events (Pump Range Scalper specific)
// ════════════════════════════════════════════════════════════════════════════

export interface RangeEventParams {
  botName: string;
  symbol: string;
  rangeTop: number;
  rangeBottom: number;
  extraInfo?: string;
}

export function formatNewRange(p: RangeEventParams): string {
  const lines = [
    `📊 *NEW RANGE DETECTED*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
    `Range: \\[${num(p.rangeBottom)} — ${num(p.rangeTop)}\\]`,
  ];
  if (p.extraInfo) lines.push(esc(p.extraInfo));
  return lines.join("\n");
}

export function formatRangeReplaced(p: RangeEventParams & { closedTrades: number }): string {
  const lines = [
    `🔄 *RANGE REPLACED*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
    `New Range: \\[${num(p.rangeBottom)} — ${num(p.rangeTop)}\\]`,
    `Closed ${esc(String(p.closedTrades))} existing trade\\(s\\)`,
  ];
  if (p.extraInfo) lines.push(esc(p.extraInfo));
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// Circuit Breakers (Short The Rip specific)
// ════════════════════════════════════════════════════════════════════════════

export interface CircuitBreakerParams {
  botName: string;
  symbol: string;
  reason: string;
  details?: string;
}

export function formatCircuitBreaker(p: CircuitBreakerParams): string {
  const lines = [
    `🛑 *CIRCUIT BREAKER*`,
    `Bot: ${esc(p.botName)} \\| ${esc(p.symbol)}`,
    `Reason: ${esc(p.reason)}`,
  ];
  if (p.details) lines.push(esc(p.details));
  return lines.join("\n");
}
