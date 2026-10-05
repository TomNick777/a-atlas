/**
 * EvidenceExplanation capability (Phase 3.3 §6) — "为什么这家公司排这么高？"
 *
 * Strong constraint, mechanically enforced: an explanation can only explain an
 * EXISTING judgement using evidence Atlas provides. Jev's only job here is to
 * pick which of the provided evidence items actually support the judgement;
 * the explanation lines are that evidence, verbatim. The capability cannot
 * search external facts, cannot add corpus-absent information, cannot guess
 * company relations, and cannot dress speculation as fact — every line cites
 * the ref it quotes.
 *
 * Evidence does not ground the judgement → `insufficientEvidence` with empty
 * lines. That is an honest answer, not an error.
 */
import { jevDetail } from "../../env";
import { jevProvider, type SystemOneResponse } from "../cloud";
import { JEV_PRICE_PER_TOKEN, JEV_TIMING, type JevOutcome } from "../provider";
import { runChunked, type ChunkResult } from "./chunked";
import { capabilityFailureOf, JEV_CAPABILITY_CONTRACT_VERSIONS, type EvidenceExplanationRequest, type EvidenceExplanationResult, type ExplanationLine } from "./contracts";
import { recordCapabilityRun, timingsOf } from "../diagnostics/capability";

export const EXPLANATION_CHUNK = 100;
export const EXPLANATION_SUPPORT_THRESHOLD = 0.5;

const EXPLAIN_HOW =
  "looking_for 是用户的查询，每一题里 company 是一家公司，profile 是它的一段业务资料。" +
  "判断这段资料能否支持「company 符合 looking_for 所描述的目标」这一既有判断。" +
  "只判断资料本身；资料没有提到就不要猜。";

type NoulAnswer = { noul?: number };

async function askSupport(request: EvidenceExplanationRequest, evidence: { ref: string; text: string }[], options: { signal?: AbortSignal; deadlineAt?: number }): Promise<ChunkResult> {
  const questions: Record<string, unknown> = {};
  evidence.forEach((item, index) => {
    questions[`e${index}`] = {
      type: "noul",
      instructions: {
        company: { name: request.judgement.companyName, code: request.judgement.companyId, profile: item.text.slice(0, jevDetail()) },
        question: "这段资料是否支持 company 符合 looking_for 的判断？",
        yes: "资料内容直接支持该判断。",
        no: "资料与该判断无关，或不足以支持。",
      },
    };
  });
  const call = await jevProvider().ask<SystemOneResponse<Record<string, NoulAnswer>>>(
    { state: { looking_for: request.userQuery.slice(0, 300), how_to_judge: EXPLAIN_HOW }, questions },
    "rerank",
    options,
  );
  if (!call.ok) return { ok: false, scores: null, tokens: 0, model: null, outcome: call.outcome };
  const answers = call.data.answers ?? {};
  let unexpected = 0;
  const scores = evidence.map((_, index) => {
    const noul = answers[`e${index}`]?.noul;
    if (typeof noul !== "number") unexpected += 1;
    return noul ?? 0.5;
  });
  return { ok: true, scores, tokens: call.usage.inputTokens + call.usage.outputTokens, model: call.model, outcome: "ok", unexpected };
}

/**
 * Run the evidence_explanation capability: Jev selects the supporting evidence;
 * Atlas renders the lines from that evidence verbatim. No call without
 * evidence; no line without a ref; no quote that is not the evidence text.
 */
export async function runEvidenceExplanation(
  request: EvidenceExplanationRequest,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<EvidenceExplanationResult> {
  const started = performance.now();
  const base = { capability: "evidence_explanation" as const, contractVersion: JEV_CAPABILITY_CONTRACT_VERSIONS.evidence_explanation };
  const evidenceCount = request.evidence.length;

  const reject = (failure: "invalid_request" | "insufficient_evidence", detail: string): EvidenceExplanationResult => {
    const timings = { prepareMs: round(performance.now() - started), judgeMs: 0, totalMs: round(performance.now() - started) };
    recordCapabilityRun({ ...base, runtimeModel: null, status: "rejected", failure, outcome: null, subjectCount: 1, evidenceCount, decisionCount: 0, unexpectedAnswers: 0, ...timingsOf(timings), detail });
    return { ...base, live: false, status: "rejected", failure, outcome: null, runtimeModel: null, tokens: 0, costUsd: null, timings, insufficientEvidence: true, lines: [], unexpectedAnswers: 0 };
  };
  if (!request.userQuery.trim()) return reject("invalid_request", "userQuery is empty");
  if (!request.judgement.companyId) return reject("invalid_request", "judgement carries no company");
  if (!evidenceCount) return reject("insufficient_evidence", "no evidence was provided to ground an explanation");

  const deadlineAt = options.deadlineAt ?? Date.now() + JEV_TIMING.rerankBudgetMs;
  const verdict = await runChunked(
    request.evidence,
    EXPLANATION_CHUNK,
    (chunk, chunkOptions) => askSupport(request, chunk, { ...chunkOptions, deadlineAt }),
    { signal: options.signal },
  );

  const live = verdict.live;
  const outcome: JevOutcome = verdict.outcome;
  // The quote is the provided evidence text, verbatim — never a paraphrase.
  const lines: ExplanationLine[] = live
    ? request.evidence.filter((_, index) => verdict.scores[index] >= EXPLANATION_SUPPORT_THRESHOLD).map((item) => ({ ref: item.ref, quote: item.text }))
    : [];

  const timings = { prepareMs: 0, judgeMs: round(verdict.judgeMs), totalMs: round(performance.now() - started) };
  const result: EvidenceExplanationResult = {
    ...base,
    live,
    status: live ? "ok" : "degraded",
    failure: live ? null : capabilityFailureOf(outcome),
    outcome: live ? null : outcome,
    runtimeModel: verdict.model,
    tokens: verdict.tokens,
    costUsd: verdict.tokens > 0 ? Math.round(verdict.tokens * JEV_PRICE_PER_TOKEN * 1e6) / 1e6 : null,
    timings,
    insufficientEvidence: live && lines.length === 0,
    lines,
    unexpectedAnswers: verdict.unexpected,
  };
  recordCapabilityRun({
    ...base,
    runtimeModel: result.runtimeModel,
    status: result.status,
    failure: result.failure,
    outcome: result.outcome,
    subjectCount: 1,
    evidenceCount,
    decisionCount: lines.length,
    unexpectedAnswers: verdict.unexpected,
    ...timingsOf(timings),
    detail: null,
  });
  return result;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
