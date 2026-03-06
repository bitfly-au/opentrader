import { z } from "zod";
import Big from "big.js";
import type { IExchange } from "@opentrader/exchanges";
import type { ICandlestick } from "@opentrader/types";
import {
  useExchange,
  useCandle,
  useSmartTrade,
  getSmartTrade,
  cancelSmartTrade,
  cancelAllTrades,
  IBotConfiguration,
  TBotContext,
  type SmartTradeService,
  type CancelAllTradesResult,
} from "@opentrader/bot-processor";
import { logger } from "@opentrader/logger";

// ════════════════════════════════════════════════════════════════════════════
// Helper utilities
// ════════════════════════════════════════════════════════════════════════════

/** Derive linear perpetual symbol: ETH/USDT → ETH/USDT:USDT */
function toPerpSymbol(symbol: string): string {
  if (symbol.includes(":")) return symbol;
  const quote = (symbol.split("/")[1] || "").split(":")[0];
  return `${symbol}:${quote}`;
}

/** Extract quote currency: ETH/USDT → USDT */
function getQuoteCurrency(symbol: string): string {
  return (symbol.split("/")[1] || "").split(":")[0];
}

// ════════════════════════════════════════════════════════════════════════════
// Main Strategy
// ════════════════════════════════════════════════════════════════════════════

/**
 * Pump Range Scalper — Short Scalping Within Pump Ranges
 *
 * Detects a "pump range" defined by 3 consecutive green candles with:
 *   - Total price rise > configurable threshold (default 4%)
 *   - First pump candle has volume >= configurable multiplier (default 4x) of prior candle
 *
 * Once a range is established, on each candle close:
 *   - If the candle's close is >= 0.22% above its open → market short
 *   - Take profit at 0.15% below entry
 *
 * Stop conditions:
 *   - Price > rangeTop → stop opening new shorts (existing TPs remain)
 *   - Price > rangeTop + 30% of range height → hard stop loss, cancel all
 *   - New range detected → market-close all existing shorts, switch to new range
 */
