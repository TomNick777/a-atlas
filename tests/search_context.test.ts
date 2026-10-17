import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerRecord } from "../lib/atlas/discoverCache";
import { recordedSearchContext, sourceTimeLabel } from "../lib/atlas/searchContext";
import { SearchContextSection } from "../components/company/SearchContextSection";

const state = vi.hoisted(() => ({ record: undefined as AnswerRecord | undefined, lookup: vi.fn() }));
vi.mock("../lib/atlas/discoverCache", () => ({ lookupAnswerRecord: state.lookup }));
vi.mock("../lib/atlas/company", () => ({
  datasetGeneratedAt: () => "2026-10-01",
  findCompany: () => ({ code: "000001", name: "合成公司", board: "main", swLevel1Industry: "合成行业", region: {}, mainProducts: [], concepts: [] }),
}));
vi.mock("../components/company/DailyChart", () => ({ DailyChart: () => { throw new Error("Company page must not load charts"); } }));
vi.mock("../components/evidence/EvidenceWhy", () => ({ EvidenceWhy: () => null }));
vi.mock("../components/CompanyDataSections", () => ({ CompanyDataSections: () => { throw new Error("Company page must not load data sections"); } }));
import StockPage from "../app/stock/[symbol]/page";

function fixture(): AnswerRecord {
  return {
    provider: "jev", runtimeModel: "recorded-model", identity: "old-identity", corpusDigest: "old-corpus",
    evidence: { "000001": [{ ref: "judge-profile:000001", kind: "judge_profile", label: "公司档案", text: "原始披露文本", provenance: { source: "old-corpus", recordedAt: "2026-10-01" } }] },
    answer: {
      query: "合成查询", searchId: "s_test_aaaaaa", ms: 1, planCaption: "原搜索行情排序说明",
      plan: { market: {}, semantic: null }, parser: {},
      execution: { order: "market-only", decidedBy: "market", degraded: false, counts: {}, timings: {}, marketDate: "2026-10-08", stateDigest16: "old-market" },
      marketSnapshot: { mode: "quote", snapshotId: "old-snapshot", source: "合成来源", tradeDate: "2026-10-08", sourceTimeMin: "2026-10-08T02:40:00Z", sourceTimeMax: "2026-10-08T02:41:00Z", coverage: 0.99 },
      results: [{ code: "000001", name: "合成公司", rank: 7, judgement: null, market: { tradeDate: "2026-10-08" }, hero: { key: "pctChange", label: "涨跌幅", value: 3.25, formatted: "+3.25%" } }],
    },
  } as unknown as AnswerRecord;
}

function context(record = fixture(), code = "000001") {
  return recordedSearchContext({ query: record.answer.query, searchId: "s_test_aaaaaa", code, record });
}

async function page(query: Record<string, string> = { q: "合成查询", s: "s_test_aaaaaa" }) {
  state.lookup.mockImplementation(() => state.record);
  return renderToStaticMarkup(await StockPage({ params: Promise.resolve({ symbol: "000001" }), searchParams: Promise.resolve(query) }));
}

afterEach(() => { state.record = undefined; vi.clearAllMocks(); });

