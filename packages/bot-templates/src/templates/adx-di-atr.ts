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
import { telegram, formatBotStarted, formatBotStopped, formatTradeEntry } from "@opentrader/telegram";
import { getQuoteCurrency, toPerpSymbol } from "./utils.js";

const HISTORY_CANDLES = 100;
const LONG_TRADE_REF = "long";
const SHORT_TRADE_REF = "short";
const LEGACY_TRADE_REF = "0";
const TRADE_REFS: Record<TradeDirection, string> = {
  long: LONG_TRADE_REF,
  short: SHORT_TRADE_REF,
};

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

function formatTradePlanDetails({
  direction,
  entryPrice,
  stopLossPrice,
  takeProfitPrice,
  quantity,
  ref,
}: {
  direction: TradeDirection;
  entryPrice: number | string;
  stopLossPrice: number | string;
  takeProfitPrice: number | string;
  quantity: number | string;
  ref?: string;
}): string[] {
  return [
    `Direction: ${direction.toUpperCase()}`,
    `Entry price: ${entryPrice}`,
    `Quantity: ${quantity}`,
    `Stop loss: ${stopLossPrice}`,
    `Take profit: ${takeProfitPrice}`,
    ...(ref ? [`Ref: ${ref}`] : []),
  ];
}

function formatSignalDetected({
  symbol,
  timeframe,
  direction,
  price,
  indicators,
}: {
  symbol: string;
  timeframe: BarSize;
  direction: TradeDirection;
  price: Big;
  indicators: IndicatorSnapshot;
}): string {
  return [
    "ADX DI ATR Trend signal detected",
    `Symbol: ${symbol}`,
    `Timeframe: ${timeframe}`,
    `Direction: ${direction.toUpperCase()}`,
    `Signal price: ${price.toFixed(4)}`,
    `ADX: ${indicators.adx.toFixed(2)} | slope: ${indicators.adxSlope.toFixed(2)}`,
    `+DI: ${indicators.plusDI.toFixed(2)} | -DI: ${indicators.minusDI.toFixed(2)} | ATR: ${indicators.atr.toFixed(4)}`,
  ].join("\n");
}

function formatMissedEntrySignal({
  symbol,
  timeframe,
  direction,
  reason,
  price,
  stopLossPrice,
  takeProfitPrice,
  quantity,
  indicators,
  details,
}: {
  symbol: string;
  timeframe: BarSize;
  direction: TradeDirection;
  reason: string;
  price: number | string;
  stopLossPrice: number | string;
  takeProfitPrice: number | string;
  quantity: number | string;
  indicators: IndicatorSnapshot;
  details?: string[];
}): string {
  return [
    "ADX DI ATR Trend missed entry signal",
    `Symbol: ${symbol}`,
    `Timeframe: ${timeframe}`,
    `Reason: ${reason}`,
    ...formatTradePlanDetails({
      direction,
      entryPrice: price,
      stopLossPrice,
      takeProfitPrice,
      quantity,
    }),
    `ADX: ${indicators.adx.toFixed(2)} | slope: ${indicators.adxSlope.toFixed(2)}`,
    `+DI: ${indicators.plusDI.toFixed(2)} | -DI: ${indicators.minusDI.toFixed(2)} | ATR: ${indicators.atr.toFixed(4)}`,
    ...(details?.length ? details : []),
  ].join("\n");
}

function formatSmartTradeLegsPlaced({
  symbol,
  plan,
  quoteCurrency,
  ref,
}: {
  symbol: string;
  plan: TradePlan;
  quoteCurrency: string;
  ref: string;
}): string {
  return [
    "ADX DI ATR Trend SmartTrade opened; TP/SL planned via SmartTrade",
    `Symbol: ${symbol}`,
    ...formatTradePlanDetails({
      direction: plan.direction,
      entryPrice: plan.entryPrice,
      stopLossPrice: plan.stopLossPrice,
      takeProfitPrice: plan.takeProfitPrice,
      quantity: plan.quantity,
      ref,
    }),
    `Stop loss order: Market ${plan.direction === "long" ? "SELL" : "BUY"} stop @ ${plan.stopLossPrice}`,
    `Take profit order: Limit ${plan.direction === "long" ? "SELL" : "BUY"} @ ${plan.takeProfitPrice}`,
    `Wallet: ${plan.walletBalance.toFixed(2)} ${quoteCurrency} | Risk budget: ${plan.riskBudget.toFixed(2)} ${quoteCurrency}`,
    `Effective leverage: ${plan.effectiveLeverage.toFixed(2)}x | Leverage capped: ${plan.leverageCapped ? "yes" : "no"}`,
  ].join("\n");
}

