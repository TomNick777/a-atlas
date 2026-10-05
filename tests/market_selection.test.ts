import { afterEach, describe, expect, it, vi } from "vitest";
import { compileHybridQuery } from "../lib/hybrid/compile";
import { runHybridQuery } from "../lib/hybrid/execute";
import { selectMarketMembers, MARKET_SELECTION_BUDGET } from "../lib/hybrid/market-selection";
import { runMarketEligibility, resetMarketEligibilityCache, setJevProviderOverride, type EligibilityBatch, type JudgementSubject } from "../lib/jev/capabilities";
import type { JudgeProvider } from "../lib/jev/provider";
import type { Company, ResultJudgement } from "../lib/types";
import { deriveFixture, fixtureManifest } from "./fixtures/market_fixture";

const judgement = (code: string, score = 0.8): ResultJudgement => ({ capability: "semantic_match", query: "业务原文", score, matched: true, relationLabel: null, evidenceRefs: [{ companyId: code, ref: "fact" }] });
const judge = (states: Record<string, "confirmed" | "rejected" | "unknown">) => async (rows: { code: string }[]): Promise<EligibilityBatch> => ({ decisions: rows.map(r => ({ companyId: r.code, state: states[r.code] ?? "rejected", judgement: states[r.code] === "confirmed" ? judgement(r.code) : null })), cacheHits: 0, estimatedCostUsd: 0.001, call: null });
const rows = Array.from({ length: 150 }, (_, i) => ({ code: String(600000 + i) }));
afterEach(() => { setJevProviderOverride(null); resetMarketEligibilityCache(); vi.useRealTimers(); });

describe("M3 scope contract", () => {
  it.each([
    ["今天涨幅最高的20家机器人公司", "business-topk", 20, "机器人"],
    ["今天涨幅最高的二十家机器人公司", "business-topk", 20, "机器人"],
    ["今天涨幅最高的２０家机器人公司", "business-topk", 20, "机器人"],
    ["今天领涨的机器人公司", "business-topk", 20, "机器人"],
    ["机器人公司成交额前10", "business-topk", 10, "机器人"],
    ["今天成交额前20家机器人公司", "business-topk", 20, "机器人"],
    ["全市场成交额前20家中有哪些机器人公司", "market-topn-subset", 20, "机器人"],
    ["全市场成交额前20中有哪些机器人公司", "market-topn-subset", 20, "机器人"],
    ["今天成交额前20中有哪些光模块公司", "market-topn-subset", 20, "光模块"],
  ])("%s", (query, scope, limit, residual) => {
    const p = compileHybridQuery(query).plan;
    expect(p.selection).toMatchObject({ scope, limit }); expect(p.semantic?.query).toBe(residual);
  });
  it("keeps pure semantic raw query and pure market without selection", () => {
    expect(compileHybridQuery("做精密零件的公司").plan.execution.order).toBe("semantic-only");
    expect(compileHybridQuery("做精密零件的公司").plan.raw).toBe("做精密零件的公司");
    expect(compileHybridQuery("今天领涨的公司").plan.selection).toBeUndefined();
  });
});

describe("M3 ordered membership scan", () => {
  it("finds a valid member beyond the original 120 semantic candidates", async () => {
    const out = await selectMarketMembers(rows, "business-topk", 1, judge({ "600130": "confirmed" }));
    expect(out.selected[0].row.code).toBe("600130"); expect(out.selection.complete).toBe(true); expect(out.selection.batches).toBe(3);
  });
  it("never fills a market TopN subset from rank N+1", async () => {
    const out = await selectMarketMembers(rows, "market-topn-subset", 2, judge({ "600001": "confirmed", "600002": "confirmed" }));
    expect(out.selected.map(x => x.row.code)).toEqual(["600001"]); expect(out.selection.complete).toBe(true);
  });
  it("a higher-ranked undecided company makes TopK incomplete", async () => {
    const out = await selectMarketMembers(rows, "business-topk", 1, judge({ "600000": "unknown", "600001": "confirmed" }));
    expect(out.selection).toMatchObject({ complete: false, unknown: 1, stopped: "target_reached" });
  });
  it("unknown after the Kth confirmed member does not invalidate TopK", async () => {
    const out = await selectMarketMembers(rows, "business-topk", 1, judge({ "600000": "confirmed", "600001": "unknown" }));
    expect(out.selection.complete).toBe(true);
  });
  it("scan budget is incomplete, not a claim of no businesses", async () => {
    const out = await selectMarketMembers(rows, "business-topk", 20, judge({}), { budget: { ...MARKET_SELECTION_BUDGET, maxScanned: 10 } });
    expect(out.selection).toMatchObject({ scanned: 10, stopped: "scan_budget", complete: false });
  });
  it("exhausted pool with fewer matches is complete", async () => {
    const out = await selectMarketMembers(rows.slice(0, 3), "business-topk", 20, judge({}));
    expect(out.selection.complete).toBe(true); expect(out.selection.stopped).toBe("pool_exhausted");
  });
  it("deadline and cancellation stop before calling", async () => {
    const scorer = vi.fn(judge({})); const signal = AbortSignal.abort();
    expect((await selectMarketMembers(rows, "business-topk", 1, scorer, { signal })).selection.stopped).toBe("cancelled");
    expect((await selectMarketMembers(rows, "business-topk", 1, scorer, { budget: { ...MARKET_SELECTION_BUDGET, maxMs: 0 } })).selection.stopped).toBe("time_budget"); expect(scorer).not.toHaveBeenCalled();
  });
});

