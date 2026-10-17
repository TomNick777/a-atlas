import { afterEach, describe, expect, it, vi } from "vitest";
import { JevCloudProvider, currentJudgeId, drainSystemOneObservations, judgeCacheIdentity, setJevProviderOverride, withJudgeProvider } from "../lib/intelligence/runtime";
import { runSemanticMatch, runSemanticComparison, runSemanticRelation, runEvidenceExplanation } from "../lib/intelligence/capabilities";
import { LayaProvider } from "../lib/intelligence/providers/laya/provider";

const subjects = [{ companyId: "000001", name: "Fixture", evidence: [{ ref: "fixture:fact", text: "Fixture fact" }] }];
afterEach(() => { setJevProviderOverride(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function cloud(models = ["jev-fixture"]) {
  const provider = new JevCloudProvider();
  const originalStatus = provider.status.bind(provider);
  vi.spyOn(provider, "configured").mockReturnValue(true);
  vi.spyOn(provider, "status").mockImplementation(() => ({ ...originalStatus(), configured: true }));
  let calls = 0;
  vi.spyOn(provider, "ask").mockImplementation(async body => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const model = models[Math.min(calls++, models.length - 1)];
    const questions = body.questions as Record<string, { type: string }>;
    return { ok: true, outcome: "ok", model, attempt: 1, latencyMs: 5, usage: { inputTokens: 5, outputTokens: 0 }, data: { model, answers: Object.fromEntries(Object.entries(questions).map(([key, q]) => [key, q.type === "score" ? { score: 3 } : { noul: 0.9 }])) } };
  });
  setJevProviderOverride(provider);
}

describe("request-local judge contracts", () => {
  it("keeps invalid optional endpoint configuration unavailable without making requests", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const provider = new LayaProvider("https://invalid.example/");
    await provider.refreshIdentity(true);
    expect(provider.configured()).toBe(false);
    expect((await provider.ask({}, "rerank")).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(provider.endpoint).toBe("invalid-local-endpoint");
  });
  it("keeps an unpromoted candidate outside production requests", async () => {
    vi.stubEnv("ATLAS_LAYA_EVALUATION", "0");
    const provider = new LayaProvider();
    const fetch = vi.fn(async () => Response.json({ ok: true, service: "a-atlas-laya", lane: "evaluation", model: "laya-fixture", sha16: "1111111111111111" }));
    vi.stubGlobal("fetch", fetch);
    await provider.refreshIdentity(true);
    expect(provider.configured()).toBe(false);
    expect((await provider.ask({}, "rerank")).ok).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    vi.stubEnv("ATLAS_LAYA_EVALUATION", "1");
    await provider.refreshIdentity(true);
    expect(provider.configured()).toBe(true);
  });
  it("retains every cloud retry observation inside its own request", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "offline-test-key");
    vi.stubEnv("JEV_MODEL", "jev-1.13.0");
    const provider = new JevCloudProvider({ retryBaseMs: 5, retryCapMs: 10, rerankBudgetMs: 1000 });
    setJevProviderOverride(provider);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      if (++calls === 1) return Response.json({ error: "synthetic retry" }, { status: 500 });
      const body = JSON.parse(options.body);
      return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { noul: 0.9 }])), usage: { input_tokens: 5, output_tokens: 1 } });
    }));
    await withJudgeProvider("jev", async () => {
      expect((await runSemanticMatch({ query: "fixture", subjects })).live).toBe(true);
      expect(drainSystemOneObservations(0).map(row => [row.attempt, row.outcome])).toEqual([[1, "server_error"], [2, "ok"]]);
    });
  });
  it("keeps concurrent Jev and Laya capabilities and cache identities separate", async () => {
    cloud();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, options?: RequestInit) => {
      if (String(url).endsWith("/health")) return Response.json({ ok: true, service: "a-atlas-laya", lane: "production", model: "laya-fixture@1111111111111111", sha16: "1111111111111111" });
      const body = JSON.parse(String(options?.body));
      return Response.json({ model: "laya-fixture@1111111111111111", answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { noul: 0.8 }])), usage: { input_tokens: 4 } });
    }));
    const [jev, laya] = await Promise.all(["jev", "laya"].map(provider => withJudgeProvider(provider, async () => {
      const result = await runSemanticMatch({ query: "fixture", subjects });
      await new Promise(resolve => setTimeout(resolve, 5));
      return { provider: currentJudgeId(), identity: judgeCacheIdentity(), model: result.runtimeModel, status: result.status, cost: result.costUsd };
    })));
    expect(jev.provider).toBe("jev"); expect(laya.provider).toBe("laya");
    expect(jev.model).toBe("jev-fixture"); expect(laya.model).toMatch(/^laya-fixture/);
    expect(jev.identity).toContain("jev-fixture"); expect(laya.identity).toContain("1111111111111111");
    expect(laya.cost).toBeNull(); expect(jev.status).toBe("ok"); expect(laya.status).toBe("ok");
  });

  it("rejects model drift across chunks instead of surfacing a mixed judgement", async () => {
    cloud(["jev-fixture-a", "jev-fixture-b"]);
    const result = await withJudgeProvider("jev", () => runSemanticMatch({ query: "fixture", subjects: Array.from({ length: 101 }, (_, i) => ({ ...subjects[0], companyId: String(i).padStart(6, "0") })) }));
    expect(result.status).toBe("degraded"); expect(result.outcome).toBe("bad_response");
  });

  it("enforces comparison ranges and refuses subjects without their own relation evidence", async () => {
    cloud();
    const provider = new JevCloudProvider();
    vi.spyOn(provider, "ask").mockResolvedValue({ ok: true, outcome: "ok", model: "jev-fixture", attempt: 1, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 0 }, data: { answers: { c0: { score: 7 } } } });
    setJevProviderOverride(provider);
    const score = await withJudgeProvider("jev", () => runSemanticComparison({ comparisonQuery: "fixture", subjects }));
    expect(score.unexpectedAnswers).toBe(1); expect(score.decisions.every(row => row.grade >= 0 && row.grade <= 3)).toBe(true);
    const relation = await withJudgeProvider("jev", () => runSemanticRelation({ relationQuery: "fixture", subjects: [{ ...subjects[0], evidence: [...subjects[0].evidence, ...subjects[0].evidence] }, { ...subjects[0], companyId: "000002", evidence: [] }] }));
    expect(relation.failure).toBe("insufficient_evidence");
  });

  it("never quotes evidence when the explanation head returns an invalid score", async () => {
    const provider = new JevCloudProvider();
    vi.spyOn(provider, "ask").mockResolvedValue({ ok: true, outcome: "ok", model: "jev-fixture", attempt: 1, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 0 }, data: { answers: { e0: { noul: 2 } } } });
    setJevProviderOverride(provider);
    const judgement = { companyId: "000001", companyName: "Fixture", capability: "semantic_match", query: "fixture", score: 0.9, matched: true } as const;
    const result = await withJudgeProvider("jev", () => runEvidenceExplanation({ userQuery: "fixture", judgement, evidence: subjects[0].evidence }));
    expect(result.lines).toEqual([]); expect(result.unexpectedAnswers).toBe(1);
  });
});
