import { createHash } from "node:crypto";
import { noteError, noteSearchActivity } from "./context";
import { detectSuspects, type SnapshotRow } from "./detectors";
import { emit, emitIncident } from "./emit";
import { isValidSearchId } from "./ids";
import { queryHash16, reformulationLink, organicEligibilityFor, type ReformulationState } from "./organic";
import { companyRoles } from "./roles";
import type { JevValue } from "./jev";
import type { TelemetryStore } from "./store";
import type { JudgeReport } from "../types";
import type { ClientEventType, OrganicEligibility, RequestOrigin } from "./types";

/**
 * Search lifecycle telemetry (规格 §12-§31): one Search Run becomes
 * SEARCH_RECEIVED → QUERY_PARSED → RETRIEVAL_COMPLETED → RERANK_STARTED →
 * RERANK_COMPLETED → SEARCH_RESPONSE_READY (+ client SEARCH_RENDERED/…),
 * all carrying the searchId shared with data/search_log/search_log.jsonl.
 */

const SEARCH_LOG_FILE = "data/search_log/search_log.jsonl";

type SearchSession = {
  reformulation: Map<string, ReformulationState>;
  recent: { searchId: string; at: number; queryKey: string; topCodes: string[] }[];
};

const searchStore = globalThis as unknown as { __telemetrySearch?: SearchSession };

function session(): SearchSession {
  return (searchStore.__telemetrySearch ??= { reformulation: new Map(), recent: [] });
}

export type BeginSearchInput = {
  searchId: string;
  rawQuery: string;
  normalizedQuery: string;
  origin: RequestOrigin;
  sessionId: string | null;
  cached: boolean;
  corrupt: boolean;
  /** Injectable store for tests; defaults to data/telemetry. */
  store?: TelemetryStore;
};

export type BeginSearchResult = {
  eligibility: OrganicEligibility;
  reformulation: { groupId: string | null; previousSearchId: string | null; editDistance: number | null; timeDeltaMs: number | null };
};

export async function beginSearch(input: BeginSearchInput): Promise<BeginSearchResult> {
  noteSearchActivity();
  const state = session();
  const existing = input.sessionId ? state.reformulation.get(input.sessionId) : undefined;
  const link = reformulationLink(existing, Date.now(), input.normalizedQuery, input.searchId);
  if (input.sessionId) {
    state.reformulation.set(input.sessionId, link.nextState);
    if (state.reformulation.size > 200) {
      const oldest = state.reformulation.keys().next();
      if (oldest.done !== true) state.reformulation.delete(oldest.value);
    }
  }
  const eligibility = organicEligibilityFor(input.origin, { cached: input.cached, corrupt: input.corrupt });
  await emit(
    "SEARCH_RECEIVED",
    "search",
    {
      rawQuery: input.rawQuery,
      normalizedQuery: input.normalizedQuery,
      queryHash: queryHash16(input.normalizedQuery),
      requestOrigin: input.origin,
      cached: input.cached,
      organicEligibility: eligibility,
      reformulationGroupId: link.groupId,
      previousSearchId: link.previousSearchId,
      reformulationEditDistance: link.editDistance,
      reformulationTimeDeltaMs: link.timeDeltaMs,
      searchLogRef: { file: SEARCH_LOG_FILE, searchId: input.searchId },
    },
    { searchId: input.searchId, sessionId: input.sessionId, store: input.store },
  );
  return { eligibility, reformulation: link };
}

export type QueryParsedInput = {
  searchId: string;
  sessionId: string | null;
  raw: string;
  normalized: string;
  must: string[];
  should: string[];
  exclude: string[];
  concepts: string[];
  attrs: { province: string | null; overseasMinShare: number | null };
  parserVersion: string;
  store?: TelemetryStore;
};

