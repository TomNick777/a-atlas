import { describe, expect, it } from "vitest";
import { runHybridQuery as runCurrentHybridQuery, type HybridExecuteOptions } from "../lib/hybrid/execute";
const runHybridQuery = (raw: string, options: HybridExecuteOptions = {}) => runCurrentHybridQuery(raw, { ...options, legacyReplay: true });
import { PHASE3_PRESETS } from "../lib/hybrid/presets3";
import { SHOWN } from "../lib/search/score";
import { loadCommittedMarketStateManifest, loadMarketStateRows } from "../lib/market/state";
import { loadPrevTradingDaySnapshot } from "../lib/market/prevday";
import { PARSER_V2_VERSION } from "../lib/planner/contracts";
import { fixtureSemanticEngine } from "./fixtures/semantic/provider";

/**
 * P1–P22 canonical suite — full-chain OFFLINE replay (Phase 3.2 Jev-First):
 *
 *   Natural Language → Deterministic Parser V2 → REAL validator → REAL
 *   normalizer → committed semantic fixtures → byte-checked Market State →
 *   Hybrid Executor → results.
 *
 * The whole chain is production code on the production path — no fixture
 * replaces the compiler anymore, because the compiler IS deterministic. Only
 * the semantic engine (Jev answers) replays from committed captures, and
 * market-snapshot anchors are recomputed in-file so a market refresh
 * re-baselines by re-running, never by silent drift.
 */

const semantic = fixtureSemanticEngine();
const manifest = loadCommittedMarketStateManifest();
const marketDay = manifest?.latestTradingDay ?? null;

const run = (query: string, options: Parameters<typeof runHybridQuery>[1] = {}) => runHybridQuery(query, {
  semanticEngine: semantic, log: false,
  marketInject: { manifest, rows: marketDay ? loadMarketStateRows(marketDay, manifest) ?? undefined : undefined },
  ...options,
});

const nonIncreasing = (values: number[]) => [...values].sort((a, b) => b - a).join(",") === values.join(",");
const nonDecreasing = (values: number[]) => [...values].sort((a, b) => a - b).join(",") === values.join(",");

/** A deterministic market-first scorer: every member of the market set scores
 * 0.99 (≥ SHOWN), so SHOWN eligibility keeps all true matches and the MARKET
 * metric alone owns the order — the mechanic under test here. */
const flatScorer = (_query: string, subset: { code: string }[]) => ({
  scores: subset.map(() => 0.99),
  live: true,
  model: "flat-test",
  outcome: null,
});

/** A minimal MarketStateRow with everything the executor touches. */
function stateRow(code: string, values: Partial<{ amount: number; pctChange: number; return20d: number; limitUpStreak: number; isLimitUp: boolean; turnoverRate: number; volumeRatio20d: number }>) {
  return {
    code,
    close: 10,
    volume: 1_000_000,
    amount: values.amount ?? 1e8,
    pctChange: values.pctChange ?? 1,
    limitBasis: "mainboard10",
    limitUpPrice: null,
    limitDownPrice: null,
    isLimitUp: values.isLimitUp ?? false,
    isLimitDown: false,
    limitUpStreak: values.limitUpStreak ?? 0,
    return5d: 1,
    return20d: values.return20d ?? 1,
    avgVolume20d: 500_000,
    avgAmount20d: 5e7,
    volumeRatio20d: values.volumeRatio20d ?? 1,
    turnoverRate: values.turnoverRate ?? 3,
    marketCapYi: 50,
  };
}

const SYNTHETIC_MANIFEST = {
  schemaVersion: "test", builderVersion: "test", generatedAt: "2026-09-29T00:00:00Z",
  latestTradingDay: "2026-09-28", tradingDays: ["2026-09-24", "2026-09-28"], window: { tradingDays: 2, start: "2026-09-24", end: "2026-09-28" },
  inputs: { dailyFiles: 2, universeSha16: "test", universeCount: 3, quoteFile: null, quoteCoherence: null },
  materializedDates: ["2026-09-28"],
  contentDigest: { algorithm: "sha256", scope: "test", value: "test0000test0000test0000test0000" },
  perDate: {}, audit: {},
} as never;

