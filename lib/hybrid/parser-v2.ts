/**
 * Deterministic Query Parser V2 (Phase 3.2) — the ONLY authoritative natural
 * language → Hybrid Query DSL compiler.
 *
 *   User Query → Parser V2 → PlannerOutput → Validator → Normalizer → Plan
 *
 * It mechanically parses the frozen Query Grammar (lib/planner/grammar.ts)
 * plus the V1 vocabulary (lib/hybrid/planner.ts, reused verbatim) into the
 * bounded PlannerOutput shape, and the EXISTING deterministic validator and
 * normalizer turn that into the plan — the Phase 3 safety boundary and frozen
 * defaults survive the LLM's removal untouched.
 *
 *   Atlas 不理解 → semantic residual 原样交 Jev（§10/§11）。
 *   不支持的表达 → 明确拒绝，绝不猜测（§12）。
 *
 * Pure function: (raw, grammar version) → PlannerOutput | null. `null` means
 * the query carries no V2 construct at all and the frozen V1 parse (byte-
 * identical Phase 2 behaviour) is the answer. No LLM, no I/O, no dataset.
 */

import {
  CALENDAR_UNSUPPORTED_RE,
  COMPARISON_DIRECTIONS,
  COMPARISON_METRIC_FIELDS,
  COMPARISON_PHRASE,
  INJECTION_RE,
  METRIC_ALIASES,
  OPERATOR_WORDS,
  POSTFIX_OPERATORS,
  STAY_RISE_RE,
  SYMBOL_OPERATORS,
  THRESHOLD_HAS_OPERATOR,
  THRESHOLD_PHRASE,
  VAGUE_EVAL_RE,
  VAGUE_TIME_RE,
  VOLUME_RATIO_PHRASE,
  WINDOW_MAPPINGS,
  type GrammarComparisonOp,
} from "../planner/grammar";
import type { PlannerOutput, PlannerOutputFilter } from "../planner/contracts";
import {
  BARE_STREAK_RE,
  COUNTED_COMPANIES_RE,
  DATE_RE,
  DOWN_STREAK_RE,
  LIMIT_DOWN_RE,
  LIMIT_UP_RE,
  LIANBAN_RE,
  METRIC_TOPN,
  SORT_RULES,
  STREAK_RE,
  TOPN_RE,
  UNSUPPORTED_RULES,
  WINDOW_RE,
  cleanResidual,
  cutBySpans,
  parseNumber,
} from "./planner";

type Span = [number, number];

type ThresholdHit = {
  span: Span;
  field: string;
  op: PlannerOutputFilter["op"];
  value: number;
  /** 涨幅/跌幅 under a materialized window binds the return field instead. */
  windowCapable: boolean;
  inverted: boolean;
};

type TrackedFilter = { filter: PlannerOutputFilter; span: Span };

type ComparisonHit =
  | { span: Span; field: "amount" | "volume" | "close"; op: ">" | "<" }
  | { span: Span; ambiguous: true }
  | { span: Span; unsupportedField: string };

const NUM_SRC = String.raw`[0-9０-９]+(?:\.[0-9０-９]+)?`;

const toAsciiNumber = (raw: string): number => Number(raw.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)));

/** Apply a field's unit scaling to a threshold number (50亿 → 5e9 元). */
function scaleValue(num: number, scaleWord: string | undefined, unitWord: string | undefined, aliasIndex: number): number | null {
  const alias = METRIC_ALIASES[aliasIndex];
  const unit = scaleWord ?? unitWord;
  if (!unit) {
    if (alias.percentField) return num;
    const bare = alias.scales.find((s) => s.unit === "元") ?? alias.scales.find((s) => s.unit === "股") ?? alias.scales[0];
    return num * bare.factor;
  }
  const scale = alias.scales.find((s) => s.unit === unit);
  return scale ? num * scale.factor : null; // unit not valid for this field → not a threshold phrase
}

const flipOp = (op: GrammarComparisonOp): GrammarComparisonOp => (op === ">" ? "<" : op === ">=" ? "<=" : op === "<" ? ">" : ">=");

