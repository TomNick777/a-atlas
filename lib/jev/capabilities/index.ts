/**
 * Jev Capability seam (Phase 3.3) — the ONLY entry point for Atlas code that
 * needs Jev intelligence.
 *
 *   executor / pipeline / API routes
 *     ↓ import from here (and nowhere else in lib/jev)
 *   capability contracts → capability implementations → runtime adapter (cloud.ts) → Jev
 *
 * Four groups live here, deliberately separated:
 *
 *   1. capabilities   — run the four contracted capabilities;
 *   2. routing        — deterministic capability resolution (no model);
 *   3. subjects       — Atlas fact → judgement subject mapping;
 *   4. runtime info   — read-only availability/identity accessors for health,
 *                       cache identity and telemetry. These never carry
 *                       payload or wire knowledge upward.
 *
 * The architecture boundary test pins this: outside lib/jev, no module may
 * touch the transport (`jevProvider().ask`, SystemOne payloads, budgets,
 * pricing) — everything goes through this seam.
 */
import { getJevCloudProvider } from "../cloud";
import type { BreakerSnapshot, ProviderStats, ProviderStatus } from "../provider";
import { resolveJevCapability } from "./route";
import { runSemanticMatch } from "./semantic-match";
import { runSemanticRelation } from "./semantic-relation";
import type { SemanticMatchResult, SemanticRelationResult, JudgementSubject } from "./contracts";

// ---- capabilities ----------------------------------------------------------
export { runSemanticMatch, MATCH_THRESHOLD, MATCH_CHUNK } from "./semantic-match";
export { runMarketEligibility, resetMarketEligibilityCache, MARKET_ELIGIBILITY_VERSION, eligibilityAdmissionCost, type EligibilityDecision, type EligibilityBatch } from "./market-eligibility";
export { runSemanticRelation, RELATION_THRESHOLD, RELATION_CHUNK } from "./semantic-relation";
export { runSemanticComparison, COMPARISON_CHUNK } from "./semantic-comparison";
export { runEvidenceExplanation, EXPLANATION_SUPPORT_THRESHOLD, EXPLANATION_CHUNK } from "./evidence-explanation";
export type {
  JevCapability,
  EvidenceItem,
  EvidenceRef,
  JudgementSubject,
  JudgementRecord,
  ExplanationLine,
  CapabilityFailure,
  CapabilityStatus,
  CapabilityTimings,
  SemanticMatchRequest,
  SemanticMatchDecision,
  SemanticMatchResult,
  SemanticRelationRequest,
  SemanticRelationDecision,
  SemanticRelationResult,
  SemanticComparisonRequest,
  SemanticComparisonDecision,
  SemanticComparisonResult,
  EvidenceExplanationRequest,
  EvidenceExplanationResult,
} from "./contracts";
export { JEV_CAPABILITY_CONTRACT_VERSIONS, capabilityFailureOf } from "./contracts";

// ---- registry + routing ----------------------------------------------------
export { JEV_CAPABILITY_REGISTRY, JEV_CAPABILITY_REGISTRY_VERSION, isRegisteredJevCapability, jevCapabilityDescriptor } from "./registry";
export { resolveJevCapability, type CapabilityRoute, type RoutedCapability } from "./route";

/**
 * One judgement entry for the discovery pipeline: deterministically resolve
 * the capability for this query, then run it. Match and relation share the
 * decisions' score field, so callers stay index-aligned either way.
 */
export async function runJevJudgement(
  query: string,
  subjects: JudgementSubject[],
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<SemanticMatchResult | SemanticRelationResult> {
  const routed = resolveJevCapability(query);
  if (routed.capability === "semantic_relation") {
    return runSemanticRelation({ relationQuery: query, subjects }, options);
  }
  return runSemanticMatch({ query, subjects }, options);
}

// ---- diagnostics -----------------------------------------------------------
export { recentCapabilityDiagnostics, capabilityDiagnosticTotals, resetCapabilityDiagnostics, type CapabilityDiagnostic } from "../diagnostics/capability";

// ---- subjects (Atlas fact mapping) ----------------------------------------
export { subjectOf, subjectsOf, judgeEvidenceOf, judgeProfileRef, judgeProfileText } from "./subjects";

// ---- runtime info (read-only accessors for health / cache / telemetry) -----
export { judgeCacheIdentity, drainSystemOneObservations, getJevCloudProvider, setJevProviderOverride } from "../cloud";
export { JEV_PRODUCTION_MODEL, expectedCloudModel } from "../provider";
export type { JevOutcome, ProviderStatus, ProviderStats, BreakerSnapshot } from "../provider";
export { identityProbe } from "../judge";

/** Read-only judge availability for health surfaces and telemetry. */
export function jevJudgeAvailability(): { configured: boolean; breaker: BreakerSnapshot } {
  const provider = getJevCloudProvider();
  return { configured: provider.configured(), breaker: provider.status().breaker };
}

/** Read-only judge runtime snapshot (status + stats) for health surfaces. */
export function jevJudgeRuntime(): { status: ProviderStatus; stats: ProviderStats } {
  const provider = getJevCloudProvider();
  return { status: provider.status(), stats: provider.stats() };
}

// ---- legacy heads that still ride the same transport -----------------------
// classify: the pre-V3 nomination head, dormant on the corpus path.
export { classify } from "../classify";
// Deterministic degradation blends — NOT judgement, always labelled degraded.
export { mockScores, mockClassify } from "../mock";