const syntheticEngine = (hits: Array<[string, number]>) => () => ({
  hits: hits.map(([code, probability]) => ({ code, name: `公司${code}`, probability, industry: "i", swLevel1Industry: "sw", province: "p", business: "b" })),
  matches: hits.length,
  searchId: null,
  degraded: false,
  decidedBy: "retrieval" as const,
  judgeOutcome: null,
});

describe("P-suite — multi-condition threshold filters (semantic-first)", () => {
  it("P1 成交额超过50亿的机器人公司: the filter is eligibility, not decoration", async () => {
    // Controlled rows prove the non-empty mechanics: 70亿 and 60亿 survive,
    // 40亿 is dropped as INELIGIBLE (not just ranked lower).
    const rows = [
      stateRow("600001", { amount: 70e8, pctChange: 2 }),
      stateRow("600002", { amount: 40e8, pctChange: 9 }),
      stateRow("600003", { amount: 60e8, pctChange: 1 }),
    ];
    const result = await run(PHASE3_PRESETS.P1, {
      semanticEngine: syntheticEngine([["600001", 0.9], ["600002", 0.95], ["600003", 0.8]]),
      marketInject: { manifest: SYNTHETIC_MANIFEST, rows: rows as never[] },
    });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.plan.market?.filters).toEqual([{ field: "amount", op: ">", value: 5e9 }]);
    expect(result.plan.market?.sort).toEqual({ field: "amount", direction: "desc" });
    expect(result.plan.heroMetric?.key).toBe("amount");
    expect(result.plan.assumptions?.join(" ")).toContain("未指定排序");
    expect(result.parser.route).toBe("deterministic");
    expect(result.results.map((row) => row.code)).toEqual(["600001", "600003"]);
    for (const row of result.results) expect(row.market?.state.amount ?? 0).toBeGreaterThan(5e9);
    expect(result.planCaption).toBe(`交易日 2026-09-28 · 语义「机器人」 · 成交额 > 50.00亿 · 按成交额排序`);
  });

  it("P1 on the frozen 2026-09-28 snapshot: every 机器人 semantic hit is under 50亿 → honestly empty", async () => {
    // The market day is a broad down day; the largest 机器人 hit trades ~12亿.
    // An empty result is the honest answer (§31) — not a relaxed filter.
    const result = await run(PHASE3_PRESETS.P1);
    expect(result.execution.marketDate).toBe(marketDay);
    expect(result.execution.degraded).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.execution.counts?.semanticEligible).toBe(0);
  });

  it("P2 换手率超过10%的消费电子公司: turnover eligibility on the snapshot day", async () => {
    const result = await run(PHASE3_PRESETS.P2);
    expect(result.plan.market?.filters).toEqual([{ field: "turnoverRate", op: ">", value: 10 }]);
    expect(result.results.length).toBeGreaterThan(0);
    for (const row of result.results) expect(row.market?.state.turnoverRate ?? 0).toBeGreaterThan(10);
  });

  it("P3 最近20日涨幅超过10%的储能公司: return20d filter, default return20d sort", async () => {
    const result = await run(PHASE3_PRESETS.P3);
    expect(result.plan.market?.filters).toEqual([{ field: "return20d", op: ">", value: 10 }]);
    expect(result.plan.market?.sort).toEqual({ field: "return20d", direction: "desc" });
    expect(result.results[0].hero?.key).toBe("return20d");
    for (const row of result.results) expect(row.market?.state.return20d ?? 0).toBeGreaterThan(10);
  });

  it("P4 涨幅过滤 + 成交额排序 compose: the filter is eligibility, the sort is the rank", async () => {
    const result = await run(PHASE3_PRESETS.P4);
    expect(result.plan.market?.filters).toEqual([{ field: "return20d", op: ">", value: 10 }]);
    expect(result.plan.market?.sort).toEqual({ field: "amount", direction: "desc" });
    expect(result.results.length).toBeGreaterThan(0);
    for (const row of result.results) expect(row.market?.state.return20d ?? 0).toBeGreaterThan(10);
    expect(nonIncreasing(result.results.map((row) => row.market?.state.amount ?? 0))).toBe(true);
  });

  it("P12 涨幅>20% AND 仍然上涨: two filters are one AND eligibility set", async () => {
    const result = await run(PHASE3_PRESETS.P12);
    expect(result.plan.market?.filters).toEqual([
      { field: "return20d", op: ">", value: 20 },
      { field: "pctChange", op: ">", value: 0 },
    ]);
    for (const row of result.results) {
      expect(row.market?.state.return20d ?? 0).toBeGreaterThan(20);
      expect(row.market?.state.pctChange ?? 0).toBeGreaterThan(0);
    }
  });

  it("P13 跌幅超过5%的创新药: negative threshold, worst-first default", async () => {
    const result = await run(PHASE3_PRESETS.P13);
    expect(result.plan.market?.filters).toEqual([{ field: "pctChange", op: "<", value: -5 }]);
    expect(result.plan.market?.sort).toEqual({ field: "pctChange", direction: "asc" });
    const pcts = result.results.map((row) => row.market?.state.pctChange ?? 0);
    expect(nonDecreasing(pcts)).toBe(true);
    for (const pct of pcts) expect(pct).toBeLessThan(-5);
  });
});

