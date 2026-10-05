import { LruCache } from "@/lib/cache";
import { findCompany } from "@/lib/atlas/company";
import { discoverCacheKey, lookupDiscover } from "@/lib/atlas/discoverCache";
import { evidenceViewsFor, judgeEvidenceFor } from "@/lib/atlas/evidence";
import {
  judgeCacheIdentity,
  runEvidenceExplanation,
  runSemanticComparison,
  subjectsOf,
} from "@/lib/jev/capabilities";
import { recordJevCall } from "@/lib/telemetry/jev";

/**
 * Evidence explanation endpoint (Phase 3.4) — the product surface of the
 * frozen `evidence-explanation-1` capability, plus the internal comparison
 * evidence surface.
 *
 * POST /api/explain { q, code }
 *   Explains the judgement behind a row of the CACHED discover answer for q.
 *   The judgement is read back from the answer the user actually saw (never
 *   re-judged, never client-asserted); evidence is resolved Atlas-side; Jev
 *   only selects which of those facts support the judgement, and the lines
 *   quote that evidence verbatim. Cache miss → the explanation is honestly
 *   unavailable (re-running the judge for a stale answer would be a second,
 *   divergent judgement). Facts (evidence views) are returned whenever they
 *   resolve — they do not depend on the search.
 *
 * POST /api/explain { mode: "comparison", q, codes }
 *   Internal surface (§8): the semantic-comparison capability over 2–4 named
 *   companies, with each decision's evidence resolved. Not linked from the UI.
 *
 * No fallback judge: Jev unavailable → honest "unavailable", never a locally
 * generated explanation.
 */

type ExplanationPayload = {
  status: "ok" | "insufficient_evidence";
  lines: { ref: string; quote: string }[];
  contractVersion: string;
  runtimeModel: string | null;
};

const explanationCache = new LruCache<ExplanationPayload>(64);

const SIX_DIGITS = /^\d{6}$/;

export async function POST(request: Request) {
  const started = performance.now();
  const body = (await request.json().catch(() => null)) as
    | { mode?: string; q?: unknown; code?: unknown; codes?: unknown }
    | null;
  const q = typeof body?.q === "string" ? body.q.trim().slice(0, 120) : "";
  if (q.length < 2) return Response.json({ error: "至少输入 2 个字。" }, { status: 400 });

  if (body?.mode === "comparison") return explainComparison(q, body.codes, started);

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!SIX_DIGITS.test(code)) return Response.json({ error: "需要 6 位公司代码。" }, { status: 400 });
  const company = findCompany(code);
  if (!company) return Response.json({ error: "公司池中没有这家公司。" }, { status: 404 });

  const ms = () => Math.round(performance.now() - started);

  // The judgement on record: the row of the answer the user saw.
  const answer = lookupDiscover(discoverCacheKey(q));
  const row = answer?.results.find((entry) => entry.code === code) ?? null;
  const judgement = row?.judgement ?? null;
  const evidenceViews = evidenceViewsFor([{ companyId: code, ref: `judge-profile:${code}` }]);
  const unavailableReason = answer ? (row ? "not_judged" : "not_in_answer") : "search_expired";

  const base = {
    code,
    name: company.name,
    judgement: judgement
      ? {
          capability: judgement.capability,
          query: judgement.query,
          score: judgement.score,
          matched: judgement.matched,
          relationLabel: judgement.relationLabel,
        }
      : null,
    evidence: evidenceViews,
  };

  if (!judgement) {
    return Response.json(
      { ...base, explanation: { status: "unavailable", lines: [], contractVersion: null, runtimeModel: null, reason: unavailableReason }, cached: false, ms: ms() },
    );
  }

  const key = `${judgeCacheIdentity()}:${q.toLowerCase()}:${code}`;
  const cachedExplanation = explanationCache.get(key);
  if (cachedExplanation) {
    return Response.json({ ...base, explanation: cachedExplanation, cached: true, ms: ms() });
  }

  const result = await runEvidenceExplanation(
    {
      userQuery: q,
      judgement: {
        capability: judgement.capability,
        query: judgement.query,
        companyId: code,
        companyName: company.name,
        score: judgement.score,
        matched: judgement.matched,
      },
      evidence: judgeEvidenceFor(code),
    },
    { signal: request.signal },
  );
  // §4 Jev cost trace: explanation calls cost tokens too — recorded under the
  // discover search that produced the judgement (when that answer is still
  // cached), otherwise under null. Never an extra call: this IS the call.
  void recordJevCall({
    searchId: answer?.searchId ?? null,
    sessionId: null,
    invocation: "evidence_explanation",
    capability: result.capability,
    contractVersion: result.contractVersion,
    runtimeModel: result.runtimeModel,
    status: result.status,
    outcome: result.outcome ?? null,
    subjectCount: 1,
    decisionCount: result.lines.length,
    chunkCount: 1,
    answeredChunks: result.status === "ok" ? 1 : 0,
    tokens: result.tokens,
    costUsd: result.costUsd,
    judgeMs: result.timings.judgeMs,
    totalMs: result.timings.totalMs,
  });

  if (result.status === "ok") {
    const payload: ExplanationPayload = {
      status: result.insufficientEvidence ? "insufficient_evidence" : "ok",
      lines: result.lines,
      contractVersion: result.contractVersion,
      runtimeModel: result.runtimeModel,
    };
    explanationCache.set(key, payload);
    return Response.json({ ...base, explanation: payload, cached: false, ms: ms() });
  }

  // Degraded / rejected: honest unavailability, never fabricated prose. Not
  // cached — a recovered judge should answer on the next click.
  return Response.json(
    {
      ...base,
      explanation: { status: "unavailable", lines: [], contractVersion: result.contractVersion, runtimeModel: result.runtimeModel, reason: result.failure ?? "degraded" },
      cached: false,
      ms: ms(),
    },
  );
}

