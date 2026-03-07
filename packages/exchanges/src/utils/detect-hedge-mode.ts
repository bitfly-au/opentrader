import type { Exchange } from "ccxt";

/**
 * Process-level cache for hedge mode detection.
 * Key: "exchangeId:symbol" → boolean
 *
 * Shared between TradeExecutor and strategy templates so only one API call
 * is made per exchange+symbol combination for the lifetime of the process.
 */
const hedgeModeCache = new Map<string, boolean>();

/**
 * Detect whether the exchange account is in hedge (dual-side) position mode
 * for the given perpetual symbol.
 *
 * Uses `fetchPositionMode` (Binance, OKX) when available, falling back to
 * `fetchPositions` (Bybit, others) to read the `hedged` field.
 *
 * Results are cached per `exchange.id + symbol` for the process lifetime.
 *
 * @returns `true` if the account is in hedge mode, `false` for one-way or spot symbols.
 */
export async function detectHedgeMode(ccxt: Exchange, symbol: string): Promise<boolean> {
  // Spot symbols never have position mode
  if (!symbol.includes(":")) return false;

  const cacheKey = `${ccxt.id}:${symbol}`;
  const cached = hedgeModeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    // Method 1: fetchPositionMode (Binance, OKX)
    if (ccxt.has["fetchPositionMode"]) {
      const mode = (await ccxt.fetchPositionMode(symbol)) as { hedged?: boolean };
      const hedged = mode?.hedged === true;
      hedgeModeCache.set(cacheKey, hedged);
      return hedged;
    }

    // Method 2: fetchPositions — check hedged field (Bybit, others)
    const positions = await ccxt.fetchPositions([symbol]);
    if (positions.length > 0) {
      const hedged = positions[0].hedged === true;
      hedgeModeCache.set(cacheKey, hedged);
      return hedged;
    }
  } catch {
    // Detection failed — default to one-way (safe: no extra params sent)
  }

  hedgeModeCache.set(cacheKey, false);
  return false;
}

/**
 * Clear the hedge mode cache. Useful for testing or when the user changes
 * their exchange position mode at runtime.
 */
export function clearHedgeModeCache(): void {
  hedgeModeCache.clear();
}
