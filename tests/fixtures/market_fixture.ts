/**
 * Shared deterministic market fixture for Market State / Market Query tests.
 *
 * A synthetic 30-trading-day market with a weekend AND a holiday inside the
 * streak window (2026-09-02 does not trade), a ChiNext listing inside the
 * window, suspensions (volume-0 rows and fully missing rows), and every
 * limit-rule regime. All expected values in the tests are hand-computed from
 * these tables — no fixture value is derived at test time.
 */

import type { MarketDataRow, MarketQuoteFile, MarketStateManifest, MarketStateRow } from "../../lib/market/contracts";
import { buildDerivedState } from "../../lib/market/derive";

export const TRADING_DAYS = [
  "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31",
  "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07",
  "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
  "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21",
  "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28",
  "2026-08-31", "2026-09-01", /* holiday 2026-09-02 */ "2026-09-03", "2026-09-04",
  "2026-09-07",
];
export const LATEST = TRADING_DAYS[TRADING_DAYS.length - 1];

export type StockSpec = {
  code: string;
  market: MarketDataRow["market"];
  name: string;
  /** close per calendar index; missing index = row absent that day */
  closes: Record<number, number>;
  volumes?: Record<number, number>;
  prevCloses?: Record<number, number>;
  amounts?: Record<number, number>;
};

const seq = (n: number, value: number): Record<number, number> => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, value]));

function flat(code: string, market: MarketDataRow["market"], name: string, price: number): StockSpec {
  return { code, market, name, closes: seq(TRADING_DAYS.length, price) };
}

export const STOCKS: StockSpec[] = [
  // 5 consecutive limit-ups crossing the weekend and the holiday (days 25-29).
  { ...flat("600002", "sh", "乙传媒", 10), closes: { ...seq(25, 10), 25: 11, 26: 12.1, 27: 13.31, 28: 14.64, 29: 16.1 } },
  // 3 limit-ups into the latest day (27, 28, 29).
  { ...flat("600001", "sh", "甲科技", 10), closes: { ...seq(27, 10), 27: 11, 28: 12.1, 29: 13.31 } },
  // Two limit-ups then a plain +1.65% day → streak resets to 0.
  { ...flat("600003", "sh", "丙机械", 10), closes: { ...seq(27, 10), 27: 11, 28: 12.1, 29: 12.3 } },
  // ST mainboard: closes at the historical 5% price — NOT a limit-up here (10% regime).
  { ...flat("000010", "sz", "ST戊", 10), closes: { ...seq(29, 10), 29: 10.5 } },
  // BSE limit-up (floor rounding) and BSE limit-down (ceil rounding).
  { ...flat("920001", "bj", "己股份", 20), closes: { ...seq(29, 20), 29: 26 } },
  { ...flat("920002", "bj", "庚农业", 10), closes: { ...seq(29, 10.03), 29: 7.03 } },
  // ChiNext listing inside the window (listedAt 2026-08-31 = index 25): day 1 +50%, then flat.
  { code: "300001", market: "sz", name: "辛生物", closes: { 25: 30, 26: 33, 27: 33, 28: 33, 29: 33 }, prevCloses: { 25: 20 } },
  // STAR 20% limit-up on the latest day.
  { ...flat("688001", "sh", "壬芯", 50), closes: { ...seq(29, 50), 29: 60 } },
  // S-share (未股改) 5% limit-up.
  { ...flat("600182", "sh", "S癸化工", 10), closes: { ...seq(29, 10), 29: 10.5 } },
  // Delisting-period name: unknown classification even at +5%.
  { ...flat("000017", "sz", "子退", 2), closes: { ...seq(29, 2), 29: 2.1 } },
  // Limit-up, suspended (volume 0, close carried), limit-up → streak 1.
  { ...flat("000018", "sz", "丑控股", 10), closes: { ...seq(27, 10), 27: 11, 28: 11, 29: 12.1 }, volumes: { 28: 0 } },
  // Limit-up, row entirely missing, limit-up → streak 1; return5d still computable.
  // prevClose on day 29 is the carried close (11) from before the missing day.
  { ...flat("000019", "sz", "寅重工", 10), closes: { ...seq(27, 10), 27: 11, 29: 12.1 }, prevCloses: { 29: 11 } },
  // Zero-volume days inside the volume-ratio base window; flat price, surge volume on the latest day.
  {
    ...flat("000020", "sz", "卯公用", 10),
    volumes: { ...seq(TRADING_DAYS.length, 1000), 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 29: 3000 },
  },
  // Unusable prevClose on the latest day: pctChange null, limit unknown.
  { ...flat("000021", "sz", "辰数据", 5), closes: { ...seq(29, 5), 29: 5 }, prevCloses: { 29: 0 } },
  // Volume surge for the volume ranking.
  { ...flat("000022", "sz", "午电子", 7), volumes: { 29: 800_000_000 } },
];

