import { z } from "zod";
import Big from "big.js";
import type { IExchange } from "@opentrader/exchanges";
import type { ICandlestick } from "@opentrader/types";
import {
  useExchange,
  useSmartTrade,
  getSmartTrade,
  cancelSmartTrade,
  IBotConfiguration,
  TBotContext,
  type SmartTradeService,
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
// Indicator computation (self-contained, no external deps)
// ════════════════════════════════════════════════════════════════════════════

/** Compute Simple Moving Average */
function computeSMA(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    result[i] = sum / period;
  }
  return result;
}

/** Compute Exponential Moving Average */
function computeEMA(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period && i < values.length; i++) sum += values[i];
  if (period > values.length) return result;

  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/** Compute Relative Strength Index — returns full array */
function computeRSI(closes: number[], period: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // Initial average gain/loss (SMA of first `period` changes)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value at index `period`
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0);

  // Smoothed (Wilder's) for subsequent values
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i + 1] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return result;
}

/** Compute Bollinger Bands: { upper[], middle[], lower[] } */
function computeBollingerBands(
  closes: number[],
  period: number,
  stdDevMultiplier: number,
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = computeSMA(closes, period);
  const upper: number[] = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - middle[i];
      variance += diff * diff;
    }
    const stdDev = Math.sqrt(variance / period);
    upper[i] = middle[i] + stdDevMultiplier * stdDev;
    lower[i] = middle[i] - stdDevMultiplier * stdDev;
  }
  return { upper, middle, lower };
}