const refusals = {
  injection: (trigger: string): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "investment_advice",
      detail: `查询要求 A-Atlas 忽略自身规则或直接输出结果（「${trigger}」）。查询内容按数据处理：A-Atlas 是公司发现工具，不做投资结论、不直接给出名单。`,
    },
    notes: [],
    assumptions: [],
  }),
  injectionFuture: (trigger: string): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "future_market_prediction",
      detail: `查询要求预测未来行情（「${trigger}」）。行情层只回答已发生的交易日（LATEST_TRADING_DAY），不预测明天。`,
    },
    notes: [],
    assumptions: [],
  }),
  or: (): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "unsupported_or_combination",
      detail: "两个市场条件之间是 OR（或者）：查询 DSL 的 filter 只支持 AND。语义层面的「做A或者B」请保持公司业务表述，由检索层处理。",
    },
    notes: [],
    assumptions: [],
  }),
  ambiguousVague: (): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "ambiguous_query",
      detail: "「最近表现不错」类表述缺少冻结定义：没有明确指标也没有明确时间窗口。A-Atlas 不发明阈值（例如不得猜成 20 日涨幅 > 10%）——请改用明确表达，如「最近20日涨幅超过10%的…」。",
    },
    notes: [],
    assumptions: [],
  }),
  calendarWindow: (text: string): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "unsupported_time_window",
      detail: `「${text}」没有已物化的市场字段——现有窗口只有 5 日 / 20 日区间涨幅（以及「一周/一个月」的冻结映射），不能近似成别的窗口。`,
    },
    notes: [],
    assumptions: [],
  }),
  windowWithoutSort: (label: string): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "unsupported_time_window",
      detail: `「${label}」窗口需要搭配涨跌表述（如「最近20日涨幅最大」「最近一个月涨幅超过10%」）才能确定市场字段。`,
    },
    notes: [],
    assumptions: [],
  }),
  windowWithUnsupportedSort: (label: string): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "window_with_unsupported_sort",
      detail: `「${label}」窗口只能与涨跌表述组合（现有字段：return5d / return20d 的区间涨幅），没有窗口化的成交额/换手率字段，无法诚实回答该排序或条件。`,
    },
    notes: [],
    assumptions: [],
  }),
  unsupportedComparisonField: (metric: string): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "unsupported_market_field",
      detail: `「${metric}比昨天…」无法回答：日环比只有成交额/成交量/收盘价字段（今日 vs 上一交易日）。`,
    },
    notes: [],
    assumptions: [],
  }),
  ambiguousComparison: (): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: {
      intent: "ambiguous_query",
      detail: "「比昨天/环比」缺少方向词（高于还是低于）——不发明方向，请写明「比昨天高/低」。",
    },
    notes: [],
    assumptions: [],
  }),
  streakUnparsed: (text: string): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: { intent: "unsupported_market_field", detail: `无法解析连板数「${text}」。` },
    notes: [],
    assumptions: [],
  }),
  downStreak: (): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: { intent: "unsupported_market_field", detail: "市场状态只有涨停连板（limit_up_streak），没有跌停连板字段，无法诚实回答。" },
    notes: [],
    assumptions: [],
  }),
  topnWithoutMetric: (text: string): PlannerOutput => ({
    semantic: null,
    market: null,
    comparison: null,
    unsupported: { intent: "topn_without_metric", detail: `「${text}」需要搭配排序维度（如「成交额前20」），无法确定按什么取前 N。` },
    notes: [],
    assumptions: [],
  }),
};

/** Blank out V2-claimed spans, then V1's residual cleanup, then strip the
 * clause punctuation V2 consumed around (V1's own residual text is untouched).
 * 「…的公司」 leaves as one unit so the residual reaches Jev clean
 * (做人形机器人减速器的公司 → 做人形机器人减速器) — 美的 itself is never touched. */
function residualOf(raw: string, spans: Span[]): string {
  let out = cutBySpans(raw, spans).replace(/[，,、；;]/g, "");
  out = out.replace(/(?:相关)?的(?:公司|企业|上市公司|概念股|个股|股票|标的)$/, "").trim();
  out = cleanResidual(out);
  return out.trim();
}

const overlaps = (span: Span, banned: Span[]): boolean => banned.some(([start, end]) => span[0] < end && start < span[1]);

/** 量比 speciality phrasing (P6): 成交量达到20日均量2倍以上. Scanned BEFORE the
 * generic thresholds so its span suppresses the bogus 成交量 hit inside it. */
