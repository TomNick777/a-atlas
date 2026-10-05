/**
 * SemanticMatch capability (Phase 3.3) — the formal contract over the rerank
 * judgement A-Atlas has run since Phase 4: each candidate company is one yes/no
 * question against the user's residual phrase. The payload builder is the
 * production code moved verbatim from lib/jev/judge.ts, so request bytes (and
 * therefore committed fixtures) are unchanged — what changed is that the seam
 * returns decisions that carry their evidence refs, plus timings and cost, and
 * that callers no longer need to know the wire.
 *
 * Jev judges; Atlas does not: no synonym expansion, no concept mapping, no
 * industry vocabulary lives here or above it.
 */
import { jevDetail } from "../../env";
import { jevProvider, type SystemOneResponse } from "../cloud";
import { JEV_PRICE_PER_TOKEN, JEV_TIMING, type JevOutcome } from "../provider";
import { runChunked, type ChunkResult } from "./chunked";
import { capabilityFailureOf, JEV_CAPABILITY_CONTRACT_VERSIONS, type EvidenceRef, type JudgementSubject, type SemanticMatchDecision, type SemanticMatchRequest, type SemanticMatchResult } from "./contracts";
import { recordCapabilityRun, timingsOf } from "../diagnostics/capability";

export const MATCH_CHUNK = 100;
/** The yes/no midpoint — a decision's `matched`, not the executor's SHOWN. */
export const MATCH_THRESHOLD = 0.5;

const HOW =
  "looking_for 是一个人用自己的话说想找的公司。" +
  "每一题是一家候选公司，profile 是它的公开业务资料。" +
  "判断这家公司的主营业务是否就是这句话在找的东西。" +
  "概念标签沾边但主营无关，回答要低。" +
  "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。" +
  "几家公司可以同时符合。";

type NoulAnswer = { noul?: number };

/** The profile text a subject is judged on (the one evidence item Atlas maps
 * from the company record). Sliced to the transport detail budget here, at the
 * payload boundary — callers hand over the full fact. */
function profileTextOf(subject: JudgementSubject): string {
  return subject.evidence
    .map((item) => item.text)
    .join("\n")
    .slice(0, jevDetail());
}

async function askNoul(query: string, subjects: JudgementSubject[], options: { signal?: AbortSignal; deadlineAt?: number }): Promise<ChunkResult> {
  const questions: Record<string, unknown> = {};
  subjects.forEach((subject, index) => {
    questions[`c${index}`] = {
      type: "noul",
      instructions: {
        company: { name: subject.name, code: subject.companyId, profile: profileTextOf(subject) },
        question: "company 是否符合 looking_for 要找的公司？",
        yes: "主营业务就是这句话在找的，地域等硬条件也对得上。",
        no: "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
      },
    };
  });
  const call = await jevProvider().ask<SystemOneResponse<Record<string, NoulAnswer>>>(
    { state: { looking_for: query.slice(0, 300), how_to_judge: HOW }, questions },
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
 * Run the semantic_match capability. Query + subjects in, per-subject decisions
 * with evidence refs out. No Jev knowledge crosses this boundary upward.
 * (Which profile text a company contributes — 中文 or English — is a fact
 * selection, decided by the Atlas-side subject mapper, not here.)
 */
export async function runSemanticMatch(
  request: SemanticMatchRequest,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<SemanticMatchResult> {
  const started = performance.now();
  const base = { capability: "semantic_match" as const, contractVersion: JEV_CAPABILITY_CONTRACT_VERSIONS.semantic_match };
  const subjectCount = request.subjects.length;
  const evidenceCount = request.subjects.reduce((sum, subject) => sum + subject.evidence.length, 0);

  const reject = (failure: "invalid_request", detail: string): SemanticMatchResult => {
    const timings = { prepareMs: round(performance.now() - started), judgeMs: 0, totalMs: round(performance.now() - started) };
    recordCapabilityRun({ ...base, runtimeModel: null, status: "rejected", failure, outcome: null, subjectCount, evidenceCount, decisionCount: 0, unexpectedAnswers: 0, ...timingsOf(timings), detail });
    return {
      ...base,
      status: "rejected",
      failure,
      outcome: null,
      runtimeModel: null,
      tokens: 0,
      costUsd: null,
      timings,
      live: false,
      decisions: [],
      chunks: 0,
      answeredChunks: 0,
      unexpectedAnswers: 0,
    };
  };
  if (!request.query.trim()) return reject("invalid_request", "query is empty");

  const deadlineAt = options.deadlineAt ?? Date.now() + JEV_TIMING.rerankBudgetMs;
  const verdict = await runChunked(
    request.subjects,
    MATCH_CHUNK,
    (chunk, chunkOptions) => askNoul(request.query, chunk, { ...chunkOptions, deadlineAt }),
    { signal: options.signal },
  );

  const live = verdict.live;
  const outcome: JevOutcome = verdict.outcome;
  const decisions: SemanticMatchDecision[] = verdict.scores.map((score, index) => {
    const subject = request.subjects[index];
    const evidenceRefs: EvidenceRef[] = subject.evidence.map((item) => ({ companyId: subject.companyId, ref: item.ref }));
    return { known: verdict.known[index], companyId: subject.companyId, score, matched: score >= MATCH_THRESHOLD, evidenceRefs };
  });

  const timings = { prepareMs: 0, judgeMs: round(verdict.judgeMs), totalMs: round(performance.now() - started) };
  const result: SemanticMatchResult = {
    ...base,
    status: live ? "ok" : "degraded",
    failure: live ? null : capabilityFailureOf(outcome),
    outcome: live ? null : outcome,
    runtimeModel: verdict.model,
    tokens: verdict.tokens,
    costUsd: verdict.tokens > 0 ? Math.round(verdict.tokens * JEV_PRICE_PER_TOKEN * 1e6) / 1e6 : null,
    timings,
    live,
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
