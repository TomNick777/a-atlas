/**
 * Deterministic Hybrid Query Planner (Phase 2) — the language layer that
 * compiles natural language into a HybridQueryPlan (reports/HYBRID_MARKET_DISCOVERY
 * /REPORT.md §D). Pure function: (raw, HYBRID_PLANNER_VERSION) → plan. No LLM,
 * no dataset access, no I/O.
 *
 * Parser precedence (frozen contract, tested in tests/hybrid_planner.test.ts):
 *   1. unsupported scan — future prediction / investment advice / out-of-scope
 *      domains. Advice phrasing (值得买/建议买/…) refuses on its own; future and
 *      out-of-scope markers refuse only when the query also carries market
 *      language, so pure company-facts queries like「做K线软件的公司」keep their
 *      existing discovery path (§14).
 *   2. time window (最近N日/天/交易日) — composes with 涨跌 sorts, rewriting
 *      them to return_5d / return_20d. A window next to any other sort, or with
 *      no sort at all, is unsupported: the state layer has no 5日成交额 field
 *      and no rankable metric to honestly answer with.
 *   3. sort — leftmost mention wins; later sort words are dropped with a note.
 *   4. filters — counted 涨停 phrases (连续N个涨停 / N连板 / 至少N个涨停) take
 *      precedence over bare 涨停; a streak filter with no explicit sort ranks by
 *      streak desc (Q5 convention); bare 涨停/跌停 with no sort rank by pctChange.
 *   5. top-N (成交额前20 / 涨幅前10 / 前20名 / Top20 / 最大的10家公司) — a
 *      metric-prefixed top-N implies its sort; a bare top-N without any sort is
 *      unsupported (nothing to rank by).
 *   6. date words (今天/今日/当日/当前/最新交易日) — qualifiers, never intent
 *      on their own.
 *   7. semantic residual (§4) — matched market spans and filler particles are
 *      removed; generic company suffixes are stripped; < 2 chars → no semantic.
 *      「的」 is only stripped at the leading edge and before suffixes, never
 *      inside a word (美的 stays 美的).
 *
 * Execution order (§5): no market intent → semantic-only (the planner never
 * touches pure discovery queries — the raw query is passed through untouched);
 * market without residual → market-only; market + residual → semantic-first,
 * or market-first when a top-N set is stated (成交额前20中有哪些光模块公司).
 *
 * Ambiguity (§12): vague wording maps to a documented default recorded in
 * plan.notes — 交易(交投)活跃 → amount desc; 涨得不错 → pctChange desc with no
 * invented threshold; 明显放量 ranks by volumeRatio20d with NO threshold (H8).
 */

import type { MarketField } from "../market/contracts";
import { HERO_LABELS } from "./hero";
import { HYBRID_PLANNER_VERSION, type HybridQueryPlan, type MarketIntent } from "./contracts";

type SortIntent = { field: MarketField; direction: "asc" | "desc" };

type SortRule = { re: RegExp; sort: SortIntent; note?: string };

/**
 * Frozen V1 vocabulary. Exported since Phase 3.2: the authoritative Parser V2
 * (lib/hybrid/parser-v2.ts) reuses these tables verbatim so the V1 baseline and
 * the v2 grammar stay single-sourced. The tables themselves are FROZEN — V1
 * plans must stay byte-identical (H1–H10 regression).
 */
export const SORT_RULES: SortRule[] = [
  { re: /领涨/, sort: { field: "pctChange", direction: "desc" } },
  { re: /涨幅最[大高]|涨得最多|涨最多的/, sort: { field: "pctChange", direction: "desc" } },
  { re: /领跌/, sort: { field: "pctChange", direction: "asc" } },
  { re: /跌幅最[大高]|跌得最多|跌最多的/, sort: { field: "pctChange", direction: "asc" } },
  { re: /成交(?:额|金额)最[大高多]/, sort: { field: "amount", direction: "desc" } },
  { re: /成交量最[大高多]/, sort: { field: "volume", direction: "desc" } },
  { re: /换手率最[大高]/, sort: { field: "turnoverRate", direction: "desc" } },
  { re: /量比最[大高]/, sort: { field: "volumeRatio20d", direction: "desc" } },
  { re: /放量最[大多]|明显放量/, sort: { field: "volumeRatio20d", direction: "desc" }, note: "「明显放量」不设阈值：按 20 日量比排序（H8 口径）。" },
  { re: /涨得不错|涨得好/, sort: { field: "pctChange", direction: "desc" }, note: "「涨得不错」无冻结阈值，只解析为按涨跌幅排序。" },
  { re: /(?:交易|交投)很?活跃/, sort: { field: "amount", direction: "desc" }, note: "「活跃」默认解释为按成交额排序（planner contract）。" },
];

