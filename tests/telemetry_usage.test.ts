import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHybridQuery } from "../lib/hybrid/execute";
import type { SubsetScores } from "../lib/hybrid/execute";
import type { HybridDiscoverResult } from "../lib/hybrid/contracts";
import { computeJevValue, recordJevCall } from "../lib/telemetry/jev";
import { discoverCompleted, discoverReceived } from "../lib/telemetry/discover";
import { buildUsageSummary, buildTraceView } from "../lib/telemetry/usage";
import { TelemetryStore } from "../lib/telemetry/store";
import { isFeedbackRating, isFeedbackReason } from "../lib/telemetry/types";
import { deriveFixture, fixtureManifest } from "./fixtures/market_fixture";

/**
 * Product Usage Baseline — every real search gets one trace, Jev cost and
 * value are observable, feedback is recordable, and telemetry changes no
 * business result. All offline.
 */

function tmpStore(): TelemetryStore {
  return new TelemetryStore(mkdtempSync(path.join(tmpdir(), "telemetry-usage-")));
}

// ---- §1.1 behaviour invariance: telemetry on/off ⇒ identical answers -------

describe("usage baseline — telemetry must not change the answer (§1.1/§19.17)", () => {
  it("log:true and log:false produce identical business results (offline, Jev skipped)", async () => {
    const query = "做伺服电机的公司";
    const without = await runHybridQuery(query, { log: false, skipJev: true });
    const withTelemetry = await runHybridQuery(query, { log: true, skipJev: true, origin: "smoke" });
    const strip = (result: typeof without) =>
      JSON.parse(
        JSON.stringify({
          plan: result.plan,
          parser: { route: result.parser.route, version: result.parser.version },
          rows: result.results.map((row) => ({ code: row.code, probability: row.probability, judgement: row.judgement })),
          execution: {
            order: result.execution.order,
            degraded: result.execution.degraded,
            counts: result.execution.counts,
            marketDate: result.execution.marketDate,
          },
          planCaption: result.planCaption,
        }),
      ) as Record<string, unknown>;
    expect(strip(withTelemetry)).toEqual(strip(without));
  });
});

// ---- §2/§19.1: every discover order carries the caller's trace id ----------

const manifest = fixtureManifest();
const { rows } = deriveFixture();
const fakeCompanies = rows.map((row) => ({
  code: row.code,
  name: row.code,
  fullName: row.code,
  exchange: row.code.startsWith("6") ? "SH" : /^(4|8|9)/.test(row.code) ? "BJ" : "SZ",
  board: "main",
  industry: "测试行业",
  swLevel1Industry: "测试SW",
  businessDescription: `${row.code}的主营业务`,
  mainProducts: [],
  concepts: [],
  region: { province: "测试省", city: "" },
  companyDescription: "",
  searchableText: `${row.code} ${row.code}的主营业务 光模块 储能`,
  judgeText: `${row.code} 测试 judge text`,
  marketCap: 100,
})) as unknown as import("../lib/types").Company[];
const marketInject = { manifest, rows, companies: fakeCompanies };

const scorer =
  (scores: Array<[string, number]>): ((query: string, subset: import("../lib/types").Company[]) => SubsetScores) =>
  (_query, subset) => ({
    scores: subset.map((company) => scores.find(([code]) => code === company.code)?.[1] ?? 0),
    live: true,
    model: "test-model",
    outcome: "ok",
    jev: {
      capability: "semantic_match",
      contractVersion: "semantic-match-1",
      status: "ok",
      outcome: null,
      tokens: 900,
      costUsd: 0.0000378,
      judgeMs: 12,
      totalMs: 14,
      chunks: 1,
      answeredChunks: 1,
      decisions: subset.length,
      matchedFalse: subset.length - scores.length,
    },
  });

