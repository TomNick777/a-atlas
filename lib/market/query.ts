/**
 * Market Query — pure structured queries over the materialized Market State.
 *
 * Phase 1 is deliberately LLM-free: the caller (CLI, API route, tests, and in
 * later phases a language layer) states WHAT it wants — a date, filters, a
 * sort, a limit — and this module answers from committed, byte-pinned state.
 *
 * Semantics:
 *   - Production "today…" requires the verified exchange target date and EOD
 *     availability. An older captured file cannot stand in for missing today.
 *     Injected artifacts explicitly replay historical dates without a clock gate.
 *   - Sorting carries the real value on every row (sortValue) so a UI can
 *     display it; ties break by canonical code ascending → deterministic.
 *   - null (unknown / not covered) never masquerades as 0: nulls sort last in
 *     both directions and every comparison filter excludes them.
 */

import { MARKET_FIELDS } from "./contracts";
import type {
  MarketField,
  MarketQueryResult,
  MarketQuerySpec,
  MarketResultRow,
  MarketStateManifest,
  MarketStateRow,
} from "./contracts";
import { loadMarketStateManifest, loadMarketStateRows, loadMarketUniverse } from "./state";
import { marketAvailability } from "./session";

export const MARKET_DAILY_SOURCE = "通达信官网每日盘后包（vendor tdx_daily_package）";
export const MARKET_QUOTE_SOURCE = "腾讯财经批量行情快照（vendor tencent_quote，仅最新捕获交易日）";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Task-sheet snake_case field names are accepted wherever a field appears. */
const FIELD_ALIASES: Record<string, MarketField> = {
  pct_change: "pctChange",
  turnover_rate: "turnoverRate",
  market_cap: "marketCapYi",
  limit_up_streak: "limitUpStreak",
  return_5d: "return5d",
  return_20d: "return20d",
  volume_ratio_20d: "volumeRatio20d",
  avg_volume_20d: "avgVolume20d",
  avg_amount_20d: "avgAmount20d",
  is_limit_up: "isLimitUp",
  is_limit_down: "isLimitDown",
  limit_up_price: "limitUpPrice",
  limit_down_price: "limitDownPrice",
};

function normalizeField(field: string): MarketField | null {
  if ((MARKET_FIELDS as readonly string[]).includes(field)) return field as MarketField;
  return FIELD_ALIASES[field] ?? null;
}

export function parseMarketQuerySpec(raw: unknown): { spec: MarketQuerySpec } | { error: string } {
  if (raw === undefined || raw === null) return { spec: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "query spec 必须是 JSON 对象。" };
  const obj = raw as Record<string, unknown>;
  const spec: MarketQuerySpec = {};
  if (obj.date !== undefined) {
    if (typeof obj.date !== "string" || !/^(LATEST_TRADING_DAY|\d{4}-\d{2}-\d{2})$/.test(obj.date)) {
      return { error: 'date 必须是 "LATEST_TRADING_DAY" 或 YYYY-MM-DD。' };
    }
    spec.date = obj.date as MarketQuerySpec["date"];
  }
  if (obj.sort !== undefined) {
    const s = obj.sort as Record<string, unknown>;
    if (!s || typeof s.field !== "string" || !normalizeField(s.field)) {
      return { error: `sort.field 必须是以下之一：${MARKET_FIELDS.join(" / ")}。` };
    }
    const direction = s.direction === "asc" ? "asc" : s.direction === "desc" || s.direction === undefined ? "desc" : null;
    if (direction === null) return { error: "sort.direction 必须是 asc 或 desc。" };
    spec.sort = { field: normalizeField(s.field)!, direction };
  }
  if (obj.filters !== undefined) {
    if (!Array.isArray(obj.filters)) return { error: "filters 必须是数组。" };
    const filters: NonNullable<MarketQuerySpec["filters"]> = [];
    for (const f of obj.filters) {
      const item = f as Record<string, unknown>;
      if (!item || typeof item.field !== "string" || !normalizeField(item.field)) {
        return { error: `filter.field 必须是以下之一：${MARKET_FIELDS.join(" / ")}。` };
      }
      if (!(item.op === ">=" || item.op === ">" || item.op === "<=" || item.op === "<" || item.op === "==" || item.op === "!=")) {
        return { error: "filter.op 必须是 >=、>、<=、<、== 或 !=。" };
      }
      if (typeof item.value !== "number" && typeof item.value !== "boolean") {
        return { error: "filter.value 必须是数字或布尔。" };
      }
      filters.push({ field: normalizeField(item.field)!, op: item.op, value: item.value });
    }
    spec.filters = filters;
  }
  if (obj.limit !== undefined) {
    if (typeof obj.limit !== "number" || !Number.isInteger(obj.limit) || obj.limit < 1 || obj.limit > MAX_LIMIT) {
      return { error: `limit 必须是 1–${MAX_LIMIT} 的整数。` };
    }
    spec.limit = obj.limit;
  }
  return { spec };
}

function valueOf(row: MarketStateRow, field: MarketField): number | boolean | null {
  return row[field] as number | boolean | null;
}

function passesFilter(row: MarketStateRow, filter: NonNullable<MarketQuerySpec["filters"]>[number]): boolean {
  const value = valueOf(row, filter.field);
  if (value === null) return false; // unknown is never compared, never guessed
  if (typeof filter.value === "boolean") {
    if (typeof value !== "boolean") return false;
    return filter.op === "==" ? value === filter.value : filter.op === "!=" ? value !== filter.value : false;
  }
  const v = value as number;
  switch (filter.op) {
    case ">=":
      return v >= filter.value;
    case ">":
      return v > filter.value;
    case "<=":
      return v <= filter.value;
    case "<":
      return v < filter.value;
    case "==":
      return v === filter.value;
    case "!=":
      return v !== filter.value;
  }
}

