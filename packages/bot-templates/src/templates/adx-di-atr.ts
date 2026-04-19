import { z } from "zod";
import Big from "big.js";
import { detectHedgeMode } from "@opentrader/exchanges";
import type { IExchange } from "@opentrader/exchanges";
import type { BarSize, ICandlestick } from "@opentrader/types";
import {
  cancelSmartTrade,
  createSmartTrade,
  getSmartTrade,
  IBotConfiguration,
  TBotContext,
  useExchange,
  useSmartTrade,
  type SmartTradeService,
} from "@opentrader/bot-processor";
import { logger } from "@opentrader/logger";
import {
  telegram,
  formatBotStarted,
  formatBotStopped,
  formatStopLoss,
  formatTakeProfit,
  formatTradeEntry,
} from "@opentrader/telegram";
import { getQuoteCurrency, toPerpSymbol } from "./utils.js";

const HISTORY_CANDLES = 100;

function toBig(value: number | string | undefined): Big {
  return new Big(value ?? 0);
}

function bigToNumber(value: Big): number {
  return Number(value.toString());
}

function isBigReady(value: BigValue): value is Big {
  return value !== null;
}

function computeDirectionalIndicators(candles: ICandlestick[], period: number): AdxResult {
  const length = candles.length;
  const atr = Array.from<BigValue>({ length }).fill(null);
  const plusDI = Array.from<BigValue>({ length }).fill(null);
  const minusDI = Array.from<BigValue>({ length }).fill(null);
  const adx = Array.from<BigValue>({ length }).fill(null);

  if (length < period * 2) {
    return { atr, plusDI, minusDI, adx };
  }

  const zero = new Big(0);
  const hundred = new Big(100);
  const periodBig = new Big(period);
  const trueRange = Array.from<Big>({ length }).fill(zero);
  const plusDM = Array.from<Big>({ length }).fill(zero);
  const minusDM = Array.from<Big>({ length }).fill(zero);
  const dx = Array.from<BigValue>({ length }).fill(null);

  for (let i = 1; i < length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const currentHigh = toBig(current.high);
    const currentLow = toBig(current.low);
    const previousHigh = toBig(previous.high);
    const previousLow = toBig(previous.low);
    const previousClose = toBig(previous.close);

    const upMove = currentHigh.minus(previousHigh);
    const downMove = previousLow.minus(currentLow);

    const range1 = currentHigh.minus(currentLow);
    const range2 = currentHigh.minus(previousClose).abs();
    const range3 = currentLow.minus(previousClose).abs();
    const trueRangeBig = [range1, range2, range3].reduce((max, value) => (value.gt(max) ? value : max), range1);
    trueRange[i] = trueRangeBig;
    plusDM[i] = upMove.gt(downMove) && upMove.gt(0) ? upMove : zero;
    minusDM[i] = downMove.gt(upMove) && downMove.gt(0) ? downMove : zero;
  }

  let smoothedTR = new Big(0);
  let smoothedPlusDM = new Big(0);
  let smoothedMinusDM = new Big(0);

  for (let i = 1; i <= period; i++) {
    smoothedTR = smoothedTR.plus(trueRange[i]);
    smoothedPlusDM = smoothedPlusDM.plus(plusDM[i]);
    smoothedMinusDM = smoothedMinusDM.plus(minusDM[i]);
  }

  for (let i = period; i < length; i++) {
    if (i > period) {
      smoothedTR = smoothedTR.minus(smoothedTR.div(periodBig)).plus(trueRange[i]);
      smoothedPlusDM = smoothedPlusDM.minus(smoothedPlusDM.div(periodBig)).plus(plusDM[i]);
      smoothedMinusDM = smoothedMinusDM.minus(smoothedMinusDM.div(periodBig)).plus(minusDM[i]);
    }

    const currentAtr = smoothedTR.div(periodBig);
    const currentPlusDI = smoothedTR.eq(0) ? zero : hundred.times(smoothedPlusDM).div(smoothedTR);
    const currentMinusDI = smoothedTR.eq(0) ? zero : hundred.times(smoothedMinusDM).div(smoothedTR);

    atr[i] = currentAtr;
    plusDI[i] = currentPlusDI;
    minusDI[i] = currentMinusDI;

    const diTotal = currentPlusDI.plus(currentMinusDI);
    dx[i] = diTotal.eq(0) ? zero : hundred.times(currentPlusDI.minus(currentMinusDI).abs()).div(diTotal);
  }

  const firstAdxIndex = period * 2 - 1;
  let dxSum = new Big(0);
  for (let i = period; i <= firstAdxIndex; i++) {
    const currentDx = dx[i];
    if (isBigReady(currentDx)) {
      dxSum = dxSum.plus(currentDx);
    }
  }

  adx[firstAdxIndex] = dxSum.div(periodBig);
  for (let i = firstAdxIndex + 1; i < length; i++) {
    const previousAdx = adx[i - 1];
    const currentDx = dx[i];
    if (isBigReady(previousAdx) && isBigReady(currentDx)) {
      adx[i] = previousAdx
        .times(period - 1)
        .plus(currentDx)
        .div(periodBig);
    }
  }

  return { atr, plusDI, minusDI, adx };
}