export const QUOTE: MarketQuoteFile = {
  schemaVersion: "1.0.0",
  date: LATEST,
  source: "腾讯",
  fetchedAt: "2026-09-07T19:00:00+08:00",
  coherence: { checked: 2, lastCloseMatchRate: 1, priceMatchRate: 1, changePctMatchRate: 1 },
  rowCount: 3,
  rows: {
    "600001": { turnoverPct: 5.5, marketCapYi: 120.5, floatMarketCapYi: 100, limitUp: null, limitDown: null, stale: false },
    "600002": { turnoverPct: 2.0, marketCapYi: 88, floatMarketCapYi: 80, limitUp: null, limitDown: null, stale: false },
    "000020": { turnoverPct: null, marketCapYi: null, floatMarketCapYi: null, limitUp: null, limitDown: null, stale: false },
  },
};

function dayRowsFor(stocks: StockSpec[]): Map<string, Map<string, MarketDataRow>> {
  const dayRows = new Map<string, Map<string, MarketDataRow>>();
  for (const date of TRADING_DAYS) dayRows.set(date, new Map());
  for (const s of stocks) {
    for (const [idxStr, close] of Object.entries(s.closes)) {
      const idx = Number(idxStr);
      const prev = s.prevCloses?.[idx] ?? s.closes[idx - 1] ?? close;
      const volume = s.volumes?.[idx] ?? 1_000_000;
      dayRows.get(TRADING_DAYS[idx])!.set(s.code, {
        date: TRADING_DAYS[idx],
        code: s.code,
        market: s.market,
        name: s.name,
        prevClose: prev,
        open: prev,
        high: Math.max(prev, close),
        low: Math.min(prev, close),
        close,
        volume,
        amount: s.amounts?.[idx] ?? volume * close,
      });
    }
  }
  return dayRows;
}

export function deriveFixture(target = LATEST, stocks: StockSpec[] = STOCKS, quote: MarketQuoteFile | null = QUOTE): {
  rows: MarketStateRow[];
  jsonl: string;
  audit: ReturnType<typeof buildDerivedState>["audit"];
} {
  const result = buildDerivedState({
    tradingDays: TRADING_DAYS,
    dayRows: dayRowsFor(stocks),
    quote: quote && quote.date === target ? quote : null,
    targetDate: target,
    listedAt: new Map([["300001", "2026-08-31"]]),
  });
  return { rows: result.rows, jsonl: result.jsonl, audit: result.audit };
}

export function fixtureManifest(materialized: string[] = [LATEST]): MarketStateManifest {
  return {
    schemaVersion: "1.0.0",
    builderVersion: "market-state-builder-test",
    generatedAt: "2026-09-07T19:00:00.000Z",
    latestTradingDay: LATEST,
    tradingDays: TRADING_DAYS,
    window: { tradingDays: TRADING_DAYS.length, start: TRADING_DAYS[0], end: LATEST },
    inputs: { dailyFiles: TRADING_DAYS.length, universeSha16: "fixture", universeCount: STOCKS.length, quoteFile: "2026-09-07.json", quoteCoherence: { lastCloseMatchRate: 1 } },
    materializedDates: materialized,
    contentDigest: { algorithm: "sha256", scope: "state/2026-09-07.jsonl", value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
    perDate: {},
    audit: {
      limitBasisCounts: {},
      isLimitUpCount: 0,
      isLimitDownCount: 0,
      turnoverCoverage: 2,
      snapshotLimitCrossCheck: { checked: 0, limitUpMatchRate: null, limitDownMatchRate: null, mismatches: [] },
    },
  };
}
