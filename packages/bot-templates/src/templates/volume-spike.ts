import { z } from "zod";
import Big from "big.js";
import { detectHedgeMode } from "@opentrader/exchanges";
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
import {
  telegram,
  formatTradeEntry,
  formatTakeProfit,
  formatMissedOpportunity,
  formatBotStarted,
  formatBotStopped,
} from "@opentrader/telegram";

// ════════════════════════════════════════════════════════════════════════════
// Helper utilities
// ════════════════════════════════════════════════════════════════════════════

/** Derive linear perpetual symbol: ETH/USDT → ETH/USDT:USDT */
function toPerpSymbol(symbol: string): string {
  if (symbol.includes(":")) return symbol;
  const quote = (symbol.split("/")[1] || "").split(":")[0];
  return `${symbol}:${quote}`;
}

/** Extract quote currency: ETH/USDT → USDT, ETH/USDT:USDT → USDT */
function getQuoteCurrency(symbol: string): string {
  return (symbol.split("/")[1] || "").split(":")[0];
}

function countOpenTradesByDirection(openTrades: TradeRecord[] = []) {
  return openTrades.reduce(
    (counts, trade) => {
      counts[trade.direction] += 1;
      return counts;
    },
    { long: 0, short: 0 } as Record<TradeDirection, number>,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Helper: Market-close all open positions
// ════════════════════════════════════════════════════════════════════════════

function* marketCloseAllPositions(state: VolumeSpikeState, perpSymbol: string) {
  const openTrades = state.openTrades ?? [];

  if (openTrades.length === 0) {
    logger.info("[VolumeSpike] No open positions to close");
    return;
  }

  // Separate longs and shorts, sum quantities
  let totalLongQty = new Big(0);
  let totalShortQty = new Big(0);

  for (const trade of openTrades) {
    if (trade.direction === "long") {
      totalLongQty = totalLongQty.plus(trade.quantity);
    } else {
      totalShortQty = totalShortQty.plus(trade.quantity);
    }
  }

  const exchange: IExchange = yield useExchange();

  // Close longs with a market sell
  if (totalLongQty.gt(0)) {
    logger.info(`[VolumeSpike] Market-closing ${totalLongQty.toFixed(6)} long position on ${perpSymbol}`);
    yield exchange.ccxt
      .createOrder(
        perpSymbol,
        "market",
        "sell",
        totalLongQty.toNumber(),
        undefined,
        state.isHedgeMode ? { hedged: true, reduceOnly: true } : { reduceOnly: true },
      )
      .then((order: any) => {
        logger.info(
          `[VolumeSpike] ✅ Market close (long) — Sell ${totalLongQty.toFixed(6)} @ market | orderId: ${order?.id ?? "unknown"}`,
        );
      })
      .catch((err: Error) => {
        logger.error(`[VolumeSpike] ❌ Failed to market-close longs: ${err.message}`);
      });
  }

  // Close shorts with a market buy
  if (totalShortQty.gt(0)) {
    logger.info(`[VolumeSpike] Market-closing ${totalShortQty.toFixed(6)} short position on ${perpSymbol}`);
    yield exchange.ccxt
      .createOrder(
        perpSymbol,
        "market",
        "buy",
        totalShortQty.toNumber(),
        undefined,
        state.isHedgeMode ? { hedged: true, reduceOnly: true } : { reduceOnly: true },
      )
      .then((order: any) => {
        logger.info(
          `[VolumeSpike] ✅ Market close (short) — Buy ${totalShortQty.toFixed(6)} @ market | orderId: ${order?.id ?? "unknown"}`,
        );
      })
      .catch((err: Error) => {
        logger.error(`[VolumeSpike] ❌ Failed to market-close shorts: ${err.message}`);
      });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Main Strategy
// ════════════════════════════════════════════════════════════════════════════

/**
 * Volume Spike Cross-Margin Strategy
 *
 * Detects volume spikes (configurable multiplier, default 4x) on closed candles
 * and enters mean-reversion trades:
 *   - Green candle (price raised) → Short (expect pullback)
 *   - Red candle (price dropped) → Long (expect bounce)
 *
 * Position size is calculated to target a specific cross-margin liquidation price.
 * Take profit is based on a percentage retreat/bounce of the spike candle's move.
 *
 * Features:
 *   - Volume requirement can be disabled (trades on price movement alone)
 *   - Trading range to restrict entries to a price window
 *   - Concurrent trading with configurable max simultaneous positions
 */
export function* volumeSpike(ctx: TBotContext<VolumeSpikeConfig, VolumeSpikeState>) {
  const {
    config: { settings: params },
    state,
    onStart,
    onStop,
  } = ctx;

  // ── Derive perpetual symbol ────────────────────────────────────────────
  const spotSymbol = ctx.config.symbol;
  const perpSymbol = toPerpSymbol(spotSymbol);
  const quoteCurrency = getQuoteCurrency(spotSymbol);

  // ── Bot lifecycle ──────────────────────────────────────────────────────

  if (onStart) {
    logger.info(`[VolumeSpike] Bot started on ${spotSymbol} (perp: ${perpSymbol})`);
    logger.info(ctx.config, "[VolumeSpike] Bot config");

    // Initialize state (preserve counter & trades across restarts)
    state.openTrades = state.openTrades ?? [];
    state.tradeCounter = state.tradeCounter ?? 0;

    // Set cross margin mode & leverage once on bot start
    const startExchange: IExchange = yield useExchange();

    yield startExchange.ccxt
      .setMarginMode("cross", perpSymbol)
      .then(() => logger.info(`[VolumeSpike] Margin mode set to CROSS for ${perpSymbol}`))
      .catch((err: Error) => logger.warn(`[VolumeSpike] setMarginMode: ${err.message}`));

    yield startExchange.ccxt
      .setLeverage(params.leverage, perpSymbol)
      .then(() => logger.info(`[VolumeSpike] Leverage set to ${params.leverage}x for ${perpSymbol}`))
      .catch((err: Error) => logger.warn(`[VolumeSpike] setLeverage: ${err.message}`));

    // Auto-detect hedge (dual-side) position mode (shared utility with process-level cache)
    state.isHedgeMode = yield detectHedgeMode(startExchange.ccxt, perpSymbol);
    logger.info(`[VolumeSpike] Position mode: ${state.isHedgeMode ? "hedge" : "one-way"}`);

    yield telegram.notify(formatBotStarted({ botName: "Volume Spike", symbol: perpSymbol }));
    return;
  }

  if (onStop) {
    logger.info("[VolumeSpike] Bot stopped — cancelling all trades");
    const result: CancelAllTradesResult = yield cancelAllTrades();
    logger.info(`[VolumeSpike] Cancelled ${result.cancelled}/${result.total} trades`);

    // Market-close any remaining positions
    yield* marketCloseAllPositions(state, perpSymbol);

    yield telegram.notify(formatBotStopped({ botName: "Volume Spike", symbol: perpSymbol }));
    state.openTrades = [];
    return;
  }

  // ── Handle order fill — clean up completed trades ──────────────────────

  if (ctx.event === "onOrderFilled") {
    const stillOpen: TradeRecord[] = [];

    for (const trade of state.openTrades ?? []) {
      const existingTrade: SmartTradeService | null = yield getSmartTrade(trade.ref);
      if (existingTrade && existingTrade.isCompleted()) {
        logger.info(`[VolumeSpike] ✅ Trade ${trade.ref} completed (TP filled) — ${trade.direction.toUpperCase()}`);
        yield telegram.notify(
          formatTakeProfit({
            botName: "Volume Spike",
            symbol: perpSymbol,
            direction: trade.direction === "long" ? "LONG" : "SHORT",
            entryPrice: trade.entryPrice,
            exitPrice: trade.tpPrice,
            quantity: trade.quantity,
            ref: trade.ref,
          }),
        );
      } else {
        stillOpen.push(trade);
      }
    }

    state.openTrades = stillOpen;
    return;
  }

  // ── Clean up completed trades on each candle tick ──────────────────────

  const activeOpenTrades: TradeRecord[] = [];
  for (const trade of state.openTrades ?? []) {
    const existingTrade: SmartTradeService | null = yield getSmartTrade(trade.ref);
    if (existingTrade && !existingTrade.isCompleted()) {
      activeOpenTrades.push(trade);
    } else if (existingTrade && existingTrade.isCompleted()) {
      logger.info(`[VolumeSpike] ✅ Trade ${trade.ref} completed — removing from tracker`);
    }
  }
  state.openTrades = activeOpenTrades;

  // ── Max concurrent trades check ────────────────────────────────────────

  const openCount = (state.openTrades ?? []).length;
  if (openCount >= params.maxConcurrentTrades) {
    logger.info(`[VolumeSpike] Skip | At max concurrent trades (${openCount}/${params.maxConcurrentTrades})`);
    yield telegram.notify(
      formatMissedOpportunity({
        botName: "Volume Spike",
        symbol: perpSymbol,
        reason: `Max concurrent trades reached (${openCount}/${params.maxConcurrentTrades})`,
      }),
    );
    return;
  }

  // ── Get last two closed candles ────────────────────────────────────────

  const currentCandle: ICandlestick = yield useCandle(-1);
  const previousCandle: ICandlestick = yield useCandle(-2);

  if (!currentCandle || !previousCandle) {
    logger.warn("[VolumeSpike] Not enough candle history — need at least 2 candles");
    return;
  }

  // ── Trading range check ────────────────────────────────────────────────

  const currentPrice = currentCandle.close;

  if (params.tradingRangeTop > 0 && currentPrice > params.tradingRangeTop) {
    logger.info(`[VolumeSpike] Skip | Price ${currentPrice.toFixed(2)} > tradingRangeTop ${params.tradingRangeTop}`);
    return;
  }

  if (params.tradingRangeBottom > 0 && currentPrice < params.tradingRangeBottom) {
    logger.info(
      `[VolumeSpike] Skip | Price ${currentPrice.toFixed(2)} < tradingRangeBottom ${params.tradingRangeBottom}`,
    );
    return;
  }

  // ── Condition checks ───────────────────────────────────────────────────

  const volumeRatio = new Big(currentCandle.volume).div(previousCandle.volume || 1);
  const isGreenCandle = new Big(currentCandle.close).gt(currentCandle.open);
  const candleMove = new Big(currentCandle.close).minus(currentCandle.open).abs();
  const priceMovePercent = candleMove.div(currentCandle.open);

  // Volume check (can be disabled via config)
  if (params.volumeFilterEnabled) {
    if (volumeRatio.lt(params.volumeMultiplier)) {
      logger.info(
        `[VolumeSpike] Skip | Vol: ${volumeRatio.toFixed(2)}x/${params.volumeMultiplier}x | Move: ${priceMovePercent.times(100).toFixed(2)}%/${(params.minPriceMove * 100).toFixed(2)}%`,
      );
      return;
    }
  }

  // Skip: doji candle
  if (candleMove.eq(0)) {
    logger.warn("[VolumeSpike] Skip | Doji candle (no price movement)");
    return;
  }

  // Skip: price move below threshold
  if (priceMovePercent.lt(params.minPriceMove)) {
    const volStatus = params.volumeFilterEnabled
      ? `Vol: ${volumeRatio.toFixed(2)}x/${params.volumeMultiplier}x ✓ | `
      : `Vol: disabled | `;
    logger.info(
      `[VolumeSpike] Skip | ${volStatus}Move: ${priceMovePercent.times(100).toFixed(2)}%/${(params.minPriceMove * 100).toFixed(2)}% ✗`,
    );
    return;
  }

  // ── All conditions met — calculate trade parameters ────────────────────

  const direction: TradeDirection = isGreenCandle ? "short" : "long";
  const entryPrice = new Big(currentCandle.close);
  const openTradesByDirection = countOpenTradesByDirection(state.openTrades);
  const oppositeDirection: TradeDirection = direction === "long" ? "short" : "long";
  const directionOpenCount = openTradesByDirection[direction];
  const oppositeOpenCount = openTradesByDirection[oppositeDirection];

  if (directionOpenCount >= params.maxConcurrentTrades - 1 && oppositeOpenCount === 0) {
    const reason = `${direction.toUpperCase()} signal blocked to reserve 1 slot for ${oppositeDirection.toUpperCase()} trades`;
    const details =
      `Open trades: ${openTradesByDirection.long} long, ${openTradesByDirection.short} short ` +
      `(max ${params.maxConcurrentTrades})`;

    logger.info(`[VolumeSpike] Skip | ${reason} | ${details}`);
    yield telegram.notify(
      formatMissedOpportunity({
        botName: "Volume Spike",
        symbol: perpSymbol,
        reason,
        details: `Signal: ${direction.toUpperCase()} @ ${entryPrice.toFixed(2)} | ${details}`,
      }),
    );
    return;
  }

  // Calculate take profit
  const tpPriceBig =
    direction === "short"
      ? entryPrice.minus(candleMove.times(params.shortTpRetreat))
      : entryPrice.plus(candleMove.times(params.longTpBounce));

  // Fetch balance
  const exchange: IExchange = yield useExchange();
  const rawBalance: Record<string, any> | null = yield exchange.ccxt
    .fetchBalance({ type: "swap" })
    .catch((err: Error) => {
      logger.error(`[VolumeSpike] Failed to fetch balance: ${err.message}`);
      return null;
    });

  const walletBalance = new Big(rawBalance ? Number(rawBalance[quoteCurrency]?.free ?? 0) : 0);

  if (walletBalance.lte(0)) {
    logger.warn(`[VolumeSpike] Skip | No ${quoteCurrency} balance (${walletBalance.toFixed(2)})`);
    yield telegram.notify(
      formatMissedOpportunity({
        botName: "Volume Spike",
        symbol: perpSymbol,
        reason: `Insufficient ${quoteCurrency} balance`,
        details: `Signal: ${direction.toUpperCase()} @ ${entryPrice.toFixed(2)} — but balance is ${walletBalance.toFixed(2)}`,
      }),
    );
    return;
  }

  // Each trade gets an equal share of the balance so that if all slots fill,
  // the aggregate position equals what a single-trade strategy would open.
  const effectiveBalance = walletBalance.div(params.maxConcurrentTrades);

  // Calculate position quantity from liquidation target
  // Cross-margin: Long Qty = Bal / (Entry - Liq×(1-MMR)), Short Qty = Bal / (Liq×(1+MMR) - Entry)
  const mmr = new Big(params.maintenanceMarginRate);
  const liqTarget = new Big(direction === "long" ? params.longLiquidationTarget : params.shortLiquidationTarget);
  let quantityBig: Big;

  if (direction === "long") {
    const denominator = entryPrice.minus(liqTarget.times(new Big(1).minus(mmr)));
    if (denominator.lte(0)) {
      logger.warn(
        `[VolumeSpike] Skip | Liq target ${liqTarget.toFixed(2)} too close to entry ${entryPrice.toFixed(2)}`,
      );
      return;
    }
    quantityBig = effectiveBalance.div(denominator);
  } else {
    const denominator = liqTarget.times(new Big(1).plus(mmr)).minus(entryPrice);
    if (denominator.lte(0)) {
      logger.warn(
        `[VolumeSpike] Skip | Liq target ${liqTarget.toFixed(2)} too close to entry ${entryPrice.toFixed(2)}`,
      );
      return;
    }
    quantityBig = effectiveBalance.div(denominator);
  }

  // Cap at leverage limit (per-trade share)
  const maxQty = effectiveBalance.times(params.leverage).div(entryPrice);
  if (quantityBig.gt(maxQty)) quantityBig = maxQty;

  if (quantityBig.lte(0)) {
    logger.warn(`[VolumeSpike] Skip | Calculated quantity is ${quantityBig.toFixed(6)}`);
    return;
  }

  // Round quantity and TP price to exchange precision
  let quantity = parseFloat(exchange.ccxt.amountToPrecision(perpSymbol, quantityBig.toNumber()));
  let tpPrice = parseFloat(exchange.ccxt.priceToPrecision(perpSymbol, tpPriceBig.toNumber()));

  if (quantity <= 0) {
    logger.warn("[VolumeSpike] Skip | Quantity rounds to 0 after precision adjustment");
    return;
  }

  // ── Place the trade ────────────────────────────────────────────────────

  const tradeRef = `t_${state.tradeCounter ?? 0}`;
  state.tradeCounter = (state.tradeCounter ?? 0) + 1;

  const volStatus = params.volumeFilterEnabled
    ? `Vol: ${volumeRatio.toFixed(2)}x/${params.volumeMultiplier}x ✓`
    : `Vol: disabled`;

  logger.info(
    `[VolumeSpike] 🚨 ${direction.toUpperCase()} ${tradeRef} | ${volStatus} | Move: ${priceMovePercent.times(100).toFixed(2)}%/${(params.minPriceMove * 100).toFixed(2)}% ✓ | ` +
      `Entry: ${entryPrice.toFixed(2)} | TP: ${tpPriceBig.toFixed(2)} | Liq: ${liqTarget.toFixed(2)} | ` +
      `Qty: ${quantityBig.toFixed(6)} | Bal: ${walletBalance.toFixed(2)} (eff: ${effectiveBalance.toFixed(2)}) ${quoteCurrency} | ` +
      `Slot: ${openCount + 1}/${params.maxConcurrentTrades}`,
  );

  const entrySide = direction === "long" ? "Buy" : "Sell";
  const tpSide = direction === "long" ? "Sell" : "Buy";

  const trade: SmartTradeService = yield useSmartTrade(
    {
      entry: {
        type: "Market",
        side: entrySide,
        symbol: perpSymbol,
      },
      tp: {
        type: "Limit",
        side: tpSide,
        price: tpPrice,
        symbol: perpSymbol,
      },
      quantity,
    },
    tradeRef,
  );

  // Track the trade
  if (!state.openTrades) state.openTrades = [];
  state.openTrades.push({
    ref: tradeRef,
    direction,
    quantity,
    entryPrice: entryPrice.toNumber(),
    tpPrice,
  });

  logger.info(
    `[VolumeSpike] ✅ Trade ${tradeRef} placed — ${direction.toUpperCase()} ${quantity.toFixed(6)} @ market, TP @ ${tpPrice.toFixed(4)} | ` +
      `Total open trades: ${state.openTrades.length}`,
  );

  yield telegram.notify(
    formatTradeEntry({
      botName: "Volume Spike",
      symbol: perpSymbol,
      direction: direction === "long" ? "LONG" : "SHORT",
      entryPrice: entryPrice.toNumber(),
      tpPrice,
      quantity,
      ref: tradeRef,
      extraInfo: `Slot: ${state.openTrades.length}/${params.maxConcurrentTrades} | Bal: ${walletBalance.toFixed(2)} ${quoteCurrency}`,
    }),
  );
}

// ── Strategy metadata ──────────────────────────────────────────────────────

volumeSpike.displayName = "Volume Spike (Cross Margin)";
volumeSpike.description =
  "Detects volume spikes on closed candles and enters mean-reversion trades with cross-margin position sizing. " +
  "Green candles (price raise) trigger shorts; red candles (price drop) trigger longs. " +
  "Position size is calculated to target a specific liquidation price. " +
  "Supports disabling volume requirement, trading within a price range, and concurrent positions.";

volumeSpike.schema = z.object({
  // ── Volume Filter ────────────────────────────────────────────────────
  volumeFilterEnabled: z
    .boolean()
    .default(true)
    .describe(
      "Enable or disable the volume spike requirement. When true (default), entries require the current candle's " +
        "volume to be at least volumeMultiplier× the previous candle's volume. When false, the strategy trades " +
        "based on price movement (minPriceMove) alone — useful in low-liquidity markets or when you want to " +
        "capture all significant price moves regardless of volume.",
    ),
  volumeMultiplier: z
    .number()
    .positive()
    .default(4)
    .describe(
      "Minimum volume ratio (current / previous candle) to trigger an entry. Only used when volumeFilterEnabled is true. " +
        "Example: 4 means the current candle must have 4× the volume of the previous candle.",
    ),
  minPriceMove: z
    .number()
    .min(0)
    .max(1)
    .default(0.02)
    .describe(
      "Minimum candle price move as fraction (0.02 = 2%) to trigger an entry. " +
        "Always active regardless of volumeFilterEnabled. Filters out small candles that aren't worth trading.",
    ),

  // ── Trading Range ────────────────────────────────────────────────────
  tradingRangeTop: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Upper price boundary — skip entries when the candle close is above this price. " +
        "Set to 0 (default) to disable the upper limit. " +
        "Example: Set to 2500 to only trade when ETH is below $2,500.",
    ),
  tradingRangeBottom: z
    .number()
    .min(0)
    .default(0)
    .describe(
      "Lower price boundary — skip entries when the candle close is below this price. " +
        "Set to 0 (default) to disable the lower limit. " +
        "Example: Set to 2000 to only trade when ETH is above $2,000. " +
        "Combined with tradingRangeTop, defines a price corridor for trading.",
    ),

  // ── Concurrency ──────────────────────────────────────────────────────
  maxConcurrentTrades: z
    .number()
    .min(2)
    .default(2)
    .describe(
      "Maximum number of simultaneous open positions. Balance is divided equally across all slots. " +
        "This strategy always reserves 1 slot for the opposite direction, so maxConcurrentTrades must be at least 2. " +
        "Example: With 3 concurrent trades and $1,000 balance, each trade uses ~$333 for position sizing. " +
        "Higher values allow capturing multiple signals but reduce per-trade size.",
    ),

  // ── Position Sizing ──────────────────────────────────────────────────
  leverage: z.number().positive().default(20).describe("Fixed leverage to set on the exchange"),
  shortTpRetreat: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Short TP: fraction of candle move to retreat (0.5 = 50%)"),
  longTpBounce: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe("Long TP: fraction of candle drop to bounce (0.3 = 30%)"),
  shortLiquidationTarget: z.number().positive().default(3042).describe("Target liquidation price for short positions"),
  longLiquidationTarget: z.number().positive().default(1200).describe("Target liquidation price for long positions"),
  maintenanceMarginRate: z
    .number()
    .min(0)
    .max(1)
    .default(0.005)
    .describe("Maintenance margin rate (e.g., 0.005 = 0.5%)"),
});

volumeSpike.requiredHistory = 3;
volumeSpike.timeframe = ({ timeframe }: IBotConfiguration) => timeframe;
volumeSpike.runPolicy = {
  onCandleClosed: true,
  onOrderFilled: true,
};
volumeSpike.watchers = {
  watchCandles: ({ symbol }: IBotConfiguration) => toPerpSymbol(symbol),
};

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

type TradeRecord = {
  ref: string;
  direction: TradeDirection;
  quantity: number;
  entryPrice: number;
  tpPrice: number;
};

type TradeDirection = "long" | "short";

type VolumeSpikeState = {
  openTrades?: TradeRecord[];
  tradeCounter?: number;
  isHedgeMode?: boolean;
};

export type VolumeSpikeConfig = IBotConfiguration<z.infer<typeof volumeSpike.schema>>;