function scanVolumeRatio(raw: string, outside: (index: number) => boolean): ThresholdHit | null {
  VOLUME_RATIO_PHRASE.lastIndex = 0;
  const m = VOLUME_RATIO_PHRASE.exec(raw);
  if (!m || !outside(m.index)) return null;
  const n = toAsciiNumber(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { span: [m.index, m.index + m[0].length], field: "volumeRatio20d", op: ">=", value: n, windowCapable: false, inverted: false };
}

/** Scan every threshold phrase: metric + operator(word or symbol, prefix or
 * postfix) + number + unit. An operator is REQUIRED — a bare number next to a
 * metric is not a frozen threshold and must not be invented (§12). */
function scanThresholds(raw: string, outside: (index: number) => boolean, banned: Span[]): ThresholdHit[] {
  const hits: ThresholdHit[] = [];
  THRESHOLD_PHRASE.lastIndex = 0;
  for (let m = THRESHOLD_PHRASE.exec(raw); m; m = THRESHOLD_PHRASE.exec(raw)) {
    const span: Span = [m.index, m.index + m[0].length];
    if (!outside(m.index) || overlaps(span, banned)) continue;
    const [, metricWord, prefixOp, numRaw, scaleWord, unitWord, postfixOp] = m;
    if (!THRESHOLD_HAS_OPERATOR(prefixOp, postfixOp)) continue; // bare number → no invented threshold
    const aliasIndex = METRIC_ALIASES.findIndex((a) => a.pattern.split("|").includes(metricWord));
    if (aliasIndex < 0) continue;
    const alias = METRIC_ALIASES[aliasIndex];
    let op: GrammarComparisonOp;
    if (prefixOp) op = OPERATOR_WORDS.find((g) => g.words.includes(prefixOp))!.op;
    else op = POSTFIX_OPERATORS.find((g) => g.words.includes(postfixOp!))!.op;
    const num = toAsciiNumber(numRaw);
    if (!Number.isFinite(num)) continue;
    const value = scaleValue(num, scaleWord, unitWord, aliasIndex);
    if (value === null) continue;
    hits.push({
      span,
      field: alias.field,
      op: alias.inverted ? flipOp(op) : op,
      value: alias.inverted ? -value : value,
      windowCapable: alias.windowCapable,
      inverted: alias.inverted,
    });
  }
  // Symbol form: 量比≥2 / 成交额>50亿 (operator symbol directly after the metric).
  for (const [aliasIndex, alias] of METRIC_ALIASES.entries()) {
    const re = new RegExp(`(${alias.pattern})\\s*([><]=?|≥|≤)\\s*(${NUM_SRC})\\s*(万|亿)?\\s*(元|%|％|倍|股)?`, "g");
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      const span: Span = [m.index, m.index + m[0].length];
      if (!outside(m.index) || overlaps(span, banned)) continue;
      const num = toAsciiNumber(m[3]);
      if (!Number.isFinite(num)) continue;
      const value = scaleValue(num, m[4], m[5], aliasIndex);
      if (value === null) continue;
      const op = SYMBOL_OPERATORS.find((s) => s.symbol === m[2])!.op;
      hits.push({
        span,
        field: alias.field,
        op: alias.inverted ? flipOp(op) : op,
        value: alias.inverted ? -value : value,
        windowCapable: alias.windowCapable,
        inverted: alias.inverted,
      });
    }
  }
  return hits;
}

function scanComparison(raw: string, outside: (index: number) => boolean): ComparisonHit | null {
  COMPARISON_PHRASE.lastIndex = 0;
  const m = COMPARISON_PHRASE.exec(raw);
  if (!m || !outside(m.index)) return null;
  const field = COMPARISON_METRIC_FIELDS[m[1]];
  if (!field) return { span: [m.index, m.index + m[0].length], unsupportedField: m[1] };
  const direction = COMPARISON_DIRECTIONS.find((g) => g.words.includes(m[3]));
  if (!direction) return { span: [m.index, m.index + m[0].length], ambiguous: true };
  return { span: [m.index, m.index + m[0].length], field, op: direction.op };
}