function formatStopLossUpdated({
  symbol,
  slot,
  previousStop,
  newStop,
  ref,
  reason,
}: {
  symbol: string;
  slot: AdxDiAtrTradeSlot;
  previousStop?: number;
  newStop: number;
  ref: string;
  reason: string;
}): string {
  return [
    "ADX DI ATR Trend stop loss updated via SmartTrade",
    `Symbol: ${symbol}`,
    `Direction: ${slot.direction.toUpperCase()}`,
    `Reason: ${reason}`,
    `Previous stop: ${previousStop ?? "unknown"}`,
    `New stop: ${newStop}`,
    `Take profit remains: ${slot.takeProfitPrice ?? "unknown"}`,
    `Quantity: ${slot.quantity ?? 0}`,
    `Ref: ${ref}`,
  ].join("\n");
}

function formatTakeProfitUpdated({
  symbol,
  slot,
  ref,
  reason,
}: {
  symbol: string;
  slot: AdxDiAtrTradeSlot;
  ref: string;
  reason: string;
}): string {
  return [
    "ADX DI ATR Trend take profit order refreshed via SmartTrade",
    `Symbol: ${symbol}`,
    `Direction: ${slot.direction.toUpperCase()}`,
    `Reason: ${reason}`,
    `Take profit: ${slot.takeProfitPrice ?? "unknown"}`,
    `Stop loss: ${slot.stopLossPrice ?? "unknown"}`,
    `Quantity: ${slot.quantity ?? 0}`,
    `Ref: ${ref}`,
  ].join("\n");
}

// ── Signal Detection Helpers ─────────────────────────────────────────────

/**
 * Builds the entry signal from indicator state only.
 *
 * This keeps signal generation isolated from execution. The logic intentionally
 * matches the original strategy: ADX must be above the entry threshold, ADX
 * slope must be above the configured minimum, and DI direction chooses long or
 * short.
 */
function detectEntrySignal(
  indicators: IndicatorSnapshot,
  params: AdxDiAtrSettings,
): { direction: TradeDirection | null; rejectionReasons: string[] } {
  const hasTrendStrength = indicators.adx.gt(params.entryAdxThreshold) && indicators.adxSlope.gt(params.minAdxSlope);
  const direction: TradeDirection | null =
    hasTrendStrength && indicators.plusDI.gt(indicators.minusDI)
      ? "long"
      : hasTrendStrength && indicators.minusDI.gt(indicators.plusDI)
        ? "short"
        : null;

  return {
    direction,
    rejectionReasons: direction ? [] : getEntryRejectionReasons(indicators, params),
  };
}

// ── Execution / Trade Management Helpers ─────────────────────────────────

function getTradeRef(direction: TradeDirection): string {
  return TRADE_REFS[direction];
}

function getTradeSlot(state: AdxDiAtrState, direction: TradeDirection): AdxDiAtrTradeSlot | undefined {
  return direction === "long" ? state.long : state.short;
}

function setTradeSlot(state: AdxDiAtrState, direction: TradeDirection, slot?: AdxDiAtrTradeSlot): void {
  if (direction === "long") {
    state.long = slot;
  } else {
    state.short = slot;
  }
}

function getActiveTradeSlots(state: AdxDiAtrState): AdxDiAtrTradeSlot[] {
  return ([state.long, state.short].filter(Boolean) as AdxDiAtrTradeSlot[]).filter((slot) => slot.inPosition);
}

