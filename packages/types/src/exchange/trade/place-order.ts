import { XOrderType } from "../../common/index.js";
import type { OrderSide } from "./common/enums.js";

export interface IPlaceOrderRequest {
  /**
   * Order type: Limit | Market
   */
  type: XOrderType;
  /**
   * Instrument ID, e.g `BTC/USDT`.
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
   * Some exchanges require price for Market orders to calculate the total cost of the order in the quote currency.
   * @see https://docs.ccxt.com/#/?id=market-buys
   */
  price?: number;
  /**
   * Extra exchange-specific parameters passed to CCXT's createOrder().
   * For example, `{ hedged: true }` for hedge/dual-side position mode,
   * or `{ reduceOnly: true }` for closing positions.
   * @see https://docs.ccxt.com/#/?id=hedged-mode
   */
  params?: Record<string, unknown>;
}

export interface IPlaceOrderResponse {
  /**
   * Order ID.
   */
  orderId: string;
  /**
   * Client-supplied order ID
   */
  clientOrderId?: string;
}
