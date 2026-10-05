/**
 * SemanticRelation capability (Phase 3.3 §4) — "A 公司与 B 公司/产业/产品之间
 * 是否存在用户描述的语义关系？"
 *
 * Jev may judge the relation ONLY against the evidence Atlas provides: a
 * relation the corpus/profile does not carry must not become a production
 * fact. There is no knowledge graph behind this — it is one relation judgement
 * per subject, batched on the same wire head the match capability uses.
 *
 * The relation label in every decision is the Atlas-provided relation phrase,
 * verbatim — never something Jev invented.
 */
import { jevDetail } from "../../env";
import { jevProvider, type SystemOneResponse } from "../cloud";
import { JEV_PRICE_PER_TOKEN, JEV_TIMING, type JevOutcome } from "../provider";
import { runChunked, type ChunkResult } from "./chunked";
import { capabilityFailureOf, JEV_CAPABILITY_CONTRACT_VERSIONS, type EvidenceRef, type JudgementSubject, type SemanticRelationDecision, type SemanticRelationRequest, type SemanticRelationResult } from "./contracts";
import { recordCapabilityRun, timingsOf } from "../diagnostics/capability";

export const RELATION_CHUNK = 100;
export const RELATION_THRESHOLD = 0.5;

const RELATION_HOW =
  "looking_for 描述一种企业之间的关系（供应、配套、合作、客户、产业链位置等）。" +
  "每一题是一家候选公司，profile 是它的公开业务资料。" +
  "只判断 profile 中的资料能否支持这家公司与 looking_for 描述的对象存在该关系。" +
  "资料里写明的客户、供应商、合作、配套等才能算支持；资料没有写就不要猜，概念沾边不算。";

type NoulAnswer = { noul?: number };

function profileTextOf(subject: JudgementSubject): string {
  return subject.evidence.map((item) => item.text).join("\n").slice(0, jevDetail());
}

async function askRelation(relationQuery: string, subjects: JudgementSubject[], options: { signal?: AbortSignal; deadlineAt?: number }): Promise<ChunkResult> {
  const questions: Record<string, unknown> = {};
  subjects.forEach((subject, index) => {
    questions[`c${index}`] = {
      type: "noul",
      instructions: {
        company: { name: subject.name, code: subject.companyId, profile: profileTextOf(subject) },
        question: "company 与 looking_for 所描述的对象之间，是否存在该关系？（只依据 profile 判断）",
        yes: "profile 明确写明了这种关系（如客户、供应商、合作、配套、产业链位置）。",
        no: "profile 没有写明这种关系，或只是概念沾边；资料不足时不猜。",
      },
    };
  });
  const call = await jevProvider().ask<SystemOneResponse<Record<string, NoulAnswer>>>(
    { state: { looking_for: relationQuery.slice(0, 300), how_to_judge: RELATION_HOW }, questions },
    "rerank",
    options,
  );
  if (!call.ok) return { ok: false, scores: null, tokens: 0, model: null, outcome: call.outcome };
  const answers = call.data.answers ?? {};
  let unexpected = 0;
  const scores = subjects.map((_, index) => {
    const noul = answers[`c${index}`]?.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) { unexpected += 1; return 0.5; }
    return noul;
  });
  return { ok: true, scores, tokens: call.usage.inputTokens + call.usage.outputTokens, model: call.model, outcome: "ok", unexpected, known: subjects.map((_, i) => { const n = answers[`c${i}`]?.noul; return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1; }) };
}

/**
 * Run the semantic_relation capability. Every subject must carry at least one
 * evidence item — a relation judgement with no facts to read is rejected
 * before any call (insufficient_evidence), never answered from model memory.
 */
export async function runSemanticRelation(
  request: SemanticRelationRequest,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<SemanticRelationResult> {
  const started = performance.now();
  const base = { capability: "semantic_relation" as const, contractVersion: JEV_CAPABILITY_CONTRACT_VERSIONS.semantic_relation };
  const subjectCount = request.subjects.length;
  const evidenceCount = request.subjects.reduce((sum, subject) => sum + subject.evidence.length, 0);

  const reject = (failure: "invalid_request" | "insufficient_evidence", detail: string): SemanticRelationResult => {
    const timings = { prepareMs: roundMs(performance.now() - started), judgeMs: 0, totalMs: roundMs(performance.now() - started) };
    recordCapabilityRun({ ...base, runtimeModel: null, status: "rejected", failure, outcome: null, subjectCount, evidenceCount, decisionCount: 0, unexpectedAnswers: 0, ...timingsOf(timings), detail });
    return { ...base, live: false, status: "rejected", failure, outcome: null, runtimeModel: null, tokens: 0, costUsd: null, timings, decisions: [], chunks: 0, answeredChunks: 0, unexpectedAnswers: 0 };
  };
  if (!request.relationQuery.trim()) return reject("invalid_request", "relationQuery is empty");
  if (!subjectCount) return reject("invalid_request", "no subjects to judge");
  if (evidenceCount < subjectCount) return reject("insufficient_evidence", "every subject must carry at least one evidence item");

  const deadlineAt = options.deadlineAt ?? Date.now() + JEV_TIMING.rerankBudgetMs;
  const verdict = await runChunked(
    request.subjects,
    RELATION_CHUNK,
    (chunk, chunkOptions) => askRelation(request.relationQuery, chunk, { ...chunkOptions, deadlineAt }),
    { signal: options.signal },
  );

  const live = verdict.live;
  const outcome: JevOutcome = verdict.outcome;
  const decisions: SemanticRelationDecision[] = live
    ? verdict.scores.map((score, index) => {
        const subject = request.subjects[index];
        const evidenceRefs: EvidenceRef[] = subject.evidence.map((item) => ({ companyId: subject.companyId, ref: item.ref }));
        return { known: verdict.known[index], companyId: subject.companyId, score, matched: score >= RELATION_THRESHOLD, relationLabel: request.relationQuery, evidenceRefs };
      })
    : [];

  const timings = { prepareMs: 0, judgeMs: roundMs(verdict.judgeMs), totalMs: roundMs(performance.now() - started) };
  const result: SemanticRelationResult = {
    ...base,
    live,
    status: live ? "ok" : "degraded",
    failure: live ? null : capabilityFailureOf(outcome),
    outcome: live ? null : outcome,
    runtimeModel: verdict.model,
    tokens: verdict.tokens,
    costUsd: verdict.tokens > 0 ? Math.round(verdict.tokens * JEV_PRICE_PER_TOKEN * 1e6) / 1e6 : null,
    timings,
    decisions,
    chunks: verdict.chunks,
    answeredChunks: verdict.answeredChunks,
    unexpectedAnswers: verdict.unexpected,
  };
  recordCapabilityRun({
    ...base,
    runtimeModel: result.runtimeModel,
    status: result.status,
    failure: result.failure,
    outcome: result.outcome,
    subjectCount,
    evidenceCount,
    decisionCount: decisions.length,
    unexpectedAnswers: verdict.unexpected,
    ...timingsOf(timings),
    detail: null,
  });
  return result;
}

function roundMs(n: number): number {
  return Math.round(n * 100) / 100;
}
