import { describe, expect, it, vi } from "vitest";
import type { Company, SearchResult } from "../lib/types";

// Loading a market adapter is a failure, even if it never makes a request.
vi.mock("../lib/market/state", () => { throw new Error("Company discovery imported market state"); });
vi.mock("../lib/market/refresh", () => { throw new Error("Company discovery imported market refresh"); });
import { compileCompanyQuery, runCompanyDiscovery } from "../lib/discovery/query";

const companies = ["000001", "000002", "000003"].map(code => ({
  code, name: `合成公司${code}`, exchange: "SZ", board: "main",
  industry: "合成行业", businessDescription: "合成产品", region: { province: "", city: "" },
  searchableText: "合成产品", judgeText: "合成产品", searchProfileText: "合成产品",
})) as Company[];

function outcome(): SearchResult {
  return {
    hits: companies.map((c, index) => ({ code: c.code, name: c.name, probability: 0.9 - index * 0.1, industry: c.industry, swLevel1Industry: "合成行业", province: "", business: c.businessDescription })),
    matches: 3, searchId: "s_test_original", degraded: false, decidedBy: "jev",
    judge: { provider: "jev", model: "jev-1.13.0", outcome: "ok" },
    judgements: Object.fromEntries(companies.map((c, index) => [c.code, {
      capability: "semantic_match", query: "合成产品", score: 0.9 - index * 0.1,
      matched: index !== 1, relationLabel: null,
      evidenceRefs: [{ companyId: c.code, ref: `judge-profile:${c.code}` }],
    }])),
  } as SearchResult;
}

describe("company discovery mainline", () => {
  it.each([
    "今天涨幅前10的公司", "今天成交额最大的公司", "半导体公司里今天涨幅前5",
    "今天涨幅前20里做半导体的公司", "市值小于200亿的机器人公司", "连续三个涨停的公司",
    "近20日相对放量前20的公司", "成交额大于上一交易日的公司",
  ])("refuses market intent without executing a partial search: %s", async query => {
    const searchEngine = vi.fn();
    const answer = await runCompanyDiscovery(query, { companies, searchEngine, traceId: "s_test_trace" });
    expect(searchEngine).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ results: [], searchId: "s_test_trace", plan: { unsupported: expect.anything(), market: null }, execution: { order: "unsupported", marketDate: null, stateDigest16: null } });
    expect(answer.planCaption).toContain("当前只支持");
  });

  it.each(["esp32硬件相关的公司", "给汽车厂供货的公司", "做伺服电机的公司", "半导体", "做K线软件的公司"])("preserves the original business query: %s", async query => {
    const engine = vi.fn().mockResolvedValue(outcome());
    const signal = new AbortController().signal;
    const answer = await runCompanyDiscovery(query, { searchEngine: engine, companies, signal, traceId: "s_test_trace", log: false });
    expect(engine).toHaveBeenCalledExactlyOnceWith(query, { signal, traceId: "s_test_trace", log: false });
    expect(answer.execution.order).toBe("semantic-only");
    expect(answer.results.map(row => row.code)).toEqual(["000001", "000003"]);
    expect(answer.results.every(row => row.market === null && row.hero === null)).toBe(true);
  });

  it("returns no matches when every live decision rejects, instead of filling nine cards", async () => {
    const result = outcome();
    for (const decision of Object.values(result.judgements!)) decision.matched = false;
    const answer = await runCompanyDiscovery("合成产品", { companies, searchEngine: async () => result });
    expect(answer.results).toEqual([]);
    expect(answer.planCaption).toContain("没有找到有证据支持的匹配");
    expect(answer.execution.degraded).toBe(false);
    expect(answer.execution.counts).toEqual({ semanticCandidates: 3, semanticEligible: 0 });
  });

  it("does not promote missing decisions or evidence to confirmed results", async () => {
    const result = outcome();
    delete result.judgements!["000001"];
    result.judgements!["000003"].evidenceRefs = [];
    const answer = await runCompanyDiscovery("合成产品", { companies, searchEngine: async () => result });
    expect(answer.results).toEqual([]);
  });

  it("keeps retrieval fallback explicitly degraded without surfacing a judgement", async () => {
    const result = outcome();
    result.degraded = true;
    result.decidedBy = "retrieval";
    result.judge = { provider: "none", model: null, outcome: "no_config" };
    const answer = await runCompanyDiscovery("合成产品", { companies, searchEngine: async () => result });
    expect(answer.results.map(row => row.code)).toEqual(companies.map(c => c.code));
    expect(answer.results.every(row => row.judgement === null)).toBe(true);
    expect(answer.execution).toMatchObject({ degraded: true, degradedReason: "no_config", decidedBy: "retrieval" });
  });

  it("keeps existing honest refusals without calling the judge", async () => {
    const searchEngine = vi.fn();
    const answer = await runCompanyDiscovery("明天最可能涨停的公司", { companies, searchEngine });
    expect(searchEngine).not.toHaveBeenCalled();
    expect(answer.execution.order).toBe("unsupported");
    expect(compileCompanyQuery("做芯片的公司").plan.semantic?.query).toContain("芯片");
  });
});
