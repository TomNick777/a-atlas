import { emit } from "./emit";
import type { TelemetryStore } from "./store";

/**
 * Jev cost & value telemetry (usage spec §4/§5).
 *
 * Cost: one JEV_CALL event per capability invocation — call sites emit it from
 * the capability contract's own result (tokens/costUsd/timings/chunks are fields
 * the seam already returns), so telemetry adds zero Jev calls and zero wire
 * knowledge outside lib/jev. `costUsd` is the capability's own estimate at the
 * frozen price sheet — recorded as estimated, never presented as exact billing.
 *
 * Value: `computeJevValue` derives — purely, from the pre-Jev and post-Jev
 * orders the caller already computed — whether Jev changed the answer. Fields
 * the caller cannot prove mechanically stay null; nothing is inferred.
 */

export type JevInvocation = "discovery_rerank" | "market_first_scoring" | "evidence_explanation" | "comparison";

export type JevCallEvidence = {
  searchId: string | null;
  sessionId?: string | null;
  invocation: JevInvocation;
  capability: string;
  contractVersion: string;
  runtimeModel: string | null;
  status: "ok" | "degraded" | "rejected";
  outcome: string | null;
  subjectCount: number;
  decisionCount: number;
  chunkCount: number;
  answeredChunks: number;
  tokens: number;
  costUsd: number | null;
  judgeMs: number;
  totalMs: number;
  /** Attempt counts observed by the caller's own observation drain; null when
   * the caller could not observe them (never guessed). */
  retries?: number | null;
  timeouts?: number | null;
  /** A-Atlas has no Jev result cache — recorded as false, not omitted, so
   * "was this answer cached" is answerable from the event alone. */
  cacheHit?: boolean;
  store?: TelemetryStore;
};

export function newJevCallId(): string {
  return `j_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

export async function recordJevCall(evidence: JevCallEvidence): Promise<void> {
  await emit(
    "JEV_CALL",
    "search",
    {
      callId: newJevCallId(),
      invocation: evidence.invocation,
      capability: evidence.capability,
      contractVersion: evidence.contractVersion,
      runtimeModel: evidence.runtimeModel,
      status: evidence.status,
      outcome: evidence.outcome,
      subjectCount: evidence.subjectCount,
      decisionCount: evidence.decisionCount,
      chunkCount: evidence.chunkCount,
      answeredChunks: evidence.answeredChunks,
      tokens: evidence.tokens,
      // The capability's own estimate at the price sheet — flagged estimated.
      costUsd: evidence.costUsd,
      costEstimated: evidence.costUsd != null,
      judgeMs: Math.round(evidence.judgeMs * 100) / 100,
      totalMs: Math.round(evidence.totalMs * 100) / 100,
      retries: evidence.retries ?? null,
      timeouts: evidence.timeouts ?? null,
      cacheHit: evidence.cacheHit ?? false,
    },
    { searchId: evidence.searchId, sessionId: evidence.sessionId ?? null, store: evidence.store },
  );
}

// ---------------------------------------------------------------------------
// Jev value measurement (§5): did this call change the candidate set / ranking?
// ---------------------------------------------------------------------------

export type JevValue = {
  /** false = Jev did not run (degraded / not requested) — the change fields are
   * honestly absent rather than zero. */
  compared: boolean;
  /** Candidate order Jev received (rank order of the retrieval/market layer). */
  preTop: string[];
  /** Final answer order the user saw. */
  postTop: string[];
  top1Changed: boolean | null;
  top10Changed: boolean | null;
  rankingChanged: boolean | null;
  /** Final top-10 members whose pre-Jev rank was outside the pre top-10. */
  promotedIntoTop10: number | null;
  /** Pre top-10 members that are not in the final top-10. */
  droppedFromTop10: number | null;
  /** Decisions where the judge itself said "not a match" (they drop below the
   * shown line downstream). Null when no decisions existed. */
  jevRemovedCount: number | null;
};

const ORDER_CAP = 200;

export function computeJevValue(preOrder: string[], postOrder: string[], jevRemovedCount: number | null = null): JevValue {
  const pre = preOrder.slice(0, ORDER_CAP);
  const post = postOrder.slice(0, ORDER_CAP);
  if (!pre.length || !post.length) {
    return { compared: false, preTop: pre, postTop: post, top1Changed: null, top10Changed: null, rankingChanged: null, promotedIntoTop10: null, droppedFromTop10: null, jevRemovedCount };
  }
  const preRank = new Map(pre.map((code, index) => [code, index]));
  const postSet = new Set(post.slice(0, 10));
  return {
    compared: true,
    preTop: pre,
    postTop: post,
    top1Changed: (preRank.get(post[0]) ?? -1) !== 0,
    top10Changed: pre.slice(0, 10).join(",") !== post.slice(0, 10).join(","),
    rankingChanged: pre.join(",") !== post.join(","),
    promotedIntoTop10: post.slice(0, 10).filter((code) => (preRank.get(code) ?? ORDER_CAP) >= 10).length,
    droppedFromTop10: pre.slice(0, 10).filter((code) => !postSet.has(code)).length,
    jevRemovedCount,
  };
}