/** Apply Phase 1 filters to an arbitrary row set — same semantics as
 * runMarketQuery (nulls never compare, never guessed). Hybrid semantic-first
 * execution uses this to constrain its semantic-eligible set; the market layer
 * itself is untouched. */
export function applyMarketFilters(
  rows: MarketStateRow[],
  filters: NonNullable<MarketQuerySpec["filters"]> | undefined,
): MarketStateRow[] {
  let selected = rows;
  for (const filter of filters ?? []) selected = selected.filter((row) => passesFilter(row, filter));
  return selected;
}

/** Shared deterministic order, without a TopN cut. */
export function sortMarketRows(selected: MarketStateRow[], sort: MarketQuerySpec["sort"]): MarketStateRow[] {
  let sorted = selected;
  if (sort) {
    const { field, direction } = sort;
    const mul = direction === "asc" ? 1 : -1;
    sorted = [...selected].sort((a, b) => {
      const va = valueOf(a, field);
      const vb = valueOf(b, field);
      if (va === null && vb === null) return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      if (va === null) return 1; // nulls last, both directions
      if (vb === null) return -1;
      if (typeof va === "boolean" || typeof vb === "boolean") {
        const na = va === true ? 1 : 0;
        const nb = vb === true ? 1 : 0;
        return (na - nb) * mul || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
      }
      return (va - vb) * mul || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    });
  }

  return sorted;
}

/**
 * Run a query against the committed state. `manifest` / `rows` are injectable
 * for tests; production callers omit them and the committed artifacts are read.
 */
export function runMarketQuery(
  spec: MarketQuerySpec,
  inject?: { manifest?: MarketStateManifest | null; rows?: MarketStateRow[] },
): MarketQueryResult {
  const manifest = inject?.manifest !== undefined ? inject.manifest : loadMarketStateManifest();
  if (!manifest) {
    return { available: false, reason: "Market State 尚未构建（缺少 data/market/state/manifest.json）。请先运行 npm run market:build。" };
  }
  const requested = spec.date ?? "LATEST_TRADING_DAY";
  if (!inject && requested === "LATEST_TRADING_DAY") {
    const { reason } = marketAvailability(manifest);
    if (reason) return { available: false, reason };
  }
  const resolved = requested === "LATEST_TRADING_DAY" ? manifest.latestTradingDay : requested;
  if (!manifest.materializedDates.includes(resolved)) {
    return {
      available: false,
      reason: `交易日 ${resolved} 的派生状态未物化（已物化：${manifest.materializedDates.join("、") || "无"}）。可用 npm run market:build -- --date ${resolved} 物化。`,
    };
  }
  const stateRows = inject?.rows ?? loadMarketStateRows(resolved, manifest);
  if (!stateRows) {
    return { available: false, reason: `交易日 ${resolved} 的状态文件缺失（manifest 声称已物化）。` };
  }

  let selected = stateRows;
  for (const filter of spec.filters ?? []) {
    selected = selected.filter((row) => passesFilter(row, filter));
  }
  const total = selected.length;

  const sorted = sortMarketRows(selected, spec.sort);

  const limit = spec.limit ?? DEFAULT_LIMIT;
  const universe = loadMarketUniverse();
  const rows: MarketResultRow[] = sorted.slice(0, limit).map((row) => {
    const company = universe.byCode.get(row.code);
    // Defensive only — the captured pool is exactly the companies.json universe.
    const fallbackExchange = row.code.startsWith("6") ? "SH" : /^(4|8|9)/.test(row.code) ? "BJ" : "SZ";
    return {
      code: row.code,
      name: company?.name ?? row.code,
      exchange: company?.exchange ?? fallbackExchange,
      board: company?.board ?? "unknown",
      industry: company?.industry ?? "unknown",
      tradeDate: resolved,
      pctChange: row.pctChange,
      close: row.close,
      volume: row.volume,
      amount: row.amount,
      turnoverRate: row.turnoverRate,
      marketCapYi: row.marketCapYi,
      isLimitUp: row.isLimitUp,
      isLimitDown: row.isLimitDown,
      limitUpStreak: row.limitUpStreak,
      return5d: row.return5d,
      return20d: row.return20d,
      volumeRatio20d: row.volumeRatio20d,
      sortValue: spec.sort ? valueOf(row, spec.sort.field) : null,
    };
  });

  return {
    available: true,
    query: spec,
    date: { requested, resolved },
    latestTradingDay: manifest.latestTradingDay,
    total,
    count: rows.length,
    rows,
    provenance: {
      dailySource: MARKET_DAILY_SOURCE,
      quoteSource: manifest.inputs.quoteFile ? MARKET_QUOTE_SOURCE : null,
      stateDigest16: manifest.contentDigest.value.slice(0, 16),
      tradingDays: manifest.tradingDays.length,
    },
    limitations: [
      "生产环境的最近交易日须通过交易日历与盘后时点校验；历史注入数据仅用于重放。",
      "涨跌停为规则判定（板块×ST×上市阶段，HALF_UP 精确到分），未知制度如实 null，绝不用涨跌幅阈值近似。",
      "换手率/市值仅在有腾讯快照的交易日有值；历史日如实为空。",
      "return_5d/return_20d 基于不复权收盘价，除权除息日的区间收益含分红缺口（follow-up：复权口径）。",
    ],
  };
}
