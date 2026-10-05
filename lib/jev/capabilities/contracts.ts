/**
 * Jev Capability contracts (Phase 3.3) — the ONLY intelligence seam between
 * Atlas and Jev.
 *
 *   Atlas Domain → Jev Capability Contract → Jev Runtime Adapter (cloud.ts) → Jev
 *
 * Upstream code (executor, pipeline, API routes) never sees the SystemOne
 * wire, the Jev endpoint, the score field names or the transport budgets; it
 * speaks only the request/decision shapes in this file. When the Jev API moves
 * (jev-1.13.0 → 1.20 → 2.x) the adapters inside lib/jev change — the contracts
 * hold.
 *
 * Evidence sovereignty (Phase 3.3 §9, frozen):
 *
 *   Atlas owns facts. Jev owns judgement.
 *
 * Fact / Judgement / Explanation are three distinct object kinds here and must
 * never blur:
 *
 *   Fact        — EvidenceItem text Atlas provides (corpus/profile), with a ref
 *                 Atlas can resolve;
 *   Judgement   — a Decision that cites the evidence refs it was grounded in;
 *   Explanation — lines that cite evidence refs of an EXISTING judgement, with
 *                 the quote taken verbatim from that evidence.
 *
 * No capability may mint a fact, invent a relation label, or assert anything
 * the provided evidence does not carry.
 *
 * Contract versions are independent of the Jev runtime version: today
 * `semantic-match-1` is judged by jev-1.13.0, tomorrow by whatever the cloud
 * answers with — the contract version moves only when the Atlas-facing shape
 * or semantics change.
 */

import type { JevOutcome } from "../provider";

/** The bounded set of intelligence Atlas may ask of Jev. Nothing else exists. */
export type JevCapability =
  | "semantic_match"
  | "semantic_relation"
  | "semantic_comparison"
  | "evidence_explanation";

/** Contract versions, independent of the runtime model version on purpose. */
export const JEV_CAPABILITY_CONTRACT_VERSIONS = {
  semantic_match: "semantic-match-1",
  semantic_relation: "semantic-relation-1",
  semantic_comparison: "semantic-comparison-1",
  evidence_explanation: "evidence-explanation-1",
} as const satisfies Record<JevCapability, string>;

/** A fact Atlas hands to the judge. `ref` must be resolvable by Atlas afterwards. */
export type EvidenceItem = { ref: string; text: string };

/** Pointer to the evidence a decision was grounded in (echoes EvidenceItem.ref). */
export type EvidenceRef = { companyId: string; ref: string };

/** The subject of a judgement: canonical 6-digit code + the facts to judge on. */
export type JudgementSubject = { companyId: string; name: string; evidence: EvidenceItem[] };

/**
 * Failure semantics (Phase 3.3 §18). No fallback, no second judge: an
 * unavailable Jev is an honest failure state the caller degrades from
 * deterministically (retrieval blend, labelled DEGRADED — never another
 * intelligence source).
 */
export type CapabilityFailure =
  | /** Jev is not reachable/usable (no key, breaker open, auth, network, 5xx, budget). */
    "jev_unavailable"
  | /** Asked-for capability is not in the registry. */
    "capability_unsupported"
  | /** Atlas-side precondition: no evidence to judge on, no call was made. */
    "insufficient_evidence"
  | /** The cloud answered but the answer shape was unusable. */
    "invalid_capability_response"
  | /** The call could not land inside its budget. */
    "timeout"
  | /** Atlas-side contract misuse (e.g. comparison with fewer than 2 subjects). */
    "invalid_request";

/** Map a transport outcome to the contract failure state. */
export function capabilityFailureOf(outcome: JevOutcome): CapabilityFailure {
  if (outcome === "timeout" || outcome === "connect_timeout") return "timeout";
  if (outcome === "bad_response") return "invalid_capability_response";
  return "jev_unavailable";
}

/** prepare = payload build (Atlas-side, must stay ms-level); judge = the cloud call. */
export type CapabilityTimings = { prepareMs: number; judgeMs: number; totalMs: number };

type CapabilityBase = {
  capability: JevCapability;
  contractVersion: string;
  /** true ⇔ every judgement call answered. Anything else degrades honestly. */
  live: boolean;
  /** The cloud model that actually answered, read from the response — never config. */
  runtimeModel: string | null;
  tokens: number;
  costUsd: number | null;
  timings: CapabilityTimings;
};