describe("M5 recorded search context", () => {
  it("renders business information without charts or external data sections", async () => {
    const html = await page({});
    expect(html).toContain("主营业务");
    for (const title of ["市场快照", "基础财务", "最近公告", "最近研报", "静态日线"]) expect(html).not.toContain(title);
  });
  it("retains original TopN subset rank, metric and snapshot instead of assigning subset rank 1", () => {
    const result = context();
    expect(result).toMatchObject({ status: "available", rank: 7, basis: "market", marketDate: "2026-10-08", metric: { value: 3.25 }, marketSnapshot: { snapshotId: "old-snapshot" }, provider: null });
    const html = renderToStaticMarkup(createElement(SearchContextSection, { context: result }));
    expect(html).toContain("原结果第 7 名");
    expect(html).toContain("+3.25%");
    expect(html).toContain("2026-10-08 10:40:00");
    expect(html).not.toContain("基础检索排序");
  });

  it("does not invent a rank for older market records or a source timestamp for daily records", () => {
    const record = fixture();
    delete record.answer.results[0].rank;
    delete record.answer.marketSnapshot;
    expect(context(record)).toMatchObject({ rank: null, marketSnapshot: undefined });
  });

  it("keeps incomplete scans and degradation visible even when the returned company has a rank", () => {
    const record = fixture();
    record.answer.execution.degraded = true;
    record.answer.execution.selection = { complete: false, scanned: 100, pool: 500, unknown: 4 } as NonNullable<typeof record.answer.execution.selection>;
    const html = renderToStaticMarkup(createElement(SearchContextSection, { context: context(record) }));
    expect(html).toContain("降级状态");
    expect(html).toContain("已扫描 100/500 家");
    expect(html).toContain("不代表完整排行");
  });

  it("freezes recorded judgement, model and verbatim evidence without consulting current state", () => {
    const record = fixture();
    record.answer.results[0].judgement = { capability: "semantic_relation", query: "原关系", relationLabel: "原关系", score: 0.8, matched: true, evidenceRefs: [{ companyId: "000001", ref: "judge-profile:000001" }] };
    const original = structuredClone(record);
    const result = context(record);
    expect(record).toEqual(original);
    record.runtimeModel = "new-model";
    record.evidence["000001"][0].text = "新语料";
    record.answer.results[0].hero!.value = 9;
    expect(result).toMatchObject({ runtimeModel: "recorded-model", judgement: { relationLabel: "原关系" }, evidence: [{ text: "原始披露文本" }], metric: { value: 3.25 } });
  });

  it("shows no partial evidence and never borrows evidence from another company", () => {
    const record = fixture();
    record.answer.results[0].judgement = { capability: "semantic_match", query: "q", score: 0.8, matched: true, relationLabel: null, evidenceRefs: [{ companyId: "000002", ref: "judge-profile:000001" }] };
    expect(context(record)).toMatchObject({ evidence: [] });
    record.answer.results[0].judgement.evidenceRefs = [{ companyId: "000001", ref: "missing-ref" }];
    expect(context(record)).toMatchObject({ evidence: [] });
  });

  it("distinguishes a direct visit, missing trace, query mismatch, absent record and absent result", () => {
    const record = fixture();
    expect(recordedSearchContext({ query: "", code: "000001" })).toEqual({ status: "none" });
    for (const input of [
      { query: record.answer.query, code: "000001", record },
      { query: "different", code: "000001", record, searchId: "s_test_aaaaaa" },
      { query: record.answer.query, code: "000001", searchId: "s_test_aaaaaa" },
      { query: record.answer.query, code: "000002", record, searchId: "s_test_aaaaaa" },
    ]) expect(recordedSearchContext(input).status).toBe("unavailable");
  });

  it("labels deterministic retrieval honestly when the original answer recorded it", () => {
    const record = fixture();
    record.answer.results[0].market = null;
    record.answer.results[0].hero = null;
    delete record.answer.results[0].rank;
    record.answer.execution.decidedBy = "retrieval";
    expect(context(record)).toMatchObject({ rank: 1, basis: "retrieval", marketSnapshot: null });
  });

  it("company page does not recover an arbitrary same-query answer when the trace is missing", async () => {
    state.record = fixture();
    const html = await page({ q: "合成查询", m: "1", c: "relation" });
    expect(state.lookup).not.toHaveBeenCalled();
    expect(html).toContain("无法恢复");
    expect(html).not.toContain("语义匹配 100");
    expect(html).not.toContain("基础检索排序");
  });

  it("company page retains market context and treats absent answers as unavailable", async () => {
    state.record = fixture();
    expect(await page()).toContain("原结果第 7 名");
    expect(state.lookup).toHaveBeenCalledWith("s_test_aaaaaa", "合成查询");
    state.record = undefined;
    const html = await page();
    expect(html).toContain("无法恢复");
    expect(html).not.toContain("基础检索排序");
    expect(await page({})).not.toContain("本次搜索记录");
  });

  it("renders the saved relation phrase and model rather than URL capability/score", async () => {
    state.record = fixture();
    state.record.answer.results[0].judgement = { capability: "semantic_relation", query: "原关系", relationLabel: "原关系", score: 0.8, matched: true, evidenceRefs: [{ companyId: "000001", ref: "judge-profile:000001" }] };
    const html = await page({ q: "合成查询", s: "s_test_aaaaaa", m: "1", c: "match" });
    expect(html).toContain("recorded-model");
    expect(html).toContain("原关系");
    expect(html).toContain("原始披露文本");
    expect(html).toContain("关系匹配 80");
  });

  it("separates fetched time from source time and preserves missing source timestamps", async () => {
    const { QuoteSection } = await vi.importActual<typeof import("../components/CompanyDataSections")>("../components/CompanyDataSections");
    const html = renderToStaticMarkup(createElement(QuoteSection, { hasSearchMarket: true, quote: { symbol: "000001", available: "ok", source: "测试源", fetchedAt: "2026-10-15T03:00:00Z", asOf: null, price: 12 } }));
    expect(html).toContain("另行获取的行情");
    expect(html).toContain("源端时点：未提供");
    expect(html).toContain("采集于 2026-10-15 11:00:00");
    expect(sourceTimeLabel("2026-10-15T03:00:00Z")).toBe("2026-10-15 11:00:00");
    expect(sourceTimeLabel(undefined)).toBe("未提供");
  });
});