type WindowHit =
  | { kind: "v1"; span: Span; field: "return5d" | "return20d"; label: string }
  | { kind: "v1-unsupported"; span: Span; label: string }
  | { kind: "mapped"; span: Span; field: "return5d" | "return20d"; label: string; note: string }
  | { kind: "calendar"; span: Span; text: string }
  | null;

/** Resolve the time window: V1's explicit N日 windows, then the grammar's
 * frozen week/month mappings, then calendar language (refusal, gated). The
 * kind decides phase ownership: V1 windows stay V1's business unless a V2
 * construct forces the full parse; mappings and calendar language force V2. */
function scanWindow(raw: string, outside: (index: number) => boolean, hasMarketIntent: boolean): WindowHit {
  const v1 = WINDOW_RE.exec(raw);
  if (v1 && outside(v1.index)) {
    const n = parseNumber(v1[1]);
    if (n === 5) return { kind: "v1", span: [v1.index, v1.index + v1[0].length], field: "return5d", label: v1[0] };
    if (n === 20) return { kind: "v1", span: [v1.index, v1.index + v1[0].length], field: "return20d", label: v1[0] };
    if (hasMarketIntent) return { kind: "v1-unsupported", span: [v1.index, v1.index + v1[0].length], label: v1[0] };
    return null;
  }
  for (const mapping of WINDOW_MAPPINGS) {
    const m = mapping.re.exec(raw);
    if (m && outside(m.index)) {
      return { kind: "mapped", span: [m.index, m.index + m[0].length], field: mapping.windowField, label: mapping.label, note: mapping.note };
    }
  }
  const cal = CALENDAR_UNSUPPORTED_RE.exec(raw);
  if (cal && outside(cal.index) && hasMarketIntent) {
    return { kind: "calendar", span: [cal.index, cal.index + cal[0].length], text: cal[0] };
  }
  return null;
}

/** OR between TWO market conditions is outside the DSL; OR inside the semantic
 * residual is Jev's business. Deterministic split test at the first 或者. */
function orBetweenMarketConditions(raw: string): boolean {
  const at = raw.indexOf("或者");
  if (at < 0) return false;
  const marketCondition = (text: string) => {
    THRESHOLD_PHRASE.lastIndex = 0;
    const threshold = THRESHOLD_PHRASE.exec(text);
    const withOp = threshold ? THRESHOLD_HAS_OPERATOR(threshold[2], threshold[6]) : false;
    return withOp || STREAK_RE.test(text) || LIANBAN_RE.test(text) || LIMIT_UP_RE.test(text);
  };
  return marketCondition(raw.slice(0, at)) && marketCondition(raw.slice(at + 2));
}

/**
 * Parse V2. Returns the PlannerOutput when the query carries V2 grammar
 * constructs; `null` defers to the frozen V1 parse (byte-identical Phase 2).
 */
