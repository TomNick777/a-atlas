import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capabilityFailureOf,
  JEV_CAPABILITY_CONTRACT_VERSIONS,
  JEV_CAPABILITY_REGISTRY,
  recentCapabilityDiagnostics,
  resetCapabilityDiagnostics,
  resolveJevCapability,
  runEvidenceExplanation,
  runJevJudgement,
  runSemanticComparison,
  runSemanticMatch,
  runSemanticRelation,
  setJevProviderOverride,
  subjectsOf,
  type EvidenceItem,
  type JudgementSubject,
} from "../lib/jev/capabilities";
import type { Company } from "../lib/types";
import type { JevCall, JudgeProvider } from "../lib/jev/provider";

/**
 * Capability contract tests (Phase 3.3 §15 B) — offline, zero network.
 *
 * The transport is an in-process stub answering the SystemOne question shape,
 * so what these tests prove is the CONTRACT: input validation, decision
 * alignment, evidence-ref traceability, failure states, and the fact that
 * contract versions and runtime identity stay independent. The REAL wire shape
 * for semantic_match is proven by the committed payload fixtures
 * (tests/jev_payload_contract.test.ts) and by the REQUIRED_LIVE suite for all
 * four capabilities.
 */

/** In-process transport stub: answers every question key with noul/score heads. */
function stubTransport(options: {
  noul?: (questionKey: string) => number;
  score?: (questionKey: string) => number;
  model?: string;
  calls?: Record<string, unknown>[];
}): JudgeProvider {
  const model = options.model ?? "jev-contract-stub";
  return {
    id: "jev",
    model,
    configured: () => true,
    status: () => ({
      provider: "jev",
      configured: true,
      model,
      endpoint: "in-process-stub",
      breaker: { state: "closed", consecutiveFailures: 0, openedAt: null, openUntil: null, trips: 0, lastTripReason: null },
      lastAnsweredModel: model,
      inFlight: 0,
    }),
    stats: () => ({ calls: 0, ok: 0, retries: 0, timeouts: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, unauthorized: 0, breakerRejected: 0, budgetExhausted: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: { p50: null, p95: null, max: null } }),
    async ask<T>(body: Record<string, unknown>): Promise<JevCall<T>> {
      options.calls?.push(JSON.parse(JSON.stringify(body)));
      const questions = (body.questions ?? {}) as Record<string, unknown>;
      const answers: Record<string, unknown> = {};
      for (const key of Object.keys(questions)) {
        const noul = options.noul?.(key) ?? 0.8;
        answers[key] = { noul, score: options.score?.(key) ?? Math.round(noul * 3) };
      }
      return {
        ok: true,
        data: { model, answers, usage: { input_tokens: 12, output_tokens: 3 } } as T,
        outcome: "ok",
        model,
        attempt: 1,
        latencyMs: 2,
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    },
  };
}

/** A transport that always fails with the given outcome (no network). */
function failingTransport(outcome: Parameters<typeof capabilityFailureOf>[0]): JudgeProvider {
  const provider = stubTransport({});
  return {
    ...provider,
    async ask<T>(): Promise<JevCall<T>> {
      return { ok: false, outcome, status: null, attempt: 1, latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function companyOf(code: string, name: string, judgeText: string): Company {
  return {
    code,
    name,
    fullName: name,
    exchange: "SZ",
    board: "主板",
    industry: "x",
    swLevel1Industry: "x",
    businessDescription: judgeText,
    mainProducts: [],
    concepts: [],
    region: { province: "x", city: null },
    companyDescription: judgeText,
    marketCap: null,
    overseasRevenueShare: null,
    searchableText: judgeText,
    judgeText,
    judgeTextEn: null,
  } as unknown as Company;
}

const Kessen = companyOf("603626", "科森科技", "科森科技（603626，SH） | 主营：为苹果等客户提供消费电子精密结构件。");
const Moutai = companyOf("600519", "贵州茅台", "贵州茅台（600519，SH） | 主营：茅台酒及系列酒的生产与销售。");
const Innolux = companyOf("300308", "中际旭创", "中际旭创（300308，SZ） | 主营：高端光通信收发模块的研发、生产及销售。");

const evidenceOf = (subject: JudgementSubject): EvidenceItem[] => subject.evidence;

beforeEach(() => {
  resetCapabilityDiagnostics();
});

afterEach(() => {
  setJevProviderOverride(null);
});

describe("semantic_match contract", () => {
  it("decisions stay input-aligned, matched follows the midpoint, evidence refs resolve", async () => {
    setJevProviderOverride(stubTransport({ noul: (key) => (key === "c1" ? 0.2 : 0.9) }));
    const subjects = subjectsOf([Kessen, Moutai]);
    const result = await runSemanticMatch({ query: "做人形机器人减速器", subjects });

    expect(result.status).toBe("ok");
    expect(result.live).toBe(true);
    expect(result.contractVersion).toBe("semantic-match-1");
    expect(result.decisions.map((decision) => decision.companyId)).toEqual(["603626", "600519"]);
    expect(result.decisions.map((decision) => decision.matched)).toEqual([true, false]);
    for (const decision of result.decisions) {
      const subject = subjects.find((row) => row.companyId === decision.companyId)!;
      expect(decision.evidenceRefs.map((ref) => ref.ref)).toEqual(evidenceOf(subject).map((item) => item.ref));
      expect(decision.evidenceRefs.every((ref) => ref.companyId === decision.companyId)).toBe(true);
    }
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("empty subjects: no call, live ok, empty decisions", async () => {
    const calls: Record<string, unknown>[] = [];
    setJevProviderOverride(stubTransport({ calls }));
    const result = await runSemanticMatch({ query: "机器人", subjects: [] });
    expect(result.status).toBe("ok");
    expect(result.decisions).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("empty query is a rejected invalid_request with no call", async () => {
    const calls: Record<string, unknown>[] = [];
    setJevProviderOverride(stubTransport({ calls }));
    const result = await runSemanticMatch({ query: "  ", subjects: subjectsOf([Kessen]) });
    expect(result.status).toBe("rejected");
    expect(result.failure).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("transport failure degrades honestly: failure state set, decisions stay aligned", async () => {
    setJevProviderOverride(failingTransport("timeout"));
    const subjects = subjectsOf([Kessen, Moutai]);
    const result = await runSemanticMatch({ query: "机器人", subjects });
    expect(result.status).toBe("degraded");
    expect(result.live).toBe(false);
    expect(result.failure).toBe("timeout");
    expect(result.outcome).toBe("timeout");
    expect(result.decisions).toHaveLength(subjects.length); // median-filled placeholders, index-aligned
    expect(result.runtimeModel).toBeNull();
  });
});

describe("semantic_relation contract", () => {
  it("judges the relation against provided evidence; label is the query verbatim", async () => {
    const calls: Record<string, unknown>[] = [];
    setJevProviderOverride(stubTransport({ noul: (key) => (key === "c1" ? 0.1 : 0.85), calls }));
    const subjects = subjectsOf([Kessen, Moutai]);
    const result = await runSemanticRelation({ relationQuery: "苹果产业链供应商", subjects });

    expect(result.status).toBe("ok");
    expect(result.contractVersion).toBe("semantic-relation-1");
    expect(result.decisions.map((decision) => decision.matched)).toEqual([true, false]);
    expect(result.decisions.every((decision) => decision.relationLabel === "苹果产业链供应商")).toBe(true);
    // The wire carries the relation question against the SAME profile facts.
    const body = calls[0] as { state?: { looking_for?: string }; questions?: Record<string, { type?: string; instructions?: { company?: { profile?: string } } }> };
    expect(body.state?.looking_for).toBe("苹果产业链供应商");
    expect(Object.values(body.questions ?? {})[0]?.type).toBe("noul");
    expect(Object.values(body.questions ?? {})[0]?.instructions?.company?.profile).toContain("苹果");
  });

  it("a subject without evidence is rejected insufficient_evidence BEFORE any call", async () => {
    const calls: Record<string, unknown>[] = [];
    setJevProviderOverride(stubTransport({ calls }));
    const result = await runSemanticRelation({
      relationQuery: "某车企供应商",
      subjects: [{ companyId: "603626", name: "科森科技", evidence: [] }],
    });
    expect(result.status).toBe("rejected");
    expect(result.failure).toBe("insufficient_evidence");
    expect(result.decisions).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("empty relation query is rejected invalid_request", async () => {
    setJevProviderOverride(stubTransport({}));
    const result = await runSemanticRelation({ relationQuery: "", subjects: subjectsOf([Kessen]) });
    expect(result.status).toBe("rejected");
    expect(result.failure).toBe("invalid_request");
  });
});

describe("semantic_comparison contract", () => {
  it("grades every subject on the score head; relative answer = sorted decisions", async () => {
    const calls: Record<string, unknown>[] = [];
    setJevProviderOverride(stubTransport({ score: (key) => (key === "c0" ? 3 : 0), calls }));
    const subjects = subjectsOf([Innolux, Moutai]);
    const result = await runSemanticComparison({ comparisonQuery: "谁更偏光模块主业", subjects });

    expect(result.status).toBe("ok");
    expect(result.contractVersion).toBe("semantic-comparison-1");
    const [first, second] = result.decisions;
    expect(first.grade).toBe(3);
    expect(first.score).toBe(1);
    expect(second.grade).toBe(0);
    expect(first.score).toBeGreaterThan(second.score);
    // The relative answer, computed the honest way:
    const ranked = [...result.decisions].sort((a, b) => b.score - a.score);
    expect(ranked[0].companyId).toBe("300308");
    // The wire is the score head with the frozen criteria.
    const question = Object.values((calls[0] as { questions?: Record<string, { type?: string }> }).questions ?? {})[0];
    expect(question?.type).toBe("score");
  });

  it("fewer than one subject, or empty query, is rejected", async () => {
    setJevProviderOverride(stubTransport({}));
    expect((await runSemanticComparison({ comparisonQuery: "x", subjects: [] })).failure).toBe("invalid_request");
    expect((await runSemanticComparison({ comparisonQuery: " ", subjects: subjectsOf([Kessen, Moutai]) })).failure).toBe("invalid_request");
  });

  it("degraded comparison keeps decisions aligned but status says degraded", async () => {
    setJevProviderOverride(failingTransport("server_error"));
    const subjects = subjectsOf([Innolux, Moutai]);
    const result = await runSemanticComparison({ comparisonQuery: "谁更偏伺服", subjects });
    expect(result.status).toBe("degraded");
    expect(result.failure).toBe("jev_unavailable");
    expect(result.decisions).toHaveLength(subjects.length); // placeholders; consumers must read status first
  });
});

describe("evidence_explanation contract", () => {
  const judgement = {
    capability: "semantic_relation" as const,
    query: "苹果产业链供应商",
    companyId: "603626",
    companyName: "科森科技",
    score: 0.9,
    matched: true,
  };

  it("lines quote the selected evidence verbatim and cite its refs — nothing else", async () => {
    const calls: Record<string, unknown>[] = [];
    setJevProviderOverride(stubTransport({ noul: (key) => (key === "e1" ? 0.1 : 0.9), calls }));
    const evidence: EvidenceItem[] = [
      { ref: "judge-profile:603626", text: "主营：为苹果等客户提供消费电子精密结构件。" },
      { ref: "profile:region", text: "注册地：江苏。" },
    ];
    const result = await runEvidenceExplanation({ userQuery: "苹果产业链供应商", judgement, evidence });

    expect(result.status).toBe("ok");
    expect(result.insufficientEvidence).toBe(false);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].ref).toBe("judge-profile:603626");
    expect(result.lines[0].quote).toBe(evidence[0].text); // verbatim — the quote IS the fact
    // The wire asked per-evidence yes/no questions against the same company.
    const body = calls[0] as { questions?: Record<string, { instructions?: { company?: { code?: string; profile?: string } } }> };
    expect(Object.values(body.questions ?? {})[0]?.instructions?.company?.code).toBe("603626");
    expect(Object.values(body.questions ?? {})[0]?.instructions?.company?.profile).toContain("苹果");
  });

  it("no evidence → rejected insufficient_evidence without a call", async () => {
    const calls: Record<string, unknown>[] = [];
    setJevProviderOverride(stubTransport({ calls }));
    const result = await runEvidenceExplanation({ userQuery: "x", judgement, evidence: [] });
    expect(result.status).toBe("rejected");
    expect(result.failure).toBe("insufficient_evidence");
    expect(result.insufficientEvidence).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("evidence that does not support the judgement is an honest empty explanation", async () => {
    setJevProviderOverride(stubTransport({ noul: () => 0.05 }));
    const result = await runEvidenceExplanation({
      userQuery: "苹果产业链供应商",
      judgement,
      evidence: [{ ref: "profile:region", text: "注册地：江苏。" }],
    });
    expect(result.status).toBe("ok");
    expect(result.insufficientEvidence).toBe(true);
    expect(result.lines).toEqual([]);
  });
});

describe("failure semantics + registry + routing (§7/§11/§18)", () => {
  it("outcome → failure mapping is total and monotone", () => {
    expect(capabilityFailureOf("timeout")).toBe("timeout");
    expect(capabilityFailureOf("connect_timeout")).toBe("timeout");
    expect(capabilityFailureOf("bad_response")).toBe("invalid_capability_response");
    for (const outcome of ["no_config", "breaker_open", "network_error", "unauthorized", "rate_limited", "server_error", "budget_exhausted", "admission_timeout", "aborted", "client_error"] as const) {
      expect(capabilityFailureOf(outcome)).toBe("jev_unavailable");
    }
  });

  it("the registry is closed: exactly the four capabilities, contract versions independent of the runtime model", () => {
    expect(JEV_CAPABILITY_REGISTRY.capabilities.map((capability) => capability.id)).toEqual(["semantic_match", "semantic_relation", "semantic_comparison", "evidence_explanation"]);
    for (const capability of JEV_CAPABILITY_REGISTRY.capabilities) {
      expect(capability.contractVersion).not.toMatch(/jev-1|jev-latest|jev-stub/); // contract ≠ runtime
      expect(capability.factAuthority).toBe("atlas");
    }
    expect(JEV_CAPABILITY_CONTRACT_VERSIONS.semantic_match).toBe("semantic-match-1");
  });

  it("routing is deterministic: relation syntax only, everything else stays match", () => {
    expect(resolveJevCapability("英伟达供应链").capability).toBe("semantic_relation");
    expect(resolveJevCapability("给新能源车企做热管理的配套厂商").capability).toBe("semantic_relation");
    expect(resolveJevCapability("机器人产业链上游零部件").capability).toBe("semantic_relation");
    expect(resolveJevCapability("做人形机器人减速器").capability).toBe("semantic_match");
    expect(resolveJevCapability("AI服务器CPO光模块").capability).toBe("semantic_match");
    expect(resolveJevCapability("做K线软件的公司").capability).toBe("semantic_match");
    expect(resolveJevCapability("未来教育相关公司").capability).toBe("semantic_match");
  });

  it("runJevJudgement routes relation syntax to semantic_relation transparently", async () => {
    setJevProviderOverride(stubTransport({ noul: () => 0.9 }));
    const routed = await runJevJudgement("某品牌供应链", subjectsOf([Kessen]));
    expect(routed.capability).toBe("semantic_relation");
    const matched = await runJevJudgement("做人形机器人减速器", subjectsOf([Kessen]));
    expect(matched.capability).toBe("semantic_match");
  });
});

describe("capability diagnostics (§13)", () => {
  it("records capability, versions, counts and latencies — never payloads or keys", async () => {
    setJevProviderOverride(stubTransport({ noul: () => 0.7 }));
    await runSemanticMatch({ query: "机器人", subjects: subjectsOf([Kessen, Moutai]) });
    const rows = recentCapabilityDiagnostics();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.capability).toBe("semantic_match");
    expect(row.contractVersion).toBe("semantic-match-1");
    expect(row.status).toBe("ok");
    expect(row.subjectCount).toBe(2);
    expect(row.evidenceCount).toBe(2);
    expect(row.decisionCount).toBe(2);
    expect(row.judgeMs).toBeGreaterThanOrEqual(0);
    expect(row.latencyMs).toBeGreaterThanOrEqual(row.judgeMs);
    expect(JSON.stringify(rows)).not.toMatch(/looking_for|TYPESAFE|api\.typesafe/);
  });

  it("rejected runs are recorded with their precondition failure", async () => {
    setJevProviderOverride(stubTransport({}));
    await runSemanticRelation({ relationQuery: "x供应链", subjects: [{ companyId: "603626", name: "科森科技", evidence: [] }] });
    const row = recentCapabilityDiagnostics()[0];
    expect(row.status).toBe("rejected");
    expect(row.failure).toBe("insufficient_evidence");
    expect(row.decisionCount).toBe(0);
  });
});