function syncLegacyStateFromSlots(state: AdxDiAtrState): void {
  const activeSlots = getActiveTradeSlots(state);
  const primarySlot = activeSlots[0];

  state.inPosition = activeSlots.length > 0;
  state.direction = primarySlot?.direction;
  state.entryPrice = primarySlot?.entryPrice;
  state.stopLossPrice = primarySlot?.stopLossPrice;
  state.takeProfitPrice = primarySlot?.takeProfitPrice;
  state.quantity = primarySlot?.quantity;
  state.stopMovedToBreakeven = primarySlot?.stopMovedToBreakeven ?? false;
}

/**
 * Migrates the previous single-position state shape into the matching long or
 * short slot. This preserves running bots that persisted `inPosition`,
 * `direction`, and price/quantity fields before the strategy gained separate
 * SmartTrade refs.
 */
function bridgeLegacySingleSlotState(state: AdxDiAtrState): void {
  if (!state.inPosition || !state.direction || getTradeSlot(state, state.direction)) return;

  setTradeSlot(state, state.direction, {
    inPosition: true,
    direction: state.direction,
    ref: getTradeRef(state.direction),
    entryPrice: state.entryPrice,
    stopLossPrice: state.stopLossPrice,
    takeProfitPrice: state.takeProfitPrice,
    quantity: state.quantity,
    stopMovedToBreakeven: state.stopMovedToBreakeven ?? false,
  });
}

/**
 * Removes a completed SmartTrade from its directional slot and emits the same
 * TP/SL notifications the original single-slot strategy sent.
 */
function* settleClosedTrade(
  state: AdxDiAtrState,
  perpSymbol: string,
  slot: AdxDiAtrTradeSlot,
  existingTrade: SmartTradeService,
): Generator<any, void, any> {
  logger.info(`[AdxDiAtr] ${slot.direction.toUpperCase()} SmartTrade completed; returning slot to scanning`);
  const exitOrder = existingTrade.smartTrade.orders.find(
    (order: any) =>
      (order.entityType === "TakeProfitOrder" || order.entityType === "StopLossOrder") && order.status === "Filled",
  );
  const direction = slot.direction === "long" ? "LONG" : "SHORT";

  if (slot.entryPrice != null && slot.quantity != null) {
    if (exitOrder?.entityType === "TakeProfitOrder" && slot.takeProfitPrice != null) {
      yield telegram.notifyPlain(
        [
          "ADX DI ATR Trend take profit filled",
          `Symbol: ${perpSymbol}`,
          `Direction: ${direction}`,
          `Entry price: ${slot.entryPrice}`,
          `Take profit fill price: ${slot.takeProfitPrice}`,
          `Quantity: ${slot.quantity}`,
          `Ref: ${slot.ref}`,
        ].join("\n"),
      );
    } else if (exitOrder?.entityType === "StopLossOrder" && slot.stopLossPrice != null) {
      yield telegram.notifyPlain(
        [
          "ADX DI ATR Trend stop loss filled",
          `Symbol: ${perpSymbol}`,
          `Direction: ${direction}`,
          `Entry price: ${slot.entryPrice}`,
          `Stop loss fill price: ${slot.stopLossPrice}`,
          `Quantity: ${slot.quantity}`,
          `Ref: ${slot.ref}`,
        ].join("\n"),
      );
    }
  }

  setTradeSlot(state, slot.direction, undefined);
  syncLegacyStateFromSlots(state);
}

/**
 * Reconciles stored directional slots with SmartTrade refs. It cleans up
 * completed trades, drops stale slot state when a ref is missing, and returns
 * whether any managed trade remains active.
 */