describe("P-suite — top-N cut with post-cut eligibility (market-first / market-only)", () => {
  it("P5 成交额前50并且换手率超过5%的机器人公司: postFilters apply AFTER the cut", async () => {
    const result = await run(PHASE3_PRESETS.P5, { subsetScorer: flatScorer });
    expect(result.plan.execution.order).toBe("market-first");
    expect(result.plan.market?.postFilters).toEqual([{ field: "turnoverRate", op: ">", value: 5 }]);
    expect(result.plan.market?.limit).toBe(50);
    expect(result.execution.counts?.marketSetSize ?? 51).toBeLessThanOrEqual(50);
    for (const row of result.results) {
      expect((row.probability ?? 0) >= SHOWN).toBe(true);
      expect(row.market?.state.turnoverRate ?? 0).toBeGreaterThan(5);
    }
    expect(nonIncreasing(result.results.map((row) => row.market?.state.amount ?? 0))).toBe(true);
    expect(result.planCaption).toContain("前50中换手率 > 5.00%");
  });

  it("P10 成交额前100里涨停的公司: market-only postcut — the cut is by amount, 涨停 keeps members", async () => {
    const result = await run(PHASE3_PRESETS.P10);
    expect(result.plan.execution.order).toBe("market-only");
    expect(result.plan.semantic).toBeNull();
    expect(result.plan.market?.postFilters).toEqual([{ field: "isLimitUp", op: "==", value: true }]);
    expect(result.execution.counts?.marketTotal).toBeGreaterThanOrEqual(result.execution.counts?.marketPostEligible ?? 0);
    expect(result.results.length).toBeLessThanOrEqual(100);
    for (const row of result.results) expect(row.market?.state.isLimitUp).toBe(true);
    expect(nonIncreasing(result.results.map((row) => row.market?.state.amount ?? 0))).toBe(true);
  });

  it("P11 成交额前50里有哪些机器人公司: V1 grammar inside the same compiler, untouched", async () => {
    const result = await run(PHASE3_PRESETS.P11, { subsetScorer: flatScorer });
    expect(result.plan.execution.order).toBe("market-first");
    expect(result.plan.market?.limit).toBe(50);
    expect(result.results[0].market?.state.amount).toBeGreaterThan(0);
  });
});

