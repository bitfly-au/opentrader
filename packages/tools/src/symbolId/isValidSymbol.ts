import { CURRENCY_PAIR_DELIMITER, EXCHANGE_CODE_DELIMITER } from "./constants.js";

export function isValidSymbol(symbol: string) {
  // Matches spot (ETH/USDT) and perpetual/futures (ETH/USDT:USDT) formats
  const symbolPattern = `^[A-Z0-9]+${CURRENCY_PAIR_DELIMITER}[A-Z0-9]+(${EXCHANGE_CODE_DELIMITER}[A-Z0-9]+)?$`;

  return new RegExp(symbolPattern).test(symbol);
}