function transport(values: Record<string, unknown>, calls: unknown[], identity = "jev-stub", failure = false): JudgeProvider {
  return { configured: () => true, status: () => ({ configured: true, model: identity, lastAnsweredModel: identity, endpoint: "in-process" }), async ask<T>(body: Record<string, unknown>) {
    calls.push(body);
    if (failure) return { ok: false, outcome: "timeout" };
    return { ok: true, data: { answers: values } as T, model: identity, outcome: "ok", usage: { inputTokens: 100, outputTokens: 10 } };
  } } as unknown as JudgeProvider;
}
const subjects: JudgementSubject[] = ["600000", "600001", "600002", "600003"].map(companyId => ({ companyId, name: companyId, evidence: [{ ref: "fact", text: "公开主营原文" }] }));
const opt = { remainingEstimatedCostUsd: 0.05, corpusDigest: "corpus-v1" };
describe("M3 eligibility contract and fact cache", () => {
  it("weak scores are rejected; midpoint and missing answers are unknown", async () => {
    setJevProviderOverride(transport({ c0: { noul: 0.3 }, c1: { noul: 0.5 }, c2: { noul: 0.8 } }, []));
    const out = await runMarketEligibility("原文条件", subjects, opt);
    expect(out.decisions.map(d => d.state)).toEqual(["rejected", "unknown", "confirmed", "unknown"]);
    expect(out.decisions[2].judgement?.evidenceRefs).toEqual([{ companyId: "600002", ref: "fact" }]);
  });
  it.each(["0.9", 2, -1, NaN, Infinity])("malformed score %s is never eligibility", async value => {
    setJevProviderOverride(transport({ c0: { noul: value } }, []));
    expect((await runMarketEligibility("原文", subjects.slice(0, 1), opt)).decisions[0].state).toBe("unknown");
  });
  it("failed chunks cannot turn median fill into membership", async () => {
    setJevProviderOverride(transport({}, [], "jev-stub", true));
    expect((await runMarketEligibility("原文", subjects, opt)).decisions.every(d => d.state === "unknown")).toBe(true);
  });
  it("cache survives market changes but invalidates facts/query/judge, and does not cache unknown", async () => {
    const calls: unknown[] = []; setJevProviderOverride(transport({ c0: { noul: 0.9 } }, calls));
    await runMarketEligibility("原文", subjects.slice(0, 1), opt);
    const cached = await runMarketEligibility("原文", subjects.slice(0, 1), opt);
    expect(cached.cacheHits).toBe(1); expect(cached.call).toBeNull(); expect(calls).toHaveLength(1);
    await runMarketEligibility("另一个原文", subjects.slice(0, 1), opt);
    await runMarketEligibility("原文", [{ ...subjects[0], evidence: [{ ref: "fact", text: "更新事实" }] }], opt);
    setJevProviderOverride(transport({ c0: { noul: 0.9 } }, calls, "jev-other"));
    await runMarketEligibility("原文", subjects.slice(0, 1), opt); expect(calls).toHaveLength(4);
    await runMarketEligibility("原文", subjects.slice(0, 1), { ...opt, corpusDigest: "corpus-v2" }); expect(calls).toHaveLength(5);
    setJevProviderOverride(transport({}, calls));
    await runMarketEligibility("未知", subjects.slice(0, 1), opt); await runMarketEligibility("未知", subjects.slice(0, 1), opt); expect(calls).toHaveLength(7);
  });
  it("cost admission rejects before network", async () => {
    const calls: unknown[] = []; setJevProviderOverride(transport({}, calls));
    expect((await runMarketEligibility("原文", subjects, { remainingEstimatedCostUsd: 0 })).stopped).toBe("cost_budget"); expect(calls).toHaveLength(0);
  });
});

describe("M3 full executor counterexample", () => {
  it("market subset preserves rank 2, and never fills with rank 3", async () => {
    const base = deriveFixture().rows[0];
    const marketRows = ["600001", "600002", "600003"].map((code, i) => ({ ...base, code, amount: 100 - i }));
    const companies = marketRows.map(r => ({ code: r.code, name: r.code, exchange: "SH", board: "main", industry: "业务", region: { province: "" }, businessDescription: "公开原文", judgeText: "公开原文" })) as Company[];
    const out = await runHybridQuery("全市场成交额前2中有哪些机器人公司", { marketInject: { manifest: fixtureManifest(), rows: marketRows }, companies, eligibilityJudge: async (_q, cs) => judge({ "600002": "confirmed", "600003": "confirmed" })(cs) });
    expect(out.results.map(r => [r.code, r.rank])).toEqual([["600002", 2]]);
    expect(out.execution.selection?.complete).toBe(true);
  });
  it("uses market order and code ties, ignores old retrieval entirely and excludes nulls", async () => {
    const base = deriveFixture().rows[0];
    const marketRows = ["600003", "600002", "600001", "600004"].map((code, i) => ({ ...base, code, pctChange: i === 3 ? null : i === 0 ? 5 : 10 }));
    const companies = marketRows.map(r => ({ code: r.code, name: r.code, exchange: "SH", board: "main", industry: "业务", region: { province: "" }, businessDescription: "公开原文", judgeText: "公开原文" })) as Company[];
    const semanticEngine = vi.fn(() => { throw Error("must not truncate by retrieval"); });
    const out = await runHybridQuery("今天涨幅最高的2家机器人公司", { marketInject: { manifest: fixtureManifest(), rows: marketRows }, companies, semanticEngine, eligibilityJudge: async (_q, cs) => judge(Object.fromEntries(cs.map(c => [c.code, "confirmed"]))) (cs) });
    expect(out.results.map(r => r.code)).toEqual(["600001", "600002"]); expect(out.execution.selection?.complete).toBe(true); expect(semanticEngine).not.toHaveBeenCalled();
  });
});