describe("P-suite — day-over-day comparison (P9)", () => {
  it("今天成交额比昨天高的AI芯片公司: comparison eligibility against the real previous trading day", async () => {
    const prev = loadPrevTradingDaySnapshot({ manifest });
    expect(prev.available).toBe(true);
    if (!prev.available) return;
    const result = await run(PHASE3_PRESETS.P9);
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.plan.comparison).toEqual({ field: "amount", op: ">" });
    expect(result.plan.market?.sort).toEqual({ field: "amount", direction: "desc" }); // normalizer default
    expect(result.plan.assumptions?.join(" ")).toContain("未指定排序");
    expect(result.execution.marketDate).toBe(marketDay);
    expect(result.results.length).toBeGreaterThan(0);
    // Recompute the baseline from the committed daily rows and verify each row.
    const dailyPrev = new Map(prev.byCode);
    const stateRows = new Map((marketDay ? loadMarketStateRows(marketDay, manifest) : [])?.map((row) => [row.code, row]));
    for (const row of result.results) {
      const today = stateRows.get(row.code);
      const before = dailyPrev.get(row.code);
      expect(today && before ? today.amount : -1).toBeGreaterThan(before ? before.amount : Number.MAX_SAFE_INTEGER);
    }
    expect(result.planCaption).toContain("成交额>上一交易日");
  });

  it("a company whose amount fell day-over-day is excluded even with high semantic score", async () => {
    // Synthetic rows: 600001 rose day-over-day (kept), 600002 fell (dropped
    // despite semantic eligibility), 600003 has no prev row (dropped — unknown
    // never compares, never guesses).
    const rows = [
      stateRow("600001", { amount: 2_000_000, pctChange: 1 }),
      stateRow("600002", { amount: 500, pctChange: 2 }),
      stateRow("600003", { amount: 5_000_000, pctChange: 3 }),
    ];
    const byCode = new Map([
      ["600001", { amount: 1_000_000, volume: 100, close: 10 }],
      ["600002", { amount: 5_000, volume: 100, close: 10 }],
    ]);
    const result = await run(PHASE3_PRESETS.P9, {
      semanticEngine: syntheticEngine([["600001", 0.9], ["600002", 0.8], ["600003", 0.7]]),
      marketInject: { manifest: SYNTHETIC_MANIFEST, rows: rows as never[] },
      prevDayInject: { byCode },
    });
    expect(result.plan.comparison).toEqual({ field: "amount", op: ">" });
    expect(result.results.map((row) => row.code)).toEqual(["600001"]);
  });
});

describe("P-suite — extended time mapping and honest windows", () => {
  it("P7 最近一个月涨得最多的半导体公司: month → return20d, frozen assumption recorded", async () => {
    const result = await run(PHASE3_PRESETS.P7);
    expect(result.plan.market?.sort).toEqual({ field: "return20d", direction: "desc" });
    expect(result.plan.assumptions?.join(" ")).toContain("一个月");
    expect(result.results[0].hero?.key).toBe("return20d");
  });

  it("P8 9月以来涨幅最大的创新药公司: no calendar-interval capability → honest unsupported", async () => {
    const result = await run(PHASE3_PRESETS.P8);
    expect(result.plan.execution.order).toBe("unsupported");
    expect(result.plan.unsupported?.intent).toBe("unsupported_time_window");
    expect(result.results).toEqual([]);
    expect(result.searchId).toBeNull();
  });
});

