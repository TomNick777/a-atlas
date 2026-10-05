/**
 * Product Evidence Layer v1 — event envelope and event type registry.
 *
 * One append-only JSONL stream under data/telemetry/events/YYYY-MM-DD.jsonl.
 * Search Run high-density payloads stay in data/search_log/search_log.jsonl;
 * the two are joined by searchId. Telemetry records what happened — it is not
 * a truth source and never mutates profiles, graders, or training data.
 */

export const TELEMETRY_SCHEMA_VERSION = 1;

/** Where in the system the event originated. */
export type TelemetryComponent = "next" | "research" | "cli" | "browser";

export type EventCategory = "runtime" | "search" | "interaction" | "quality" | "incident";

/** Who asked for the search. Normal UI input is organic_ui without asking the user. */
export type RequestOrigin = "organic_ui" | "developer" | "smoke" | "benchmark" | "replay" | "api";

/** Pre-registered eligibility vocabulary (freeze protocol applies rules later). */
export type OrganicEligibility =
  | "CANDIDATE"
  | "EXCLUDED_SYSTEM_TEST"
  | "EXCLUDED_SMOKE"
  | "EXCLUDED_REPLAY"
  | "EXCLUDED_CACHE"
  | "EXCLUDED_CORRUPT"
  | "EXCLUDED_DEVELOPER";

export type TelemetryRuntime = {
  pid: number;
  port?: number | null;
  platform?: string;
  nodeVersion?: string;
  pythonVersion?: string;
  uptimeMs?: number;
  cwd?: string;
};

/** Production/knowledge tuple as known at emit time (best effort, per field). */
export type TelemetryVersions = {
  rerankerShaExpected?: string | null;
  rerankerShaActual?: string | null;
  knowledgeVersion?: string | null;
  materialAttributionVersion?: string | null;
  ontologyVersion?: string | null;
  retrievalVersion?: string | null;
  profileEdition?: string | null;
  datasetSha16?: string | null;
  gitHead?: string | null;
  buildVersion?: string | null;
};

export type TelemetryEnvelope<P = Record<string, unknown>> = {
  telemetrySchemaVersion: number;
  eventId: string;
  eventType: string;
  category: EventCategory;
  timestamp: string;
  appRunId: string;
  /** Browser user-session id; null for pure runtime events. */
  sessionId: string | null;
  searchId: string | null;
  gitHead: string | null;
  component: TelemetryComponent;
  runtime: TelemetryRuntime;
  versions: TelemetryVersions;
  payload: P;
};

export type IncidentSeverity = "info" | "warning" | "error";

// ---------------------------------------------------------------------------
// Event type registry (documentation mirrored in reports/PRODUCT_TELEMETRY_SCHEMA.md)
// ---------------------------------------------------------------------------

export const RUNTIME_EVENT_TYPES = [
  "APP_START",
  "APP_READY",
  "APP_STOP",
  "APP_CRASH",
  "NEXT_RESTART",
  "PREVIOUS_RUN_UNCLEAN_EXIT",
  "RUNTIME_HEARTBEAT",
  "PORT_ALREADY_BOUND",
  "ROLLUP_GENERATED",
  // Phase 4: the judge is a remote cloud model, so the runtime reports an identity
  // probe and an availability edge instead of a local process lifecycle.
  "JEV_IDENTITY_VERIFIED",
  "JEV_UNAVAILABLE",
  "RESEARCH_COMPONENT_START_REQUESTED",
  "RESEARCH_COMPONENT_HEALTHY",
  "RESEARCH_COMPONENT_UNREACHABLE",
  // Historical: produced by Phase 1-3 while the Laya sidecar was part of this
  // runtime. Kept so old event files still validate; A-Atlas no longer emits them.
  "SIDECAR_START_REQUESTED",
  "SIDECAR_STARTED",
  "SIDECAR_HEALTHY",
  "SIDECAR_IDENTITY_VERIFIED",
  "SIDECAR_STOPPED",
  "SIDECAR_CRASHED",
  "SIDECAR_START_FAILED",
  "SIDECAR_UNREACHABLE",
] as const;

export const SEARCH_EVENT_TYPES = [
  "SEARCH_RECEIVED",
  "QUERY_PARSED",
  "RETRIEVAL_COMPLETED",
  "RERANK_STARTED",
  "RERANK_COMPLETED",
  "SEARCH_RESPONSE_READY",
  "SEARCH_RENDERED",
  "SEARCH_RESULTS_VISIBLE",
  "SEARCH_FAILED",
  "SEARCH_CLIENT_ABORTED",
  // Product Usage Baseline (Phase 3.7 后): the discover surface is ONE trace per
  // real search across every execution order — market-only / market-first /
  // unsupported previously produced no search trace at all. JEV_CALL is the
  // per-capability-invocation cost record (§4 of the usage spec): emitted from
  // contract data at the call sites, never from inside lib/jev, never an extra
  // Jev call.
  "DISCOVER_RECEIVED",
  "DISCOVER_RESPONSE_READY",
  "JEV_CALL",
] as const;