function lastIndicatorValues(result: AdxResult, slopeLookback: number): IndicatorSnapshot | null {
  const lastIndex = result.adx.length - 1;
  const slopeIndex = lastIndex - slopeLookback;

  if (slopeIndex < 0) return null;

  const currentAdx = result.adx[lastIndex];
  const previousAdx = result.adx[slopeIndex];
  const currentAtr = result.atr[lastIndex];
  const currentPlusDI = result.plusDI[lastIndex];
  const currentMinusDI = result.minusDI[lastIndex];

  if (
    !isBigReady(currentAdx) ||
    !isBigReady(previousAdx) ||
    !isBigReady(currentAtr) ||
    !isBigReady(currentPlusDI) ||
    !isBigReady(currentMinusDI)
  ) {
    return null;
  }

  return {
    adx: currentAdx,
    adxSlope: currentAdx.minus(previousAdx),
    atr: currentAtr,
    plusDI: currentPlusDI,
    minusDI: currentMinusDI,
  };
}

function* marketClosePosition(
  perpSymbol: string,
  direction: TradeDirection,
  quantity: number,
  isHedgeMode?: boolean,
): Generator<any, void, any> {
  if (quantity <= 0) {
    logger.info("[AdxDiAtr] No quantity to close");
    return;
  }

  const exchange: IExchange = yield useExchange();
  const side = direction === "long" ? "sell" : "buy";

  yield exchange.ccxt
    .createOrder(
      perpSymbol,
      "market",
      side,
      quantity,
      undefined,
      isHedgeMode ? { hedged: true, reduceOnly: true } : { reduceOnly: true },
    )
    .then((order: any) => {
      logger.info(
        `[AdxDiAtr] Market close placed | ${side.toUpperCase()} ${quantity} ${perpSymbol} | orderId: ${order?.id ?? "unknown"}`,
      );
    })
    .catch((err: Error) => {
      logger.error(`[AdxDiAtr] Failed to market-close ${direction}: ${err.message}`);
    });
}

function shouldExit(direction: TradeDirection, indicators: IndicatorSnapshot, params: AdxDiAtrSettings): string | null {
  if (indicators.adx.gt(params.exitAdxThreshold) && indicators.adxSlope.lt(0)) {
    return `ADX exhaustion (${indicators.adx.toFixed(2)} > ${params.exitAdxThreshold}, slope ${indicators.adxSlope.toFixed(2)})`;
  }

  if (direction === "long" && indicators.minusDI.gt(indicators.plusDI)) {
    return `DI reversal (-DI ${indicators.minusDI.toFixed(2)} > +DI ${indicators.plusDI.toFixed(2)})`;
  }

  if (direction === "short" && indicators.plusDI.gt(indicators.minusDI)) {
    return `DI reversal (+DI ${indicators.plusDI.toFixed(2)} > -DI ${indicators.minusDI.toFixed(2)})`;
  }

  return null;
}