export function* pumpRangeScalper(ctx: TBotContext<PumpRangeScalperConfig, PumpRangeScalperState>) {
  const {
    config: { settings: params },
    state,
    onStart,
    onStop,
  } = ctx;

  const spotSymbol = ctx.config.symbol;
  const perpSymbol = toPerpSymbol(spotSymbol);
  const quoteCurrency = getQuoteCurrency(spotSymbol);

  // ── Bot lifecycle ──────────────────────────────────────────────────────

  if (onStart) {
    logger.info(`[PumpRangeScalper] Bot started on ${spotSymbol} (perp: ${perpSymbol})`);
    logger.info(ctx.config, "[PumpRangeScalper] Bot config");

    // Initialize state (preserve all fields across restarts)
    state.phase = state.phase ?? "SCANNING";
    state.openTrades = state.openTrades ?? [];
    state.tradeCounter = state.tradeCounter ?? 0;
    // rangeTop and rangeBottom are preserved from DB state

    if (state.phase === "RANGE_ACTIVE" && state.rangeTop != null && state.rangeBottom != null) {
      logger.info(
        `[PumpRangeScalper] ♻️ Restored range from previous session: [${state.rangeBottom.toFixed(2)} — ${state.rangeTop.toFixed(2)}] | ` +
        `Phase: ${state.phase} | Open trades: ${(state.openTrades ?? []).length}`,
      );
    }

    // Set cross margin mode & leverage
    const startExchange: IExchange = yield useExchange();

    yield startExchange.ccxt
      .setMarginMode("cross", perpSymbol)
      .then(() => logger.info(`[PumpRangeScalper] Margin mode set to CROSS for ${perpSymbol}`))
      .catch((err: Error) => logger.warn(`[PumpRangeScalper] setMarginMode: ${err.message}`));

    yield startExchange.ccxt
      .setLeverage(params.leverage, perpSymbol)
      .then(() => logger.info(`[PumpRangeScalper] Leverage set to ${params.leverage}x for ${perpSymbol}`))
      .catch((err: Error) => logger.warn(`[PumpRangeScalper] setLeverage: ${err.message}`));

    return;
  }

  if (onStop) {
    logger.info("[PumpRangeScalper] Bot stopped — cancelling all trades");
    const result: CancelAllTradesResult = yield cancelAllTrades();
    logger.info(`[PumpRangeScalper] Cancelled ${result.cancelled}/${result.total} trades`);

    // Market-close any remaining short positions
    yield* marketCloseAllShorts(ctx, perpSymbol, quoteCurrency);

    // Clear trades (positions are closed) but preserve the range for restarts
    state.openTrades = [];
    return;
  }

  // ── Handle order fill events ───────────────────────────────────────────

  if (ctx.event === "onOrderFilled") {
    // Check each tracked trade to see if it completed (TP filled)
    const stillOpen: TradeRecord[] = [];

    for (const trade of state.openTrades ?? []) {
      const existingTrade: SmartTradeService | null = yield getSmartTrade(trade.ref);
      if (existingTrade && existingTrade.isCompleted()) {
        logger.info(`[PumpRangeScalper] ✅ Trade ${trade.ref} completed (TP filled)`);
      } else {
        stillOpen.push(trade);
      }
    }

    state.openTrades = stillOpen;
    return;
  }

  // ── Main candle-close logic ────────────────────────────────────────────

  // Clean up completed trades first
  const activeOpenTrades: TradeRecord[] = [];
  for (const trade of state.openTrades ?? []) {
    const existingTrade: SmartTradeService | null = yield getSmartTrade(trade.ref);
    if (existingTrade && !existingTrade.isCompleted()) {
      activeOpenTrades.push(trade);
    } else if (existingTrade && existingTrade.isCompleted()) {
      logger.info(`[PumpRangeScalper] ✅ Trade ${trade.ref} completed — removing from tracker`);
    }
  }
  state.openTrades = activeOpenTrades;

  // ── Check for new pump range (always, even if already in a range) ──────

  const candle1: ICandlestick = yield useCandle(-1); // most recent closed
  const candle2: ICandlestick = yield useCandle(-2);
  const candle3: ICandlestick = yield useCandle(-3);
  const candle0: ICandlestick = yield useCandle(-4); // reference candle before the pump

  const newRangeDetected = detectPumpRange(candle0, candle3, candle2, candle1, params);

  if (newRangeDetected) {
    const newRangeTop = Math.max(candle3.high, candle2.high, candle1.high);
    const newRangeBottom = candle3.open;
    const rangeHeight = new Big(newRangeTop).minus(newRangeBottom);
    const totalRise = new Big(candle1.close).minus(candle3.open).div(candle3.open).times(100);
    const volRatio = new Big(candle3.volume).div(candle0.volume);

    logger.info(
      `[PumpRangeScalper] 🚨 NEW PUMP RANGE DETECTED | Rise: ${totalRise.toFixed(2)}% | Vol: ${volRatio.toFixed(2)}x | ` +
      `Range: [${newRangeBottom.toFixed(2)} — ${newRangeTop.toFixed(2)}] (height: ${rangeHeight.toFixed(2)})`,
    );

    // If we had an old range with open trades → market close all shorts
    if (state.phase === "RANGE_ACTIVE" && (state.openTrades ?? []).length > 0) {
      logger.info(
        `[PumpRangeScalper] Range replaced — market-closing ${state.openTrades!.length} open short(s)`,
      );

      // Cancel all pending TP limit orders
      const cancelResult: CancelAllTradesResult = yield cancelAllTrades();
      logger.info(`[PumpRangeScalper] Cancelled ${cancelResult.cancelled}/${cancelResult.total} pending orders`);

      // Market-close the aggregate short position
      yield* marketCloseAllShorts(ctx, perpSymbol, quoteCurrency);

      state.openTrades = [];
    }

    // Establish the new range
    state.phase = "RANGE_ACTIVE";
    state.rangeTop = newRangeTop;
    state.rangeBottom = newRangeBottom;

    const slCeiling = new Big(newRangeTop).plus(new Big(params.stopLossRangeMultiple).times(rangeHeight));
    logger.info(
      `[PumpRangeScalper] Range active: [${newRangeBottom.toFixed(2)} — ${newRangeTop.toFixed(2)}] | ` +
      `SL ceiling: ${slCeiling.toFixed(2)}`,
    );
  }

  // ── If no active range, nothing to do ──────────────────────────────────

  if (state.phase !== "RANGE_ACTIVE" || state.rangeTop == null || state.rangeBottom == null) {
    logger.info("[PumpRangeScalper] SCANNING — no active range");
    return;
  }

  const currentPrice = candle1.close;
  const rangeTop = new Big(state.rangeTop);
  const rangeBottom = new Big(state.rangeBottom);
  const rangeHeight = rangeTop.minus(rangeBottom);
  const stopLossCeiling = rangeTop.plus(new Big(params.stopLossRangeMultiple).times(rangeHeight));

  // ── Hard stop loss: price above rangeTop + 30% of range height ─────────

  if (new Big(currentPrice).gt(stopLossCeiling)) {
    logger.warn(
      `[PumpRangeScalper] 🛑 HARD STOP LOSS | Price ${currentPrice.toFixed(2)} > SL ceiling ${stopLossCeiling.toFixed(2)} | ` +
      `Market-closing ${(state.openTrades ?? []).length} short(s)`,
    );

    // Cancel all pending TP orders
    const cancelResult: CancelAllTradesResult = yield cancelAllTrades();
    logger.info(`[PumpRangeScalper] Cancelled ${cancelResult.cancelled}/${cancelResult.total} pending orders`);

    // Market-close all shorts
    yield* marketCloseAllShorts(ctx, perpSymbol, quoteCurrency);

    state.openTrades = [];
    state.phase = "SCANNING";
    state.rangeTop = undefined;
    state.rangeBottom = undefined;
    return;
  }

  // ── Stop trading (no new shorts) if price > rangeTop ───────────────────

  if (new Big(currentPrice).gt(rangeTop)) {
    logger.info(
      `[PumpRangeScalper] Price ${currentPrice.toFixed(2)} > rangeTop ${rangeTop.toFixed(2)} — no new shorts | ` +
      `Open trades: ${(state.openTrades ?? []).length} | SL ceiling: ${stopLossCeiling.toFixed(2)}`,
    );
    return;
  }

  // ── Max concurrent trades check ────────────────────────────────────────

  const openCount = (state.openTrades ?? []).length;
  if (openCount >= params.maxConcurrentTrades) {
    logger.info(
      `[PumpRangeScalper] Skip | At max concurrent trades (${openCount}/${params.maxConcurrentTrades}) | ` +
      `Price: ${currentPrice.toFixed(2)} | Range: [${rangeBottom.toFixed(2)} — ${rangeTop.toFixed(2)}]`,
    );
    return;
  }

  // ── Entry condition: candle close >= 0.22% above candle open ───────────

  const candleRise = new Big(candle1.close).minus(candle1.open).div(candle1.open);

  if (candleRise.lt(params.entryRiseThreshold)) {
    logger.info(
      `[PumpRangeScalper] Skip | Candle rise: ${candleRise.times(100).toFixed(4)}% < ${(params.entryRiseThreshold * 100).toFixed(2)}% | ` +
      `Price: ${currentPrice.toFixed(2)} | Range: [${rangeBottom.toFixed(2)} — ${rangeTop.toFixed(2)}] | ` +
      `Open trades: ${(state.openTrades ?? []).length}`,
    );
    return;
  }

  // ── All conditions met — calculate position size ───────────────────────

  const entryPrice = new Big(currentPrice);
  const tpPriceBig = entryPrice.times(new Big(1).minus(params.tpDropPercent));

  // Fetch balance
  const exchange: IExchange = yield useExchange();
  const rawBalance: Record<string, any> | null = yield exchange.ccxt
    .fetchBalance({ type: "swap" })
    .catch((err: Error) => {
      logger.error(`[PumpRangeScalper] Failed to fetch balance: ${err.message}`);
      return null;
    });

  const walletBalance = new Big(rawBalance ? Number(rawBalance[quoteCurrency]?.free ?? 0) : 0);

  if (walletBalance.lte(0)) {
    logger.warn(`[PumpRangeScalper] Skip | No ${quoteCurrency} balance (${walletBalance.toFixed(2)})`);
    return;
  }

  // Position sizing: cross-margin liquidation target formula
  // Each trade gets an equal share of the balance so that if all slots fill,
  // the aggregate position equals what a single-trade strategy would open.
  // Short: Qty = (Balance / maxConcurrentTrades) / (LiqTarget × (1 + MMR) - Entry)
  const effectiveBalance = walletBalance.div(params.maxConcurrentTrades);
  const mmr = new Big(params.maintenanceMarginRate);
  const liqTarget = new Big(params.liquidationTarget);
  const denominator = liqTarget.times(new Big(1).plus(mmr)).minus(entryPrice);

  if (denominator.lte(0)) {
    logger.warn(
      `[PumpRangeScalper] Skip | Liq target ${liqTarget.toFixed(2)} too close to entry ${entryPrice.toFixed(2)} (denominator: ${denominator.toFixed(4)})`,
    );
    return;
  }

  let quantityBig = effectiveBalance.div(denominator);

  // Cap at leverage limit (also proportional per trade)
  const maxQty = effectiveBalance.times(params.leverage).div(entryPrice);
  if (quantityBig.gt(maxQty)) quantityBig = maxQty;

  if (quantityBig.lte(0)) {
    logger.warn(`[PumpRangeScalper] Skip | Calculated quantity is ${quantityBig.toFixed(6)}`);
    return;
  }

  // Round quantity and TP price to exchange precision
  let quantity = parseFloat(exchange.ccxt.amountToPrecision(perpSymbol, quantityBig.toNumber()));
  let tpPrice = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, tpPriceBig.toNumber()));

  if (quantity <= 0) {
    logger.warn(`[PumpRangeScalper] Skip | Quantity rounds to 0 after precision adjustment`);
    return;
  }

  // ── Place the short ────────────────────────────────────────────────────

  const tradeRef = `t_${state.tradeCounter ?? 0}`;
  state.tradeCounter = (state.tradeCounter ?? 0) + 1;

  logger.info(
    `[PumpRangeScalper] 🚨 SHORT ${tradeRef} | Rise: ${candleRise.times(100).toFixed(4)}% ≥ ${(params.entryRiseThreshold * 100).toFixed(2)}% | ` +
    `Entry: ${entryPrice.toFixed(2)} | TP: ${tpPrice.toFixed(2)} (${(params.tpDropPercent * 100).toFixed(2)}% drop) | ` +
    `Qty: ${quantity.toFixed(6)} | Bal: ${walletBalance.toFixed(2)} (eff: ${effectiveBalance.toFixed(2)}) ${quoteCurrency} | ` +
    `Range: [${rangeBottom.toFixed(2)} — ${rangeTop.toFixed(2)}] | Slot: ${openCount + 1}/${params.maxConcurrentTrades}`,
  );

  const trade: SmartTradeService = yield useSmartTrade(
    {
      entry: {
        type: "Market",
        side: "Sell",
        symbol: perpSymbol,
      },
      tp: {
        type: "Limit",
        side: "Buy",
        price: tpPrice,
        symbol: perpSymbol,
      },
      quantity,
    },
    tradeRef,
  );

  // Track the trade
  if (!state.openTrades) state.openTrades = [];
  state.openTrades.push({ ref: tradeRef, quantity, entryPrice: currentPrice });

  logger.info(
    `[PumpRangeScalper] ✅ Trade ${tradeRef} placed — SHORT ${quantity.toFixed(6)} @ market | TP: ${tpPrice.toFixed(2)} | ` +
    `Total open trades: ${state.openTrades.length}`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Helper: Market-close all open short positions
// ════════════════════════════════════════════════════════════════════════════

function* marketCloseAllShorts(
  ctx: TBotContext<PumpRangeScalperConfig, PumpRangeScalperState>,
  perpSymbol: string,
  quoteCurrency: string,
) {
  const { state } = ctx;
  const openTrades = state.openTrades ?? [];

  if (openTrades.length === 0) {
    logger.info("[PumpRangeScalper] No open shorts to close");
    return;
  }

  // Sum total quantity to close using Big for precision
  const totalQty = openTrades.reduce((sum, t) => sum.plus(t.quantity), new Big(0));

  if (totalQty.lte(0)) {
    logger.info("[PumpRangeScalper] No quantity to close");
    return;
  }

  const totalQtyNum = totalQty.toNumber();

  logger.info(
    `[PumpRangeScalper] Market-closing ${openTrades.length} short(s) — total qty: ${totalQty.toFixed(6)} ${perpSymbol}`,
  );

  const exchange: IExchange = yield useExchange();

  // Place a single market buy to close all shorts
  yield exchange.ccxt
    .createOrder(perpSymbol, "market", "buy", totalQtyNum, undefined, { reduceOnly: true })
    .then((order: any) => {
      logger.info(
        `[PumpRangeScalper] ✅ Market close order placed — Buy ${totalQty.toFixed(6)} @ market | orderId: ${order?.id ?? "unknown"}`,
      );
    })
    .catch((err: Error) => {
      logger.error(`[PumpRangeScalper] ❌ Failed to market-close shorts: ${err.message}`);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Pump range detection
// ════════════════════════════════════════════════════════════════════════════

/**
 * Detect if the last 3 candles form a pump range.
 *
 * @param refCandle  - The candle before the pump (for volume comparison)
 * @param c1        - First pump candle (must be green, must have 4x volume of refCandle)
 * @param c2        - Second pump candle (must be green)
 * @param c3        - Third pump candle (must be green)
 * @param params    - Strategy params
 * @returns true if pump range conditions are met
 */
function detectPumpRange(
  refCandle: ICandlestick,
  c1: ICandlestick,
  c2: ICandlestick,
  c3: ICandlestick,
  params: z.infer<typeof pumpRangeScalper.schema>,
): boolean {
  if (!refCandle || !c1 || !c2 || !c3) return false;

  // All 3 candles must be green (close > open)
  const allGreen = c1.close > c1.open && c2.close > c2.open && c3.close > c3.open;
  if (!allGreen) return false;

  // Total rise from c1 open to c3 close must exceed threshold
  const totalRise = new Big(c3.close).minus(c1.open).div(c1.open);
  if (totalRise.lt(params.minTotalRise)) return false;

  // First pump candle must have volumeMultiplier× the reference candle volume
  if (refCandle.volume <= 0) return false;
  const volRatio = new Big(c1.volume).div(refCandle.volume);
  if (volRatio.lt(params.volumeMultiplier)) return false;

  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// Strategy metadata
// ════════════════════════════════════════════════════════════════════════════

pumpRangeScalper.displayName = "Pump Range Scalper";
pumpRangeScalper.description =
  "Detects pump ranges (3 consecutive green candles with 4%+ rise and volume spike) and " +
  "scalp-shorts within the range. When a candle closes 0.22%+ above its open inside the " +
  "range, enters a market short with a 0.15% take profit. Supports multiple concurrent " +
  "trades. Stops new entries when price exceeds range top. Hard stop-loss when price " +
  "exceeds rangeTop + 30% of range height. On new range detection, market-closes all " +
  "existing shorts before switching.";

pumpRangeScalper.schema = z.object({
  // ── Range Detection ──────────────────────────────────────────────────
  minTotalRise: z
    .number()
    .min(0)
    .max(1)
    .default(0.04)
    .describe("Minimum total rise across the 3 pump candles as fraction (0.04 = 4%)"),
  volumeMultiplier: z
    .number()
    .positive()
    .default(4)
    .describe("Minimum volume ratio: first pump candle volume / previous candle volume"),

  // ── Entry & Exit ─────────────────────────────────────────────────────
  entryRiseThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.0022)
    .describe("Minimum candle close/open rise to trigger a short entry (0.0022 = 0.22%)"),
  tpDropPercent: z
    .number()
    .min(0)
    .max(1)
    .default(0.0015)
    .describe("Take profit: drop from entry price as fraction (0.0015 = 0.15%)"),

  // ── Stop Loss ────────────────────────────────────────────────────────
  stopLossRangeMultiple: z
    .number()
    .min(0)
    .max(5)
    .default(0.30)
    .describe("Hard SL = rangeTop + this × rangeHeight. 0.30 = 30% of range height above top."),

  // ── Concurrency ──────────────────────────────────────────────────────
  maxConcurrentTrades: z
    .number()
    .positive()
    .default(5)
    .describe("Maximum number of simultaneous open short positions. Balance is divided equally across all slots."),

  // ── Position Sizing ──────────────────────────────────────────────────
  leverage: z
    .number()
    .positive()
    .default(20)
    .describe("Fixed leverage to set on the exchange"),
  liquidationTarget: z
    .number()
    .positive()
    .default(3042)
    .describe("Target liquidation price for short positions (cross-margin)"),
  maintenanceMarginRate: z
    .number()
    .min(0)
    .max(1)
    .default(0.005)
    .describe("Maintenance margin rate (e.g., 0.005 = 0.5%)"),
});

pumpRangeScalper.requiredHistory = 5;

pumpRangeScalper.timeframe = ({ timeframe }: IBotConfiguration) => timeframe;

pumpRangeScalper.runPolicy = {
  onCandleClosed: true,
  onOrderFilled: true,
};

pumpRangeScalper.watchers = {
  watchCandles: ({ symbol }: IBotConfiguration) => toPerpSymbol(symbol),
};

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

type TradeRecord = {
  ref: string;
  quantity: number;
  entryPrice: number;
};

type PumpRangeScalperState = {
  phase?: "SCANNING" | "RANGE_ACTIVE";
  rangeTop?: number;
  rangeBottom?: number;
  openTrades?: TradeRecord[];
  tradeCounter?: number;
};

export type PumpRangeScalperConfig = IBotConfiguration<z.infer<typeof pumpRangeScalper.schema>>;
