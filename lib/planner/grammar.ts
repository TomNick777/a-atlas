/**
 * QueryGrammarRegistry (Phase 3.2 §14) — the frozen description of HOW users
 * express market-query capabilities in Chinese, and the single entry point for
 * extending the deterministic query language.
 *
 *   Query Grammar  →  DSL  →  Capability Registry validation  →  Executor
 *
 * (lib/planner/capabilities.ts stays the authority on what the EXECUTOR can
 * answer; this file is the authority on how that capability is WRITTEN.)
 *
 * Discipline (§16): this registry holds market QUERY LANGUAGE only — time
 * words, numeric units, operator words, market-field aliases, sort phrases,
 * TopN/postFilter/comparison syntax, ambiguity and refusal rules. It must
 * NEVER contain an industry / product / concept word: whatever the grammar
 * does not claim stays in the semantic residual and goes to Jev VERBATIM
 * (§9–§11 — Atlas 不做第二个 Jev). A boundary test pins the file itself to
 * zero such words, comments included.
 *
 * Every table here is consumed mechanically by lib/hybrid/parser-v2.ts; a
 * grammar row that the parser does not execute must not exist.
 */

/** Bumped when grammar rules change parse outcomes. */
export const QUERY_GRAMMAR_REGISTRY_VERSION = "query-grammar-2";
/** M3 set/quantity syntax; consumed by the selection compiler. */
export const SELECTION_COUNT_RE = /([0-9０-９]{1,3}|[一二两三四五六七八九十]{1,3})\s*(?:家|只|个)(?=\S)/;
export const MARKET_SUBSET_RE = /(?:前|top)\s*[0-9０-９一二两三四五六七八九十]{1,3}\s*(?:名|个|只|家)?\s*(?:里|中|内)/i;
export const MARKET_ALL_RE = /全市场/g;

export type GrammarComparisonOp = ">" | ">=" | "<" | "<=";

/** Numeric literal: Arabic (full-width normalized) with an optional decimal. */
const NUM_SRC = String.raw`[0-9０-９]+(?:\.[0-9０-９]+)?`;

/** 操作词 → DSL op（冻结映射）。Prefix form: 成交额超过50亿. */
export const OPERATOR_WORDS: ReadonlyArray<{ words: readonly string[]; op: GrammarComparisonOp }> = [
  { words: ["超过", "大于", "高于", "超出", "高出", "多于"], op: ">" },
  { words: ["达到", "不少于", "不低于", "至少"], op: ">=" },
  { words: ["不足", "不到", "低于", "小于", "少于"], op: "<" },
  { words: ["不超过", "至多", "不高于"], op: "<=" },
];

/** Postfix form: 成交额50亿以上. Same ops, word order after the number. */
export const POSTFIX_OPERATORS: ReadonlyArray<{ words: readonly string[]; op: GrammarComparisonOp }> = [
  { words: ["以上", "及以上"], op: ">=" },
  { words: ["以下", "及以下"], op: "<=" },
];

/** Symbol operators (量比≥2). */
export const SYMBOL_OPERATORS: ReadonlyArray<{ symbol: string; op: GrammarComparisonOp }> = [
  { symbol: ">=", op: ">=" },
  { symbol: "≥", op: ">=" },
  { symbol: ">", op: ">" },
  { symbol: "<=", op: "<=" },
  { symbol: "≤", op: "<=" },
  { symbol: "<", op: "<" },
];

/** 市场指标词 → capability 字段。Only market language (§16); scales are the
 * unit each value arrives in (50亿 → 5e9 元; 市值100亿 → 100 亿元单位). */
