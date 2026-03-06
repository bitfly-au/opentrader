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
  IBotConfiguration,
  TBotContext,
  type SmartTradeService,
} from "@opentrader/bot-processor";
import { logger } from "@opentrader/logger";

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

    return;
  }

  if (onStop) {
    logger.info("[VolumeSpike] Bot stopped — cancelling open trades");
    yield cancelSmartTrade();
    state.inPosition = false;
    return;
  }

  // ── Handle order fill — reset state only, no trading logic ─────────────

  if (ctx.event === "onOrderFilled") {
    if (state.inPosition) {
      const existingTrade: SmartTradeService | null = yield getSmartTrade();
      if (existingTrade && existingTrade.isCompleted()) {
        logger.info("[VolumeSpike] Trade completed (order filled) — resetting state");
        state.inPosition = false;
      }
    }
    return;
  }

  // ── Skip if already in a position ──────────────────────────────────────

  if (state.inPosition) {
    const existingTrade: SmartTradeService | null = yield getSmartTrade();
    if (existingTrade && !existingTrade.isCompleted()) {
      logger.info("[VolumeSpike] Already in a position — skipping");
      return;
    }

    // Trade completed — reset state
    logger.info("[VolumeSpike] Previous trade completed — ready for new signals");
    state.inPosition = false;
  }

  // ── Get last two closed candles ────────────────────────────────────────

  const currentCandle: ICandlestick = yield useCandle(-1);
  const previousCandle: ICandlestick = yield useCandle(-2);

  if (!currentCandle || !previousCandle) {
    logger.warn("[VolumeSpike] Not enough candle history — need at least 2 candles");
    return;
  }

  // ── Condition checks ───────────────────────────────────────────────────

  const volumeRatio = new Big(currentCandle.volume).div(previousCandle.volume);
  const isGreenCandle = new Big(currentCandle.close).gt(currentCandle.open);
  const candleMove = new Big(currentCandle.close).minus(currentCandle.open).abs();
  const priceMovePercent = candleMove.div(currentCandle.open);

  // Skip: volume below threshold
  if (volumeRatio.lt(params.volumeMultiplier)) {
    logger.info(
      `[VolumeSpike] Skip | Vol: ${volumeRatio.toFixed(2)}x/${params.volumeMultiplier}x | Move: ${priceMovePercent.times(100).toFixed(2)}%/${(params.minPriceMove * 100).toFixed(2)}%`,
    );
    return;
  }

  // Skip: doji candle
  if (candleMove.eq(0)) {
    logger.warn("[VolumeSpike] Skip | Doji candle (no price movement)");
    return;
  }

  // Skip: price move below threshold
  if (priceMovePercent.lt(params.minPriceMove)) {
    logger.info(
      `[VolumeSpike] Skip | Vol: ${volumeRatio.toFixed(2)}x/${params.volumeMultiplier}x ✓ | Move: ${priceMovePercent.times(100).toFixed(2)}%/${(params.minPriceMove * 100).toFixed(2)}% ✗`,
    );
    return;
  }

  // ── All conditions met — calculate trade parameters ────────────────────

  const direction: "long" | "short" = isGreenCandle ? "short" : "long";
  const entryPrice = new Big(currentCandle.close);

  // Calculate take profit
  const tpPriceBig = direction === "short"
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
    return;
  }

  // Calculate position quantity from liquidation target
  // Cross-margin: Long Qty = Bal / (Entry - Liq×(1-MMR)), Short Qty = Bal / (Liq×(1+MMR) - Entry)
  const mmr = new Big(params.maintenanceMarginRate);
  const liqTarget = new Big(direction === "long" ? params.longLiquidationTarget : params.shortLiquidationTarget);
  let quantityBig: Big;

  if (direction === "long") {
    const denominator = entryPrice.minus(liqTarget.times(new Big(1).minus(mmr)));
    if (denominator.lte(0)) {
      logger.warn(`[VolumeSpike] Skip | Liq target ${liqTarget.toFixed(2)} too close to entry ${entryPrice.toFixed(2)}`);
      return;
    }
    quantityBig = walletBalance.div(denominator);
  } else {
    const denominator = liqTarget.times(new Big(1).plus(mmr)).minus(entryPrice);
    if (denominator.lte(0)) {
      logger.warn(`[VolumeSpike] Skip | Liq target ${liqTarget.toFixed(2)} too close to entry ${entryPrice.toFixed(2)}`);
      return;
    }
    quantityBig = walletBalance.div(denominator);
  }

  // Cap at leverage limit
  const maxQty = walletBalance.times(params.leverage).div(entryPrice);
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

  // ── Single consolidated signal log ─────────────────────────────────────

  logger.info(
    `[VolumeSpike] 🚨 ${direction.toUpperCase()} | Vol: ${volumeRatio.toFixed(2)}x/${params.volumeMultiplier}x ✓ | Move: ${priceMovePercent.times(100).toFixed(2)}%/${(params.minPriceMove * 100).toFixed(2)}% ✓ | Entry: ${entryPrice.toFixed(2)} | TP: ${tpPriceBig.toFixed(2)} | Liq: ${liqTarget.toFixed(2)} | Qty: ${quantityBig.toFixed(6)} | Bal: ${walletBalance.toFixed(2)} ${quoteCurrency}`,
  );

  // ── Place the trade ────────────────────────────────────────────────────

  const entrySide = direction === "long" ? "Buy" : "Sell";
  const tpSide = direction === "long" ? "Sell" : "Buy";

  const trade: SmartTradeService = yield useSmartTrade({
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
  });

  state.inPosition = true;
  state.lastDirection = direction;
  state.lastEntryPrice = entryPrice.toNumber();
  state.lastTpPrice = tpPrice;
  state.lastQuantity = quantity;

  logger.info(
    `[VolumeSpike] ✅ Trade placed — ${direction.toUpperCase()} ${quantity.toFixed(6)} @ market, TP @ ${tpPriceBig.toFixed(4)}`,
  );
}

// ── Strategy metadata ──────────────────────────────────────────────────────

volumeSpike.displayName = "Volume Spike (Cross Margin)";
volumeSpike.description =
  "Detects volume spikes on closed candles and enters mean-reversion trades with cross-margin position sizing. " +
  "Green candles (price raise) trigger shorts; red candles (price drop) trigger longs. " +
  "Position size is calculated to target a specific liquidation price.";

volumeSpike.schema = z.object({
  volumeMultiplier: z
    .number()
    .positive()
    .default(4)
    .describe("Minimum volume ratio (current / previous) to trigger an entry"),
  minPriceMove: z
    .number()
    .min(0)
    .max(1)
    .default(0.02)
    .describe("Minimum candle price move as fraction (0.02 = 2%) to trigger an entry"),
  leverage: z
    .number()
    .positive()
    .default(20)
    .describe("Fixed leverage to set on the exchange"),
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
  shortLiquidationTarget: z
    .number()
    .positive()
    .default(3042)
    .describe("Target liquidation price for short positions"),
  longLiquidationTarget: z
    .number()
    .positive()
    .default(1200)
    .describe("Target liquidation price for long positions"),
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

// ── Types ──────────────────────────────────────────────────────────────────

type VolumeSpikeState = {
  inPosition?: boolean;
  lastDirection?: "long" | "short";
  lastEntryPrice?: number;
  lastTpPrice?: number;
  lastQuantity?: number;
};

export type VolumeSpikeConfig = IBotConfiguration<z.infer<typeof volumeSpike.schema>>;