function* reconcileTradeSlots(
  state: AdxDiAtrState,
  perpSymbol: string,
): Generator<any, { hasActiveTrade: boolean; settledTrade: boolean }, any> {
  let hasActiveTrade = false;
  let settledTrade = false;

  for (const direction of ["long", "short"] as TradeDirection[]) {
    const slot = getTradeSlot(state, direction);
    const ref = getTradeRef(direction);
    const existingTrade: SmartTradeService | null = yield getSmartTrade(ref);

    if (existingTrade && isSmartTradeClosed(existingTrade)) {
      yield* settleClosedTrade(state, perpSymbol, slot ?? { inPosition: true, direction, ref }, existingTrade);
      settledTrade = true;
      continue;
    }

    if (existingTrade) {
      hasActiveTrade = true;
      if (!slot) {
        setTradeSlot(state, direction, {
          inPosition: true,
          direction,
          ref,
          stopMovedToBreakeven: false,
        });
      }
      continue;
    }

    if (slot?.inPosition) {
      const legacyTrade: SmartTradeService | null = yield getSmartTrade(LEGACY_TRADE_REF);
      if (legacyTrade && isSmartTradeClosed(legacyTrade)) {
        yield* settleClosedTrade(state, perpSymbol, { ...slot, ref: LEGACY_TRADE_REF }, legacyTrade);
        settledTrade = true;
        continue;
      }
      if (legacyTrade) {
        slot.ref = LEGACY_TRADE_REF;
        setTradeSlot(state, direction, slot);
        hasActiveTrade = true;
        continue;
      }

      logger.warn(
        `[AdxDiAtr] ${direction.toUpperCase()} state indicated an open position but no SmartTrade was found; resetting slot`,
      );
      setTradeSlot(state, direction, undefined);
    }
  }

  syncLegacyStateFromSlots(state);
  return { hasActiveTrade, settledTrade };
}

/**
 * Calculates ATR stop/target prices and quantity using the existing risk model:
 * riskFractionOfBalance, leverage cap, and exchange price/amount precision.
 */
function* buildTradePlan({
  exchange,
  perpSymbol,
  quoteCurrency,
  direction,
  currentPrice,
  indicators,
  params,
}: {
  exchange: IExchange;
  perpSymbol: string;
  quoteCurrency: string;
  direction: TradeDirection;
  currentPrice: Big;
  indicators: IndicatorSnapshot;
  params: AdxDiAtrSettings;
}): Generator<any, TradePlanBuildResult, any> {
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
    const reason = `invalid risk prices (SL ${stopLoss.toFixed(4)}, TP ${takeProfit.toFixed(4)})`;
    logger.warn(`[AdxDiAtr] Skip | ${reason}`);
    return {
      missed: {
        reason,
        direction,
        entryPrice: bigToNumber(currentPrice),
        stopLossPrice: stopLoss.toFixed(4),
        takeProfitPrice: takeProfit.toFixed(4),
        quantity: 0,
      },
    };
  }

  const stopLossPrice = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, bigToNumber(stopLoss)));
  const takeProfitPrice = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, bigToNumber(takeProfit)));
  const preciseTakeProfit = new Big(takeProfitPrice);
  const takeProfitPercent = preciseTakeProfit.minus(currentPrice).abs().div(currentPrice).times(100);

  if (takeProfitPercent.lt(params.minTakeProfitPercent)) {
    const reason = `take-profit distance too small (${takeProfitPercent.toFixed(4)}% < ${params.minTakeProfitPercent}%)`;
    logger.warn(`[AdxDiAtr] Skip | ${reason}`);
    return {
      missed: {
        reason,
        direction,
        entryPrice: bigToNumber(currentPrice),
        stopLossPrice,
        takeProfitPrice,
        quantity: 0,
        takeProfitPercent,
      },
    };
  }

  const rawBalance: Record<string, any> | null = yield exchange.ccxt
    .fetchBalance({ type: "swap" })
    .catch((err: Error) => {
      logger.error(`[AdxDiAtr] Failed to fetch balance: ${err.message}`);
      return null;
    });

  const walletBalance = new Big(rawBalance ? (rawBalance[quoteCurrency]?.free ?? 0) : 0);

  if (walletBalance.lte(0)) {
    const reason = `no ${quoteCurrency} balance (${walletBalance.toFixed(2)})`;
    logger.warn(`[AdxDiAtr] Skip | ${reason}`);
    return {
      missed: {
        reason,
        direction,
        entryPrice: bigToNumber(currentPrice),
        stopLossPrice,
        takeProfitPrice,
        quantity: 0,
        walletBalance,
      },
    };
  }

  const preciseStopLoss = new Big(stopLossPrice);
  const stopDistance = currentPrice.minus(preciseStopLoss).abs();

  if (stopDistance.lte(0)) {
    const reason = `stop-loss distance invalid (${stopDistance.toFixed(8)})`;
    logger.warn(`[AdxDiAtr] Skip | ${reason}`);
    return {
      missed: {
        reason,
        direction,
        entryPrice: bigToNumber(currentPrice),
        stopLossPrice,
        takeProfitPrice,
        quantity: 0,
        walletBalance,
      },
    };
  }

  const riskBudget = walletBalance.times(params.riskFractionOfBalance);
  const qtyRisk = riskBudget.div(stopDistance);
  const configuredLeverage = new Big(params.leverage);
  const qtyLevCap = walletBalance.times(configuredLeverage).div(currentPrice);
  const quantityBig = qtyRisk.gt(qtyLevCap) ? qtyLevCap : qtyRisk;

  if (quantityBig.lte(0)) {
    const reason = `calculated quantity is zero or invalid (${quantityBig.toFixed(6)})`;
    logger.warn(`[AdxDiAtr] Skip | ${reason}`);
    return {
      missed: {
        reason,
        direction,
        entryPrice: bigToNumber(currentPrice),
        stopLossPrice,
        takeProfitPrice,
        quantity: quantityBig.toFixed(6),
        walletBalance,
        riskBudget,
      },
    };
  }

  const quantity = parseFloat(exchange.ccxt.amountToPrecision(perpSymbol, bigToNumber(quantityBig)));

  if (quantity <= 0) {
    const reason = `quantity rounds to zero after precision adjustment (raw ${quantityBig.toFixed(8)})`;
    logger.warn(`[AdxDiAtr] Skip | ${reason}`);
    return {
      missed: {
        reason,
        direction,
        entryPrice: bigToNumber(currentPrice),
        stopLossPrice,
        takeProfitPrice,
        quantity: 0,
        rawQuantity: quantityBig,
        walletBalance,
        riskBudget,
      },
    };
  }

  const quantityPrecise = new Big(quantity);
  const notional = currentPrice.times(quantityPrecise);
  const effectiveLeverage = walletBalance.gt(0) ? notional.div(walletBalance) : new Big(0);

  return {
    plan: {
      direction,
      entryPrice: bigToNumber(currentPrice),
      stopLossPrice,
      takeProfitPrice,
      quantity,
      walletBalance,
      riskBudget,
      configuredLeverage,
      effectiveLeverage,
      leverageCapped: qtyRisk.gt(qtyLevCap),
    },
  };
}