/** Internal comparison evidence surface — Atlas picks subjects and evidence,
 * Jev grades the relative semantic relation, decisions sort into the answer. */
async function explainComparison(q: string, codes: unknown, started: number): Promise<Response> {
  const ms = () => Math.round(performance.now() - started);
  if (!Array.isArray(codes) || codes.length < 2 || codes.length > 4) {
    return Response.json({ error: "比较需要 2–4 家公司。" }, { status: 400 });
  }
  const list = [...new Set(codes)].map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (list.some((code) => !SIX_DIGITS.test(code))) {
    return Response.json({ error: "需要 6 位公司代码。" }, { status: 400 });
  }
  const companies = list.map((code) => findCompany(code));
  if (companies.some((company) => company === null)) {
    return Response.json({ error: "公司池中存在未知代码。" }, { status: 404 });
  }
  const result = await runSemanticComparison({ comparisonQuery: q, subjects: subjectsOf(companies as NonNullable<(typeof companies)[number]>[], "zh") });
  void recordJevCall({
    searchId: null,
    sessionId: null,
    invocation: "comparison",
    capability: result.capability,
    contractVersion: result.contractVersion,
    runtimeModel: result.runtimeModel,
    status: result.status,
    outcome: result.outcome ?? null,
    subjectCount: (companies as NonNullable<(typeof companies)[number]>[]).length,
    decisionCount: result.decisions.length,
    chunkCount: result.chunks,
    answeredChunks: result.answeredChunks,
    tokens: result.tokens,
    costUsd: result.costUsd,
    judgeMs: result.timings.judgeMs,
    totalMs: result.timings.totalMs,
  });
  const subjects = result.decisions
    .map((decision) => {
      const company = (companies as NonNullable<(typeof companies)[number]>[]).find((entry) => entry!.code === decision.companyId)!;
      return {
        companyId: decision.companyId,
        name: company.name,
        grade: decision.grade,
        score: decision.score,
        evidence: evidenceViewsFor(decision.evidenceRefs),
      };
    })
    .sort((a, b) => b.score - a.score);
  return Response.json({
    mode: "comparison",
    query: q,
    status: result.status,
    failure: result.failure,
    outcome: result.outcome,
    contractVersion: result.contractVersion,
    runtimeModel: result.runtimeModel,
    // Placeholder decisions when degraded — consumers must check status first.
    subjects,
    ms: ms(),
  });
}