export function emitQueryParsed(input: QueryParsedInput): void {
  void emit(
    "QUERY_PARSED",
    "search",
    {
      raw: input.raw,
      normalized: input.normalized,
      must: input.must,
      should: input.should,
      exclude: input.exclude,
      // QuerySpec v1 has no role/process/material/commodity/application fields;
      // recorded as null rather than guessed (honest absence, not a fake value).
      requestedRole: null,
      process: null,
      material: null,
      commodity: null,
      application: null,
      concepts: input.concepts,
      attrs: input.attrs,
      parserVersion: input.parserVersion,
    },
    { searchId: input.searchId, sessionId: input.sessionId, store: input.store },
  );
}

export type RetrievalEvidence = {
  searchId: string;
  sessionId: string | null;
  timings: { bm25Ms: number | null; embeddingMs: number | null; rrfMs: number | null; filterMs: number | null; totalRetrievalMs: number };
  bm25TopN: number;
  vectorTopN: number;
  candidateCount: number;
  fusedBeforeCap: number;
  droppedByHardFilter: number;
  top200Hash: string | null;
  vectorsFilePresent: boolean;
  retrievalVersion: string;
  store?: TelemetryStore;
};

export async function retrievalCompleted(input: RetrievalEvidence): Promise<void> {
  await emit("RETRIEVAL_COMPLETED", "search", { ...input, searchLogRef: { file: SEARCH_LOG_FILE, searchId: input.searchId } }, { searchId: input.searchId, sessionId: input.sessionId, store: input.store });
}

export type RerankEvidence = {
  searchId: string;
  sessionId: string | null;
  phase: "started" | "completed";
  provider: string | null;
  store?: TelemetryStore;
  candidateCount: number;
  batchCount: number | null;
  rerankMs?: number;
  timeouts?: number;
  errors?: number;
  retries?: number;
  rateLimited?: number;
  degraded?: boolean;
};

export function rerankEvent(input: RerankEvidence): void {
  void emit(input.phase === "started" ? "RERANK_STARTED" : "RERANK_COMPLETED", "search", { ...input }, { searchId: input.searchId, sessionId: input.sessionId, store: input.store });
}

export type ResponseEvidence = {
  searchId: string;
  sessionId: string | null;
  serverTotalMs: number;
  queryParseMs: number;
  retrievalMs: number;
  rerankMs: number;
  fusionMs: number | null;
  degraded: boolean;
  /** The provider's own outcome code (§34): timeout / rate_limited / breaker_open / … */
  degradedReason: string | null;
  fallbackUsed: string | null;
  decidedBy: string;
  judge: JudgeReport;
  matches: number;
  actualJudgeModel: string | null;
  expectedJudgeModel: string;
  knowledgeVersion: string | null;
  retrievalVersion: string;
  organicEligibility: OrganicEligibility;
  candidateCount: number;
  fusedBeforeCap: number;
  droppedByHardFilter: number;
  bm25TopN: number;
  vectorTopN: number;
  vectorsFilePresent: boolean;
  exclusionTypes: string[];
  normalizedQuery: string;
  rerankTimeouts: number;
  rerankErrors: number;
  rerankRetries: number;
  rerankRateLimited: number;
  answeredChunks: number;
  chunkCount: number;
  breakerState: string;
  top: SnapshotRow[];
  top200Hash: string | null;
  /** §4 query-level Jev rollup (calls/tokens/cost/latency) — null when Jev
   * never ran. Tokens are the capability's own usage sum; cost is estimated. */
  jevSummary: { calls: number; tokens: number; costUsd: number | null; latencyMs: number | null } | null;
  /** §5 Jev value measurement — null when Jev did not produce the ranking. */
  jevValue: JevValue | null;
  /** §6 per-result judgement record for the top rows: refs only, no corpus
   * text — evidence prose resolves from the corpus at inspection time. */
  judgedByCode: Record<string, { capability: string; matched: boolean; evidenceRefs: string[] }> | null;
  store?: TelemetryStore;
};

export type ResponseSnapshot = { resultSnapshotHash: string; top20: SnapshotRow[] };