/**
 * ok        — every judgement call answered; decisions are live Jev judgements.
 * degraded  — Jev unavailable/timeout; `failure`/`outcome` say exactly why.
 *             Match still returns decisions (chunk-median fill, as before);
 *             relation/comparison return none. Callers degrade deterministically.
 * rejected  — Atlas-side precondition failed; no call was made.
 */
export type CapabilityStatus = "ok" | "degraded" | "rejected";

// ---- semantic_match ------------------------------------------------------

export type SemanticMatchRequest = { query: string; subjects: JudgementSubject[] };

export type SemanticMatchDecision = {
  /** false for missing/malformed answers or failed chunk median fill. */
  known?: boolean;
  companyId: string;
  /** 0..1 — the yes/no probability the judge assigned. */
  score: number;
  /** The capability's own judgement (score ≥ 0.5). Atlas eligibility (fuse/SHOWN)
   * stays the rank authority — this flag does not change executor semantics. */
  matched: boolean;
  evidenceRefs: EvidenceRef[];
};

export type SemanticMatchResult = CapabilityBase & {
  capability: "semantic_match";
  contractVersion: "semantic-match-1";
  status: CapabilityStatus;
  failure: CapabilityFailure | null;
  /** The provider outcome when degraded — the honest DEGRADED label. */
  outcome: JevOutcome | null;
  /** Input order preserved — production score arrays are index-aligned. */
  decisions: SemanticMatchDecision[];
  chunks: number;
  answeredChunks: number;
  /** Answers that were missing or unusable for known subjects. */
  unexpectedAnswers: number;
};

// ---- semantic_relation ---------------------------------------------------

export type SemanticRelationRequest = { relationQuery: string; subjects: JudgementSubject[] };

export type SemanticRelationDecision = {
  known?: boolean;
  companyId: string;
  matched: boolean;
  score: number;
  /** The Atlas-provided relation phrase, verbatim. Never Jev-invented. */
  relationLabel: string;
  evidenceRefs: EvidenceRef[];
};

export type SemanticRelationResult = CapabilityBase & {
  capability: "semantic_relation";
  contractVersion: "semantic-relation-1";
  status: CapabilityStatus;
  failure: CapabilityFailure | null;
  outcome: JevOutcome | null;
  decisions: SemanticRelationDecision[];
  chunks: number;
  answeredChunks: number;
  unexpectedAnswers: number;
};

// ---- semantic_comparison -------------------------------------------------

export type SemanticComparisonRequest = { comparisonQuery: string; subjects: JudgementSubject[] };

export type SemanticComparisonDecision = {
  companyId: string;
  /** Raw 0..3 grade the judge assigned. */
  grade: number;
  /** grade / 3, so thresholds keep their meaning across capabilities. */
  score: number;
  evidenceRefs: EvidenceRef[];
};

export type SemanticComparisonResult = CapabilityBase & {
  capability: "semantic_comparison";
  contractVersion: "semantic-comparison-1";
  status: CapabilityStatus;
  failure: CapabilityFailure | null;
  outcome: JevOutcome | null;
  /** Input order preserved; sort by score for the relative answer. */
  decisions: SemanticComparisonDecision[];
  chunks: number;
  answeredChunks: number;
  unexpectedAnswers: number;
};

// ---- evidence_explanation ------------------------------------------------

/**
 * The judgement an explanation explains — an Atlas-side record of a decision
 * that was already made. Explanations never re-judge and never extend it.
 */
export type JudgementRecord = {
  capability: Exclude<JevCapability, "evidence_explanation">;
  /** The phrase that was judged (residual / relation / comparison query). */
  query: string;
  companyId: string;
  companyName: string;
  score: number;
  matched: boolean;
};

export type EvidenceExplanationRequest = {
  userQuery: string;
  judgement: JudgementRecord;
  /** Candidate facts of the judged company that might ground the explanation. */
  evidence: EvidenceItem[];
};

/** One explanation line: the evidence ref it is grounded in and that evidence's
 * text, verbatim. The quote IS the fact — explanation prose cannot exceed it. */
export type ExplanationLine = { ref: string; quote: string };

export type EvidenceExplanationResult = CapabilityBase & {
  capability: "evidence_explanation";
  contractVersion: "evidence-explanation-1";
  status: CapabilityStatus;
  failure: CapabilityFailure | null;
  outcome: JevOutcome | null;
  /**
   * true when the provided evidence does not ground the judgement — either the
   * request carried none (rejected, no call) or the judge selected none of it.
   * An empty-explanation answer is an honest answer, not an error.
   */
  insufficientEvidence: boolean;
  lines: ExplanationLine[];
  unexpectedAnswers: number;
};
