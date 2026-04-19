export function toPerpSymbol(symbol: string): string {
  if (symbol.includes(":")) return symbol;
  const quote = (symbol.split("/")[1] || "").split(":")[0];
  return `${symbol}:${quote}`;
}

export function getQuoteCurrency(symbol: string): string {
  return (symbol.split("/")[1] || "").split(":")[0];
}