export type MetricAlias = {
  /** longest-first alternation source (成交额 before 成交). */
  pattern: string;
  field: "amount" | "volume" | "turnoverRate" | "volumeRatio20d" | "marketCapYi" | "close" | "pctChange";
  /** unit word the number carries, and its multiplier onto the field value. */
  scales: ReadonlyArray<{ unit: string; factor: number }>;
  /** pct-style fields whose value is the percent number itself. */
  percentField: boolean;
  /** 涨幅/跌幅 can bind a materialized window (最近20日涨幅 → return20d). */
  windowCapable: boolean;
  /** 跌幅 flips the operator and negates the value (P13: 跌幅超过5% → pctChange < -5). */
  inverted: boolean;
};

export const METRIC_ALIASES: ReadonlyArray<MetricAlias> = [
  { pattern: "成交金额|成交额", field: "amount", scales: [{ unit: "亿", factor: 1e8 }, { unit: "万", factor: 1e4 }, { unit: "元", factor: 1 }], percentField: false, windowCapable: false, inverted: false },
  { pattern: "成交量", field: "volume", scales: [{ unit: "亿", factor: 1e8 }, { unit: "万", factor: 1e4 }, { unit: "股", factor: 1 }], percentField: false, windowCapable: false, inverted: false },
  { pattern: "换手率|换手", field: "turnoverRate", scales: [{ unit: "%", factor: 1 }, { unit: "％", factor: 1 }], percentField: true, windowCapable: false, inverted: false },
  { pattern: "量比", field: "volumeRatio20d", scales: [{ unit: "倍", factor: 1 }], percentField: false, windowCapable: false, inverted: false },
  { pattern: "市值", field: "marketCapYi", scales: [{ unit: "亿", factor: 1 }, { unit: "万", factor: 1e-4 }], percentField: false, windowCapable: false, inverted: false },
  { pattern: "收盘价|股价", field: "close", scales: [{ unit: "元", factor: 1 }], percentField: false, windowCapable: false, inverted: false },
  { pattern: "涨跌幅|涨幅", field: "pctChange", scales: [{ unit: "%", factor: 1 }, { unit: "％", factor: 1 }], percentField: true, windowCapable: true, inverted: false },
  { pattern: "跌幅", field: "pctChange", scales: [{ unit: "%", factor: 1 }, { unit: "％", factor: 1 }], percentField: true, windowCapable: true, inverted: true },
];

export const METRIC_ALTERNATION = METRIC_ALIASES.map((m) => m.pattern).join("|");

const OP_ALT = OPERATOR_WORDS.flatMap((g) => g.words).join("|");
const POSTFIX_ALT = POSTFIX_OPERATORS.flatMap((g) => g.words).join("|");
const SYMBOL_ALT = SYMBOL_OPERATORS.map((s) => s.symbol.replace(/[>=<]/g, (c) => `\\${c}`)).join("|");

/** A threshold phrase: metric + [operator] + number + [unit] + [postfix op].
 * An operator word (prefix or postfix) is REQUIRED — a bare number next to a
 * metric is not a frozen threshold and must not be invented (§12). */
export const THRESHOLD_PHRASE = new RegExp(
  `(${METRIC_ALTERNATION})\\s*(${OP_ALT})?\\s*(${NUM_SRC})\\s*(万|亿)?\\s*(元|%|％|倍|股)?\\s*(${POSTFIX_ALT})?`,
  "g",
);

export const THRESHOLD_HAS_OPERATOR = (prefix: string | undefined, postfix: string | undefined): boolean =>
  Boolean(prefix) || Boolean(postfix);

/** 量比 speciality: 「成交量达到20日均量2倍以上」 — the 20-day average-volume
 * ratio phrasing binds to volumeRatio20d (P6). */
export const VOLUME_RATIO_PHRASE = new RegExp(
  String.raw`成交量(?:达到|为|是|超)?\s*(?:20\s*日)?(?:均量|平均量|平均成交量|均成交量)\s*(?:的)?\s*(${NUM_SRC})\s*倍?\s*(以上|至少)?`,
  "g",
);

/** 已物化时间窗口 — the ONLY intervals Market State can answer (§14 registry
 * timeMapping). Everything else is calendar language → honest refusal. */
