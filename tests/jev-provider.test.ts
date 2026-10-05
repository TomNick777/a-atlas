import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JevCloudProvider, type JevTimingOverrides } from "../lib/jev/cloud";
import { JEV_TIMING, type JevOutcome } from "../lib/jev/provider";
import type { Company } from "../lib/types";

/**
 * Jev Cloud provider contract (Phase 4 §40). Every fault §20 names gets its own
 * case, and each one asserts the same three things: the search still gets an
 * answer it can use, the outcome is nameable, and no Laya path exists to take.
 *
 * The clock is the production one; only the ms figures are shrunk, through the
 * same overrides a caller could pass, so a timeout here is a real timeout.
 */

const KEY = "test-key-DO-NOT-LEAK";
const FAST = {
  connectMs: 120,
  requestMs: 200,
  rerankBudgetMs: 1_000,
  classifyBudgetMs: 600,
  retryBaseMs: 5,
  retryCapMs: 20,
  breakerCooldownMs: 80,
  authCooldownMs: 80,
} as const;

const companies: Company[] = [
  { code: "000001", name: "平安银行", judgeText: "平安银行 | 行业：银行" },
  { code: "600519", name: "贵州茅台", judgeText: "贵州茅台 | 行业：白酒" },
] as Company[];

function providerWithKey(overrides: JevTimingOverrides = {}): JevCloudProvider {
  process.env.TYPESAFE_API_KEY = KEY;
  delete process.env.LAYA_URL;
  return new JevCloudProvider({ ...FAST, ...overrides });
}

function body() {
  return { state: { looking_for: "银行", how_to_judge: "h" }, questions: { c0: { type: "noul" }, c1: { type: "noul" } } };
}

function okResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({ model: "jev-1.13.0", answers: { c0: { noul: 0.9 }, c1: { noul: 0.1 } }, usage: { input_tokens: 1200, output_tokens: 12 }, ...overrides });
}