describe("usage baseline — one trace id per search, every order (§2)", () => {
  it("unsupported intents carry the trace id (previously: none)", async () => {
    const result = await runHybridQuery("明天最可能涨停的机器人公司", { traceId: "s_test_abc123" });
    expect(result.execution.order).toBe("unsupported");
    expect(result.searchId).toBe("s_test_abc123");
  });

  it("market-only answers carry the trace id", async () => {
    const result = await runHybridQuery("连续三个涨停的公司", { traceId: "s_test_def456", marketInject });
    expect(result.execution.order).toBe("market-only");
    expect(result.searchId).toBe("s_test_def456");
  });

  it("market-first carries the trace id plus jev value/summary from this layer's call", async () => {
    const result = await runHybridQuery("今天成交额前20中有哪些光模块公司", {
      traceId: "s_test_123abc",
      legacyReplay: true,
      marketInject,
      subsetScorer: scorer([
        [rows[0]?.code ?? "600001", 0.9],
        [rows[1]?.code ?? "600002", 0.8],
      ]),
    });
    expect(result.execution.order).toBe("market-first");
    expect(result.searchId).toBe("s_test_123abc");
    expect(result.jevSummary?.calls).toBe(1);
    expect(result.jevSummary?.tokens).toBe(900);
    expect(result.jevValue?.compared).toBe(true);
    // Pre-order = the market set; post-order = the eligible rows, market order kept.
    expect(result.jevValue?.postTop.length).toBeLessThanOrEqual(result.jevValue?.preTop.length ?? 0);
  });
});

// ---- §5 Jev value derivation ------------------------------------------------

describe("usage baseline — computeJevValue (§5)", () => {
  it("reports no change when Jev kept the order", () => {
    const value = computeJevValue(["a", "b", "c"], ["a", "b", "c"], 0);
    expect(value).toMatchObject({ compared: true, top1Changed: false, top10Changed: false, rankingChanged: false, promotedIntoTop10: 0, droppedFromTop10: 0 });
  });

  it("detects a top1 change and a promotion into the top10", () => {
    const pre = Array.from({ length: 15 }, (_, at) => `c${String(at + 1).padStart(2, "0")}`);
    const post = ["c14", ...pre.slice(0, 14)];
    const value = computeJevValue(pre, post, 3);
    expect(value.top1Changed).toBe(true);
    expect(value.top10Changed).toBe(true);
    expect(value.rankingChanged).toBe(true);
    expect(value.promotedIntoTop10).toBe(1);
    expect(value.droppedFromTop10).toBe(1);
    expect(value.jevRemovedCount).toBe(3);
  });

  it("records honestly when there is nothing to compare", () => {
    expect(computeJevValue([], [], null).compared).toBe(false);
    expect(computeJevValue(["a"], [], null).compared).toBe(false);
  });
});

// ---- §4 JEV_CALL ------------------------------------------------------------

