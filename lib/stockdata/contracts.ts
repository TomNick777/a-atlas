/**
 * Stock data contracts (refocus §二十三/§二十四).
 *
 * The A-Atlas UI never understands Tencent/Eastmoney/Sina/CNINFO field shapes —
 * the Python data service (services/stock-data, a-atlas-data on :8920) translates
 * vendor payloads into these shapes, and this module is the single wire contract
 * the web app compiles against.
 *
 * Error semantics is the point: 没有数据 ≠ 数据源坏了. Every block carries
 * `available` plus provenance (`source` / `fetchedAt`), and the company page must
 * render EMPTY / UNAVAILABLE / ERROR differently:
 *   ok           — data present (fields may still be individually null)
 *   empty        — source answered fine, this company genuinely has none
 *                  (e.g. no research coverage) →「暂无数据」
 *   unavailable  — source declares it does not cover this instrument at all
 *                  (e.g. 东财研报库不索引北交所老号段) →「该数据源不覆盖」
 *   error        — timeout / HTTP failure / structure change →「数据源暂时不可用」
 * A renderer that shows "该公司没有公告" for an `error` is a bug, not a style.
 */

/** Canonical identity on the wire is always the 6-digit code (StockIdentity). */
export type DataAvailability = "ok" | "empty" | "unavailable" | "error";

export type DataProvenance = {
  /** Canonical 6-digit code as requested. */
  symbol: string;
  /** Human-readable source name, e.g. 腾讯 / 新浪财经 / 巨潮资讯 / 东方财富. */
  source: string;
  /** When we fetched it (ISO). */
  fetchedAt: string;
  /** The data's own timestamp when the source declares one (e.g. quote time), else null. */
  asOf?: string | null;
};

type BlockBase = DataProvenance & {
  available: DataAvailability;
  /** Error detail when available === "error" (never shown raw to users). */
  error?: string | null;
};

/** 市场快照（refocus §十八.1）：最新价/涨跌幅/PE/PB/总市值/换手率。 */
export type StockQuote = BlockBase & {
  name?: string;
  /** 元。 */
  price?: number;
  /** 昨收，用于涨跌着色。 */
  lastClose?: number;
  /** 百分比，如 1.25 表示 +1.25%。 */
  changePct?: number;
  peTtm?: number | null;
  pb?: number | null;
  /** 亿元。 */
  marketCapYi?: number | null;
  /** 百分比。 */
  turnoverPct?: number | null;
  /** 上游僵尸报价检测（停牌/迁移老码）：HTTP 200 但不是当日真实成交。 */
  stale?: boolean;
  staleReason?: string | null;
};

/**
 * 基础财务（refocus §十八.2）：只取少量基础财务，以新浪三表实际稳定提供的
 * 科目为准，数值保持上游原始字符串（不伪造精度）。毛利率/ROE 是从披露科目
 * 计算的派生值，缺科目时如实 null，绝不补造。
 */
export type StockFundamentals = BlockBase & {
  /** 报告期，如 "2026-06-30"。 */
  reportPeriod?: string;
  /** 营业收入（上游原始字符串）。 */
  revenue?: string | null;
  revenueYoY?: string | null;
  /** 净利润（上游原始字符串）。 */
  netProfit?: string | null;
  netProfitYoY?: string | null;
  /** 基本每股收益（上游原始字符串，如 "33.19"）。 */
  eps?: string | null;
  /** 毛利率 %（(营收-营业成本)/营收，从利润表计算）。 */
  grossMarginPct?: number | null;
  /** ROE %（净利润/股东权益，利润表+资产负债表计算）。 */
  roePct?: number | null;
};

/** 最近公告索引（refocus §十八.3）。 */
export type StockAnnouncement = {
  title: string;
  date: string;
  type: string;
  url: string;
};

export type StockAnnouncements = BlockBase & {
  items: StockAnnouncement[];
};

/** 最近研报索引（refocus §十八.4）。 */
export type StockResearchReport = {
  title: string;
  institution: string;
  analyst?: string | null;
  date: string;
  rating?: string | null;
  url: string;
};

export type StockResearchReports = BlockBase & {
  items: StockResearchReport[];
};