describe("P-suite — frozen ambiguity and volume disciplines", () => {
  it("P6 量比≥2 是明确阈值: market-only boolean-free numeric filter", async () => {
    const result = await run(PHASE3_PRESETS.P6);
    expect(result.plan.market?.filters).toEqual([{ field: "volumeRatio20d", op: ">=", value: 2 }]);
    expect(result.plan.market?.sort).toEqual({ field: "volumeRatio20d", direction: "desc" });
    for (const row of result.results) expect(row.market?.state.volumeRatio20d ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("P15 明显放量而且涨停: 涨停 filters, 量比 sorts, NO threshold invented", async () => {
    const result = await run(PHASE3_PRESETS.P15);
    expect(result.plan.execution.order).toBe("market-only");
    expect(result.plan.market?.filters).toEqual([{ field: "isLimitUp", op: "==", value: true }]);
    expect(result.plan.market?.sort).toEqual({ field: "volumeRatio20d", direction: "desc" });
    expect(result.plan.market?.filters.some((filter) => filter.field === "volumeRatio20d")).toBe(false);
    // The frozen invariant is "no invented threshold", not exact wording.
    expect(result.plan.notes.join(" ")).toMatch(/不(设|发明)[^。]*阈值/);
    for (const row of result.results) expect(row.market?.state.isLimitUp).toBe(true);
  });

  it("P14 至少三连板且成交额超过10亿: streak AND amount, streak-first default sort (controlled rows)", async () => {
    // Controlled rows: C fails the amount threshold, D fails the streak —
    // both are eligibility drops, not rank positions.
    const rows = [
      stateRow("600001", { limitUpStreak: 5, amount: 2e9, isLimitUp: true }),
      stateRow("600002", { limitUpStreak: 3, amount: 1.5e9, isLimitUp: true }),
      stateRow("600003", { limitUpStreak: 5, amount: 5e8, isLimitUp: true }),
      stateRow("600004", { limitUpStreak: 1, amount: 3e9, isLimitUp: false }),
    ];
    const result = await run(PHASE3_PRESETS.P14, {
      marketInject: { manifest: SYNTHETIC_MANIFEST, rows: rows as never[] },
    });
    expect(result.plan.execution.order).toBe("market-only");
    expect(result.plan.market?.filters).toEqual([
      { field: "limitUpStreak", op: ">=", value: 3 },
      { field: "amount", op: ">", value: 1e9 },
    ]);
    expect(result.plan.market?.sort).toEqual({ field: "limitUpStreak", direction: "desc" });
    expect(result.results.map((row) => row.code)).toEqual(["600001", "600002"]);
  });

  it("P14 on the frozen 2026-09-28 snapshot: no streak>=3 company traded 10亿+ → honestly empty", async () => {
    const result = await run(PHASE3_PRESETS.P14);
    expect(result.plan.unsupported).toBeNull();
    expect(result.results).toEqual([]);
  });

  it("P17 最近表现不错的机器人公司: ambiguous — no invented window, no invented metric", async () => {
    const result = await run(PHASE3_PRESETS.P17);
    expect(result.plan.execution.order).toBe("unsupported");
    expect(result.plan.unsupported?.intent).toBe("ambiguous_query");
    expect(result.results).toEqual([]);
  });

  it("P16 交易很活跃的机器人公司: V1 frozen default (amount desc + note) survives Phase 3.2", async () => {
    const result = await run(PHASE3_PRESETS.P16);
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.plan.market?.sort).toEqual({ field: "amount", direction: "desc" });
    expect(result.plan.notes.join(" ")).toContain("成交额");
  });
});

describe("P-suite — refusal and no-answer disciplines (§15/§31)", () => {
  it("P21 injection-shaped query refuses as investment advice; nothing runs", async () => {
    const result = await run(PHASE3_PRESETS.P21);
    expect(result.plan.execution.order).toBe("unsupported");
    expect(result.plan.unsupported?.intent).toBe("investment_advice");
    expect(result.results).toEqual([]);
    expect(result.searchId).toBeNull();
    expect(result.execution.order).toBe("unsupported");
  });

  it("P22 至少五连板且成交额超过500亿的消费电子: legal plan, honestly empty", async () => {
    const result = await run(PHASE3_PRESETS.P22);
    expect(result.plan.unsupported).toBeNull();
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.execution.degraded).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.execution.counts?.semanticEligible).toBe(0);
  });

  it("P18/P19/P20 predictions and advice refuse through the frozen V1 intents", async () => {
    const p18 = await run(PHASE3_PRESETS.P18);
    const p19 = await run(PHASE3_PRESETS.P19);
    const p20 = await run(PHASE3_PRESETS.P20);
    expect(p18.plan.unsupported?.intent).toBe("future_market_prediction");
    expect(p19.plan.unsupported?.intent).toBe("investment_advice");
    expect(p20.plan.unsupported?.intent).toBe("future_market_prediction");
    for (const result of [p18, p19, p20]) {
      expect(result.results).toEqual([]);
    }
  });
});

describe("P-suite — parser provenance reaches the result envelope (§24)", () => {
  it("every result carries the single deterministic route and version", async () => {
    const compiled = await run(PHASE3_PRESETS.P1);
    expect(compiled.parser).toMatchObject({ route: "deterministic", version: PARSER_V2_VERSION });
    expect(compiled.parser.parseMs).toBeGreaterThanOrEqual(0);
    const v1 = await run(PHASE3_PRESETS.P16);
    expect(v1.parser).toMatchObject({ route: "deterministic", version: PARSER_V2_VERSION });
  });

  // 22 full-chain replays ×2 — the 5s default budget flaked under parallel
  // cold dataset loads (Phase 3.5 added a dataset-reading test file); the
  // determinism assertion itself is unchanged.
  it("the full P1–P22 set compiles deterministically end-to-end (replay bytes stable)", { timeout: 20_000 }, async () => {
    for (const [key, query] of Object.entries(PHASE3_PRESETS)) {
      const first = await run(query);
      const second = await run(query);
      expect(JSON.stringify(second.plan), key).toBe(JSON.stringify(first.plan));
      expect(first.parser.route, key).toBe("deterministic");
    }
  });
});