function getEntryRejectionReasons(indicators: IndicatorSnapshot, params: AdxDiAtrSettings): string[] {
  const reasons: string[] = [];

  if (!indicators.adx.gt(params.entryAdxThreshold)) {
    reasons.push(`ADX ${indicators.adx.toFixed(2)} <= threshold ${params.entryAdxThreshold}`);
  }

  if (!indicators.adxSlope.gt(params.minAdxSlope)) {
    reasons.push(`ADX slope ${indicators.adxSlope.toFixed(2)} <= min ${params.minAdxSlope}`);
  }

  if (!indicators.plusDI.gt(indicators.minusDI) && !indicators.minusDI.gt(indicators.plusDI)) {
    reasons.push(`DI not aligned (+DI ${indicators.plusDI.toFixed(2)} = -DI ${indicators.minusDI.toFixed(2)})`);
  }

  return reasons;
}

function formatAdxStatusUpdate({
  symbol,
  timeframe,
  price,
  indicators,
  params,
  direction,
  entryRejectionReasons,
}: {
  symbol: string;
  timeframe: BarSize;
  price: Big;
  indicators: IndicatorSnapshot;
  params: AdxDiAtrSettings;
  direction?: TradeDirection;
  entryRejectionReasons?: string[];
}): string {
  const diBias = indicators.plusDI.gt(indicators.minusDI)
    ? "long"
    : indicators.minusDI.gt(indicators.plusDI)
      ? "short"
      : "flat";
  const trendReady = indicators.adx.gt(params.entryAdxThreshold) && indicators.adxSlope.gt(params.minAdxSlope);
  const position = direction
    ? `Position ${direction.toUpperCase()}`
    : `Bias ${diBias}${trendReady ? " ready" : " wait"}`;
  const slopePrefix = indicators.adxSlope.gte(0) ? "+" : "";

  return [
    "ADX DI ATR status",
    `${symbol} ${timeframe} @ ${price.toFixed(4)}`,
    `ADX ${indicators.adx.toFixed(2)} (${slopePrefix}${indicators.adxSlope.toFixed(2)}) | +DI ${indicators.plusDI.toFixed(2)} / -DI ${indicators.minusDI.toFixed(2)}`,
    `ATR ${indicators.atr.toFixed(4)} | ${position}`,
    ...(entryRejectionReasons?.length ? [`No entry: ${entryRejectionReasons.join("; ")}`] : []),
  ].join("\n");
}

function isSmartTradeClosed(trade: SmartTradeService): boolean {
  return (
    trade.isCompleted() ||
    trade.smartTrade.orders.some(
      (order: any) =>
        (order.entityType === "TakeProfitOrder" || order.entityType === "StopLossOrder") && order.status === "Filled",
    )
  );
}

/**
 * ADX/DI/ATR trend-following strategy.
 *
 * Entries require strong and rising ADX plus DI alignment on the bot's configured timeframe. Risk uses ATR-based
 * stop-loss and take-profit orders. Optional breakeven moves recreate the
 * SmartTrade after cancelling the existing TP/SL legs.
 */