/** Top-N with an explicit metric: the metric IS the sort. */
export const METRIC_TOPN: { metric: string; sort: SortIntent }[] = [
  { metric: "涨跌幅|涨幅", sort: { field: "pctChange", direction: "desc" } },
  { metric: "跌幅", sort: { field: "pctChange", direction: "asc" } },
  { metric: "成交额|成交金额", sort: { field: "amount", direction: "desc" } },
  { metric: "成交量", sort: { field: "volume", direction: "desc" } },
  { metric: "换手率", sort: { field: "turnoverRate", direction: "desc" } },
  { metric: "量比", sort: { field: "volumeRatio20d", direction: "desc" } },
];

export const WINDOW_RE = /(?<![附逼])(?:最近|近)\s*([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,4})\s*个?\s*(?:交易日|天|日)/;
export const TOPN_RE = /(?<![之以])前\s*([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,3})\s*(?:名|个|只|家)|top\s*([0-9０-９]{1,3})/i;
/** 「最大的10家公司」式数量 — only honoured when another market signal exists. */
export const COUNTED_COMPANIES_RE = /([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,3})\s*(?:家|只|个)\s*(?:公司|企业|上市公司|个股|股票|标的)/;
export const DATE_RE = /今天|今日|当日|当前|最新交易日/g;
export const STREAK_RE = /(?:连续|至少)?\s*([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,4})\s*个?\s*涨停/;
export const LIANBAN_RE = /([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,4})\s*连板/;
export const BARE_STREAK_RE = /连续\s*涨停|(?<![0-9０-９一二两三四五六七八九十])连板/;
export const DOWN_STREAK_RE = /(?:连续|至少)?\s*(?:[0-9０-９]{1,3}|[一二两三四五六七八九十]{1,4})\s*个?\s*跌停|连续\s*跌停/;
export const LIMIT_UP_RE = /涨停/;
export const LIMIT_DOWN_RE = /跌停/;

/** §13 — advice phrasing refuses on its own; the others gate on market intent.
 * Exported since Phase 3.2: Parser V2 applies the same frozen refusal
 * disciplines to grammar-compiled queries (the intents are product law). */