/**
 * Opens a SmartTrade in the direction-specific ref and records the slot state
 * used later for exits, breakeven movement, and notifications.
 */
function* openDirectionalTrade({
  state,
  perpSymbol,
  quoteCurrency,
  indicators,
  plan,
}: {
  state: AdxDiAtrState;
  perpSymbol: string;
  quoteCurrency: string;
  indicators: IndicatorSnapshot;
  plan: TradePlan;
}): Generator<any, void, any> {
  const { direction } = plan;
  const entrySide = direction === "long" ? "Buy" : "Sell";
  const exitSide = direction === "long" ? "Sell" : "Buy";
  const ref = getTradeRef(direction);

  logger.info(
    `[AdxDiAtr] Entering ${direction.toUpperCase()} | Entry ${plan.entryPrice.toFixed(4)} | ` +
      `SL ${plan.stopLossPrice} | TP ${plan.takeProfitPrice} | ` +
      `Qty ${plan.quantity} | Bal ${plan.walletBalance.toFixed(2)} ${quoteCurrency} | ` +
      `RiskBudget ${plan.riskBudget.toFixed(2)} ${quoteCurrency} | ConfigLev ${plan.configuredLeverage.toFixed(2)}x | ` +
      `EffectiveLev ${plan.effectiveLeverage.toFixed(2)}x | LeverageCapped ${plan.leverageCapped ? "yes" : "no"} | Ref ${ref}`,
  );

  yield useSmartTrade(
    {
      entry: {
        type: "Market",
        side: entrySide,
        symbol: perpSymbol,
      },
      tp: {
        type: "Limit",
        side: exitSide,
        symbol: perpSymbol,
        price: plan.takeProfitPrice,
      },
      sl: {
        type: "Market",
        side: exitSide,
        symbol: perpSymbol,
        stopPrice: plan.stopLossPrice,
      },
      quantity: plan.quantity,
    },
    ref,
  );

  setTradeSlot(state, direction, {
    inPosition: true,
    direction,
    ref,
    entryPrice: plan.entryPrice,
    stopLossPrice: plan.stopLossPrice,
    takeProfitPrice: plan.takeProfitPrice,
    quantity: plan.quantity,
    stopMovedToBreakeven: false,
  });
  syncLegacyStateFromSlots(state);

  yield telegram.notify(
    formatTradeEntry({
      botName: "ADX DI ATR Trend",
      symbol: perpSymbol,
      direction: direction === "long" ? "LONG" : "SHORT",
      entryPrice: plan.entryPrice,
      tpPrice: plan.takeProfitPrice,
      slPrice: plan.stopLossPrice,
      quantity: plan.quantity,
      extraInfo:
        `ADX: ${indicators.adx.toFixed(2)} | +DI: ${indicators.plusDI.toFixed(2)} | ` +
        `-DI: ${indicators.minusDI.toFixed(2)} | ATR: ${indicators.atr.toFixed(4)} | ` +
        `Bal: ${plan.walletBalance.toFixed(2)} ${quoteCurrency} | Risk: ${plan.riskBudget.toFixed(2)} ${quoteCurrency} | ` +
        `Config lev: ${plan.configuredLeverage.toFixed(2)}x | Effective lev: ${plan.effectiveLeverage.toFixed(2)}x | ` +
        `Leverage capped: ${plan.leverageCapped ? "yes" : "no"} | Ref: ${ref}`,
    }),
  );

  yield telegram.notifyPlain(
    formatSmartTradeLegsPlaced({
      symbol: perpSymbol,
      plan,
      quoteCurrency,
      ref,
    }),
  );
}