export async function searchResponseReady(input: ResponseEvidence): Promise<ResponseSnapshot> {
  const top20 = input.top.slice(0, 20);
  const resultSnapshotHash = snapshotHash(top20);
  rememberSearch(input.searchId, input.normalizedQuery, top20.map((row) => row.code));
  await emit(
    "SEARCH_RESPONSE_READY",
    "search",
    {
      serverTotalMs: round2(input.serverTotalMs),
      timing: { queryParseMs: round2(input.queryParseMs), retrievalMs: round2(input.retrievalMs), rerankMs: round2(input.rerankMs), fusionMs: input.fusionMs == null ? null : round2(input.fusionMs) },
      degraded: input.degraded,
      degradedReason: input.degradedReason,
      fallbackUsed: input.fallbackUsed,
      decidedBy: input.decidedBy,
      judge: input.judge,
      matches: input.matches,
      productionTuple: { actualJudgeModel: input.actualJudgeModel, expectedJudgeModel: input.expectedJudgeModel, knowledgeVersion: input.knowledgeVersion, retrievalVersion: input.retrievalVersion },
      rerankEvidence: {
        timeouts: input.rerankTimeouts,
        errors: input.rerankErrors,
        retries: input.rerankRetries,
        rateLimited: input.rerankRateLimited,
        answeredChunks: input.answeredChunks,
        chunkCount: input.chunkCount,
        breakerState: input.breakerState,
      },
      organicEligibility: input.organicEligibility,
      candidateCount: input.candidateCount,
      top200Hash: input.top200Hash,
      resultSnapshotHash,
      top20,
      jevSummary: input.jevSummary,
      jevValue: input.jevValue,
      judgedByCode: input.judgedByCode,
      searchLogRef: { file: SEARCH_LOG_FILE, searchId: input.searchId },
    },
    { searchId: input.searchId, sessionId: input.sessionId, store: input.store },
  );

  // Suspects scan (§29-§30): async, observational, never blocks the response.
  void runSuspectScan(input, top20);

  // Service-level degradation becomes an incident; a single bad search stays a
  // search-level fact. These are awaited: rare, tiny, and incident ordering stays
  // deterministic (§34 "刚才为什么坏了" must be answerable from the incident file).
  if (input.degraded && JEV_UNAVAILABLE_REASONS.has(input.degradedReason ?? "")) {
    noteError();
    await emitIncident("JEV_UNAVAILABLE", { searchId: input.searchId, reason: input.degradedReason, judge: input.judge, fallbackUsed: input.fallbackUsed }, { searchId: input.searchId, severity: "warning", store: input.store });
  }
  if (input.degradedReason === "rate_limited" || input.rerankRateLimited > 0) {
    await emitIncident("RATE_LIMIT", { searchId: input.searchId, rateLimitedCalls: input.rerankRateLimited, breakerState: input.breakerState }, { searchId: input.searchId, severity: "warning", store: input.store });
  }
  if (input.breakerState === "open") {
    await emitIncident("CIRCUIT_OPEN", { searchId: input.searchId, stage: "jev", timeouts: input.rerankTimeouts, errors: input.rerankErrors }, { searchId: input.searchId, severity: "warning", store: input.store });
  }
  if (input.judge.provider === "jev" && input.actualJudgeModel && input.actualJudgeModel !== input.expectedJudgeModel) {
    await emitIncident("MODEL_IDENTITY_MISMATCH", { searchId: input.searchId, expectedJudgeModel: input.expectedJudgeModel, actualJudgeModel: input.actualJudgeModel }, { searchId: input.searchId, severity: "error", store: input.store });
  }
  if (input.rerankTimeouts > 0) {
    await emitIncident("SEARCH_TIMEOUT", { searchId: input.searchId, stage: "rerank", timeouts: input.rerankTimeouts }, { searchId: input.searchId, severity: "warning", store: input.store });
  }
  return { resultSnapshotHash, top20 };
}

/** Outcomes that mean the judge itself is not reachable — not "this query was bad". */
const JEV_UNAVAILABLE_REASONS = new Set(["timeout", "connect_timeout", "network_error", "server_error", "rate_limited", "bad_response", "unauthorized", "no_config", "breaker_open", "budget_exhausted", "admission_timeout"]);

