/**
 * SemanticComparison capability (Phase 3.3 §5) — "这几家谁更偏 X？"
 *
 * Atlas decides WHO is compared and WHICH facts they are judged on (subjects +
 * evidence, with the corpus/profile text and its data cutoff); Jev only grades
 * each subject's relative semantic fit to the user's description, on the same
 * score head the graded harnesses have always used (payload verbatim from
 * judge.ts's askGraded). The relative answer is the sorted decisions — this
 * capability is never free-form question answering.
 *
 * The graded head keeps its chunked median-fill semantics so the offline
 * harnesses that ride judgeGraded keep byte-identical payloads.
 */
import { jevDetail } from "../../env";
import { jevProvider, type SystemOneResponse } from "../cloud";
import { JEV_PRICE_PER_TOKEN, JEV_TIMING, type JevOutcome } from "../provider";
import { runChunked, type ChunkResult } from "./chunked";
import { capabilityFailureOf, JEV_CAPABILITY_CONTRACT_VERSIONS, type EvidenceRef, type JudgementSubject, type SemanticComparisonDecision, type SemanticComparisonRequest, type SemanticComparisonResult } from "./contracts";
import { recordCapabilityRun, timingsOf } from "../diagnostics/capability";

export const COMPARISON_CHUNK = 100;

const COMPARISON_HOW =
  "looking_for 是一个人用自己的话说想找的公司。" +
  "每一题是一家候选公司，profile 是它的公开业务资料。" +
  "判断这家公司的主营业务是否就是这句话在找的东西。" +
  "概念标签沾边但主营无关，回答要低。" +
  "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。" +
  "几家公司可以同时符合。";

type ScoreAnswer = { score?: number };

function profileTextOf(subject: JudgementSubject): string {
  return subject.evidence.map((item) => item.text).join("\n").slice(0, jevDetail());
}

async function askGraded(comparisonQuery: string, subjects: JudgementSubject[], options: { signal?: AbortSignal; deadlineAt?: number }): Promise<ChunkResult> {
  const questions: Record<string, unknown> = {};
  subjects.forEach((subject, index) => {
    questions[`c${index}`] = {
      type: "score",
      instructions: {
        company: { name: subject.name, code: subject.companyId, profile: profileTextOf(subject) },
        question: "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。",
      },
      criteria: ["0=无关:主营业务与查询要找的无关", "1=沾边:概念/名字/大类相邻,主营业务并不符合", "2=部分相关:产业链上下游,或组合条件只满足一半", "3=直接相关:主营业务就是查询要找的东西"],
    };
  });
  const call = await jevProvider().ask<SystemOneResponse<Record<string, ScoreAnswer>>>(
    { state: { looking_for: comparisonQuery.slice(0, 300), how_to_judge: COMPARISON_HOW }, questions },
    "rerank",
    options,
  );
  if (!call.ok) return { ok: false, scores: null, tokens: 0, model: null, outcome: call.outcome };
  const answers = call.data.answers ?? {};
  let unexpected = 0;
  // Normalised to 0..1 so thresholds keep their meaning across capabilities.
  const scores = subjects.map((_, index) => {
    const grade = answers[`c${index}`]?.score;
    if (typeof grade !== "number") unexpected += 1;
    return typeof grade === "number" ? grade / 3 : 0;
  });
  return { ok: true, scores, tokens: call.usage.inputTokens + call.usage.outputTokens, model: call.model, outcome: "ok", unexpected };
}

/**
 * Run the semantic_comparison capability. Subjects are judged independently
 * and returned in input order; sort by score for the relative answer.
 *
 * Contract rule: decisions are ALWAYS input-aligned, but when status !== "ok"
 * they are chunk-median placeholders, not judgements — consumers must check
 * status first. (The graded offline harnesses ride this alignment; relation,
 * which has no such harness, returns no decisions at all when degraded.)
 */
export async function runSemanticComparison(
  request: SemanticComparisonRequest,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<SemanticComparisonResult> {
  const started = performance.now();
  const base = { capability: "semantic_comparison" as const, contractVersion: JEV_CAPABILITY_CONTRACT_VERSIONS.semantic_comparison };
  const subjectCount = request.subjects.length;
  const evidenceCount = request.subjects.reduce((sum, subject) => sum + subject.evidence.length, 0);

  const reject = (failure: "invalid_request" | "insufficient_evidence", detail: string): SemanticComparisonResult => {
    const timings = { prepareMs: round(performance.now() - started), judgeMs: 0, totalMs: round(performance.now() - started) };
    recordCapabilityRun({ ...base, runtimeModel: null, status: "rejected", failure, outcome: null, subjectCount, evidenceCount, decisionCount: 0, unexpectedAnswers: 0, ...timingsOf(timings), detail });
    return { ...base, live: false, status: "rejected", failure, outcome: null, runtimeModel: null, tokens: 0, costUsd: null, timings, decisions: [], chunks: 0, answeredChunks: 0, unexpectedAnswers: 0 };
  };
  if (!request.comparisonQuery.trim()) return reject("invalid_request", "comparisonQuery is empty");
  if (!subjectCount) return reject("invalid_request", "no subjects to compare");
  if (evidenceCount < subjectCount) return reject("insufficient_evidence", "every subject must carry at least one evidence item");

  const deadlineAt = options.deadlineAt ?? Date.now() + JEV_TIMING.rerankBudgetMs;
  const verdict = await runChunked(
    request.subjects,
    COMPARISON_CHUNK,
    (chunk, chunkOptions) => askGraded(request.comparisonQuery, chunk, { ...chunkOptions, deadlineAt }),
    { signal: options.signal },
  );

  const live = verdict.live;
  const outcome: JevOutcome = verdict.outcome;
  const decisions: SemanticComparisonDecision[] = verdict.scores.map((score, index) => {
    const subject = request.subjects[index];
    const evidenceRefs: EvidenceRef[] = subject.evidence.map((item) => ({ companyId: subject.companyId, ref: item.ref }));
    return { companyId: subject.companyId, grade: Math.round(score * 3), score, evidenceRefs };
  });

  const timings = { prepareMs: 0, judgeMs: round(verdict.judgeMs), totalMs: round(performance.now() - started) };
  const result: SemanticComparisonResult = {
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

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