/**
 * Applies execution-time management for an active slot: early exit on ADX/DI
 * reversal and optional breakeven stop replacement. Signal detection is kept
 * outside this helper so trade management stays explicit.
 */
function* manageOpenTradeSlot({
  state,
  exchange,
  perpSymbol,
  currentPrice,
  indicators,
  params,
  slot,
}: {
  state: AdxDiAtrState;
  exchange: IExchange;
  perpSymbol: string;
  currentPrice: Big;
  indicators: IndicatorSnapshot;
  params: AdxDiAtrSettings;
  slot: AdxDiAtrTradeSlot;
}): Generator<any, void, any> {
  const exitReason = shouldExit(slot.direction, indicators, params);
  const ref = slot.ref ?? getTradeRef(slot.direction);

  if (exitReason) {
    logger.info(`[AdxDiAtr] Closing ${slot.direction.toUpperCase()} early: ${exitReason}`);
    yield cancelSmartTrade(ref);
    yield* marketClosePosition(perpSymbol, slot.direction, slot.quantity ?? 0, state.isHedgeMode);
    yield telegram.notifyPlain(
      [
        "ADX DI ATR Trend early close",
        `Symbol: ${perpSymbol}`,
        `Direction: ${slot.direction.toUpperCase()}`,
        `Reason: ${exitReason}`,
        `Quantity: ${slot.quantity ?? 0}`,
        `Ref: ${ref}`,
      ].join("\n"),
    );
    setTradeSlot(state, slot.direction, undefined);
    syncLegacyStateFromSlots(state);
    return;
  }

  const entryPrice = new Big(slot.entryPrice ?? 0);
  const unrealizedProfit = slot.direction === "long" ? currentPrice.minus(entryPrice) : entryPrice.minus(currentPrice);

  if (
    params.moveStopToBreakeven &&
    !slot.stopMovedToBreakeven &&
    entryPrice.gt(0) &&
    unrealizedProfit.gt(indicators.atr.times(params.breakevenAtrMultiplier))
  ) {
    const entrySide = slot.direction === "long" ? "Buy" : "Sell";
    const exitSide = slot.direction === "long" ? "Sell" : "Buy";
    const breakevenStop = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, bigToNumber(entryPrice)));
    const previousStop = slot.stopLossPrice;

    logger.info(`[AdxDiAtr] Moving ${slot.direction.toUpperCase()} stop to breakeven at ${breakevenStop}`);
    yield cancelSmartTrade(ref);
    yield createSmartTrade(
      {
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
          price: slot.takeProfitPrice,
        },
        sl: {
          type: "Market",
          side: exitSide,
          symbol: perpSymbol,
          stopPrice: breakevenStop,
        },
        quantity: slot.quantity ?? 0,
      },
      ref,
    );
    slot.stopMovedToBreakeven = true;
    slot.stopLossPrice = breakevenStop;
    setTradeSlot(state, slot.direction, slot);
    syncLegacyStateFromSlots(state);
    yield telegram.notifyPlain(
      formatStopLossUpdated({
        symbol: perpSymbol,
        slot,
        previousStop,
        newStop: breakevenStop,
        ref,
        reason: `breakeven trigger reached (${params.breakevenAtrMultiplier} ATR)`,
      }),
    );
    yield telegram.notifyPlain(
      formatTakeProfitUpdated({
        symbol: perpSymbol,
        slot,
        ref,
        reason: "SmartTrade refreshed after stop-loss update",
      }),
    );
  }
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
  bridgeLegacySingleSlotState(state);

  if (onStart) {
    logger.info(`[AdxDiAtr] Bot started on ${spotSymbol} (perp: ${perpSymbol}, timeframe: ${ctx.config.timeframe})`);
    state.inPosition = state.inPosition ?? false;
    state.stopMovedToBreakeven = state.stopMovedToBreakeven ?? false;
    bridgeLegacySingleSlotState(state);
    syncLegacyStateFromSlots(state);

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
    logger.info("[AdxDiAtr] Bot stopped; cancelling open SmartTrades");
    for (const direction of ["long", "short"] as TradeDirection[]) {
      const slot = getTradeSlot(state, direction);
      yield cancelSmartTrade(getTradeRef(direction));
      if (slot?.inPosition && (slot.quantity ?? 0) > 0) {
        yield* marketClosePosition(perpSymbol, direction, slot.quantity!, state.isHedgeMode);
      }
    }
    yield cancelSmartTrade(LEGACY_TRADE_REF);
    yield telegram.notify(formatBotStopped({ botName: "ADX DI ATR Trend", symbol: perpSymbol }));
    state.long = undefined;
    state.short = undefined;
    syncLegacyStateFromSlots(state);
    return;
  }

  const { hasActiveTrade, settledTrade } = yield* reconcileTradeSlots(state, perpSymbol);
  if (ctx.event === "onOrderFilled") {
    if (hasActiveTrade) {
      logger.info("[AdxDiAtr] Order fill event received, managed trade remains active");
    }
    return;
  }
  if (settledTrade) return;

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

  const { direction, rejectionReasons: entryRejectionReasons } = detectEntrySignal(indicators, params);

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

  for (const slot of getActiveTradeSlots(state)) {
    yield* manageOpenTradeSlot({
      state,
      exchange,
      perpSymbol,
      currentPrice,
      indicators,
      params,
      slot,
    });
  }

  if (!direction) {
    logger.info(`[AdxDiAtr] No entry signal | ${entryRejectionReasons.join("; ")}`);
    return;
  }

  yield telegram.notifyPlain(
    formatSignalDetected({
      symbol: perpSymbol,
      timeframe,
      direction,
      price: currentPrice,
      indicators,
    }),
  );

  const planResult: TradePlanBuildResult = yield* buildTradePlan({
    exchange,
    perpSymbol,
    quoteCurrency,
    direction,
    currentPrice,
    indicators,
    params,
  });

  const activeSlot = getTradeSlot(state, direction);
  if (activeSlot?.inPosition) {
    logger.info(
      `[AdxDiAtr] ${direction.toUpperCase()} signal present, but ${getTradeRef(direction)} slot is already active`,
    );
    const plan = planResult.plan;
    const missed = planResult.missed;
    yield telegram.notifyPlain(
      formatMissedEntrySignal({
        symbol: perpSymbol,
        timeframe,
        direction,
        reason: `${getTradeRef(direction)} slot already active`,
        price: plan?.entryPrice ?? missed?.entryPrice ?? currentPrice.toFixed(4),
        stopLossPrice: plan?.stopLossPrice ?? missed?.stopLossPrice ?? "unknown",
        takeProfitPrice: plan?.takeProfitPrice ?? missed?.takeProfitPrice ?? "unknown",
        quantity: plan?.quantity ?? missed?.quantity ?? "unknown",
        indicators,
        details: [
          `Active quantity: ${activeSlot.quantity ?? "unknown"}`,
          `Active entry: ${activeSlot.entryPrice ?? "unknown"}`,
          `Active SL: ${activeSlot.stopLossPrice ?? "unknown"}`,
          `Active TP: ${activeSlot.takeProfitPrice ?? "unknown"}`,
          `Ref: ${activeSlot.ref}`,
          ...(missed ? [`Plan check also failed: ${missed.reason}`] : []),
        ],
      }),
    );
    return;
  }

  if (planResult.missed) {
    yield telegram.notifyPlain(
      formatMissedEntrySignal({
        symbol: perpSymbol,
        timeframe,
        direction,
        reason: planResult.missed.reason,
        price: planResult.missed.entryPrice,
        stopLossPrice: planResult.missed.stopLossPrice,
        takeProfitPrice: planResult.missed.takeProfitPrice,
        quantity: planResult.missed.quantity,
        indicators,
        details: [
          ...(planResult.missed.walletBalance
            ? [`Wallet: ${planResult.missed.walletBalance.toFixed(2)} ${quoteCurrency}`]
            : []),
          ...(planResult.missed.riskBudget
            ? [`Risk budget: ${planResult.missed.riskBudget.toFixed(2)} ${quoteCurrency}`]
            : []),
          ...(planResult.missed.takeProfitPercent
            ? [
                `Take profit distance: ${planResult.missed.takeProfitPercent.toFixed(4)}% (min ${params.minTakeProfitPercent}%)`,
              ]
            : []),
          ...(planResult.missed.rawQuantity ? [`Raw quantity: ${planResult.missed.rawQuantity.toFixed(8)}`] : []),
        ],
      }),
    );
    return;
  }

  yield* openDirectionalTrade({
    state,
    perpSymbol,
    quoteCurrency,
    indicators,
    plan: planResult.plan,
  });
}