/** A cloud that never answers, the way a hung socket behaves. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let savedKey = "";

beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY ?? "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey) process.env.TYPESAFE_API_KEY = savedKey;
  else delete process.env.TYPESAFE_API_KEY;
});

describe("Jev Cloud provider — happy path", () => {
  it("posts the SystemOne contract to the cloud and returns the answers", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const call = await providerWithKey().ask<Record<string, unknown>>(body(), "rerank");
    expect(call.ok).toBe(true);
    if (!call.ok) return;
    expect(call.outcome).toBe("ok");
    expect(call.model).toBe("jev-1.13.0");
    expect(call.usage.inputTokens).toBe(1200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "jev-latest", state: { looking_for: "银行" } });
  });

  it("reports the model that answered, not the alias asked for", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ model: "jev-1.99.0" })));
    const provider = providerWithKey();
    await provider.ask(body(), "rerank");
    expect(provider.status().lastAnsweredModel).toBe("jev-1.99.0");
    expect(provider.status().model).toBe("jev-latest");
  });
});

describe("Jev Cloud provider — faults (§20)", () => {
  it("no key: asks nobody and names the reason, instead of reaching for a local judge", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.TYPESAFE_API_KEY;
    process.env.LAYA_URL = "http://127.0.0.1:8787"; // present in the environment, and ignored
    const provider = new JevCloudProvider({ ...FAST });
    const call = await provider.ask(body(), "rerank");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("no_config");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("timeout: retries once inside the budget, then reports the timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const call = await providerWithKey().ask(body(), "classify");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("connect_timeout");
    expect(call.attempt).toBe(2);
  });

  it("401: no retry, breaker opens at once, and the key is never echoed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: { error_type: "authentication_error", message: `bad key ${KEY}` } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = providerWithKey();
    const call = await provider.ask(body(), "rerank");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.breakerSnapshot().state).toBe("open");
    for (const payload of [JSON.stringify(call), JSON.stringify(provider.status()), JSON.stringify(provider.stats())]) {
      expect(payload).not.toContain(KEY);
    }
  });

  it("429: retryable, counted separately, and exactly one retry is spent", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "0" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = providerWithKey();
    const call = await provider.ask(body(), "rerank");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("rate_limited");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.stats().rateLimited).toBe(1);
    expect(provider.stats().retries).toBe(1);
    expect(provider.stats().calls).toBe(1);
  });

  it("5xx: retried once, then failed as server_error", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = providerWithKey();
    const call = await provider.ask(body(), "rerank");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("server_error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("connection refused (DNS/down host) is network_error, not a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    }));
    const call = await providerWithKey().ask(body(), "rerank");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("network_error");
  });

  it("a 200 with an unusable body is bad_response, not a zero-scored success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const call = await providerWithKey().ask(body(), "rerank");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("bad_response");
  });

  it("400/422 is a client error: never retried, never counted as an outage", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = providerWithKey();
    const call = await provider.ask(body(), "rerank");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("client_error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.breakerSnapshot().state).toBe("closed");
  });
});

describe("Jev Cloud provider — budget (§12)", () => {
  it("refuses a budget that is already spent instead of starting a doomed call", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const call = await providerWithKey().ask(body(), "rerank", { deadlineAt: Date.now() - 1 });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("budget_exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the overall search budget, not the per-request one, is what bounds a hung cloud", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const started = Date.now();
    const call = await providerWithKey({ requestMs: 500 }).ask(body(), "rerank", { deadlineAt: Date.now() + 400 });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).not.toBe("ok");
    expect(Date.now() - started).toBeLessThan(1_200);
  });

  it("a caller abort surfaces as aborted and does not trip the breaker", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const provider = providerWithKey();
    const controller = new AbortController();
    controller.abort();
    const call = await provider.ask(body(), "rerank", { signal: controller.signal });
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("aborted");
    expect(provider.breakerSnapshot().state).toBe("closed");
  });
});

describe("Jev Cloud provider — circuit breaker (§14)", () => {
  async function failTimes(provider: JevCloudProvider, count: number) {
    for (let at = 0; at < count; at++) await provider.ask(body(), "rerank");
  }

  it("opens after the configured consecutive failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const provider = providerWithKey();
    expect(provider.breakerSnapshot().state).toBe("closed");
    await failTimes(provider, JEV_TIMING.breaker.failureThreshold);
    expect(provider.breakerSnapshot().state).toBe("open");
    expect(provider.breakerSnapshot().trips).toBe(1);
  });

  it("while open it rejects without spending a network call", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = providerWithKey();
    await failTimes(provider, JEV_TIMING.breaker.failureThreshold);
    const callsBefore = fetchMock.mock.calls.length;
    const call = await provider.ask(body(), "rerank");
    expect(call.ok).toBe(false);
    if (call.ok) return;
    expect(call.outcome).toBe("breaker_open");
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(provider.stats().breakerRejected).toBe(1);
  });

  it("half-open lets one probe through, and a good probe closes the circuit", async () => {
    let failing = true;
    vi.stubGlobal("fetch", vi.fn(async () => (failing ? new Response("boom", { status: 500 }) : okResponse())));
    const provider = providerWithKey({ failureThreshold: 2 });
    await failTimes(provider, 2);
    expect(provider.breakerSnapshot().state).toBe("open");
    failing = false;
    await wait(FAST.breakerCooldownMs + 20);
    expect(provider.breakerSnapshot().state).toBe("half_open");
    expect((await provider.ask(body(), "rerank")).ok).toBe(true);
    expect(provider.breakerSnapshot().state).toBe("closed");
  });

  it("a failed probe re-opens instead of letting every search pay the timeout again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const provider = providerWithKey({ failureThreshold: 2 });
    await failTimes(provider, 2);
    await wait(FAST.breakerCooldownMs + 20);
    expect(provider.breakerSnapshot().state).toBe("half_open");
    await provider.ask(body(), "rerank");
    expect(provider.breakerSnapshot().state).toBe("open");
    expect(provider.breakerSnapshot().trips).toBe(2);
  });
});

describe("Jev Cloud provider — admission control (§15)", () => {
  it("never runs more than the measured ceiling of batches at once", async () => {
    let live = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await wait(10);
      live -= 1;
      return okResponse();
    }));
    const provider = providerWithKey();
    await Promise.all(Array.from({ length: 12 }, () => provider.ask(body(), "rerank")));
    expect(peak).toBeLessThanOrEqual(JEV_TIMING.maxInFlight);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("judge() over the provider — degraded result (§10/§11)", () => {
  it("marks the verdict not-live with the provider's own reason when the cloud refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    setProviderForJudge(providerWithKey());
    const { judge } = await import("../lib/jev/judge");
    const verdict = await judge("银行", companies);
    expect(verdict.live).toBe(false);
    expect(verdict.outcome).toBe<JevOutcome>("server_error");
    expect(verdict.scores).toHaveLength(2);
  });

  it("fills a missing chunk from the answered ones but still reports partial", async () => {
    let second = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      second = !second;
      if (second) return new Response("boom", { status: 500 });
      return Response.json({ model: "jev-1.13.0", answers: { c0: { noul: 1 }, c1: { noul: 0 } }, usage: { input_tokens: 10, output_tokens: 1 } });
    }));
    setProviderForJudge(providerWithKey());
    const { judge } = await import("../lib/jev/judge");
    const many = Array.from({ length: 150 }, (_, index) => ({ ...companies[index % 2], code: `6${String(index).padStart(5, "0")}` })) as Company[];
    const verdict = await judge("银行", many);
    expect(verdict.chunks).toBe(2);
    expect(verdict.answeredChunks).toBe(1);
    expect(verdict.live).toBe(false);
    expect(verdict.scores).toHaveLength(150);
  });

  it("empty candidate pool asks the cloud nothing", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    setProviderForJudge(providerWithKey());
    const { judge } = await import("../lib/jev/judge");
    const verdict = await judge("银行", []);
    expect(verdict.live).toBe(true);
    expect(verdict.chunks).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** judge()/classify() resolve the provider through the singleton seam. */