describe("usage baseline — JEV_CALL cost record (§4)", () => {
  it("writes one event with call identity, tokens, estimated cost and no-cache", async () => {
    const store = tmpStore();
    try {
      await recordJevCall({
        searchId: "s_test_abc789",
        sessionId: null,
        invocation: "discovery_rerank",
        capability: "semantic_match",
        contractVersion: "semantic-match-1",
        runtimeModel: "jev-1.13.0",
        status: "ok",
        outcome: null,
        subjectCount: 200,
        decisionCount: 200,
        chunkCount: 2,
        answeredChunks: 2,
        tokens: 4200,
        costUsd: 0.000176,
        judgeMs: 540,
        totalMs: 545,
        retries: 0,
        timeouts: 0,
        store,
      });
      await store.flush();
      const { events } = await store.readEvents();
      const call = events.find((event) => event.eventType === "JEV_CALL");
      expect(call).toBeTruthy();
      expect(call?.searchId).toBe("s_test_abc789");
      expect(call?.payload).toMatchObject({
        invocation: "discovery_rerank",
        capability: "semantic_match",
        tokens: 4200,
        costEstimated: true,
        cacheHit: false,
        subjectCount: 200,
        chunkCount: 2,
      });
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });
});

// ---- §2/§6 discover trace events --------------------------------------------

function fakeDiscoverResult(searchId: string): HybridDiscoverResult {
  return {
    query: "给英伟达提供液冷设备的A股公司",
    plan: { plannerVersion: "hybrid-planner-v1", raw: "q", semantic: { query: "q" }, market: null, execution: { order: "semantic-only" }, heroMetric: null, notes: [], unsupported: null },
    parser: { route: "deterministic", version: "hybrid-parser-v2", parseMs: 1 },
    execution: { order: "semantic-only", timings: { parserMs: 1, semanticMs: 10, marketMs: null, mergeMs: null, totalMs: 12 }, degraded: false, degradedReason: null, decidedBy: "jev", counts: {}, marketDate: null, stateDigest16: null },
    results: [
      {
        code: "300001",
        name: "甲",
        exchange: "SZ",
        board: "main",
        industry: "t",
        swLevel1Industry: "t",
        province: "t",
        business: "t",
        probability: 0.9,
        semantic: { query: "q", score: 0.9, matchedFacts: ["液冷", "服务器"] },
        market: null,
        hero: null,
        judgement: { capability: "semantic_relation", query: "q", score: 0.9, matched: true, relationLabel: "供应商", evidenceRefs: [{ companyId: "300001", ref: "judge-profile:300001" }] },
      },
    ],
    planCaption: "",
    intelligence: null,
    searchId,
    ms: 12,
    jevValue: null,
  } as unknown as HybridDiscoverResult;
}

describe("usage baseline — discover trace events (§2/§3/§6)", () => {
  it("RECEIVED + RESPONSE_READY share the trace id and carry plan, snapshot and refs", async () => {
    const store = tmpStore();
    try {
      const searchId = "s_test_456def";
      const link = await discoverReceived({ searchId, rawQuery: "给英伟达提供液冷设备的A股公司", origin: "organic_ui", sessionId: "sess_test0000001", cached: false, corrupt: false, store });
      await discoverCompleted({ searchId, sessionId: "sess_test0000001", result: fakeDiscoverResult(searchId), jevSummary: null, cached: false, serverMs: 12, store });
      await store.flush();
      const { events } = await store.readEvents();
      const received = events.find((event) => event.eventType === "DISCOVER_RECEIVED");
      const ready = events.find((event) => event.eventType === "DISCOVER_RESPONSE_READY");
      expect(received?.searchId).toBe(searchId);
      expect(ready?.searchId).toBe(searchId);
      expect(received?.payload.queryHash).toBeTruthy();
      expect(received?.payload.marketIdentity).toBeTruthy();
      expect(link.eligibility).toBe("CANDIDATE");
      expect((ready?.payload.plan as { plannerVersion?: string }).plannerVersion).toBe("hybrid-planner-v1");
      expect((ready?.payload.execution as { order?: string }).order).toBe("semantic-only");
      const snapshot = ready?.payload.snapshot as Array<{ code: string; judgement: { evidenceRefs: string[] } | null }>;
      expect(snapshot[0]?.code).toBe("300001");
      expect(snapshot[0]?.judgement?.evidenceRefs).toEqual(["judge-profile:300001"]);
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });
});

// ---- §8 feedback + §13 summary ----------------------------------------------

describe("usage baseline — feedback vocabulary and usage summary (§8/§13)", () => {
  it("holds feedback to its closed vocabulary", () => {
    expect(isFeedbackRating("good")).toBe(true);
    expect(isFeedbackRating("excellent")).toBe(false);
    expect(isFeedbackReason("too_slow")).toBe(true);
    expect(isFeedbackReason("ugly")).toBe(false);
  });

  it("summarizes searches, jev cost, clicked rank and feedback from the stream", async () => {
    const store = tmpStore();
    try {
      const { emit } = await import("../lib/telemetry/emit");
      const base = { store, component: "next" as const };
      // organic fresh search with results
      await emit("DISCOVER_RECEIVED", "search", { rawQuery: "q1", organicEligibility: "CANDIDATE", cached: false }, { ...base, searchId: "s_test_aaa001" });
      await emit("DISCOVER_RESPONSE_READY", "search", { cached: false, serverMs: 100, resultCount: 2, execution: { order: "semantic-only", degraded: false, timings: { parserMs: 1, semanticMs: 10 } }, snapshot: [{ rank: 1, code: "600001" }, { rank: 2, code: "600002" }], jevSummary: null }, { ...base, searchId: "s_test_aaa001" });
      // organic no-result search
      await emit("DISCOVER_RECEIVED", "search", { rawQuery: "q2", organicEligibility: "CANDIDATE", cached: false }, { ...base, searchId: "s_test_aaa002" });
      await emit("DISCOVER_RESPONSE_READY", "search", { cached: false, serverMs: 90, resultCount: 0, execution: { order: "market-only", degraded: false, timings: { marketMs: 5 } }, snapshot: [], jevSummary: null }, { ...base, searchId: "s_test_aaa002" });
      // cache hit
      await emit("DISCOVER_RECEIVED", "search", { rawQuery: "q1", organicEligibility: "EXCLUDED_CACHE", cached: true }, { ...base, searchId: "s_test_aaa003" });
      // jev call for the first search
      await emit("JEV_CALL", "search", { capability: "semantic_match", tokens: 500, costUsd: 0.000021, status: "ok", cacheHit: false }, { ...base, searchId: "s_test_aaa001" });
      // interactions: click rank 2 of the first search
      await emit("RESULT_OPEN_DETAIL", "interaction", { code: "600002" }, { ...base, searchId: "s_test_aaa001" });
      await emit("SEARCH_RESULTS_VISIBLE", "search", { timeToVisibleResultsMs: 180 }, { ...base, searchId: "s_test_aaa001" });
      // feedback: rating + reason on the first search
      await emit("SEARCH_FEEDBACK", "interaction", { rating: "bad" }, { ...base, searchId: "s_test_aaa001" });
      await emit("SEARCH_FEEDBACK", "interaction", { rating: "bad", reason: "missing_company" }, { ...base, searchId: "s_test_aaa001" });
      await store.flush();

      const now = new Date();
      const summary = await buildUsageSummary(store, { since: new Date(now.getTime() - 3600_000).toISOString(), until: now.toISOString() });
      expect(summary.search.searches).toBe(3);
      expect(summary.search.cacheHits).toBe(1);
      expect(summary.search.organic).toBe(2);
      expect(summary.search.noResult).toBe(1);
      expect(summary.jev.calls).toBe(1);
      expect(summary.jev.tokensTotal).toBe(500);
      expect(summary.jev.zeroJevOrganicSearches).toBe(1); // the no-result market search
      expect(summary.interaction.openDetail).toBe(1);
      expect(summary.interaction.avgClickedRank).toBe(2);
      expect(summary.interaction.top3Clicks).toBe(1);
      expect(summary.interaction.feedback.bad).toBe(1);
      expect(summary.interaction.feedback.reasons.missing_company).toBe(1);
      expect(summary.latency.serverMs.p50).toBeGreaterThan(0);

      // §14: the same stream rebuilds one search end to end
      const view = await buildTraceView(store, "s_test_aaa001");
      expect(view?.received?.eventType).toBe("DISCOVER_RECEIVED");
      expect(view?.ready?.eventType).toBe("DISCOVER_RESPONSE_READY");
      expect(view?.jevCalls).toHaveLength(1);
      expect(view?.feedback).toHaveLength(2);
      expect(view?.searchLogRun).toBeNull();
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });
});