adxDiAtr.displayName = "ADX DI ATR Trend";
adxDiAtr.description =
  "Trend-following strategy using ADX strength, ADX slope, DI direction, and ATR-based stop-loss/take-profit levels on the selected bot timeframe, with a minimum take-profit distance filter.";

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
  minTakeProfitPercent: z
    .number()
    .min(0)
    .default(0.33)
    .describe("Minimum absolute percentage distance from entry price to take-profit price required before entry."),
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
      "Maximum leverage to set on the perpetual market at bot start. Actual position sizing may use less to satisfy stop-loss risk.",
    ),
  riskFractionOfBalance: z
    .number()
    .gt(0)
    .lte(1)
    .default(0.5)
    .describe(
      "Fraction of available balance to lose if stop loss is hit. 0.5 means risk 50% of wallet balance per trade.",
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

type AdxDiAtrTradeSlot = {
  inPosition: boolean;
  direction: TradeDirection;
  ref: string;
  entryPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  quantity?: number;
  stopMovedToBreakeven?: boolean;
};

type AdxDiAtrState = {
  long?: AdxDiAtrTradeSlot;
  short?: AdxDiAtrTradeSlot;
  inPosition?: boolean;
  direction?: TradeDirection;
  entryPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  quantity?: number;
  stopMovedToBreakeven?: boolean;
  isHedgeMode?: boolean;
};

type TradePlan = {
  direction: TradeDirection;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  walletBalance: Big;
  riskBudget: Big;
  configuredLeverage: Big;
  effectiveLeverage: Big;
  leverageCapped: boolean;
};

type MissedTradePlan = {
  reason: string;
  direction: TradeDirection;
  entryPrice: number | string;
  stopLossPrice: number | string;
  takeProfitPrice: number | string;
  quantity: number | string;
  rawQuantity?: Big;
  takeProfitPercent?: Big;
  walletBalance?: Big;
  riskBudget?: Big;
};

type TradePlanBuildResult = { plan: TradePlan; missed?: never } | { plan?: never; missed: MissedTradePlan };

type AdxDiAtrSettings = z.infer<typeof adxDiAtr.schema>;

export type AdxDiAtrConfig = IBotConfiguration<AdxDiAtrSettings>;