export function* adxDiAtr(ctx: TBotContext<AdxDiAtrConfig, AdxDiAtrState>): Generator<any, void, any> {
  const {
    config: { settings: params },
    state,
    onStart,
    onStop,
  } = ctx;

  const spotSymbol = ctx.config.symbol;
  const perpSymbol = toPerpSymbol(spotSymbol);
  const quoteCurrency = getQuoteCurrency(spotSymbol);

  if (onStart) {
    logger.info(`[AdxDiAtr] Bot started on ${spotSymbol} (perp: ${perpSymbol}, timeframe: ${ctx.config.timeframe})`);
    state.inPosition = state.inPosition ?? false;
    state.stopMovedToBreakeven = state.stopMovedToBreakeven ?? false;

    const startExchange: IExchange = yield useExchange();
    yield startExchange.ccxt
      .setLeverage(params.leverage, perpSymbol)
      .then(() => logger.info(`[AdxDiAtr] Leverage set to ${params.leverage}x for ${perpSymbol}`))
      .catch((err: Error) => logger.warn(`[AdxDiAtr] setLeverage: ${err.message}`));

    state.isHedgeMode = yield detectHedgeMode(startExchange.ccxt, perpSymbol);
    logger.info(`[AdxDiAtr] Position mode: ${state.isHedgeMode ? "hedge" : "one-way"}`);
    yield telegram.notify(
      formatBotStarted({
        botName: "ADX DI ATR Trend",
        symbol: perpSymbol,
        extraInfo: `Timeframe: ${ctx.config.timeframe} | Leverage: ${params.leverage}x`,
      }),
    );
    return;
  }

  if (onStop) {
    logger.info("[AdxDiAtr] Bot stopped; cancelling open SmartTrade");
    yield cancelSmartTrade();
    if (state.inPosition && state.direction && (state.quantity ?? 0) > 0) {
      yield* marketClosePosition(perpSymbol, state.direction, state.quantity!, state.isHedgeMode);
    }
    yield telegram.notify(formatBotStopped({ botName: "ADX DI ATR Trend", symbol: perpSymbol }));
    state.inPosition = false;
    state.stopMovedToBreakeven = false;
    return;
  }

  const existingTrade: SmartTradeService | null = yield getSmartTrade();
  if (existingTrade && isSmartTradeClosed(existingTrade)) {
    logger.info("[AdxDiAtr] SmartTrade completed; returning to scanning");
    const exitOrder = existingTrade.smartTrade.orders.find(
      (order: any) =>
        (order.entityType === "TakeProfitOrder" || order.entityType === "StopLossOrder") && order.status === "Filled",
    );
    if (state.direction && state.entryPrice != null && state.quantity != null) {
      const direction = state.direction === "long" ? "LONG" : "SHORT";
      if (exitOrder?.entityType === "TakeProfitOrder" && state.takeProfitPrice != null) {
        yield telegram.notify(
          formatTakeProfit({
            botName: "ADX DI ATR Trend",
            symbol: perpSymbol,
            direction,
            entryPrice: state.entryPrice,
            exitPrice: state.takeProfitPrice,
            quantity: state.quantity,
          }),
        );
      } else if (exitOrder?.entityType === "StopLossOrder" && state.stopLossPrice != null) {
        yield telegram.notify(
          formatStopLoss({
            botName: "ADX DI ATR Trend",
            symbol: perpSymbol,
            direction,
            entryPrice: state.entryPrice,
            exitPrice: state.stopLossPrice,
            quantity: state.quantity,
          }),
        );
      }
    }
    state.inPosition = false;
    state.direction = undefined;
    state.stopMovedToBreakeven = false;
    return;
  }

  if (ctx.event === "onOrderFilled" && existingTrade && !isSmartTradeClosed(existingTrade)) {
    logger.info("[AdxDiAtr] Order fill event received, managed trade remains active");
    return;
  }

  if (state.inPosition && !existingTrade) {
    logger.warn("[AdxDiAtr] State indicated an open position but no SmartTrade was found; resetting state");
    state.inPosition = false;
    state.direction = undefined;
    state.stopMovedToBreakeven = false;
  }

  const exchange: IExchange = yield useExchange();
  const timeframe = ctx.config.timeframe as BarSize;
  const candles: ICandlestick[] = yield exchange
    .getCandlesticks({
      symbol: perpSymbol,
      bar: timeframe,
      limit: HISTORY_CANDLES,
    })
    .catch((err: Error) => {
      logger.error(`[AdxDiAtr] Failed to fetch ${timeframe} candles: ${err.message}`);
      return [];
    });

  if (candles.length < HISTORY_CANDLES) {
    logger.warn(`[AdxDiAtr] Not enough ${timeframe} candle history (got ${candles.length}, need ${HISTORY_CANDLES})`);
    return;
  }

  const indicators = lastIndicatorValues(computeDirectionalIndicators(candles, params.adxPeriod), params.slopeLookback);

  if (!indicators) {
    logger.warn("[AdxDiAtr] Indicator values are not ready");
    return;
  }

  const currentPrice = toBig(candles[candles.length - 1].close);
  logger.info(
    `[AdxDiAtr] ADX ${indicators.adx.toFixed(2)} | slope ${indicators.adxSlope.toFixed(2)} | ` +
      `+DI ${indicators.plusDI.toFixed(2)} | -DI ${indicators.minusDI.toFixed(2)} | ATR ${indicators.atr.toFixed(4)}`,
  );

  const hasTrendStrength = indicators.adx.gt(params.entryAdxThreshold) && indicators.adxSlope.gt(params.minAdxSlope);
  const direction: TradeDirection | null =
    hasTrendStrength && indicators.plusDI.gt(indicators.minusDI)
      ? "long"
      : hasTrendStrength && indicators.minusDI.gt(indicators.plusDI)
        ? "short"
        : null;
  const entryRejectionReasons = direction ? [] : getEntryRejectionReasons(indicators, params);

  if (params.telegramAdxUpdates && ctx.event === "onCandleClosed") {
    yield telegram.notifyPlain(
      formatAdxStatusUpdate({
        symbol: perpSymbol,
        timeframe,
        price: currentPrice,
        indicators,
        params,
        direction: state.inPosition ? state.direction : undefined,
        entryRejectionReasons: state.inPosition ? [] : entryRejectionReasons,
      }),
    );
  }

  if (state.inPosition && state.direction) {
    const exitReason = shouldExit(state.direction, indicators, params);

    if (exitReason) {
      logger.info(`[AdxDiAtr] Closing ${state.direction.toUpperCase()} early: ${exitReason}`);
      yield cancelSmartTrade();
      yield* marketClosePosition(perpSymbol, state.direction, state.quantity ?? 0, state.isHedgeMode);
      yield telegram.notifyPlain(
        [
          "ADX DI ATR Trend early close",
          `Symbol: ${perpSymbol}`,
          `Direction: ${state.direction.toUpperCase()}`,
          `Reason: ${exitReason}`,
          `Quantity: ${state.quantity ?? 0}`,
        ].join("\n"),
      );
      state.inPosition = false;
      state.direction = undefined;
      state.stopMovedToBreakeven = false;
      return;
    }

    const entryPrice = new Big(state.entryPrice ?? 0);
    const unrealizedProfit =
      state.direction === "long" ? currentPrice.minus(entryPrice) : entryPrice.minus(currentPrice);

    if (
      params.moveStopToBreakeven &&
      !state.stopMovedToBreakeven &&
      entryPrice.gt(0) &&
      unrealizedProfit.gt(indicators.atr.times(params.breakevenAtrMultiplier))
    ) {
      const entrySide = state.direction === "long" ? "Buy" : "Sell";
      const exitSide = state.direction === "long" ? "Sell" : "Buy";
      const breakevenStop = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, bigToNumber(entryPrice)));

      logger.info(`[AdxDiAtr] Moving stop to breakeven at ${breakevenStop}`);
      yield cancelSmartTrade();
      yield createSmartTrade({
        entry: {
          type: "Market",
          side: entrySide,
          symbol: perpSymbol,
          price: breakevenStop,
          status: "Filled",
        },
        tp: {
          type: "Limit",
          side: exitSide,
          symbol: perpSymbol,
          price: state.takeProfitPrice,
        },
        sl: {
          type: "Market",
          side: exitSide,
          symbol: perpSymbol,
          stopPrice: breakevenStop,
        },
        quantity: state.quantity ?? 0,
      });
      state.stopMovedToBreakeven = true;
      state.stopLossPrice = breakevenStop;
      yield telegram.notifyPlain(
        [
          "ADX DI ATR Trend stop moved to breakeven",
          `Symbol: ${perpSymbol}`,
          `Direction: ${state.direction.toUpperCase()}`,
          `Stop: ${breakevenStop}`,
          `Quantity: ${state.quantity ?? 0}`,
        ].join("\n"),
      );
    }

    return;
  }

  if (!direction) {
    logger.info(`[AdxDiAtr] No entry signal | ${entryRejectionReasons.join("; ")}`);
    return;
  }

  const atr = indicators.atr;
  const stopLoss =
    direction === "long"
      ? currentPrice.minus(atr.times(params.stopLossAtrMultiplier))
      : currentPrice.plus(atr.times(params.stopLossAtrMultiplier));
  const takeProfit =
    direction === "long"
      ? currentPrice.plus(atr.times(params.takeProfitAtrMultiplier))
      : currentPrice.minus(atr.times(params.takeProfitAtrMultiplier));

  if (stopLoss.lte(0) || takeProfit.lte(0)) {
    logger.warn(`[AdxDiAtr] Invalid risk prices | SL ${stopLoss.toFixed(4)} | TP ${takeProfit.toFixed(4)}`);
    return;
  }

  const rawBalance: Record<string, any> | null = yield exchange.ccxt
    .fetchBalance({ type: "swap" })
    .catch((err: Error) => {
      logger.error(`[AdxDiAtr] Failed to fetch balance: ${err.message}`);
      return null;
    });

  const walletBalance = new Big(rawBalance ? (rawBalance[quoteCurrency]?.free ?? 0) : 0);

  if (walletBalance.lte(0)) {
    logger.warn(`[AdxDiAtr] Skip | No ${quoteCurrency} balance (${walletBalance.toFixed(2)})`);
    return;
  }

  const quantityBig = walletBalance.times(params.leverage).div(currentPrice);
  if (quantityBig.lte(0)) {
    logger.warn(`[AdxDiAtr] Skip | Calculated quantity is ${quantityBig.toFixed(6)}`);
    return;
  }

  const quantity = parseFloat(exchange.ccxt.amountToPrecision(perpSymbol, bigToNumber(quantityBig)));
  const stopLossPrice = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, bigToNumber(stopLoss)));
  const takeProfitPrice = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, bigToNumber(takeProfit)));

  if (quantity <= 0) {
    logger.warn("[AdxDiAtr] Quantity rounds to 0 after precision adjustment");
    return;
  }

  const entrySide = direction === "long" ? "Buy" : "Sell";
  const exitSide = direction === "long" ? "Sell" : "Buy";

  logger.info(
    `[AdxDiAtr] Entering ${direction.toUpperCase()} | Entry ${currentPrice.toFixed(4)} | ` +
      `SL ${stopLossPrice} (${params.stopLossAtrMultiplier} ATR) | TP ${takeProfitPrice} (${params.takeProfitAtrMultiplier} ATR) | ` +
      `Qty ${quantity} | Bal ${walletBalance.toFixed(2)} ${quoteCurrency} | Lev ${params.leverage}x`,
  );

  yield useSmartTrade({
    entry: {
      type: "Market",
      side: entrySide,
      symbol: perpSymbol,
    },
    tp: {
      type: "Limit",
      side: exitSide,
      symbol: perpSymbol,
      price: takeProfitPrice,
    },
    sl: {
      type: "Market",
      side: exitSide,
      symbol: perpSymbol,
      stopPrice: stopLossPrice,
    },
    quantity,
  });

  state.inPosition = true;
  state.direction = direction;
  state.entryPrice = bigToNumber(currentPrice);
  state.stopLossPrice = stopLossPrice;
  state.takeProfitPrice = takeProfitPrice;
  state.quantity = quantity;
  state.stopMovedToBreakeven = false;

  yield telegram.notify(
    formatTradeEntry({
      botName: "ADX DI ATR Trend",
      symbol: perpSymbol,
      direction: direction === "long" ? "LONG" : "SHORT",
      entryPrice: bigToNumber(currentPrice),
      tpPrice: takeProfitPrice,
      slPrice: stopLossPrice,
      quantity,
      extraInfo:
        `ADX: ${indicators.adx.toFixed(2)} | +DI: ${indicators.plusDI.toFixed(2)} | ` +
        `-DI: ${indicators.minusDI.toFixed(2)} | ATR: ${indicators.atr.toFixed(4)} | ` +
        `Bal: ${walletBalance.toFixed(2)} ${quoteCurrency} | Lev: ${params.leverage}x`,
    }),
  );
}

