import { afterEach, describe, expect, it } from "vitest";
import { POST as explainPOST } from "../app/api/explain/route";
import { discoverCacheKey, storeDiscover } from "../lib/atlas/discoverCache";
import { setJevProviderOverride } from "../lib/jev/cloud";
import { judgeProfileText } from "../lib/jev/capabilities";
import type { JevCall, JudgeProvider, ProviderStats, ProviderStatus } from "../lib/jev/provider";
import { loadDataset } from "../lib/companies";
import type { HybridDiscoverResult } from "../lib/hybrid/contracts";
import type { ResultJudgement } from "../lib/types";

/**
 * Evidence explain endpoint, offline (Phase 3.4): the explanation capability
 * runs for real (real request build, real parsing, real line rendering); only
 * the transport is scripted. Pins the grounding property mechanically:
 * explanation lines ⊆ resolved evidence refs, quotes verbatim.
 */

function scripted(answersFor: (body: Record<string, unknown>) => Record<string, unknown>): JudgeProvider {
  const status: ProviderStatus = {
    provider: "jev",
    configured: true,
    model: "test-model",
    endpoint: "scripted-test",
    breaker: { state: "closed", consecutiveFailures: 0, openedAt: null, openUntil: null, trips: 0, lastTripReason: null },
    lastAnsweredModel: "test-model",
    inFlight: 0,
  };
  const stats: ProviderStats = {
    calls: 0, ok: 0, retries: 0, timeouts: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, unauthorized: 0, breakerRejected: 0, budgetExhausted: 0,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
    latencyMs: { p50: null, p95: null, max: null },
  };
  return {
    id: "jev",
    model: "test-model",
    configured: () => true,
    status: () => status,
    stats: () => stats,
    async ask<T>(body: Record<string, unknown>): Promise<JevCall<T>> {
      return {
        ok: true,
        data: { model: "test-model", answers: answersFor(body), usage: {} } as T,
        outcome: "ok",
        model: "test-model",
        attempt: 1,
        latencyMs: 1,
        usage: { inputTokens: 10, outputTokens: 4 },
      };
    },
  };
}

function post(body: unknown): Promise<Response> {
  return explainPOST(
    new Request("http://localhost/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
}

function seedDiscoverAnswer(q: string, code: string, name: string): void {
  const judgement: ResultJudgement = {
    capability: "semantic_match",
    query: q,
    score: 0.94,
    matched: true,
    relationLabel: null,
    evidenceRefs: [{ companyId: code, ref: `judge-profile:${code}` }],
  };
  const domain = {
    query: q,
    plan: { plannerVersion: "t", raw: q, semantic: { query: q }, market: null, execution: { order: "semantic-only" }, heroMetric: null, notes: [], unsupported: null },
    parser: { route: "deterministic", version: "t" },
    execution: { order: "semantic-only", timings: { parserMs: 0, semanticMs: null, marketMs: null, mergeMs: null, totalMs: 0 }, degraded: false, degradedReason: null, decidedBy: "jev", counts: {}, marketDate: null, stateDigest16: null },
    results: [
      { code, name, exchange: null, board: null, industry: null, swLevel1Industry: null, province: null, business: null, probability: 0.94, semantic: { query: q, score: 0.94, matchedFacts: [] }, market: null, hero: null, judgement },
    ],
    planCaption: "",
    intelligence: null,
    searchId: "fixture:test",
    ms: 0,
  } as unknown as HybridDiscoverResult;
  storeDiscover(discoverCacheKey(q), domain);
}

afterEach(() => {
  setJevProviderOverride(null);
});

describe("explain endpoint — grounded explanation (evidence-explanation-1)", () => {
  it("explanation lines quote the resolved evidence verbatim and stay inside its refs", async () => {
    const { companies } = loadDataset();
    const company = companies.find((entry) => entry.searchProfileText)!;
    const q = "做人形机器人减速器";
    seedDiscoverAnswer(q, company.code, company.name);
    setJevProviderOverride(scripted(() => ({ e0: { noul: 0.92 } })));
    const response = await post({ q, code: company.code });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.judgement.score).toBe(0.94);
    expect(data.evidence).toHaveLength(1);
    expect(data.evidence[0].text).toBe(company.searchProfileText);
    expect(data.explanation.status).toBe("ok");
    expect(data.explanation.lines).toHaveLength(1);
    // ⊆ evidenceRefs …
    expect(data.explanation.lines[0].ref).toBe(`judge-profile:${company.code}`);
    // … and the quote IS the evidence text, verbatim.
    expect(data.explanation.lines[0].quote).toBe(company.searchProfileText);
    expect(data.explanation.contractVersion).toBe("evidence-explanation-1");
  });

  it("evidence that does not support the judgement is insufficient_evidence, not a low score", async () => {
    const { companies } = loadDataset();
    const company = companies.find((entry) => entry.searchProfileText)!;
    const q = "未来教育";
    seedDiscoverAnswer(q, company.code, company.name);
    setJevProviderOverride(scripted(() => ({ e0: { noul: 0.1 } })));
    const data = await (await post({ q, code: company.code })).json();
    expect(data.explanation.status).toBe("insufficient_evidence");
    expect(data.explanation.lines).toEqual([]);
  });

  it("without the answer on record the explanation is honestly unavailable — facts still resolve", async () => {
    const { companies } = loadDataset();
    const company = companies.find((entry) => entry.searchProfileText)!;
    const data = await (await post({ q: "从未搜过的查询组合", code: company.code })).json();
    expect(data.explanation.status).toBe("unavailable");
    expect(data.explanation.reason).toBe("search_expired");
    expect(data.explanation.lines).toEqual([]);
    expect(data.evidence[0].text).toBe(company.searchProfileText);
  });
});

describe("explain endpoint — internal comparison surface (semantic-comparison-1)", () => {
  it("grades both subjects and resolves their evidence; sorted by score", async () => {
    const { companies } = loadDataset();
    const withText = companies.filter((entry) => entry.searchProfileText);
    const [a, b] = withText;
    setJevProviderOverride(
      scripted((body) => {
        const answers: Record<string, unknown> = {};
        for (const key of Object.keys((body.questions ?? {}) as Record<string, unknown>)) {
          answers[key] = { score: key === "c0" ? 3 : 1 };
        }
        return answers;
      }),
    );
    const data = await (await post({ mode: "comparison", q: "谁更偏伺服", codes: [a.code, b.code] })).json();
    expect(data.status).toBe("ok");
    expect(data.contractVersion).toBe("semantic-comparison-1");
    expect(data.subjects).toHaveLength(2);
    expect(data.subjects[0].companyId).toBe(a.code);
    expect(data.subjects[0].grade).toBe(3);
    expect(data.subjects[1].grade).toBe(1);
    expect(data.subjects[0].evidence[0].text).toBe(a.searchProfileText);
  });

  it("refuses to compare fewer than two subjects", async () => {
    const { companies } = loadDataset();
    const company = companies.find((entry) => entry.searchProfileText)!;
    const response = await post({ mode: "comparison", q: "谁更偏伺服", codes: [company.code] });
    expect(response.status).toBe(400);
  });
});
