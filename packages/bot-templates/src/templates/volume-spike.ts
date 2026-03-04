import { z } from "zod";
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
  // Convert spot symbol (ETH/USDT) to linear perpetual format (ETH/USDT:USDT)
  const spotSymbol = ctx.config.symbol;
  const symbolParts = spotSymbol.split("/");
  const quotePart = symbolParts[1] || "";
  const quoteCurrency = quotePart.split(":")[0]; // handle both ETH/USDT and ETH/USDT:USDT
  const perpSymbol = spotSymbol.includes(":") ? spotSymbol : `${spotSymbol}:${quoteCurrency}`;

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

  // ── Volume spike detection ─────────────────────────────────────────────

  const volumeRatio = currentCandle.volume / previousCandle.volume;

  if (volumeRatio < params.volumeMultiplier) {
    logger.info(
      `[VolumeSpike] Volume ratio ${volumeRatio.toFixed(2)}x — below ${params.volumeMultiplier}x threshold, skipping`,
    );
    return;
  }

  logger.info(
    `[VolumeSpike] 🚨 Volume spike detected! Ratio: ${volumeRatio.toFixed(2)}x (threshold: ${params.volumeMultiplier}x)`,
  );

  // ── Determine direction ────────────────────────────────────────────────
  // Green candle (close > open) = price raised → Short
  // Red candle (close < open) = price dropped → Long

  const isGreenCandle = currentCandle.close > currentCandle.open;
  const candleMove = Math.abs(currentCandle.close - currentCandle.open);

  if (candleMove === 0) {
    logger.warn("[VolumeSpike] Doji candle (no price movement) — skipping");
    return;
  }

  // ── Minimum price move filter ──────────────────────────────────────────

  const priceMovePercent = candleMove / currentCandle.open;

  if (priceMovePercent < params.minPriceMove) {
    logger.info(
      `[VolumeSpike] Price move ${(priceMovePercent * 100).toFixed(2)}% — below ${(params.minPriceMove * 100).toFixed(2)}% threshold, skipping`,
    );
    return;
  }

  logger.info(`[VolumeSpike] Price move: ${(priceMovePercent * 100).toFixed(2)}% (threshold: ${(params.minPriceMove * 100).toFixed(2)}%)`);

  const direction: "long" | "short" = isGreenCandle ? "short" : "long";
  const entryPrice = currentCandle.close;

  logger.info(
    `[VolumeSpike] Direction: ${direction.toUpperCase()} | Entry: ${entryPrice} | Candle move: ${candleMove.toFixed(4)}`,
  );

  // ── Calculate take profit ──────────────────────────────────────────────

  let tpPrice: number;

  if (direction === "short") {
    // Short: TP when price retreats by configured % of the candle's upward move
    tpPrice = entryPrice - candleMove * params.shortTpRetreat;
  } else {
    // Long: TP when price bounces by configured % of the candle's downward move
    tpPrice = entryPrice + candleMove * params.longTpBounce;
  }

  logger.info(`[VolumeSpike] Take profit target: ${tpPrice.toFixed(4)}`);

  // ── Fetch balance & calculate position size ────────────────────────────

  const exchange: IExchange = yield useExchange();

  // Fetch futures/swap wallet balance via CCXT directly
  // Using .catch() because try-catch around yield doesn't work in generators
  const rawBalance: Record<string, any> | null = yield exchange.ccxt
    .fetchBalance({ type: "swap" })
    .catch((err: Error) => {
      logger.error(`[VolumeSpike] Failed to fetch balance: ${err.message}`);
      return null;
    });

  const walletBalance = rawBalance ? Number(rawBalance[quoteCurrency]?.free ?? 0) : 0;

  if (walletBalance <= 0) {
    logger.warn(`[VolumeSpike] No available ${quoteCurrency} balance (${walletBalance}) — skipping`);
    return;
  }

  logger.info(`[VolumeSpike] Wallet balance: ${walletBalance} ${quoteCurrency}`);

  // ── Calculate position quantity from liquidation target ─────────────────
  //
  // Cross-margin liquidation formulas:
  //   Long:  Qty = Balance / (Entry - LiqPrice × (1 - MMR))
  //   Short: Qty = Balance / (LiqPrice × (1 + MMR) - Entry)
  //
  // Also cap at max leverage allows: Qty ≤ (Balance × Leverage) / Entry

  const mmr = params.maintenanceMarginRate;
  let quantity: number;

  if (direction === "long") {
    const liqTarget = params.longLiquidationTarget;
    const denominator = entryPrice - liqTarget * (1 - mmr);

    if (denominator <= 0) {
      logger.warn(
        `[VolumeSpike] Long liquidation target ${liqTarget} is too close to or above entry ${entryPrice} — skipping`,
      );
      return;
    }

    quantity = walletBalance / denominator;
  } else {
    const liqTarget = params.shortLiquidationTarget;
    const denominator = liqTarget * (1 + mmr) - entryPrice;

    if (denominator <= 0) {
      logger.warn(
        `[VolumeSpike] Short liquidation target ${liqTarget} is too close to or below entry ${entryPrice} — skipping`,
      );
      return;
    }

    quantity = walletBalance / denominator;
  }

  // Cap quantity at what leverage allows
  const maxQty = (walletBalance * params.leverage) / entryPrice;
  if (quantity > maxQty) {
    logger.warn(
      `[VolumeSpike] Calculated qty ${quantity.toFixed(6)} exceeds leverage cap ${maxQty.toFixed(6)} — capping`,
    );
    quantity = maxQty;
  }

  if (quantity <= 0) {
    logger.warn(`[VolumeSpike] Calculated quantity is ${quantity} — skipping`);
    return;
  }

  logger.info(`[VolumeSpike] Position quantity: ${quantity.toFixed(6)} (max from leverage: ${maxQty.toFixed(6)})`);

  // ── Place the trade ────────────────────────────────────────────────────

  const entrySide = direction === "long" ? "Buy" : "Sell";
  const tpSide = direction === "long" ? "Sell" : "Buy";

  logger.info(
    `[VolumeSpike] 📈 Placing ${direction.toUpperCase()} | Entry: Market @ ~${entryPrice} | TP: ${tpPrice.toFixed(4)} | Qty: ${quantity.toFixed(6)}`,
  );

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
  state.lastEntryPrice = entryPrice;
  state.lastTpPrice = tpPrice;
  state.lastQuantity = quantity;

  logger.info(
    `[VolumeSpike] ✅ Trade placed — ${direction.toUpperCase()} ${quantity.toFixed(6)} @ market, TP @ ${tpPrice.toFixed(4)}`,
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
  watchCandles: ({ symbol }: IBotConfiguration) => symbol,
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