export type WindowMapping = {
  /** matches the natural expression (checked BEFORE the calendar refusal scan). */
  re: RegExp;
  label: string;
  windowField: "return5d" | "return20d";
  note: string;
};

export const WINDOW_MAPPINGS: ReadonlyArray<WindowMapping> = [
  {
    re: /(?:最近|近|过去)\s*一\s*周|一周以来/,
    label: "一周",
    windowField: "return5d",
    note: "「一周」按最近 5 个交易日解释（frozen mapping）。",
  },
  {
    re: /(?:最近|近|过去)\s*一\s*个?\s*月|一个月以来/,
    label: "一个月",
    windowField: "return20d",
    note: "「一个月」按最近 20 个交易日解释（frozen mapping）。",
  },
];

/** V1's explicit-day window (最近5日/最近20日…), consumed from lib/hybrid/planner. */

/** Calendar language with NO materialized field. A refusal ONLY when the query
 * otherwise carries market language — pure company-facts queries keep the
 * discovery path (§14 preservation). */
export const CALENDAR_UNSUPPORTED_RE =
  /上周|上个月|上月|本月以来|今年以来|今年|去年|近一年|过去一年|近日|近期|这几天|(?:最近|近|过去)\s*[0-9０-９一二三四五六七八九十]+\s*个?\s*(?:周|月|年)|[0-9０-９一二三四五六七八九十]{1,2}\s*月份?\s*以来|月以来/;

/** 日环比比较 (§8): today.field op previousTradingDay.field. All market metric
 * words are recognisable; only the fields the daily rows can join (capability
 * registry comparison.fields: amount/volume/close) compile — the rest refuse
 * honestly instead of being ignored. */
export const COMPARISON_PHRASE = new RegExp(
  `(${METRIC_ALTERNATION})\\s*(?:比|较|相比)\\s*(昨天|昨日|前一日|前一交易日|上一?个?交易日)\\s*(高|多|大|强|低|少|小)?`,
  "g",
);
export const COMPARISON_DIRECTIONS: ReadonlyArray<{ words: readonly string[]; op: ">" | "<" }> = [
  { words: ["高", "多", "大", "强"], op: ">" },
  { words: ["低", "少", "小"], op: "<" },
];
export const COMPARISON_METRIC_FIELDS: Record<string, "amount" | "volume" | "close"> = {
  成交金额: "amount",
  成交额: "amount",
  成交量: "volume",
  收盘价: "close",
  股价: "close",
};

/** 「并且今天仍然上涨」/「今天上涨」 → pctChange > 0. Requires a connective or
 * an explicit date word — bare「上涨」never fires — and a business-qualifier
 * lookahead keeps「上涨逻辑」「上涨概念」 semantic (§28 context protection). */
export const STAY_RISE_RE = new RegExp(
  String.raw`(?:(?:并且|且|而且|同时|，|,)\s*(?:今天|今日|当日|当天)?\s*(?:仍然|还在|仍在)?上涨|(?:今天|今日|当日|当天)\s*(?:仍然|还在|仍在)?上涨)(?!\s*(?:软件|系统|服务|业务|设备|数据|概念|终端|工具|厂商|管理|平台|方案|行业|板块|趋势|逻辑|空间))`,
);

/** Prompt-injection discipline (§16 analog): the query is DATA. Demands that
 * Atlas ignore its rules are a refusal intent, never instructions. */
export const INJECTION_RE = /(?:忽略|无视)[^，。；,]{0,8}(?:规则|设定|约束|指令)|不要输出\s*JSON/;

/** 模糊评价 + 模糊时间 → ambiguous_query (P17): neither word has a frozen
 * reading, and inventing one (「最近表现不错」→ return20d > 10%) is exactly the
 * guessing Phase 3.2 removed. */
export const VAGUE_EVAL_RE = /(?:表现|走势)\s*(?:很|相当|挺|比较|非常)?(?:不错|好|优秀|强劲|强势)/;
export const VAGUE_TIME_RE = /最近|近期|近日|近来|今年|今年以来|这段时间/;