export const INTERACTION_EVENT_TYPES = [
  "RESULT_CLICK",
  "RESULT_OPEN_DETAIL",
  "RESULT_CLOSE_DETAIL",
  "RESULT_COPY",
  "RESULT_EXTERNAL_LINK",
  "SEARCH_EDIT_AFTER_RESULTS",
  "SEARCH_REQUERY",
  "SEARCH_CLEAR",
  // §8 lightweight feedback: 好/一般/差 + optional reason, tied to searchId.
  "SEARCH_FEEDBACK",
] as const;

export const QUALITY_EVENT_TYPES = ["SEARCH_QUALITY_SUSPECT"] as const;

export const INCIDENT_EVENT_TYPES = [
  "MODEL_IDENTITY_MISMATCH",
  "PORT_STALE_PROCESS",
  "NEXT_CRASH",
  "STALE_RUNTIME_DATASET",
  "SEARCH_TIMEOUT",
  "SEARCH_FAILED",
  "DEGRADED_SEARCH",
  "LOG_WRITE_FAILURE",
  "CORRUPT_QUERY_CAPTURE",
  "TELEMETRY_UNWRITABLE",
  "PREVIOUS_RUN_UNCLEAN_EXIT",
  // Phase 4 §34 — the vocabulary "刚才为什么坏了" is answered with.
  "SERVICE_FAILURE",
  "UPSTREAM_FAILURE",
  "JEV_UNAVAILABLE",
  "RATE_LIMIT",
  "CIRCUIT_OPEN",
  "DEGRADED",
  "RECOVERED",
  "JOB_QUEUE_FAILURE",
  "PERSISTENCE_SLOW",
  // Historical: emitted by Phase 1-3 while Laya was part of this runtime. Kept so
  // old incident lines still validate; A-Atlas no longer produces them.
  "SIDECAR_CRASH",
  "SIDECAR_START_FAILED",
  "GPU_MEMORY_PRESSURE",
] as const;

/** Event types the browser may post to /api/telemetry/event (§25: record existing UI behavior only). */
export const CLIENT_EVENT_TYPES = [...INTERACTION_EVENT_TYPES, "SEARCH_RENDERED", "SEARCH_RESULTS_VISIBLE"] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

export function isClientEventType(value: unknown): value is ClientEventType {
  return typeof value === "string" && (CLIENT_EVENT_TYPES as readonly string[]).includes(value);
}

/** Suspect kinds — every one is a SUSPECT, never an automatic root cause (§29). */
export const SUSPECT_KINDS = [
  "RETRIEVAL_EMPTY",
  "RETRIEVAL_UNDERFILLED",
  "BM25_EMPTY",
  "VECTOR_EMPTY",
  "VECTOR_UNAVAILABLE",
  "FILTER_OVERDROP",
  "RETRIEVAL_LATENCY_SPIKE",
  "RERANK_TIMEOUT",
  "RERANK_RETRY",
  "RERANK_DEGRADED",
  "RERANK_LATENCY_SPIKE",
  "GPU_MEMORY_PRESSURE",
  "SCORE_COLLAPSE",
  "EXCLUSION_FAILURE",
  "PROFILE_GAP_SUSPECT",
  "RANKING_FAILURE_SUSPECT",
  "REPEAT_OFFENDER",
  "CROSS_DOMAIN_PRIOR",
  "CMP_DEVICE_MATERIAL_INTRUSION_SUSPECT",
  "FAMILY_NOUN_ROLE_INTRUSION_SUSPECT",
] as const;

export type SuspectKind = (typeof SUSPECT_KINDS)[number];

// ---------------------------------------------------------------------------
// Lightweight search feedback (usage spec §8) — 好/一般/差 plus one optional
// machine-readable reason. Closed vocabularies: the UI offers nothing else and
// the intake route rejects anything else. Free text is deliberately NOT taken.
// ---------------------------------------------------------------------------

export const FEEDBACK_RATINGS = ["good", "neutral", "bad"] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const FEEDBACK_REASONS = [
  "missing_company",
  "bad_ranking",
  "irrelevant",
  "too_slow",
  "evidence_insufficient",
  "other",
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export function isFeedbackRating(value: unknown): value is FeedbackRating {
  return typeof value === "string" && (FEEDBACK_RATINGS as readonly string[]).includes(value);
}

export function isFeedbackReason(value: unknown): value is FeedbackReason {
  return typeof value === "string" && (FEEDBACK_REASONS as readonly string[]).includes(value);
}
