import { afterEach, expect, it, vi } from "vitest";
import { DrexProvider } from "../lib/intelligence/providers/drex/provider";
import { JevCloudProvider, currentJudgeId, judgeCacheIdentity, parseProvider, withJudgeProvider } from "../lib/intelligence/runtime";
import { runSemanticMatch, runSemanticRelation, runSemanticComparison, runEvidenceExplanation } from "../lib/intelligence/capabilities";
import { verifyJudgeIdentity } from "../lib/telemetry/contract";
import { selectMarketMembers } from "../lib/hybrid/market-selection";
import { runMarketEligibility, resetMarketEligibilityCache } from "../lib/intelligence/capabilities/market-eligibility";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetMarketEligibilityCache(); });
const subjects = [{ companyId: "fixture", name: "Fixture", evidence: [{ ref: "fixture:fact", text: "Fixture supplies products." }] }];
function mockCloud() {
  vi.stubEnv("NACE_API_KEY", "fixture-nace-key");
  vi.stubEnv("TYPESAFE_API_KEY", "fixture-jev-key");
  const fetch = vi.fn(async (_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body));
    if (String(_url).includes("nace.ai")) {
      for (const q of Object.values(body.questions) as { instructions?: unknown }[]) {
        if (q.instructions !== undefined && q.instructions !== null && typeof q.instructions !== "string") {
          return Response.json({ error: "instructions must be a string" }, { status: 400 });
        }
      }
    }
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions as Record<string, { type: string }>).map(([id, q]) => [id, q.type === "score" ? { score: 3 } : { noul: 0.9 }])), usage: { input_tokens: 10, output_tokens: 5 } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("uses independent credentials and endpoint, and cannot have its model overwritten by payload", async () => {
  const fetch = mockCloud();
  const drex = new DrexProvider();
  const result = await drex.ask({ model: "untrusted", state: "fixture", questions: {} }, "rerank");
  expect(result.ok).toBe(true);
  expect(fetch.mock.calls[0][0]).toBe("https://console.nace.ai/v1/systemone");
  const init = fetch.mock.calls[0][1]!;
  expect(init.headers).toMatchObject({ authorization: "Bearer fixture-nace-key" });
  expect(JSON.parse(String(init.body)).model).toBe("drex-v1.5");
  expect(drex.stats().estimatedCostUsd).toBeCloseTo(0.0000005, 10);
  expect(new JevCloudProvider().stats().calls).toBe(0);
  expect(JSON.stringify(drex.status())).not.toContain("fixture-nace-key");
});
it("serializes structured instructions without mutating the capability payload", async () => {
  const fetch = mockCloud();
  const instructions = { company: { code: "fixture", profile: "Original fact: 中文。" }, question: "Original question?" };
  const body = { state: { looking_for: "original" }, questions: {
    c0: { type: "noul", instructions },
    c1: { type: "noul", instructions: "Already text", criteria: { true: "yes" } },
  } };
  expect((await new DrexProvider().ask(body, "rerank")).ok).toBe(true);
  const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(sent.state).toEqual(body.state);
  expect(JSON.parse(sent.questions.c0.instructions)).toEqual(instructions);
  expect(sent.questions.c1).toEqual(body.questions.c1);
  expect(body.questions.c0.instructions).toBe(instructions);
});
it("does not borrow Jev credentials when Drex is unconfigured", async () => {
  vi.stubEnv("NACE_API_KEY", ""); vi.stubEnv("TYPESAFE_API_KEY", "fixture-jev-key");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(await new DrexProvider().ask({}, "rerank")).toMatchObject({ ok: false, outcome: "no_config" });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([null, "drex-v2", "jev-1.13.0"])("rejects missing or wrong actual identity %s", async model => {
  vi.stubEnv("NACE_API_KEY", "fixture-key");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ model, answers: {} })));
  const provider = new DrexProvider();
  expect(await provider.ask({}, "rerank")).toMatchObject({ ok: false, outcome: "bad_response" });
  expect(provider.status().lastAnsweredModel).toBeNull();
});
it("keeps four capabilities and cache identities scoped to the explicitly selected judge", async () => {
  mockCloud();
  await withJudgeProvider("drex", async () => {
    expect(currentJudgeId()).toBe("drex");
    const match = await runSemanticMatch({ query: "fixture", subjects });
    const relation = await runSemanticRelation({ relationQuery: "fixture supplier", subjects });
    const comparison = await runSemanticComparison({ comparisonQuery: "fixture", subjects });
    const explanation = await runEvidenceExplanation({ userQuery: "fixture", judgement: { capability: "semantic_match", query: "fixture", companyId: "fixture", companyName: "Fixture", score: 0.9, matched: true }, evidence: [{ ref: "fixture:fact", text: "Fixture supplies products." }] });
    for (const result of [match, relation, comparison, explanation]) {
      expect(result.runtimeModel).toBe("drex-v1.5");
      expect(result.costUsd).toBeCloseTo(0.0000005, 10);
    }
    expect(match.live).toBe(true);
    expect(match.decisions[0].evidenceRefs).toHaveLength(1);
    expect(judgeCacheIdentity()).toContain("judge:drex:drex-v1.5:drex-v1.5:");
  });
  await withJudgeProvider("jev", async () => { expect(judgeCacheIdentity()).toContain("judge:jev:"); });
  expect(parseProvider("drex")).toBe("drex");
  expect(verifyJudgeIdentity("drex-v1.5", true, "drex").status).toBe("verified");
  expect(verifyJudgeIdentity("jev-1.13.0", true, "drex").status).toBe("drift");
  await expect(withJudgeProvider("drex", async () => {}, "drex-v2")).rejects.toThrow("original judge identity");
});
it("accounts for Drex input costs while retaining scan limits", async () => {
  mockCloud();
  await withJudgeProvider("drex", async () => {
    const result = await selectMarketMembers([{ code: "fixture" }], "business-topk", 1, async (_batch, deadlineAt, remainingCost) => runMarketEligibility("fixture", subjects, { deadlineAt, remainingEstimatedCostUsd: remainingCost }));
    expect(result.selection.complete).toBe(true);
    expect(result.selection.estimatedCostUsd).toBeCloseTo(0.0000005, 10);
    expect(result.selection.batches).toBe(1);
  });
});