function setProviderForJudge(provider: JevCloudProvider) {
  return import("../lib/jev/cloud").then(({ setJevProviderOverride }) => {
    setJevProviderOverride(provider);
    return provider;
  });
}

describe("runtime decoupling — structural proof (§1/§3)", () => {
  const runtimeFiles = ["lib/jev/cloud.ts", "lib/jev/judge.ts", "lib/jev/classify.ts", "lib/jev/provider.ts", "lib/jev/mock.ts", "lib/env.ts", "lib/search/pipeline.ts", "scripts/atlas_start.cmd", "app/api/health/route.ts", "lib/telemetry/runtime.ts", "lib/telemetry/contract.ts", "lib/atlas/runtime.ts", "scripts/jev_stub.mjs", ".github/workflows/windows-runtime.yml"];

  it("has no Laya transport module at all", () => {
    expect(() => readFileSync("lib/jev/client.ts", "utf8")).toThrow();
  });

  it("names neither Laya nor its port anywhere in the runtime path", () => {
    for (const file of runtimeFiles) {
      const text = readFileSync(file, "utf8");
      // A real dependency needs a real identifier: a config var, a URL, a module
      // or an import. Prose that says "we no longer use Laya" is not one.
      expect(text, file).not.toMatch(/LAYA_URL|LAYA_CHECKPOINT|layaUrl|\b8787\b|laya_server|from "[^"]*laya|require\([^)]*laya/i);
    }
  });

  it("the judge exposes one provider and one test seam, nothing else", async () => {
    const cloud = await import("../lib/jev/cloud");
    const exports = Object.keys(cloud).sort();
    expect(exports).toContain("JevCloudProvider");
    expect(exports).toContain("jevProvider");
    expect(exports).toContain("setJevProviderOverride");
    // The guard that matters: no second transport, no fallback, no alias for Laya.
    expect(exports.join(","), "judge module exports").not.toMatch(/laya|sidecar|fallback|second|backup/i);
  });
});