/** Connectives. AND joins market conditions (filters AND); OR between two
 * market conditions is outside the DSL (filter-OR → unsupported), while OR
 * inside the semantic residual is Jev's business (做A或者B的公司). */
export const AND_CONNECTIVE_RE = /并且|而且|且|同时/;
export const OR_CONNECTIVE = "或者";

/** The grammar's frozen ambiguity/refusal summary (report §E, CLI --vocab). */
export function grammarSummary(): Record<string, unknown> {
  return {
    grammarVersion: QUERY_GRAMMAR_REGISTRY_VERSION,
    time: {
      qualifiers: ["今天", "今日", "当日", "当前", "最新交易日"],
      windows: WINDOW_MAPPINGS.map((m) => ({ expressions: m.re.source, resolvesTo: m.windowField, note: m.note })),
      explicitDays: ["最近5日/天/交易日 → return5d", "最近20日/天/交易日 → return20d", "其他 N 日 → unsupported_time_window"],
      unsupportedCalendar: CALENDAR_UNSUPPORTED_RE.source,
    },
    numeric: {
      units: { 亿: "1e8（元/股类字段）", 万: "1e4（元/股类字段）", "%": "百分数字段直接用数值", 倍: "倍数字段直接用数值", 元: "1" },
      chineseNumerals: "一至九十九（数量词：三个涨停/前二十）",
      noInventedThresholds: true,
    },
    operators: {
      prefix: Object.fromEntries(OPERATOR_WORDS.map((g) => [g.op, g.words])),
      postfix: Object.fromEntries(POSTFIX_OPERATORS.map((g) => [g.op, g.words])),
      symbols: SYMBOL_OPERATORS.map((s) => `${s.symbol}→${s.op}`),
    },
    marketFieldAliases: METRIC_ALIASES.map((m) => ({ words: m.pattern.split("|"), field: m.field })),
    sortPhrases: "见 lib/hybrid/planner.ts SORT_RULES（grammar 直接复用 V1 冻结排序词表）",
    topN: ["成交额前20", "涨幅前10", "前20名", "Top20", "最大的10家公司"],
    selection: { count: SELECTION_COUNT_RE.source, postCut: MARKET_SUBSET_RE.source, global: MARKET_ALL_RE.source, rule: "集合内前K默认顺序扫描；全市场或前N里/中/内限定为截断集合，不补位。" },
    postFilter: "「A前N里/中/内/并且B」→ 先按 A 排序取前 N，B 施加于截断集（B 在截断短语之后出现）",
    comparison: { phrases: COMPARISON_PHRASE.source, fields: Object.values(COMPARISON_METRIC_FIELDS).filter((v, i, a) => a.indexOf(v) === i), baseline: "PREV_TRADING_DAY" },
    ambiguity: [
      { shape: "表现/走势 + 不错/好/…", rule: "有模糊时间 → ambiguous_query；单独出现 → 语义透传（§14）" },
      { shape: "环比无方向词", rule: "ambiguous_query" },
    ],
    unsupported: [
      "future_market_prediction（明天/预测类）",
      "investment_advice（买卖建议/直接给名单类）",
      "out_of_scope_domain（MACD/资金流/财务指标等非市场状态字段）",
      "unsupported_time_window（未物化日历窗口）",
      "unsupported_or_combination（两个市场条件的 OR）",
      "unsupported_market_field（跌停连板等不存在的字段）",
      "topn_without_metric（前 N 无排序维度）",
      "window_with_unsupported_sort（窗口搭配非涨跌排序）",
      "ambiguous_query（无冻结解释的模糊表述）",
    ],
    semanticBoundary: "行业/产品/公司概念不属于 grammar —— 未被 grammar 认领的文本原样进入 semantic residual 交 Jev（§10/§11）",
  };
}