adxDiAtr.displayName = "ADX DI ATR Trend";
adxDiAtr.description =
  "Trend-following strategy using ADX strength, ADX slope, DI direction, and ATR-based stop-loss/take-profit levels on the selected bot timeframe.";

adxDiAtr.schema = z.object({
  adxPeriod: z.number().positive().default(14).describe("Wilder period used for ADX, DI, and ATR calculations."),
  entryAdxThreshold: z
    .number()
    .positive()
    .default(25)
    .describe("Enter only when ADX is above this trend-strength threshold."),
  exitAdxThreshold: z
    .number()
    .positive()
    .default(50)
    .describe("Close an open position when ADX is above this value and its slope turns negative."),
  slopeLookback: z
    .number()
    .positive()
    .default(1)
    .describe("Number of closed candles used to measure ADX slope on the selected timeframe."),
  minAdxSlope: z.number().min(0).default(0).describe("Minimum positive ADX slope required for entry."),
  stopLossAtrMultiplier: z.number().positive().default(1.5).describe("Stop-loss distance from entry in ATR multiples."),
  takeProfitAtrMultiplier: z
    .number()
    .positive()
    .default(4)
    .describe("Take-profit distance from entry in ATR multiples."),
  moveStopToBreakeven: z
    .boolean()
    .default(false)
    .describe(
      "When enabled, once unrealized profit exceeds breakevenAtrMultiplier ATR, the stop loss is moved to the entry price so the trade can no longer lose if price reverses sharply.",
    ),
  breakevenAtrMultiplier: z
    .number()
    .positive()
    .default(1)
    .describe("Unrealized profit in ATR multiples required before moving SL to breakeven."),
  leverage: z
    .number()
    .positive()
    .default(100)
    .describe(
      "Leverage to set on the perpetual market at bot start. 1 means no effective leverage amplification, 100 means 100x.",
    ),
  telegramAdxUpdates: z
    .boolean()
    .default(false)
    .describe("When enabled, send a concise Telegram ADX/DI/ATR status update on each candle close."),
});

adxDiAtr.requiredHistory = HISTORY_CANDLES;
adxDiAtr.timeframe = ({ timeframe }: IBotConfiguration) => timeframe;
adxDiAtr.runPolicy = {
  onCandleClosed: true,
  onOrderFilled: true,
};
adxDiAtr.watchers = {
  watchCandles: ({ symbol }: IBotConfiguration) => toPerpSymbol(symbol),
};

type TradeDirection = "long" | "short";

type AdxResult = {
  atr: BigValue[];
  plusDI: BigValue[];
  minusDI: BigValue[];
  adx: BigValue[];
};

type IndicatorSnapshot = {
  adx: Big;
  adxSlope: Big;
  atr: Big;
  plusDI: Big;
  minusDI: Big;
};

type BigValue = Big | null;

type AdxDiAtrState = {
  inPosition?: boolean;
  direction?: TradeDirection;
  entryPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  quantity?: number;
  stopMovedToBreakeven?: boolean;
  isHedgeMode?: boolean;
};

type AdxDiAtrSettings = z.infer<typeof adxDiAtr.schema>;

export type AdxDiAtrConfig = IBotConfiguration<AdxDiAtrSettings>;
