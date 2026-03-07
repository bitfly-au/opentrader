import type { OrderSide } from "./common/enums.js";

export interface IPlaceLimitOrderRequest {
  /**
   * Instrument ID, e.g `ADA-USDT`.
   */
  symbol: string;
  /**
   * Client-supplied order ID
   */
  clientOrderId?: string;
  side: OrderSide;
  /**
   * Quantity to buy or sell.
   */
  quantity: number;
  /**
   * Order price.
   */
  price: number;
  /**
   * Extra exchange-specific parameters passed to CCXT's createLimitOrder().
   * For example, `{ hedged: true }` for hedge/dual-side position mode,
   * or `{ reduceOnly: true }` for closing positions.
   * @see https://docs.ccxt.com/#/?id=hedged-mode
   */
  params?: Record<string, unknown>;
}

export interface IPlaceLimitOrderResponse {
  /**
   * Order ID.
   */
  orderId: string;
  /**
   * Client-supplied order ID
   */
  clientOrderId?: string;
}