/** Compute Average True Range */
function computeATR(candles: ICandlestick[], period: number): number[] {
  const result: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < 2) return result;

  // True Range array (starts at index 1)
  const tr: number[] = [0]; // placeholder for index 0
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // SMA of TR for initial ATR, then Wilder's smoothing
  if (candles.length < period + 1) return result;

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  result[period] = sum / period;

  for (let i = period + 1; i < candles.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// Pivot / Divergence detection
// ════════════════════════════════════════════════════════════════════════════

interface PivotHigh {
  index: number;
  price: number;
  rsi: number;
}

/**
 * Find confirmed pivot highs.
 * A pivot high at bar[i] is confirmed when:
 *   high[i] > high[i-1..i-strength] AND high[i] > high[i+1..i+strength]
 * We can only detect pivots up to (length - strength) since we need
 * `strength` bars after the pivot to confirm.
 */
function findPivotHighs(
  candles: ICandlestick[],
  rsiValues: number[],
  strength: number,
  lookback: number,
): PivotHigh[] {
  const pivots: PivotHigh[] = [];
  const startIdx = Math.max(strength, candles.length - lookback);
  const endIdx = candles.length - strength; // need `strength` bars after to confirm

  for (let i = startIdx; i < endIdx; i++) {
    const high = candles[i].high;
    let isPivot = true;

    for (let j = 1; j <= strength; j++) {
      if (candles[i - j].high >= high || candles[i + j].high >= high) {
        isPivot = false;
        break;
      }
    }

    if (isPivot && !isNaN(rsiValues[i])) {
      pivots.push({ index: i, price: high, rsi: rsiValues[i] });
    }
  }
  return pivots;
}

/**
 * Detect bearish divergence: price makes a higher high but RSI makes a lower high.
 * Returns true if the last two pivot highs show divergence.
 */
function detectBearishDivergence(pivots: PivotHigh[]): boolean {
  if (pivots.length < 2) return false;

  const prev = pivots[pivots.length - 2];
  const curr = pivots[pivots.length - 1];

  return curr.price > prev.price && curr.rsi < prev.rsi;
}

// ════════════════════════════════════════════════════════════════════════════
// Volume analysis
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compute volume trend ratio: SMA(volume, shortPeriod) / SMA(volume, longPeriod).
 * A ratio > threshold means the recent bounce has surging volume (dangerous for shorts).
 */
function computeVolumeTrendRatio(
  candles: ICandlestick[],
  shortPeriod: number,
  longPeriod: number,
): Big {
  const volumes = candles.map((c) => c.volume);
  const shortSma = computeSMA(volumes, shortPeriod);
  const longSma = computeSMA(volumes, longPeriod);

  const lastShort = shortSma[shortSma.length - 1];
  const lastLong = longSma[longSma.length - 1];

  if (isNaN(lastShort) || isNaN(lastLong) || lastLong === 0) return new Big(0);
  return new Big(lastShort).div(lastLong);
}

// ════════════════════════════════════════════════════════════════════════════
// Helper: Market-close the open short position
// ════════════════════════════════════════════════════════════════════════════

function* marketCloseShort(
  perpSymbol: string,
  quantity: number,
) {
  if (quantity <= 0) {
    logger.info("[ShortTheRip] No quantity to close");
    return;
  }

  logger.info(
    `[ShortTheRip] Market-closing short — qty: ${quantity} ${perpSymbol}`,
  );

  const exchange: IExchange = yield useExchange();

  yield exchange.ccxt
    .createOrder(perpSymbol, "market", "buy", quantity, undefined, { reduceOnly: true })
    .then((order: any) => {
      logger.info(
        `[ShortTheRip] ✅ Market close order placed — Buy ${quantity} @ market | orderId: ${order?.id ?? "unknown"}`,
      );
    })
    .catch((err: Error) => {
      logger.error(`[ShortTheRip] ❌ Failed to market-close short: ${err.message}`);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Main Strategy
// ════════════════════════════════════════════════════════════════════════════

/**
 * Short the Rip — Bear Market Mean-Reversion Shorting Strategy
 *
 * Designed for bear markets. Uses a scoring system to identify overextended
 * bounces ("rips") in a downtrend and shorts them with ATR-based risk management.
 *
 * Filters:
 *   - Multi-timeframe EMA trend filter (execution + macro TF)
 *   - Volume surge filter (aborts if bounce has too much momentum)
 *
 * Entry signals (scoring system):
 *   - Trend confirmed on both timeframes (+scoreTrendFilter pts)
 *   - Bearish RSI divergence detected (+scoreDivergence pts)
 *   - Price touches Upper Bollinger Band (+scoreBBTouch pts)
 *   - Rejection candle confirmation (+scoreRejectionCandle pts)
 *
 * Risk management:
 *   - ATR-based stop-loss
 *   - Take profit at Lower Bollinger Band or ATR-based target
 *   - Circuit breakers (daily loss limit, consecutive losses)
 *   - Cooldown between trades
 */
export function* shortTheRip(ctx: TBotContext<ShortTheRipConfig, ShortTheRipState>) {
  const {
    config: { settings: params },
    state,
    onStart,
    onStop,
  } = ctx;

  const spotSymbol = ctx.config.symbol;
  const perpSymbol = toPerpSymbol(spotSymbol);
  const quoteCurrency = getQuoteCurrency(spotSymbol);
  const executionTimeframe = ctx.config.timeframe ?? "15m";

  // ── Bot lifecycle ──────────────────────────────────────────────────────

  if (onStart) {
    logger.info(`[ShortTheRip] Bot started on ${spotSymbol} (perp: ${perpSymbol})`);
    logger.info(ctx.config, "[ShortTheRip] Bot config");

    // Initialize state
    state.phase = "SCANNING";
    state.inPosition = false;
    state.consecutiveLosses = 0;
    state.dailyPnl = 0;
    state.dailyPnlResetTimestamp = Date.now();
    state.lastTradeTimestamp = 0;
    state.candlesSinceLastTrade = params.cooldownCandles; // allow immediate first trade

    // Set cross margin mode & leverage
    const startExchange: IExchange = yield useExchange();

    yield startExchange.ccxt
      .setMarginMode("cross", perpSymbol)
      .then(() => logger.info(`[ShortTheRip] Margin mode set to CROSS for ${perpSymbol}`))
      .catch((err: Error) => logger.warn(`[ShortTheRip] setMarginMode: ${err.message}`));

    yield startExchange.ccxt
      .setLeverage(params.leverage, perpSymbol)
      .then(() => logger.info(`[ShortTheRip] Leverage set to ${params.leverage}x for ${perpSymbol}`))
      .catch((err: Error) => logger.warn(`[ShortTheRip] setLeverage: ${err.message}`));

    return;
  }

  if (onStop) {
    logger.info("[ShortTheRip] Bot stopped — cancelling open trades");
    yield cancelSmartTrade("main");

    // Market-close the short position if we have one
    if (state.inPosition && (state.positionQuantity ?? 0) > 0) {
      yield* marketCloseShort(perpSymbol, state.positionQuantity!);
    }

    state.phase = "SCANNING";
    state.inPosition = false;
    return;
  }

  // ── Handle order fill events ───────────────────────────────────────────

  if (ctx.event === "onOrderFilled") {
    if (state.inPosition) {
      const existingTrade: SmartTradeService | null = yield getSmartTrade("main");
      if (existingTrade && existingTrade.isCompleted()) {
        // Determine if it was a win or loss
        // For a short: TP hit = profit, SL hit = loss
        const tpHit = existingTrade.tp?.status === "Filled";
        const wasProfit = tpHit;

        // Calculate P&L and update daily tracker
        const entryBig = new Big(state.entryPrice ?? 0);
        if (entryBig.gt(0)) {
          const exitPrice = tpHit
            ? new Big(state.takeProfitPrice ?? 0)
            : new Big(state.stopLossPrice ?? 0);
          // Short P&L: (entry - exit) / entry × 100
          const pnlPercent = entryBig.minus(exitPrice).div(entryBig).times(100).toNumber();
          state.dailyPnl = (state.dailyPnl ?? 0) + pnlPercent;
        }

        if (wasProfit) {
          state.consecutiveLosses = 0;
          logger.info("[ShortTheRip] ✅ Trade completed — PROFIT");
        } else {
          state.consecutiveLosses = (state.consecutiveLosses ?? 0) + 1;
          logger.info(
            `[ShortTheRip] ❌ Trade completed — LOSS (consecutive: ${state.consecutiveLosses})`,
          );
        }

        state.inPosition = false;
        state.phase = "SCANNING";
        state.lastTradeTimestamp = Date.now();
        state.candlesSinceLastTrade = 0;
      }
    }
    return;
  }

  // ── Increment candle counter ───────────────────────────────────────────

  state.candlesSinceLastTrade = (state.candlesSinceLastTrade ?? params.cooldownCandles) + 1;

  // ── Reset daily P&L at midnight UTC ────────────────────────────────────

  const now = Date.now();
  const lastReset = state.dailyPnlResetTimestamp ?? 0;
  const dayMs = 24 * 60 * 60 * 1000;
  if (now - lastReset > dayMs) {
    state.dailyPnl = 0;
    state.dailyPnlResetTimestamp = now;
    logger.info("[ShortTheRip] Daily P&L reset");
  }

  // ── Circuit breakers ───────────────────────────────────────────────────

  if ((state.dailyPnl ?? 0) <= -params.maxDailyLossPercent) {
    logger.warn(
      `[ShortTheRip] 🛑 Circuit breaker: Daily loss ${(state.dailyPnl ?? 0).toFixed(2)}% exceeds limit ${params.maxDailyLossPercent}%. Paused.`,
    );
    return;
  }

  if ((state.consecutiveLosses ?? 0) >= params.maxConsecutiveLosses) {
    const timeSinceLastTrade = now - (state.lastTradeTimestamp ?? 0);
    const cooldownMs = params.cooldownHours * 60 * 60 * 1000;
    if (timeSinceLastTrade < cooldownMs) {
      const remainingHours = ((cooldownMs - timeSinceLastTrade) / 3600000).toFixed(1);
      logger.warn(
        `[ShortTheRip] 🛑 Circuit breaker: ${state.consecutiveLosses} consecutive losses. Cooling down (${remainingHours}h remaining).`,
      );
      return;
    }
    // Cooldown expired, reset
    state.consecutiveLosses = 0;
    logger.info("[ShortTheRip] Circuit breaker cooldown expired — resuming");
  }

  // ── If in position, check for early exit (RSI oversold) ────────────────

  if (state.inPosition) {
    const existingTrade: SmartTradeService | null = yield getSmartTrade("main");
    if (existingTrade && existingTrade.isCompleted()) {
      // Trade completed between candle events — calculate P&L
      const entryBig = new Big(state.entryPrice ?? 0);
      if (entryBig.gt(0)) {
        const tpHit = existingTrade.tp?.status === "Filled";
        const exitPrice = tpHit
          ? new Big(state.takeProfitPrice ?? 0)
          : new Big(state.stopLossPrice ?? 0);
        const pnlPercent = entryBig.minus(exitPrice).div(entryBig).times(100).toNumber();
        state.dailyPnl = (state.dailyPnl ?? 0) + pnlPercent;
      }

      state.inPosition = false;
      state.phase = "SCANNING";
      state.lastTradeTimestamp = now;
      state.candlesSinceLastTrade = 0;
      logger.info("[ShortTheRip] Trade completed — resetting to SCANNING");
      return;
    }

    if (!existingTrade) {
      state.inPosition = false;
      state.phase = "SCANNING";
      return;
    }

    // Fetch candles for early exit RSI check
    const exchange: IExchange = yield useExchange();
    const recentCandles: ICandlestick[] = yield exchange
      .getCandlesticks({
        symbol: perpSymbol,
        bar: executionTimeframe,
        limit: params.rsiPeriod + 5,
      })
      .catch((err: Error) => {
        logger.error(`[ShortTheRip] Failed to fetch candles for RSI check: ${err.message}`);
        return [];
      });

    if (recentCandles.length > params.rsiPeriod) {
      const closes = recentCandles.map((c) => c.close);
      const rsiArr = computeRSI(closes, params.rsiPeriod);
      const currentRSI = rsiArr[rsiArr.length - 1];

      if (!isNaN(currentRSI) && currentRSI < 30) {
        logger.info(
          `[ShortTheRip] 📉 RSI oversold (${currentRSI.toFixed(1)}) — closing position early`,
        );

        // Cancel TP/SL orders
        yield cancelSmartTrade("main");

        // Market-close the short position
        if ((state.positionQuantity ?? 0) > 0) {
          yield* marketCloseShort(perpSymbol, state.positionQuantity!);
        }

        // Estimate P&L using current close as exit
        const entryBig = new Big(state.entryPrice ?? 0);
        const exitPrice = new Big(closes[closes.length - 1]);
        if (entryBig.gt(0)) {
          const pnlPercent = entryBig.minus(exitPrice).div(entryBig).times(100).toNumber();
          state.dailyPnl = (state.dailyPnl ?? 0) + pnlPercent;
        }

        state.inPosition = false;
        state.phase = "SCANNING";
        state.lastTradeTimestamp = now;
        state.candlesSinceLastTrade = 0;
      }
    }
    return;
  }

  // ── Cooldown between trades ────────────────────────────────────────────

  if ((state.candlesSinceLastTrade ?? params.cooldownCandles) < params.cooldownCandles) {
    logger.info(
      `[ShortTheRip] Cooldown: ${state.candlesSinceLastTrade}/${params.cooldownCandles} candles since last trade`,
    );
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ENTRY LOGIC — Scoring system
  // ══════════════════════════════════════════════════════════════════════════

  const exchange: IExchange = yield useExchange();

  // ── Fetch execution timeframe candles ──────────────────────────────────

  const historyLength = Math.max(params.emaPeriod, params.pivotLookback, params.bbPeriod) + 20;

  const execCandles: ICandlestick[] = yield exchange
    .getCandlesticks({
      symbol: perpSymbol,
      bar: executionTimeframe,
      limit: historyLength,
    })
    .catch((err: Error) => {
      logger.error(`[ShortTheRip] Failed to fetch execution TF candles: ${err.message}`);
      return [];
    });

  if (execCandles.length < historyLength * 0.8) {
    logger.warn(
      `[ShortTheRip] Not enough execution TF candles (got ${execCandles.length}, need ~${historyLength})`,
    );
    return;
  }

  // ── Fetch macro timeframe candles ──────────────────────────────────────

  const macroCandles: ICandlestick[] = yield exchange
    .getCandlesticks({
      symbol: perpSymbol,
      bar: params.macroTimeframe,
      limit: params.emaPeriod + 10,
    })
    .catch((err: Error) => {
      logger.error(`[ShortTheRip] Failed to fetch macro TF candles: ${err.message}`);
      return [];
    });

  if (macroCandles.length < params.emaPeriod) {
    logger.warn(
      `[ShortTheRip] Not enough macro TF candles (got ${macroCandles.length}, need ${params.emaPeriod})`,
    );
    return;
  }

  // ── Compute indicators ─────────────────────────────────────────────────

  const execCloses = execCandles.map((c) => c.close);
  const macroCloses = macroCandles.map((c) => c.close);

  const execEMA = computeEMA(execCloses, params.emaPeriod);
  const macroEMA = computeEMA(macroCloses, params.emaPeriod);
  const rsiArr = computeRSI(execCloses, params.rsiPeriod);
  const bb = computeBollingerBands(execCloses, params.bbPeriod, params.bbStdDev);
  const atrArr = computeATR(execCandles, params.atrPeriod);

  // Latest values
  const lastIdx = execCandles.length - 1;
  const prevIdx = lastIdx - 1;
  const currentPrice = new Big(execCloses[lastIdx]);
  const previousCandleLow = new Big(execCandles[prevIdx].low);
  const currentClose = new Big(execCloses[lastIdx]);
  const previousClose = new Big(execCloses[prevIdx]);

  const execEmaValue = new Big(execEMA[lastIdx]);
  const macroEmaValue = new Big(macroEMA[macroCandles.length - 1]);
  const macroPrice = new Big(macroCloses[macroCloses.length - 1]);
  const currentRSI = rsiArr[lastIdx];
  const upperBB = new Big(bb.upper[lastIdx]);
  const lowerBB = new Big(bb.lower[lastIdx]);
  const currentATR = new Big(atrArr[lastIdx]);

  // Validate all indicators are computed
  if (
    isNaN(execEMA[lastIdx]) || isNaN(macroEMA[macroCandles.length - 1]) || isNaN(currentRSI) ||
    isNaN(bb.upper[lastIdx]) || isNaN(bb.lower[lastIdx]) || isNaN(atrArr[lastIdx])
  ) {
    logger.warn("[ShortTheRip] Indicators not ready (NaN values) — skipping");
    return;
  }

  // ── Score calculation ──────────────────────────────────────────────────

  let score = 0;
  const scoreBreakdown: string[] = [];

  // 1. TREND FILTER: Price below EMA on both timeframes
  const execBelowEma = currentPrice.lt(execEmaValue);
  const macroBelowEma = macroPrice.lt(macroEmaValue);
  if (execBelowEma && macroBelowEma) {
    score += params.scoreTrendFilter;
    scoreBreakdown.push(`Trend(${params.scoreTrendFilter})`);
  }

  // 2. DIVERGENCE: Bearish RSI divergence
  const pivots = findPivotHighs(execCandles, rsiArr, params.pivotStrength, params.pivotLookback);
  const hasDivergence = detectBearishDivergence(pivots);
  if (hasDivergence) {
    score += params.scoreDivergence;
    scoreBreakdown.push(`Div(${params.scoreDivergence})`);
  }

  // 3. BB TOUCH: Price at or above Upper Bollinger Band
  const touchingUpperBB = currentPrice.gte(upperBB);
  if (touchingUpperBB) {
    score += params.scoreBBTouch;
    scoreBreakdown.push(`BB(${params.scoreBBTouch})`);
  }

  // 4. REJECTION CANDLE: Current close below previous candle's low
  const isRejectionCandle = currentClose.lt(previousCandleLow);
  // Also accept a simple red candle (close < previous close) as a weaker signal
  const isRedCandle = currentClose.lt(previousClose);
  if (isRejectionCandle) {
    score += params.scoreRejectionCandle;
    scoreBreakdown.push(`Reject(${params.scoreRejectionCandle})`);
  } else if (isRedCandle) {
    // Award half points for a simple red candle (not as strong as rejection)
    const halfScore = Math.floor(params.scoreRejectionCandle / 2);
    score += halfScore;
    scoreBreakdown.push(`RedCandle(${halfScore})`);
  }

  // ── Volume filter ──────────────────────────────────────────────────────

  let volumeAborted = false;
  if (params.volumeFilterEnabled) {
    const volRatio = computeVolumeTrendRatio(
      execCandles,
      params.volumeShortPeriod,
      params.volumeLongPeriod,
    );

    if (volRatio.gt(params.volumeAbortRatio)) {
      volumeAborted = true;
      logger.info(
        `[ShortTheRip] Volume abort | Ratio: ${volRatio.toFixed(2)} > ${params.volumeAbortRatio} — bounce has too much momentum`,
      );
    }
  }

  // ── Log signal analysis ────────────────────────────────────────────────

  logger.info(
    `[ShortTheRip] Analysis | Price: ${currentPrice.toFixed(2)} | EMA: ${execEmaValue.toFixed(2)} | RSI: ${currentRSI.toFixed(1)} | ` +
    `BB: [${lowerBB.toFixed(2)} — ${upperBB.toFixed(2)}] | ATR: ${currentATR.toFixed(2)} | ` +
    `Score: ${score}/${params.entryScoreThreshold} [${scoreBreakdown.join(" + ") || "none"}] | ` +
    `Pivots: ${pivots.length} | Div: ${hasDivergence} | VolAbort: ${volumeAborted}`,
  );

  // ── Entry decision ─────────────────────────────────────────────────────

  if (score < params.entryScoreThreshold) {
    logger.info(
      `[ShortTheRip] Skip | Score ${score} < threshold ${params.entryScoreThreshold}`,
    );
    return;
  }

  if (volumeAborted) {
    return;
  }

  // Must have at least the trend filter passing (mandatory, not just scored)
  if (!execBelowEma || !macroBelowEma) {
    logger.info("[ShortTheRip] Skip | Trend filter not met (mandatory)");
    return;
  }

  // Must have some form of price confirmation (red candle minimum)
  if (!isRedCandle && !isRejectionCandle) {
    logger.info("[ShortTheRip] Skip | No price action confirmation");
    return;
  }

  // ── Calculate position size & risk levels ──────────────────────────────

  const entryPrice = currentPrice;
  const stopLoss = entryPrice.plus(currentATR.times(params.atrStopMultiplier));

  let takeProfit: Big;
  if (params.tp2Target === "lowerBB") {
    takeProfit = lowerBB;
  } else {
    takeProfit = entryPrice.minus(currentATR.times(params.tp2AtrMultiplier));
  }

  // Sanity: TP must be below entry for a short
  if (takeProfit.gte(entryPrice)) {
    logger.warn(
      `[ShortTheRip] Skip | TP (${takeProfit.toFixed(2)}) >= Entry (${entryPrice.toFixed(2)}) — invalid`,
    );
    return;
  }

  // Sanity: SL must be above entry for a short
  if (stopLoss.lte(entryPrice)) {
    logger.warn(
      `[ShortTheRip] Skip | SL (${stopLoss.toFixed(2)}) <= Entry (${entryPrice.toFixed(2)}) — invalid`,
    );
    return;
  }

  // Fetch balance
  const rawBalance: Record<string, any> | null = yield exchange.ccxt
    .fetchBalance({ type: "swap" })
    .catch((err: Error) => {
      logger.error(`[ShortTheRip] Failed to fetch balance: ${err.message}`);
      return null;
    });

  const walletBalance = new Big(rawBalance ? Number(rawBalance[quoteCurrency]?.free ?? 0) : 0);

  if (walletBalance.lte(0)) {
    logger.warn(`[ShortTheRip] Skip | No ${quoteCurrency} balance (${walletBalance.toFixed(2)})`);
    return;
  }

  // Position sizing based on risk percentage
  // Risk per trade = walletBalance × riskPercent / 100
  // Risk per unit = |stopLoss - entry|
  // Quantity = riskAmount / riskPerUnit
  const riskAmount = walletBalance.times(params.riskPercent).div(100);
  const riskPerUnit = stopLoss.minus(entryPrice); // positive for a short
  let quantityBig = riskAmount.div(riskPerUnit);

  // Cap at leverage limit
  const maxQty = walletBalance.times(params.leverage).div(entryPrice);
  if (quantityBig.gt(maxQty)) quantityBig = maxQty;

  if (quantityBig.lte(0)) {
    logger.warn(`[ShortTheRip] Skip | Calculated quantity is ${quantityBig.toFixed(6)}`);
    return;
  }

  // Round quantity and prices to exchange precision
  let quantity = parseFloat(exchange.ccxt.amountToPrecision(perpSymbol, quantityBig.toNumber()));
  let tpPrice = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, takeProfit.toNumber()));
  let slPrice = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, stopLoss.toNumber()));

  if (quantity <= 0) {
    logger.warn("[ShortTheRip] Skip | Quantity rounds to 0 after precision adjustment");
    return;
  }

  // ── Place the short ────────────────────────────────────────────────────

  logger.info(
    `[ShortTheRip] 🚨 SHORT | Score: ${score}/${params.entryScoreThreshold} [${scoreBreakdown.join(" + ")}] | ` +
    `Entry: ${entryPrice.toFixed(2)} | SL: ${slPrice} | TP: ${tpPrice} | ` +
    `Qty: ${quantity} | Risk: $${riskAmount.toFixed(2)} (${params.riskPercent}%) | ` +
    `Bal: ${walletBalance.toFixed(2)} ${quoteCurrency}`,
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
      sl: {
        type: "Market",
        side: "Buy",
        symbol: perpSymbol,
        stopPrice: slPrice,
      },
      quantity,
    },
    "main",
  );

  state.phase = "POSITION_OPEN";
  state.inPosition = true;
  state.entryPrice = entryPrice.toNumber();
  state.stopLossPrice = slPrice;
  state.takeProfitPrice = tpPrice;
  state.positionQuantity = quantity;
  state.lastTradeTimestamp = now;
  state.candlesSinceLastTrade = 0;

  logger.info(
    `[ShortTheRip] ✅ Trade placed — SHORT ${quantity} @ market | SL: ${slPrice} | TP: ${tpPrice}`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Strategy metadata
// ════════════════════════════════════════════════════════════════════════════

shortTheRip.displayName = "Short the Rip (Bear Market)";
shortTheRip.description =
  "Bear market mean-reversion shorting strategy. Uses a weighted scoring system to identify " +
  "overextended bounces ('rips') in a confirmed downtrend and shorts them with ATR-based " +
  "risk management. Requires price below EMA on both execution and macro timeframes. " +
  "Scores entries based on trend confirmation, bearish RSI divergence, Bollinger Band " +
  "touch, and rejection candle patterns. Includes circuit breakers for daily loss limits " +
  "and consecutive loss protection.";

shortTheRip.schema = z.object({
  // ── Trend Filter ─────────────────────────────────────────────────────
  emaPeriod: z
    .number()
    .positive()
    .default(200)
    .describe(
      "EMA period for trend determination on both the execution and macro timeframes. " +
      "Price must be below this EMA on BOTH timeframes for the trend filter to pass (mandatory condition). " +
      "Common values: 50 (more responsive — catches shorter downtrends, generates more signals), " +
      "100 (balanced), 200 (conservative — only trades in well-established downtrends). " +
      "Example: With emaPeriod=200 on a 15m execution timeframe, the bot computes a 200-period EMA on the 15m chart " +
      "AND a 200-period EMA on the macro timeframe (e.g. 4h). Both must show price below EMA before any entry is considered.",
    ),
  macroTimeframe: z
    .enum(["5m", "15m", "1h", "4h", "1d", "1w"])
    .default("4h")
    .describe(
      "Higher timeframe for macro trend confirmation. Should be significantly larger than the bot's execution timeframe " +
      "to provide a broader market context. This ensures you're shorting rips within a larger downtrend, not fighting an uptrend. " +
      "Examples: If execution TF is 5m → use 1h or 4h macro. If execution TF is 15m → use 4h or 1d macro. " +
      "If execution TF is 1h → use 1d macro. A 4h macro with a 15m execution TF is a popular combination for crypto.",
    ),

  // ── Scoring System ───────────────────────────────────────────────────
  entryScoreThreshold: z
    .number()
    .min(0)
    .max(100)
    .default(70)
    .describe(
      "Minimum combined bearish score (0–100) required to open a short position. The score is built from four " +
      "independent signals: Trend Filter, Bearish Divergence, Bollinger Band Touch, and Rejection Candle. " +
      "Each signal awards its configured points when triggered; the total is compared against this threshold. " +
      "Lower threshold = more trades (aggressive), higher threshold = fewer but higher-conviction entries. " +
      "Example with defaults: Trend(40) + Divergence(30) = 70 → meets threshold, entry triggered. " +
      "Trend(40) + BBTouch(20) = 60 → below 70, entry skipped. " +
      "Trend(40) + BBTouch(20) + Reject(10) = 70 → meets threshold, entry triggered. " +
      "Tip: Set to 40 if you want to trade on trend confirmation alone, or 70+ for multi-signal confluence.",
    ),
  scoreTrendFilter: z
    .number()
    .min(0)
    .max(100)
    .default(40)
    .describe(
      "Points awarded when price is below the EMA on BOTH the execution and macro timeframes, " +
      "confirming a downtrend on multiple scales. This is typically the highest-weighted signal because " +
      "trend alignment is the most important factor for mean-reversion shorting. " +
      "Example: ETH is at $2,400 with 200 EMA at $2,500 on 15m AND 200 EMA at $2,600 on 4h → +40 points. " +
      "If price is below EMA only on the execution TF but above on macro → 0 points (both must be below). " +
      "Increase to 50–60 to make the trend filter effectively mandatory by itself.",
    ),
  scoreDivergence: z
    .number()
    .min(0)
    .max(100)
    .default(30)
    .describe(
      "Points awarded when bearish RSI divergence is detected — price makes a higher high but RSI makes a " +
      "lower high, signaling weakening momentum behind the bounce. Divergence is detected by comparing the " +
      "last two confirmed pivot highs (controlled by pivotStrength and pivotLookback). " +
      "Example: Pivot High #1 at $2,500 with RSI 72. Later Pivot High #2 at $2,550 (higher price) " +
      "with RSI 65 (lower RSI) → bearish divergence → +30 points. " +
      "This is a strong reversal signal. Set to 0 to disable divergence scoring entirely.",
    ),
  scoreBBTouch: z
    .number()
    .min(0)
    .max(100)
    .default(20)
    .describe(
      "Points awarded when the current price touches or exceeds the Upper Bollinger Band, indicating the " +
      "bounce is statistically overextended relative to recent price action. " +
      "Example: With bbPeriod=20 and bbStdDev=2.0, if the 20-period SMA is $2,400 and the upper band is $2,480, " +
      "a candle closing at $2,485 (above upper BB) earns +20 points. " +
      "Increase to 30+ if you want BB touches to carry more weight in entry decisions. " +
      "Set to 0 to disable this signal.",
    ),
  scoreRejectionCandle: z
    .number()
    .min(0)
    .max(100)
    .default(10)
    .describe(
      "Points awarded for price action confirmation on the most recent candle. Two levels: " +
      "Full points if the candle's close is below the PREVIOUS candle's low (strong rejection — sellers overpowered buyers). " +
      "Half points (rounded down) if the candle is simply red (close < previous close) but not a full rejection. " +
      "Example with default 10: Full rejection candle → +10 pts. Simple red candle → +5 pts. Green candle → 0 pts. " +
      "This acts as a timing filter to avoid entering shorts while the bounce is still actively pushing up. " +
      "Increase to 20+ if you want stronger candle confirmation before entering.",
    ),

  // ── Indicators ───────────────────────────────────────────────────────
  rsiPeriod: z
    .number()
    .min(2)
    .default(14)
    .describe(
      "Period for the Relative Strength Index (RSI) calculation, used for divergence detection and early exit. " +
      "Standard value is 14. Lower values (e.g. 7–10) make RSI more sensitive and generate divergence signals faster " +
      "but with more noise. Higher values (e.g. 21) are smoother but slower to react. " +
      "The RSI is also used for early exit: if RSI drops below 30 (oversold) while in a short, the position is closed early. " +
      "Example: With rsiPeriod=14, a divergence where price makes a higher high at RSI 65 vs. previous RSI 72 " +
      "would trigger a bearish divergence signal.",
    ),
  bbPeriod: z
    .number()
    .min(2)
    .default(20)
    .describe(
      "Bollinger Band period — the middle band is a Simple Moving Average (SMA) of this length, and the upper/lower " +
      "bands are placed at ±bbStdDev standard deviations from it. Used for both entry scoring (upper BB touch) " +
      "and take profit targeting (lower BB as TP when tp2Target='lowerBB'). " +
      "Standard value is 20. Lower values (e.g. 10) create tighter, more reactive bands — more BB touch signals " +
      "but also more false signals. Higher values (e.g. 30–50) create wider, more stable bands. " +
      "Example: With bbPeriod=20 and bbStdDev=2.0 on ETH 15m, typical band width might be $80–120 depending on volatility.",
    ),
  bbStdDev: z
    .number()
    .positive()
    .default(2.0)
    .describe(
      "Standard deviation multiplier for Bollinger Bands. Controls how wide the bands are relative to the SMA. " +
      "Standard value is 2.0 (captures ~95% of price action). " +
      "Lower values (e.g. 1.5) create tighter bands — price touches the upper band more often, generating more " +
      "BB touch signals but at less extreme levels. " +
      "Higher values (e.g. 2.5–3.0) create wider bands — fewer touches but each is a more statistically extreme move. " +
      "Example: With bbStdDev=2.0 and SMA at $2,400 with $40 std dev → Upper BB = $2,480, Lower BB = $2,320. " +
      "With bbStdDev=1.5 → Upper BB = $2,460, Lower BB = $2,340 (tighter).",
    ),
  atrPeriod: z
    .number()
    .min(2)
    .default(14)
    .describe(
      "Period for Average True Range (ATR) calculation, used for volatility-adjusted stop-loss and take profit distances. " +
      "ATR measures average price movement per candle over this many periods. Standard value is 14. " +
      "Lower values (e.g. 7) react faster to recent volatility changes. Higher values (e.g. 21) give a smoother average. " +
      "Example: On ETH 15m with atrPeriod=14, if ATR = $30, then with atrStopMultiplier=2.0, " +
      "the stop-loss is placed $60 above entry. With tp2AtrMultiplier=3.0, " +
      "the take profit (if using ATR mode) is $90 below entry, giving a 1:1.5 risk/reward ratio.",
    ),
  pivotStrength: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe(
      "Number of bars required on EACH side to confirm a swing high (pivot high). A pivot at bar[i] is confirmed " +
      "when high[i] is greater than the highs of the previous `strength` bars AND the next `strength` bars. " +
      "Higher values = fewer pivots detected but each is more significant (less noise). " +
      "Lower values = more pivots detected but may include minor fluctuations. " +
      "Example: With pivotStrength=3, a bar's high must be higher than the 3 bars before it AND " +
      "the 3 bars after it to be considered a pivot high. This means pivots are only confirmed " +
      "after a 3-bar delay (need the confirmation bars to close). " +
      "Use 1–2 for scalping timeframes (1m–5m), 3–5 for swing timeframes (15m–4h).",
    ),
  pivotLookback: z
    .number()
    .min(10)
    .max(100)
    .default(30)
    .describe(
      "Maximum number of bars to look back when searching for pivot highs used in divergence detection. " +
      "The strategy needs at least 2 pivot highs within this window to check for bearish divergence. " +
      "Too small (e.g. 10) may miss divergences that develop slowly. " +
      "Too large (e.g. 100) may compare pivots that are too far apart to be meaningful. " +
      "Example: With pivotLookback=30 on a 15m chart, the bot looks back 30 candles (7.5 hours) for pivot highs. " +
      "If two pivot highs are found where the second is a higher price but lower RSI → bearish divergence. " +
      "Increase to 50–60 for higher timeframes (1h, 4h) where divergences develop over more bars.",
    ),

  // ── Volume Filter ────────────────────────────────────────────────────
  volumeFilterEnabled: z
    .boolean()
    .default(true)
    .describe(
      "Enable or disable the volume surge filter. When enabled, the bot compares short-term average volume " +
      "to long-term average volume. If the recent volume is surging (ratio exceeds volumeAbortRatio), " +
      "the trade is aborted because the bounce has strong buying momentum behind it — dangerous to short against. " +
      "Set to false to disable this safety check (not recommended for beginners). " +
      "Example: A bounce with 2x normal volume suggests institutional buying, making it risky to short.",
    ),
  volumeShortPeriod: z
    .number()
    .min(2)
    .default(5)
    .describe(
      "Short-term volume SMA period — measures the average volume of the most recent candles (the bounce). " +
      "Used as the numerator in the volume surge ratio: SMA(volume, shortPeriod) / SMA(volume, longPeriod). " +
      "Default 5 captures the last 5 candles' average volume. " +
      "Example: On a 15m chart, volumeShortPeriod=5 averages the last 1h15m of volume. " +
      "Lower values (3) react faster but are noisier. Higher values (10) are smoother but less responsive.",
    ),
  volumeLongPeriod: z
    .number()
    .min(5)
    .default(20)
    .describe(
      "Long-term volume SMA period — establishes the baseline 'normal' volume level. " +
      "Used as the denominator in the volume surge ratio: SMA(volume, shortPeriod) / SMA(volume, longPeriod). " +
      "Default 20 gives a solid baseline over the last 20 candles. " +
      "Example: On a 15m chart, volumeLongPeriod=20 averages the last 5 hours of volume as the baseline. " +
      "If the 5-bar average is 150K and the 20-bar average is 100K, the ratio is 1.5.",
    ),
  volumeAbortRatio: z
    .number()
    .positive()
    .default(1.5)
    .describe(
      "Maximum allowed volume surge ratio (short SMA / long SMA). If the ratio exceeds this value, " +
      "the entry is aborted because the bounce has abnormally high volume — likely strong buying pressure. " +
      "Default 1.5 means abort if recent volume is 50%+ above the baseline average. " +
      "Lower values (1.2) are more conservative — abort on smaller volume increases. " +
      "Higher values (2.0+) are more permissive — only abort on very large volume surges. " +
      "Example: 5-bar vol avg = 120K, 20-bar vol avg = 100K → ratio = 1.2 → allowed (< 1.5). " +
      "5-bar vol avg = 180K, 20-bar vol avg = 100K → ratio = 1.8 → ABORTED (> 1.5).",
    ),

  // ── Position Sizing ──────────────────────────────────────────────────
  leverage: z
    .number()
    .positive()
    .default(20)
    .describe(
      "Leverage multiplier set on the exchange for the perpetual contract. Determines the maximum position " +
      "size relative to your margin. The actual position size is calculated from riskPercent, not from leverage " +
      "directly — leverage sets the upper cap. " +
      "Example: With $1,000 balance and 20x leverage, the max position is $20,000 notional. " +
      "However, if riskPercent=2% only risks $20, the actual position will typically be much smaller than the max. " +
      "Higher leverage allows larger positions but increases liquidation risk if the stop-loss is not hit. " +
      "Common values: 5–10x (conservative), 20x (moderate), 50x+ (aggressive — not recommended).",
    ),
  riskPercent: z
    .number()
    .min(0.1)
    .max(10)
    .default(2.0)
    .describe(
      "Percentage of your account balance to risk per trade. Risk is defined as the dollar amount lost " +
      "if the stop-loss is hit. Position size is automatically calculated: Qty = (Balance × riskPercent / 100) / (SL - Entry). " +
      "Example: With $1,000 balance, riskPercent=2%, the risk amount is $20 per trade. " +
      "If entry is $2,400 and SL is $2,460 (ATR×2 = $60 above entry), then Qty = $20 / $60 = 0.333 ETH. " +
      "Conservative: 0.5–1%. Moderate: 1–2%. Aggressive: 3–5%. " +
      "Tip: With maxDailyLossPercent=3% and riskPercent=1%, you can take 3 full losses before the daily circuit breaker triggers.",
    ),

  // ── Stop Loss & Take Profit ──────────────────────────────────────────
  atrStopMultiplier: z
    .number()
    .positive()
    .default(2.0)
    .describe(
      "Stop-loss distance above entry, expressed as a multiple of the current ATR. " +
      "SL Price = Entry Price + (ATR × atrStopMultiplier). " +
      "Higher values = wider stop (less likely to get stopped out by noise, but larger loss when hit). " +
      "Lower values = tighter stop (more stop-outs, but smaller individual losses). " +
      "Example: Entry at $2,400, ATR = $30, atrStopMultiplier = 2.0 → SL = $2,400 + $60 = $2,460. " +
      "If multiplier was 1.5 → SL = $2,445. If multiplier was 3.0 → SL = $2,490. " +
      "Common range: 1.5 (tight) to 3.0 (wide). The default 2.0 balances noise tolerance vs. loss size.",
    ),
  tp2Target: z
    .enum(["lowerBB", "atr"])
    .default("lowerBB")
    .describe(
      "Take profit target mode. Determines where the TP order is placed: " +
      "'lowerBB' — TP at the Lower Bollinger Band. This is a dynamic target that adapts to current volatility. " +
      "Best for mean-reversion trades where you expect price to return to the lower band. " +
      "Example: SMA = $2,400, Lower BB = $2,320 → TP at $2,320 (aiming for $80 profit on a short from $2,400). " +
      "'atr' — TP at a fixed ATR-based distance below entry: TP = Entry - (ATR × tp2AtrMultiplier). " +
      "Best when you want consistent risk/reward ratios regardless of band width. " +
      "Example: Entry = $2,400, ATR = $30, tp2AtrMultiplier = 3.0 → TP = $2,400 - $90 = $2,310.",
    ),
  tp2AtrMultiplier: z
    .number()
    .positive()
    .default(3.0)
    .describe(
      "ATR multiplier for take profit distance (only used when tp2Target = 'atr'). " +
      "TP Price = Entry Price - (ATR × tp2AtrMultiplier). " +
      "Combined with atrStopMultiplier, this defines your risk/reward ratio: R:R = tp2AtrMultiplier / atrStopMultiplier. " +
      "Example: atrStopMultiplier=2.0 and tp2AtrMultiplier=3.0 → R:R = 1:1.5 (risking 2 ATR to gain 3 ATR). " +
      "With ATR = $30: SL = entry + $60, TP = entry - $90. " +
      "Common setups: 2.0 (1:1 R:R), 3.0 (1:1.5 R:R), 4.0 (1:2 R:R). " +
      "Ignored when tp2Target = 'lowerBB'.",
    ),

  // ── Circuit Breakers ─────────────────────────────────────────────────
  maxDailyLossPercent: z
    .number()
    .min(0.5)
    .max(20)
    .default(3.0)
    .describe(
      "Maximum allowed cumulative daily loss (as % of balance) before the bot pauses for the rest of the day. " +
      "Resets at midnight UTC each day. Protects against runaway losses in choppy or trending-up markets. " +
      "Example: With maxDailyLossPercent=3% and a $1,000 account, the bot pauses after losing $30 total in a day. " +
      "With riskPercent=1% per trade, this allows ~3 full stop-loss hits before pausing. " +
      "Conservative: 2%. Moderate: 3–5%. Aggressive: 5–10%.",
    ),
  maxConsecutiveLosses: z
    .number()
    .min(1)
    .max(20)
    .default(3)
    .describe(
      "Maximum number of consecutive losing trades before triggering a cooldown pause. " +
      "After this many losses in a row, the bot pauses for cooldownHours before resuming. " +
      "This catches scenarios where the market regime has shifted (e.g. bear-to-bull transition) " +
      "and the strategy keeps shorting into strength. " +
      "Example: maxConsecutiveLosses=3 → after 3 back-to-back stop-loss hits, the bot pauses for 24 hours (default). " +
      "The counter resets to 0 after any winning trade or after the cooldown expires.",
    ),
  cooldownHours: z
    .number()
    .positive()
    .default(24)
    .describe(
      "Number of hours to pause trading after the consecutive loss circuit breaker triggers. " +
      "During cooldown, the bot logs a warning but takes no new trades. Existing positions are NOT closed. " +
      "After the cooldown expires, the consecutive loss counter resets and trading resumes. " +
      "Example: With maxConsecutiveLosses=3 and cooldownHours=24, after 3 losses in a row " +
      "the bot pauses for 24 hours. If the first loss was at 10:00 AM and the 3rd at 11:30 AM, " +
      "trading resumes at 11:30 AM the next day. " +
      "Shorter cooldowns (6–12h) for active scalping strategies, longer (24–48h) for conservative approaches.",
    ),
  cooldownCandles: z
    .number()
    .min(0)
    .default(5)
    .describe(
      "Minimum number of candles to wait between trades, regardless of signals. Prevents overtrading " +
      "by enforcing a gap after each trade completes (win or loss). Set to 0 to allow back-to-back trades. " +
      "Example: With cooldownCandles=5 on a 15m chart, the bot waits at least 1h15m after a trade closes " +
      "before opening a new one. On a 1h chart, that's 5 hours. " +
      "This helps avoid re-entering the same setup that just failed and gives time for new price action to develop.",
    ),
});

shortTheRip.requiredHistory = 3;

shortTheRip.timeframe = ({ timeframe }: IBotConfiguration) => timeframe;

shortTheRip.runPolicy = {
  onCandleClosed: true,
  onOrderFilled: true,
};

shortTheRip.watchers = {
  watchCandles: ({ symbol }: IBotConfiguration) => toPerpSymbol(symbol),
};

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

type ShortTheRipState = {
  phase?: "SCANNING" | "POSITION_OPEN";
  inPosition?: boolean;
  entryPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  positionQuantity?: number;
  consecutiveLosses?: number;
  dailyPnl?: number;
  dailyPnlResetTimestamp?: number;
  lastTradeTimestamp?: number;
  candlesSinceLastTrade?: number;
};

export type ShortTheRipConfig = IBotConfiguration<z.infer<typeof shortTheRip.schema>>;