async function runSuspectScan(input: ResponseEvidence, top20: SnapshotRow[]): Promise<void> {
  try {
    const roles = companyRoles();
    const withRoles = top20.map((row) => ({ ...row, roles: row.roles.length ? row.roles : roles.get(row.code) ?? [] }));
    const state = session();
    const suspects = detectSuspects({
      normalizedQuery: input.normalizedQuery,
      exclusionTypes: input.exclusionTypes,
      candidateCount: input.candidateCount,
      fusedBeforeCap: input.fusedBeforeCap,
      droppedByHardFilter: input.droppedByHardFilter,
      bm25TopN: input.bm25TopN,
      vectorTopN: input.vectorTopN,
      vectorsFilePresent: input.vectorsFilePresent,
      retrievalMs: input.retrievalMs,
      rerankMs: input.rerankMs,
      rerankTimeouts: input.rerankTimeouts,
      rerankErrors: input.rerankErrors,
      rerankRetries: input.rerankRetries,
      // Phase 4: Jev answers with a binary head, so 0-3 grades exist only when a
      // graded head answered. The detectors key off the rows, not a flag.
      graded: top20.some((row) => row.grade != null),
      degraded: input.degraded,
      top: withRoles,
      recentTopCompanies: state.recent.slice(-30).map((row) => ({ queryKey: row.queryKey, codes: row.topCodes })),
    });
    for (const suspect of suspects) {
      await emit("SEARCH_QUALITY_SUSPECT", "quality", { kind: suspect.kind, verdict: "SUSPECT", evidence: suspect.evidence }, { searchId: input.searchId, sessionId: input.sessionId, store: input.store });
    }
  } catch (error) {
    console.warn("[telemetry] suspect scan failed (search unaffected):", error instanceof Error ? error.message : error);
  }
}

export function snapshotHash(top20: SnapshotRow[]): string {
  return createHash("sha256")
    .update(JSON.stringify(top20.map((row) => ({ r: row.rank, c: row.code, g: row.grade, s: Math.round(row.rerankerScore * 1000) }))))
    .digest("hex")
    .slice(0, 16);
}

function rememberSearch(searchId: string, normalizedQuery: string, topCodes: string[]): void {
  const state = session();
  state.recent.push({ searchId, at: Date.now(), queryKey: normalizedQuery, topCodes: topCodes.slice(0, 10) });
  if (state.recent.length > 60) state.recent.shift();
}

export async function searchFailed(searchId: string | null, sessionId: string | null, message: string, kind: "SEARCH_TIMEOUT" | "SEARCH_FAILED"): Promise<void> {
  noteError();
  await emitIncident(kind, { searchId, message: message.slice(0, 500) }, { searchId, severity: "error" });
}

export async function searchClientAborted(searchId: string | null, sessionId: string | null): Promise<void> {
  await emit("SEARCH_CLIENT_ABORTED", "search", {}, { searchId, sessionId });
}

export function corruptCapture(searchId: string | null, reason: string): void {
  void emitIncident("CORRUPT_QUERY_CAPTURE", { searchId, reason }, { searchId, severity: "warning" });
}

// ---------------------------------------------------------------------------
// Client events (browser → /api/telemetry/event)
// ---------------------------------------------------------------------------

export type ClientEventInput = {
  searchId: string | null;
  sessionId: string | null;
  eventType: ClientEventType;
  payload: Record<string, unknown>;
  clientTs: string | null;
};

export async function recordClientEvent(input: ClientEventInput): Promise<{ verified: boolean }> {
  const state = session();
  const known = input.searchId ? state.recent.some((row) => row.searchId === input.searchId) : false;
  await emit(
    input.eventType,
    "interaction",
    {
      ...input.payload,
      clientTs: input.clientTs,
      serverVerifiedLink: known,
    },
    { searchId: input.searchId, sessionId: input.sessionId, component: "browser" },
  );
  return { verified: known };
}

export function isKnownSearchId(searchId: string): boolean {
  return session().recent.some((row) => row.searchId === searchId);
}

export { isValidSearchId };

const round2 = (n: number) => Math.round(n * 100) / 100;
