/**
 * Canonical A-share stock identity for the whole product (A-Atlas §3).
 *
 * The 6-digit code is THE stable boundary between company discovery
 * (data/companies.json `code`), the company URL (`/stock/:symbol`) and the
 * Vibe research backend (`?code=`). Every mapping here is a pure function
 * with tests locked against the real 5567-company pool.
 */

export type StockExchange = "SH" | "SZ" | "BJ";
export type StockBoard = "main" | "star" | "chinext" | "bse" | "b";

export const BOARD_LABEL: Record<StockBoard, string> = {
  main: "主板",
  star: "科创板",
  chinext: "创业板",
  bse: "北交所",
  b: "B股",
};

export type StockIdentity = {
  /** Canonical 6-digit numeric code, e.g. "688017". */
  symbol: string;
  exchange: StockExchange;
  board: StockBoard;
};

/**
 * Accept "688017", " 688017.SH ", "SH688017", "sz000001", "688017.SZ" and
 * return the canonical 6-digit code. Anything else (names, tickers, short
 * codes) is null — identity is never guessed.
 */
export function normalizeSymbol(input: string): string | null {
  const raw = input.trim().toUpperCase();
  const match = /^(?:SH|SZ|BJ)?(\d{6})(?:\.(?:SH|SZ|BJ|SS|XSHE|XSHG))?$/.exec(raw);
  if (!match) return null;
  return match[1];
}

/** 6-digit code → exchange, or null for codes outside the A-share scheme. */
export function exchangeFor(symbol: string): StockExchange | null {
  if (/^(60|68|90)/.test(symbol)) return "SH";
  if (/^(00|20|30)/.test(symbol)) return "SZ";
  if (/^(43|83|87|88|92)/.test(symbol)) return "BJ";
  return null;
}

/** 6-digit code → board, or null when the exchange itself is unknown. */
export function boardFor(symbol: string): StockBoard | null {
  if (/^60/.test(symbol)) return "main";
  if (/^68/.test(symbol)) return "star";
  if (/^900/.test(symbol)) return "b";
  if (/^(000|001|002|003)/.test(symbol)) return "main";
  if (/^200/.test(symbol)) return "b";
  if (/^(300|301|302)/.test(symbol)) return "chinext";
  if (/^(43|83|87|88|92)/.test(symbol)) return "bse";
  return null;
}

/** Full identity from a user-supplied symbol string; null when invalid. */
export function stockIdentity(input: string): StockIdentity | null {
  const symbol = normalizeSymbol(input);
  if (!symbol) return null;
  const exchange = exchangeFor(symbol);
  const board = boardFor(symbol);
  if (!exchange || !board) return null;
  return { symbol, exchange, board };
}