export function parseQueryOutput(rawInput: string): PlannerOutput | null {
  const raw = rawInput.trim();

  // 1. Injection discipline — the query is data; rule-breaking demands refuse.
  const injection = INJECTION_RE.exec(raw);
  if (injection) {
    const future = /明天|后天|下周|下月|接下来|即将|将会|会涨|会跌|要涨|要跌|预测|预计/.test(raw);
    return future ? refusals.injectionFuture(injection[0]) : refusals.injection(injection[0]);
  }

  // 2. Filter-level OR between two market conditions → honest refusal.
  if (orBetweenMarketConditions(raw)) return refusals.or();

  const spans: Span[] = [];
  const outside = (index: number) => !spans.some(([start, end]) => index >= start && index < end);
  const mark = (span: Span) => spans.push(span);
  const notes: string[] = [];
  const assumptions: string[] = [];

  // 3a. Sort — leftmost mention wins; later sort words dropped with a note (V1).
  let sort: { field: string; direction: "asc" | "desc" } | null = null;
  {
    let best: { at: number; end: number; sort: { field: string; direction: "asc" | "desc" }; note?: string; text: string } | null = null;
    for (const rule of SORT_RULES) {
      const m = rule.re.exec(raw);
      if (m && outside(m.index) && (!best || m.index < best.at)) {
        best = { at: m.index, end: m.index + m[0].length, sort: rule.sort, note: rule.note, text: m[0] };
      }
    }
    if (best) {
      sort = best.sort;
      mark([best.at, best.end]);
      if (best.note) notes.push(best.note);
      for (const rule of SORT_RULES) {
        const m = rule.re.exec(raw);
        if (m && m.index > best.at && outside(m.index)) {
          notes.push(`检测到多个排序表述：按先出现的「${best.text}」排序，忽略「${m[0]}」。`);
          mark([m.index, m.index + m[0].length]);
          break;
        }
      }
    }
  }

  // 3b. Volume-ratio speciality, then thresholds, comparison, stay-rise.
  const volumeRatio = scanVolumeRatio(raw, outside);
  const banned: Span[] = volumeRatio ? [volumeRatio.span] : [];
  const thresholds = scanThresholds(raw, outside, banned);
  if (volumeRatio) thresholds.push(volumeRatio);
  for (const hit of thresholds) mark(hit.span);
  const comparison = scanComparison(raw, outside);
  if (comparison) mark(comparison.span);

  let stayRise: Span | null = null;
  {
    const m = STAY_RISE_RE.exec(raw);
    if (m && outside(m.index)) {
      stayRise = [m.index, m.index + m[0].length];
      mark(stayRise);
    }
  }

  // 3c. Streak / 涨停 / 跌停 filters (V1 tables, same precedence, spans kept
  // so the post-cut move can relocate them). The lianban scan is widened over
  // V1's to cover a leading 连续/至少 — V1 leaks it into the residual.
  const tracked: TrackedFilter[] = [];
  {
    const LIANBAN_QUALIFIED_RE = /(?:连续|至少)?\s*([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,4})\s*连板/;
    const mStreak = STREAK_RE.exec(raw);
    const mLianban = LIANBAN_QUALIFIED_RE.exec(raw);
    const mBare = BARE_STREAK_RE.exec(raw);
    const addStreak = (n: number, span: Span, note?: string) => {
      tracked.push({ filter: { field: "limitUpStreak", op: ">=", value: n }, span });
      mark(span);
      if (note) notes.push(note);
    };
    if (mStreak && outside(mStreak.index)) {
      const n = parseNumber(mStreak[1]);
      if (n == null || n < 1 || n > 99) return refusals.streakUnparsed(mStreak[1]);
      addStreak(n, [mStreak.index, mStreak.index + mStreak[0].length], /连续|至少/.test(mStreak[0]) ? undefined : `「${mStreak[0]}」按 连板数 ≥ ${n} 解释（连续/至少 省略）。`);
    } else if (mLianban && outside(mLianban.index)) {
      const n = parseNumber(mLianban[1]);
      if (n == null || n < 1 || n > 99) return refusals.streakUnparsed(mLianban[1]);
      addStreak(n, [mLianban.index, mLianban.index + mLianban[0].length]);
    } else if (mBare && outside(mBare.index)) {
      addStreak(2, [mBare.index, mBare.index + mBare[0].length], `「${mBare[0]}」按 连板数 ≥ 2 解释。`);
    } else if (DOWN_STREAK_RE.test(raw)) {
      return refusals.downStreak();
    }
    if (!tracked.length) {
      const m = LIMIT_UP_RE.exec(raw);
      if (m && outside(m.index)) {
        tracked.push({ filter: { field: "isLimitUp", op: "==", value: true }, span: [m.index, m.index + m[0].length] });
        mark([m.index, m.index + m[0].length]);
      }
    }
    if (!tracked.length) {
      const m = LIMIT_DOWN_RE.exec(raw);
      if (m && outside(m.index)) {
        tracked.push({ filter: { field: "isLimitDown", op: "==", value: true }, span: [m.index, m.index + m[0].length] });
        mark([m.index, m.index + m[0].length]);
      }
    }
  }

  // 3d. Top-N (V1 tables; metric-prefixed top-N implies its sort).
  let topN: { span: Span; n: number } | null = null;
  {
    let best: { span: Span; n: number; sort: { field: string; direction: "asc" | "desc" } | null } | null = null;
    for (const { metric, sort: metricSort } of METRIC_TOPN) {
      const re = new RegExp(`(?:${metric})\\s*(?<![之以])(?:前|top)\\s*([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,3})\\s*(?:名|个|只|家)?`, "i");
      const m = re.exec(raw);
      if (m && outside(m.index) && (!best || m.index < best.span[0])) {
        const n = parseNumber(m[1]);
        if (n != null && n >= 1) best = { span: [m.index, m.index + m[0].length], n, sort: metricSort };
      }
    }
    const bare = TOPN_RE.exec(raw);
    if (bare && outside(bare.index)) {
      const n = parseNumber(bare[1] ?? bare[2] ?? "");
      if (n != null && n >= 1 && (!best || bare.index < best.span[0])) best = { span: [bare.index, bare.index + bare[0].length], n, sort: null };
    }
    if (!best && sort) {
      const counted = COUNTED_COMPANIES_RE.exec(raw);
      if (counted && outside(counted.index)) {
        const n = parseNumber(counted[1]);
        if (n != null && n >= 1) best = { span: [counted.index, counted.index + counted[0].length], n, sort: null };
      }
    }
    if (best) {
      if (!sort && best.sort) sort = best.sort;
      mark(best.span);
      topN = { span: best.span, n: best.n };
    }
  }

  // 3e. Date qualifiers (今天/今日/…) — consumed, never intent alone (V1 §6).
  for (const m of raw.matchAll(DATE_RE)) {
    if (outside(m.index)) mark([m.index, m.index + m[0].length]);
  }

  // 3f. Standalone AND-connectives are grammar, not semantics (stay-rise and
  // postcut matches already carry theirs; overlapping marks are skipped).
  for (const m of raw.matchAll(/并且|而且|同时|且/g)) {
    if (outside(m.index)) mark([m.index, m.index + m[0].length]);
  }

  // 4. Vague evaluation + vague time → ambiguous (no invented window/metric).
  const vagueEval = VAGUE_EVAL_RE.test(raw);
  const vagueTime = VAGUE_TIME_RE.test(raw);
  if (vagueEval && vagueTime) return refusals.ambiguousVague();

  // 4b. The V1 refusal disciplines are product law on the grammar path too:
  // advice/out-of-scope refuse on their own (the §14 lookahead protects
  // company-facts phrasing), future markers refuse under market language.
  const hasMarketIntentSoFar =
    Boolean(sort) || tracked.length > 0 || topN !== null || thresholds.length > 0 || comparison !== null || stayRise !== null;
  for (const rule of UNSUPPORTED_RULES) {
    const m = rule.re.exec(raw);
    if (!m) continue;
    if (rule.intent === "future_market_prediction" && !hasMarketIntentSoFar) continue;
    return {
      semantic: null,
      market: null,
      comparison: null,
      unsupported: { intent: rule.intent, detail: `${rule.detail}（触发词：「${m[0]}」）` },
      notes: [],
      assumptions: [],
    };
  }

  // 5. Window resolution (needs the market-intent picture from the scans) and
  // post-cut detection — both decide whether the query needs V2 at all.
  const hasV2Construct = thresholds.length > 0 || comparison !== null || stayRise !== null || (vagueEval && vagueTime);
  const hasV1MarketIntent = Boolean(sort) || tracked.length > 0 || topN !== null;
  const hasMarketIntent = hasV1MarketIntent || hasV2Construct;
  const windowHit = scanWindow(raw, outside, hasMarketIntent);
  if (windowHit) mark(windowHit.span);

  let postcutJoiner: RegExpExecArray | null = null;
  if (topN) {
    for (const m of raw.matchAll(/里|中|内|并且|而且|同时|且/g)) {
      if (m.index !== undefined && m.index >= topN.span[1]) {
        postcutJoiner = m as RegExpExecArray;
        break;
      }
    }
  }
  const postcutJoinerAt = postcutJoiner ? postcutJoiner.index : null;
  const postcut =
    postcutJoinerAt !== null &&
    [stayRise, ...thresholds.map((hit) => hit.span), ...tracked.map((entry) => entry.span)].some(
      (span) => span !== null && span[0] >= postcutJoinerAt!,
    );

  const windowForcesPhaseB = windowHit !== null && (windowHit.kind === "mapped" || windowHit.kind === "calendar");
  // An AND-connective next to market intent forces the grammar path too: V1
  // leaks the connective into the semantic residual (「而且的」), phase B cuts
  // it. Semantic-only connectives (做机器人而且自动化的公司 with no market
  // intent) stay untouched on the discovery path.
  const connectiveWithMarketIntent = /并且|而且|同时|且/.test(raw) && hasV1MarketIntent;
  if (!hasV2Construct && !postcut && !windowForcesPhaseB && !connectiveWithMarketIntent) return null;

  if (windowHit?.kind === "calendar") return refusals.calendarWindow(windowHit.text);
  if (windowHit?.kind === "v1-unsupported") {
    return {
      semantic: null,
      market: null,
      comparison: null,
      unsupported: {
        intent: "unsupported_time_window",
        detail: `「${windowHit.label}」没有已冻结的市场字段——现有窗口只有 5 日 / 20 日区间涨幅。`,
      },
      notes: [],
      assumptions: [],
    };
  }

  let windowField: "return5d" | "return20d" | null = null;
  if (windowHit && (windowHit.kind === "v1" || windowHit.kind === "mapped")) {
    windowField = windowHit.field;
    if (windowHit.kind === "mapped") assumptions.push(windowHit.note);
  }

  // 6. Bind the window: a 涨幅/跌幅 threshold or a 涨跌 sort carries it; a
  // window with neither is an honest refusal — never an approximation.
  if (windowField) {
    const returnThreshold = thresholds.find((hit) => hit.windowCapable);
    if (returnThreshold) {
      returnThreshold.field = windowField;
    } else if (sort && sort.field === "pctChange") {
      sort = { field: windowField, direction: sort.direction };
    } else {
      const label = windowHit && "label" in windowHit ? windowHit.label : "";
      if (sort || tracked.length || topN || thresholds.length) return refusals.windowWithUnsupportedSort(label);
      return refusals.windowWithoutSort(label);
    }
  }

  // 8. Comparison checks (registry field set + direction presence).
  if (comparison) {
    if ("unsupportedField" in comparison) return refusals.unsupportedComparisonField(comparison.unsupportedField);
    if ("ambiguous" in comparison) return refusals.ambiguousComparison();
  }

  // 9. Post-cut eligibility: a condition AFTER a stated top-N joined by
  // 里/中/内/并且/且/而且/同时 applies to the CUT set, not the market (§6).
  const postFilters: PlannerOutputFilter[] = [];
  if (topN && postcutJoiner && postcutJoinerAt !== null) {
    mark([postcutJoinerAt, postcutJoinerAt + postcutJoiner[0].length]);
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (thresholds[i].span[0] >= postcutJoinerAt) {
        postFilters.unshift({ field: thresholds[i].field, op: thresholds[i].op, value: thresholds[i].value });
        thresholds.splice(i, 1);
      }
    }
    for (let i = tracked.length - 1; i >= 0; i--) {
      if (tracked[i].span[0] >= postcutJoinerAt) {
        postFilters.unshift(tracked[i].filter);
        tracked.splice(i, 1);
      }
    }
  }

  // 10. Compile the remaining filters (streaks first per V1, then thresholds,
  // then stay-rise) in stable, deterministic order.
  const filters: PlannerOutputFilter[] = [...tracked.map((entry) => entry.filter)];
  for (const hit of thresholds) filters.push({ field: hit.field, op: hit.op, value: hit.value });
  if (stayRise) filters.push({ field: "pctChange", op: ">", value: 0 });

  // 11. Semantic residual — everything the grammar did NOT claim, verbatim.
  const residual = residualOf(raw, spans);
  const semantic = residual.length >= 2 ? residual : null;
  if (residual.length > 0 && !semantic) notes.push(`语义残留「${residual}」短于 2 字，按 market-only 执行。`);

  // 12. Top-N without any rank dimension → honest refusal (V1 rule).
  if (topN && !sort && !filters.length && !postFilters.length && !comparison) {
    return refusals.topnWithoutMetric(raw.slice(topN.span[0], topN.span[1]));
  }

  return {
    semantic,
    market: {
      date: "LATEST_TRADING_DAY",
      filters,
      postFilters,
      sort,
      limit: topN ? topN.n : null,
    },
    comparison: comparison && "field" in comparison ? { field: comparison.field, op: comparison.op } : null,
    unsupported: null,
    notes,
    assumptions,
  };
}
