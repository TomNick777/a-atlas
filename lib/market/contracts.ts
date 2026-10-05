/**
 * Market Intelligence Phase 1 contracts — the Market Data / Market State /
 * Market Query layers (docs in reports/MARKET_STATE_PHASE1/REPORT.md).
 *
 * Layer discipline ( mirrors the Company Knowledge Corpus):
 *   Market Data  — data/market/daily/*.jsonl + quote/*.json: objective vendor
 *                  rows captured by scripts/market_fetch.py, never derived.
 *   Market State — data/market/state/*.jsonl: deterministic derivation built by
 *                  scripts/build_market_state.ts (--check pins bytes, like
 *                  corpus:check). Unknown is null; nothing is ever filled in.
 *   Market Query — this module + query.ts: pure structured queries over the
 *                  state; no LLM, no live vendor calls.
 *
 * Isolation: this layer never writes to Company Facts / corpus artifacts and
 * joins company identity (name / exchange / board / industry) read-only via
 * data/companies.json on the canonical 6-digit code.
 */

/** One objective row in data/market/daily/<date>.jsonl (vendor tdx package). */
export type MarketDataRow = {
  date: string;
  code: string;
  market: "sh" | "sz" | "bj";
  name: string;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 股. */
  volume: number;
  /** 元. */
  amount: number;
};

/** Per-code snapshot row in data/market/quote/<date>.json (vendor tencent batch). */
export type MarketQuoteRow = {
  /** %, source-native. */
  turnoverPct: number | null;
  /** 亿元. */
  marketCapYi: number | null;
  floatMarketCapYi: number | null;
  limitUp: number | null;
  limitDown: number | null;
  stale: boolean;
};

export type MarketQuoteFile = {
  schemaVersion: string;
  date: string;
  source: string;
  fetchedAt: string;
  coherence: {
    checked: number;
    lastCloseMatchRate: number;
    priceMatchRate: number;
    changePctMatchRate: number;
  };
  rowCount: number;
  rows: Record<string, MarketQuoteRow>;
};

/** limitBasis — why a day's limit prices are what they are, or why they are unknown.
 * Ratios/rounding were calibrated against the captured window's own closes
 * (see reports/MARKET_STATE_PHASE1/REPORT.md §E). */
export type LimitBasis =
  | "mainboard10"
  | "s_mainboard5"
  | "chinext20"
  | "star20"
  | "bj30"
  | "mainboard_ipo_d1"
  // unknown classifications — the limit state is deliberately null, never guessed:
  | "unknown_no_prev_close"
  | "unknown_no_limit_first_days"
  | "unknown_no_limit_first_day"
  | "unknown_delisting_period"
  | "unknown_universe_boundary";

export type LimitRule =
  | { known: true; basis: LimitBasis; ratioUpPct: number; ratioDownPct: number }
  | { known: false; basis: LimitBasis };

/** One derived row in data/market/state/<date>.jsonl. Absent knowledge is
 * explicit null — 0 is never used to mean unknown. */
export type MarketStateRow = {
  code: string;
  close: number;
  volume: number;
  amount: number;
  /** %, (close/prevClose − 1)×100 on the package's own prevClose; null when prevClose unusable. */
  pctChange: number | null;
  limitBasis: LimitBasis;
  limitUpPrice: number | null;
  limitDownPrice: number | null;
  isLimitUp: boolean | null;
  isLimitDown: boolean | null;
  /** Consecutive limit-up days ending at this trading day (market trading days; 0 if not limit-up today; null when today's state is unknown). */
  limitUpStreak: number | null;
  /** % vs the close exactly 5 / 20 market trading days earlier; null when either row is missing. */
  return5d: number | null;
  return20d: number | null;
  /** Mean volume over the previous 20 *traded* rows (volume>0), null when fewer exist. */
  avgVolume20d: number | null;
  avgAmount20d: number | null;
  /** today volume / avgVolume20d; null when the base or today's volume is unusable. */
  volumeRatio20d: number | null;
  /** % from the Tencent snapshot; only captured days have it. */
  turnoverRate: number | null;
  marketCapYi: number | null;
};

export type MarketStateManifest = {
  runtime?: {
    mode: "quote";
    snapshotId: string;
    historySnapshotId: string | null;
    source: string;
    tradeDate: string;
    phase: string;
    startedAt: string;
    endedAt: string;
    sourceTimeMin: string;
    sourceTimeMax: string;
    collectionSeconds: number;
    counts: Record<string, number>;
    coverage: number;
    policy: { maxSourceAgeSeconds: number; refreshSeconds: number };
  };
  schemaVersion: string;
  builderVersion: string;
  generatedAt: string;
  latestTradingDay: string;
  tradingDays: string[];
  window: { tradingDays: number; start: string; end: string };
  inputs: {
    dailyFiles: number;
    universeSha16: string;
    universeCount: number;
    quoteFile: string | null;
    quoteCoherence: { lastCloseMatchRate: number } | null;
  };
  materializedDates: string[];
  contentDigest: { algorithm: "sha256"; scope: string; value: string };
  perDate: Record<string, { rows: number; sha16: string }>;
  audit: {
    limitBasisCounts: Record<string, number>;
    isLimitUpCount: number;
    isLimitDownCount: number;
    turnoverCoverage: number;
    /** computed limit prices vs the snapshot's own limit fields (cross-check only) */
    snapshotLimitCrossCheck: {
      checked: number;
      limitUpMatchRate: number | null;
      limitDownMatchRate: number | null;
      mismatches: { code: string; kind: "up" | "down"; computed: number; snapshot: number }[];
    };
  };
};

/** Sortable / filterable fields on a state row. */
export const MARKET_FIELDS = [
  "pctChange",
  "close",
  "volume",
  "amount",
  "turnoverRate",
  "marketCapYi",
  "isLimitUp",
  "isLimitDown",
  "limitUpStreak",
  "return5d",
  "return20d",
  "avgVolume20d",
  "avgAmount20d",
  "volumeRatio20d",
  "limitUpPrice",
  "limitDownPrice",
] as const;

export type MarketField = (typeof MARKET_FIELDS)[number];

export type MarketQuerySpec = {
  /** "LATEST_TRADING_DAY" (default) or an explicit materialized YYYY-MM-DD. */
  date?: "LATEST_TRADING_DAY" | (string & {});
  filters?: { field: MarketField; op: ">=" | ">" | "<=" | "<" | "==" | "!="; value: number | boolean }[];
  sort?: { field: MarketField; direction: "asc" | "desc" };
  limit?: number;
};

export type MarketResultRow = {
  code: string;
  name: string;
  exchange: "SH" | "SZ" | "BJ";
  board: string;
  industry: string;
  tradeDate: string;
  sortValue: number | boolean | null;
} & Pick<
  MarketStateRow,
  | "close"
  | "pctChange"
  | "volume"
  | "amount"
  | "turnoverRate"
  | "marketCapYi"
  | "isLimitUp"
  | "isLimitDown"
  | "limitUpStreak"
  | "return5d"
  | "return20d"
  | "volumeRatio20d"
>;

export type MarketQueryResult =
  | {
      available: true;
      query: MarketQuerySpec;
      date: { requested: string; resolved: string };
      latestTradingDay: string;
      total: number;
      count: number;
      rows: MarketResultRow[];
      provenance: {
        dailySource: string;
        quoteSource: string | null;
        stateDigest16: string;
        tradingDays: number;
      };
      limitations: string[];
    }
  | { available: false; reason: string };
