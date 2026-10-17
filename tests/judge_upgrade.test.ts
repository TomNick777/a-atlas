import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevCloudProvider, setJevProviderOverride, withJudgeProvider } from "../lib/intelligence/runtime";
import { DrexProvider } from "../lib/intelligence/providers/drex/provider";
import { runSemanticMatch } from "../lib/intelligence/capabilities";
import { estimateInputCost } from "../lib/intelligence/pricing";
import { verifyJudgeIdentity } from "../lib/telemetry/contract";
import { installCloudBudget } from "../quality/discovery/runner/cloud-budget";

afterEach(() => { setJevProviderOverride(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const usage = { input_tokens: 1000, output_tokens: 9000 };
function mock(model: string) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { noul: 0.9 }])), usage });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it.each([["jev", "jev-1.14.0", 0.042], ["drex", "drex-v1.5", 0.05], ["drex", "drex-v2.0", 0.06]])("prices %s %s by input tokens", (provider, model, price) => {
  expect(estimateInputCost(String(provider), String(model), 1e6)).toBe(price);
});
it("does not guess prices for unknown or local identities", () => {
  expect(estimateInputCost("jev", "jev-1.99.0", 1000)).toBeNull();
  expect(estimateInputCost("laya", "v4.1", 1000)).toBeNull();
});
it("runs 1.14 across chunks without certifying it or billing output tokens", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-only"); vi.stubEnv("JEV_MODEL", "jev-1.14.0");
  const fetch = mock("jev-1.14.0");
  const provider = new JevCloudProvider(); setJevProviderOverride(provider);
  await withJudgeProvider("jev", async () => {
    const subjects = Array.from({ length: 101 }, (_, i) => ({ companyId: String(i), name: "Fixture", evidence: [{ ref: "fixture:fact", text: "Disclosed business." }] }));
    const result = await runSemanticMatch({ query: "business", subjects });
    expect(result.live).toBe(true);
    expect(result.chunks).toBe(2);
    expect(result.tokens).toBe(20000);
    expect(result.costUsd).toBeCloseTo(0.000084, 10);
    expect(provider.stats().estimatedCostUsd).toBeCloseTo(result.costUsd!, 10);
    expect(verifyJudgeIdentity(result.runtimeModel, true).status).toBe("drift");
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("rejects response identity changes for a fixed Jev candidate", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-only"); vi.stubEnv("JEV_MODEL", "jev-1.14.0");
  mock("jev-1.13.0");
  const provider = new JevCloudProvider();
  expect(await provider.ask({ questions: {} }, "rerank")).toMatchObject({ ok: false, outcome: "bad_response" });
  expect(provider.status().lastAnsweredModel).toBeNull();
  expect(provider.stats().estimatedCostUsd).toBeNull();
});
it("supports a fixed Drex 2.0 response without changing the default 1.5", async () => {
  vi.stubEnv("NACE_API_KEY", "test-only"); vi.stubEnv("DREX_MODEL", "drex-v2.0");
  const fetch = mock("drex-v2.0"); const provider = new DrexProvider();
  expect((await provider.ask({ questions: {} }, "rerank")).ok).toBe(true);
  expect(provider.stats().estimatedCostUsd).toBeCloseTo(0.00006, 10);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe("drex-v2.0");
});
it("settles the private budget on input usage and prevents the next call at the cap", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-only"); vi.stubEnv("JEV_MODEL", "jev-1.14.0");
  const fetch = mock("jev-1.14.0"); setJevProviderOverride(new JevCloudProvider());
  const directory = mkdtempSync(join(tmpdir(), "atlas-budget-")); const file = join(directory, "ledger.json");
  const restore = installCloudBudget(file, 1, 1);
  try {
    await withJudgeProvider("jev", async () => {
      const request = { method: "POST", body: JSON.stringify({ questions: {} }) };
      await globalThis.fetch("https://api.typesafe.ai/v1/systemone", request);
      expect(JSON.parse(readFileSync(file, "utf8")).costUsd).toBeCloseTo(0.000042, 10);
      await expect(globalThis.fetch("https://api.typesafe.ai/v1/systemone", request)).rejects.toThrow("budget exhausted");
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { restore(); rmSync(directory, { recursive: true, force: true }); }
});