export const UNSUPPORTED_RULES: { intent: string; detail: string; re: RegExp; adviceOnly?: boolean }[] = [
  {
    intent: "future_market_prediction",
    detail: "行情层只回答已发生的交易日（LATEST_TRADING_DAY），不预测明天。",
    re: /明天|后天|未来|下周|下月|接下来|即将|将会|会涨|会跌|要涨|要跌|预测|预计|有望|大概率/,
  },
  {
    intent: "investment_advice",
    adviceOnly: true,
    detail: "A-Atlas 是公司发现，不做买卖建议、不给投资结论。",
    re: /值得买|值得投资|最值得|该买|建议买|建议买入|能不能买|可以买|要不要买|买什么|抄底|建仓|加仓|减仓|清仓|潜力股|牛股|金股/,
  },
  {
    intent: "out_of_scope_domain",
    detail: "Phase 2 只组合 公司事实 × 市场状态，不做技术指标、资金或财务筛选。",
    // Not followed by a product-domain qualifier: 「做K线软件的公司」 is a
    // legitimate company-facts query (§14), 「MACD金叉」 is a screening request.
    re: /(?:龙虎榜|资金流|主力资金|北向资金|分钟线|分时|MACD|KDJ|RSI|K线|盘口|Level-?2|市盈率|市净率|市销率|ROE|净利润|营收|财报)(?!\s*(?:软件|系统|服务|业务|设备|数据|概念|终端|工具|厂商|图|指标|函数|公式|管理|平台|方案))/i,
  },
];

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** Arabic / full-width / Chinese-numeral → number (三个→3, 二十→20). */
export function parseNumber(raw: string): number | null {
  const s = raw.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const parts = s.split("十");
  if (parts.length !== 2) return CN_DIGITS[s] ?? null;
  const tens = parts[0] === "" || parts[0] === "一" ? 1 : CN_DIGITS[parts[0]];
  const ones = parts[1] === "" ? 0 : CN_DIGITS[parts[1]];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

/** Residual cleanup (§4): filler particles, then generic company suffixes.
 * 「的」 only leaves at the leading edge — never inside a word (美的 stays 美的). */
export function cleanResidual(text: string): string {
  let out = text;
  for (const span of out.match(/中有哪些|里有哪些|有哪些|哪些|帮我|找一下|找出|看看|查一下|查下|请|一下/g) ?? []) out = out.replace(span, "");
  out = out.replace(/^[的了吗呢]+/, "").replace(/[了呢吗啊]+$/g, "").trim();
  out = out.replace(/(?:相关)?(?:公司|企业|上市公司|概念股|个股|股票|标的)$/, "").trim();
  out = out.replace(/(?:类|板块|概念)$/, "").trim();
  return out;
}

/** Blank out the consumed [start,end) spans, character-faithful (V1 §4 / V2 share). */
export function cutBySpans(text: string, spans: Array<[number, number]>): string {
  const keep: boolean[] = Array.from(text, () => true);
  for (const [start, end] of spans) for (let i = start; i < end && i < keep.length; i++) keep[i] = false;
  return [...text].filter((_, i) => keep[i]).join("");
}

function planFor(
  raw: string,
  market: MarketIntent | null,
  semantic: string | null,
  order: HybridQueryPlan["execution"]["order"],
  heroKey: MarketField | null,
  notes: string[],
  unsupported: HybridQueryPlan["unsupported"],
): HybridQueryPlan {
  return {
    plannerVersion: HYBRID_PLANNER_VERSION,
    raw,
    semantic: semantic ? { query: semantic } : null,
    market,
    execution: { order },
    heroMetric: heroKey ? { key: heroKey, label: HERO_LABELS[heroKey] } : null,
    notes,
    unsupported,
  };
}

const unsupportedPlan = (raw: string, intent: string, detail: string): HybridQueryPlan =>
  planFor(raw, null, null, "unsupported", null, [], { intent, detail });

export function parseHybridQuery(rawInput: string): HybridQueryPlan {
  const raw = rawInput.trim();

  // §13 scan — decided at the intent gate below.
  const scanHits = UNSUPPORTED_RULES.map((rule) => ({ rule, m: rule.re.exec(raw) })).filter((hit) => hit.m);

  const notes: string[] = [];
  const spans: Array<[number, number]> = [];
  const cut = (text: string): string => cutBySpans(text, spans);
  const outside = (index: number) => !spans.some(([start, end]) => index >= start && index < end);

  // Window (step 2).
  let windowField: "return5d" | "return20d" | null = null;
  let windowUnsupported: HybridQueryPlan["unsupported"] = null;
  {
    const m = WINDOW_RE.exec(raw);
    if (m) {
      const n = parseNumber(m[1]);
      if (n === 5) windowField = "return5d";
      else if (n === 20) windowField = "return20d";
      else windowUnsupported = {
        intent: "unsupported_time_window",
        detail: `「${m[0]}」没有已冻结的市场字段——现有窗口只有 5 日 / 20 日区间涨幅。`,
      };
      spans.push([m.index, m.index + m[0].length]);
    }
  }

  // Sort (step 3) — leftmost mention wins.
  let sort: SortIntent | null = null;
  {
    let best: { at: number; end: number; sort: SortIntent; note?: string; text: string } | null = null;
    for (const rule of SORT_RULES) {
      const m = rule.re.exec(raw);
      if (m && outside(m.index) && (!best || m.index < best.at)) {
        best = { at: m.index, end: m.index + m[0].length, sort: rule.sort, note: rule.note, text: m[0] };
      }
    }
    if (best) {
      sort = best.sort;
      spans.push([best.at, best.end]);
      if (best.note) notes.push(best.note);
      for (const rule of SORT_RULES) {
        const m = rule.re.exec(raw);
        if (m && m.index > best!.at && outside(m.index)) {
          notes.push(`检测到多个排序表述：按先出现的「${best!.text}」排序，忽略「${m[0]}」。`);
          spans.push([m.index, m.index + m[0].length]);
          break;
        }
      }
    }
  }

  // Window composition (step 2′): return windows rewrite a 涨跌 sort.
  if (windowField) {
    if (sort && sort.field === "pctChange") {
      sort = { field: windowField, direction: sort.direction };
    } else if (sort) {
      return unsupportedPlan(
        raw,
        "window_with_unsupported_sort",
        `「${windowField === "return5d" ? "5日" : "20日"}」窗口只能与涨跌表述组合（现有字段：return_5d / return_20d 的区间涨幅），无法诚实回答该排序。`,
      );
    } else {
      return unsupportedPlan(raw, "window_without_sort", "时间窗口需要搭配涨跌表述（如「最近5日涨幅最大」）才能确定排序字段。");
    }
  }

  // Filters (step 4) — counted phrases take precedence over bare 涨停/跌停.
  const filters: MarketIntent["filters"] = [];
  {
    const addStreak = (n: number, span: [number, number], note?: string) => {
      filters.push({ field: "limitUpStreak", op: ">=", value: n });
      spans.push(span);
      if (note) notes.push(note);
    };
    const mStreak = STREAK_RE.exec(raw);
    const mLianban = LIANBAN_RE.exec(raw);
    const mBare = BARE_STREAK_RE.exec(raw);
    if (mStreak && outside(mStreak.index)) {
      const n = parseNumber(mStreak[1]);
      if (n == null || n < 1 || n > 99) return unsupportedPlan(raw, "unsupported_streak_count", `无法解析连板数「${mStreak[1]}」。`);
      addStreak(n, [mStreak.index, mStreak.index + mStreak[0].length], /连续|至少/.test(mStreak[0]) ? undefined : `「${mStreak[0]}」按 连板数 ≥ ${n} 解释（连续/至少 省略）。`);
    } else if (mLianban && outside(mLianban.index)) {
      const n = parseNumber(mLianban[1]);
      if (n == null || n < 1 || n > 99) return unsupportedPlan(raw, "unsupported_streak_count", `无法解析连板数「${mLianban[1]}」。`);
      addStreak(n, [mLianban.index, mLianban.index + mLianban[0].length]);
    } else if (mBare && outside(mBare.index)) {
      addStreak(2, [mBare.index, mBare.index + mBare[0].length], `「${mBare[0]}」按 连板数 ≥ 2 解释。`);
    } else if (DOWN_STREAK_RE.test(raw)) {
      return unsupportedPlan(raw, "unsupported_market_field", "市场状态只有涨停连板（limit_up_streak），没有跌停连板字段，无法诚实回答。");
    }
    if (!filters.length) {
      const m = LIMIT_UP_RE.exec(raw);
      if (m && outside(m.index)) {
        filters.push({ field: "isLimitUp", op: "==", value: true });
        spans.push([m.index, m.index + m[0].length]);
      }
    }
    if (!filters.length) {
      const m = LIMIT_DOWN_RE.exec(raw);
      if (m && outside(m.index)) {
        filters.push({ field: "isLimitDown", op: "==", value: true });
        spans.push([m.index, m.index + m[0].length]);
      }
    }
  }

  // Top-N (step 5).
  let topN: number | null = null;
  {
    let best: { at: number; end: number; n: number; sort: SortIntent | null } | null = null;
    for (const { metric, sort: metricSort } of METRIC_TOPN) {
      const re = new RegExp(
        `(?:${metric})\\s*(?<![之以])(?:前|top)\\s*([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,3})\\s*(?:名|个|只|家)?`,
        "i",
      );
      const m = re.exec(raw);
      if (m && outside(m.index) && (!best || m.index < best.at)) {
        const n = parseNumber(m[1]);
        if (n != null && n >= 1) best = { at: m.index, end: m.index + m[0].length, n, sort: metricSort };
      }
    }
    const bare = TOPN_RE.exec(raw);
    if (bare && outside(bare.index)) {
      const n = parseNumber(bare[1] ?? bare[2] ?? "");
      if (n != null && n >= 1 && (!best || bare.index < best.at)) best = { at: bare.index, end: bare.index + bare[0].length, n, sort: null };
    }
    // 「成交额最大的10家公司」 — a counted-company suffix turns the number into a limit.
    if (!best && sort) {
      const counted = COUNTED_COMPANIES_RE.exec(raw);
      if (counted && outside(counted.index)) {
        const n = parseNumber(counted[1]);
        if (n != null && n >= 1) best = { at: counted.index, end: counted.index + counted[0].length, n, sort: null };
      }
    }
    if (best) {
      if (!sort && best.sort) sort = best.sort;
      if (!sort) {
        return unsupportedPlan(raw, "topn_without_metric", `「${raw.slice(best.at, best.end).trim()}」需要搭配排序维度（如「成交额前20」），无法确定按什么取前 N。`);
      }
      if (best.sort && (best.sort.field !== sort.field || best.sort.direction !== sort.direction)) {
        notes.push(`「前N」的度量与排序表述不一致，按显式排序 ${sort.field} ${sort.direction} 执行。`);
      }
      spans.push([best.at, best.end]);
      topN = best.n;
    }
  }

  // Date words (step 6) — qualifiers only.
  for (const m of raw.matchAll(DATE_RE)) {
    if (outside(m.index)) spans.push([m.index, m.index + m[0].length]);
  }

  // Market intent exists only when something rankable/filterable was said.
  const hasMarketIntent = Boolean(sort) || filters.length > 0 || topN !== null;
  // An unmapped window (最近10日) is only a refusal when the query otherwise
  // carries market language; on its own it stays on the discovery path (§14).
  if (hasMarketIntent && windowUnsupported) return unsupportedPlan(raw, windowUnsupported.intent, windowUnsupported.detail);
  // Advice and out-of-scope phrasing refuse on their own (the product-qualifier
  // lookahead already protects「做K线软件的公司」); an unmapped future marker
  // refuses only when the query otherwise carries market language — pure
  // queries like「做未来教育的公司」stay on the discovery path (§14).
  const adviceHit = scanHits.find((hit) => hit.rule.intent === "investment_advice");
  const scopeHit = scanHits.find((hit) => hit.rule.intent === "out_of_scope_domain");
  const futureHit = scanHits.find((hit) => hit.rule.intent === "future_market_prediction");
  const unsupportedHit = adviceHit ?? scopeHit ?? (hasMarketIntent ? futureHit : null);
  if (unsupportedHit) {
    return unsupportedPlan(raw, unsupportedHit.rule.intent, `${unsupportedHit.rule.detail}（触发词：「${unsupportedHit.m![0]}」）`);
  }
  if (!hasMarketIntent) {
    // §14 — the planner did not intervene; the raw query stays exactly as typed.
    return planFor(raw, null, null, "semantic-only", null, notes, null);
  }

  // Residual (step 7).
  const residual = cleanResidual(cut(raw));
  const semantic = residual.length >= 2 ? residual : null;
  if (residual.length > 0 && !semantic) notes.push(`语义残留「${residual}」短于 2 字，按 market-only 执行。`);

  // A filter with no explicit sort still ranks honestly (Q5 convention).
  let heroKey: MarketField | null = sort?.field ?? null;
  if (!sort && filters.length) {
    const streak = filters.find((f) => f.field === "limitUpStreak");
    if (streak) {
      sort = { field: "limitUpStreak", direction: "desc" };
      notes.push("连板过滤未指定排序：默认按连板数从高到低（Q5 口径）。");
    } else {
      sort = { field: "pctChange", direction: filters.some((f) => f.field === "isLimitDown") ? "asc" : "desc" };
      notes.push("涨跌停过滤未指定排序：默认按涨跌幅排序。");
    }
    heroKey = sort.field;
  }

  const market: MarketIntent = { date: "LATEST_TRADING_DAY", filters, sort, limit: topN };
  const order: HybridQueryPlan["execution"]["order"] = semantic ? (topN !== null ? "market-first" : "semantic-first") : "market-only";
  return planFor(raw, market, semantic, order, heroKey, notes, null);
}

/** The frozen vocabulary, surfaced for the report / CLI contract display. */
export const SUPPORTED_VOCAB = {
  time: ["今天", "今日", "当前", "最新交易日", "最近5天/近5日/最近五个交易日", "最近20天/近20日/最近二十个交易日"],
  sort: ["领涨", "涨幅最大/涨得最多", "领跌/跌幅最大/跌得最多", "成交额(金额)最大", "成交量最大", "换手率最高", "放量最大/明显放量", "交易(交投)活跃→成交额", "涨得不错→涨跌幅"],
  filter: ["涨停", "跌停", "连续N个涨停", "N连板", "至少N个涨停", "连续涨停/连板(≥2)"],
  topN: ["成交额前20", "涨幅前10", "前20名", "Top20", "最大的10家公司"],
  unsupported: UNSUPPORTED_RULES.map((r) => r.intent),
} as const;
