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
    .describe("EMA period for trend determination. Price must be below this EMA to short."),
  macroTimeframe: z
    .enum(["5m", "15m", "1h", "4h", "1d", "1w"])
    .default("4h")
    .describe("Higher timeframe for macro trend confirmation. Must be larger than the bot's execution timeframe."),

  // ── Scoring System ───────────────────────────────────────────────────
  entryScoreThreshold: z
    .number()
    .min(0)
    .max(100)
    .default(70)
    .describe("Minimum bearish score (0-100) to enter a short. Lower = more trades, higher = more selective."),
  scoreTrendFilter: z
    .number()
    .min(0)
    .max(100)
    .default(40)
    .describe("Points awarded when price is below EMA on both timeframes."),
  scoreDivergence: z
    .number()
    .min(0)
    .max(100)
    .default(30)
    .describe("Points awarded when bearish RSI divergence is detected."),
  scoreBBTouch: z
    .number()
    .min(0)
    .max(100)
    .default(20)
    .describe("Points awarded when price touches or exceeds the Upper Bollinger Band."),
  scoreRejectionCandle: z
    .number()
    .min(0)
    .max(100)
    .default(10)
    .describe("Points for rejection candle (close < prev low). Half points for a simple red candle."),

  // ── Indicators ───────────────────────────────────────────────────────
  rsiPeriod: z
    .number()
    .min(2)
    .default(14)
    .describe("RSI calculation period."),
  bbPeriod: z
    .number()
    .min(2)
    .default(20)
    .describe("Bollinger Band period (middle band = SMA of this length)."),
  bbStdDev: z
    .number()
    .positive()
    .default(2.0)
    .describe("Bollinger Band standard deviation multiplier."),
  atrPeriod: z
    .number()
    .min(2)
    .default(14)
    .describe("ATR period for volatility-adjusted stops and targets."),
  pivotStrength: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe("Bars on each side to confirm a swing high. Higher = fewer but more reliable pivots."),
  pivotLookback: z
    .number()
    .min(10)
    .max(100)
    .default(30)
    .describe("Maximum bars to look back for previous pivot high when checking divergence."),

  // ── Volume Filter ────────────────────────────────────────────────────
  volumeFilterEnabled: z
    .boolean()
    .default(true)
    .describe("Enable volume surge filter. Aborts entry if bounce has too much buying momentum."),
  volumeShortPeriod: z
    .number()
    .min(2)
    .default(5)
    .describe("Short-term volume SMA period (recent bounce volume)."),
  volumeLongPeriod: z
    .number()
    .min(5)
    .default(20)
    .describe("Long-term volume SMA period (baseline volume)."),
  volumeAbortRatio: z
    .number()
    .positive()
    .default(1.5)
    .describe("Abort trade if short/long volume ratio exceeds this. Higher = more permissive."),

  // ── Position Sizing ──────────────────────────────────────────────────
  leverage: z
    .number()
    .positive()
    .default(20)
    .describe("Leverage to set on the exchange."),
  riskPercent: z
    .number()
    .min(0.1)
    .max(10)
    .default(2.0)
    .describe("Percentage of account balance to risk per trade."),

  // ── Stop Loss & Take Profit ──────────────────────────────────────────
  atrStopMultiplier: z
    .number()
    .positive()
    .default(2.0)
    .describe("Stop-loss distance = ATR × this multiplier above entry."),
  tp2Target: z
    .enum(["lowerBB", "atr"])
    .default("lowerBB")
    .describe("Take profit target: 'lowerBB' (Lower Bollinger Band) or 'atr' (ATR-based distance)."),
  tp2AtrMultiplier: z
    .number()
    .positive()
    .default(3.0)
    .describe("If tp2Target is 'atr', TP distance = ATR × this multiplier below entry."),

  // ── Circuit Breakers ─────────────────────────────────────────────────
  maxDailyLossPercent: z
    .number()
    .min(0.5)
    .max(20)
    .default(3.0)
    .describe("Pause bot if daily P&L loss exceeds this percentage."),
  maxConsecutiveLosses: z
    .number()
    .min(1)
    .max(20)
    .default(3)
    .describe("Pause bot after this many consecutive losing trades."),
  cooldownHours: z
    .number()
    .positive()
    .default(24)
    .describe("Hours to pause after a circuit breaker triggers."),
  cooldownCandles: z
    .number()
    .min(0)
    .default(5)
    .describe("Minimum candles to wait between trades (anti-overtrade)."),
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
