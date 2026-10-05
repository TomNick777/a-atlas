import { queryHash16, organicEligibilityFor, reformulationLink, type ReformulationState, type RequestOrigin, type OrganicEligibility } from "./organic";
import { emit, emitIncident } from "./emit";
import type { TelemetryStore } from "./store";
import type { JevValue } from "./jev";
import { loadMarketStateManifest } from "../market/state";
import type { HybridDiscoverResult, HybridResultRow } from "../hybrid/contracts";

/**
 * Discover-surface search trace (usage spec §2/§3/§6).
 *
 * The discover route is the product's only search entry, and until now only its
 * semantic-only order produced a search trace (via the pipeline). market-only,
 * market-first, semantic-first merges and unsupported intents answered real
 * users with no trace at all. These events put ONE trace id on every discover
 * search regardless of order:
 *
 *   DISCOVER_RECEIVED      → query + origin + market identity + cache status
 *   DISCOVER_RESPONSE_READY → plan (verbatim) + execution + timings + funnel
 *                             counts + Top-20 snapshot + jev summary/value
 *
 * The pipeline's own events (SEARCH_RECEIVED → …) continue unchanged under the
 * same searchId for the orders that run it; this layer records what the
 * pipeline cannot see (plan, market stage, merge, unsupported answers).
 */

export type MarketIdentity = { marketDate: string | null; stateDigest16: string | null };

/** The market tuple this search would have used (cached loader read; recorded
 * for every discover search so trace identity is uniform, whether or not the
 * plan touched the market layer). */
export function marketIdentity(): MarketIdentity {
  const manifest = loadMarketStateManifest();
  return {
    marketDate: manifest?.latestTradingDay ?? null,
    stateDigest16: manifest ? manifest.contentDigest.value.slice(0, 16) : null,
  };
}

// Reformulation grouping for the discover surface (usage spec §7) — its own
// session map so it never double-advances the pipeline's grouping for the
// semantic searches that group there. Same window and semantics as organic.ts.
type DiscoverSession = { reformulation: Map<string, ReformulationState> };
const sessionStore = globalThis as unknown as { __telemetryDiscover?: DiscoverSession };

function session(): DiscoverSession {
  return (sessionStore.__telemetryDiscover ??= { reformulation: new Map() });
}

export type DiscoverReceivedInput = {
  searchId: string;
  rawQuery: string;
  origin: RequestOrigin;
  sessionId: string | null;
  cached: boolean;
  corrupt: boolean;
  store?: TelemetryStore;
};

export type DiscoverReceivedLink = { eligibility: OrganicEligibility; reformulationGroupId: string | null; previousSearchId: string | null };

export async function discoverReceived(input: DiscoverReceivedInput): Promise<DiscoverReceivedLink> {
  const normalized = input.rawQuery.trim().slice(0, 120);
  const state = session();
  const existing = input.sessionId ? state.reformulation.get(input.sessionId) : undefined;
  const link = reformulationLink(existing, Date.now(), normalized, input.searchId);
  if (input.sessionId) {
    state.reformulation.set(input.sessionId, link.nextState);
    if (state.reformulation.size > 200) {
      const oldest = state.reformulation.keys().next();
      if (oldest.done !== true) state.reformulation.delete(oldest.value);
    }
  }
  const eligibility = organicEligibilityFor(input.origin, { cached: input.cached, corrupt: input.corrupt });
  await emit(
    "DISCOVER_RECEIVED",
    "search",
    {
      rawQuery: input.rawQuery.slice(0, 200),
      normalizedQuery: normalized,
      queryHash: queryHash16(normalized),
      requestOrigin: input.origin,
      cached: input.cached,
      organicEligibility: eligibility,
      reformulationGroupId: link.groupId,
      previousSearchId: link.previousSearchId,
      reformulationEditDistance: link.editDistance,
      reformulationTimeDeltaMs: link.timeDeltaMs,
      marketIdentity: marketIdentity(),
    },
    { searchId: input.searchId, sessionId: input.sessionId, store: input.store },
  );
  return { eligibility, reformulationGroupId: link.groupId, previousSearchId: link.previousSearchId };
}

// ---- result snapshot (§6: the minimum needed to rebuild "why it ranked") ---

export type DiscoverSnapshotRow = {
  rank: number;
  code: string;
  name: string;
  probability: number | null;
  /** The plan's formatted hero metric — the market number that explains the rank. */
  hero: string | null;
  /** Deterministic corpus word hits (capped) — the non-semantic "why". */
  matchedFacts: string[];
  /** The live judgement behind the row, refs only — never corpus text. */
  judgement: {
    capability: string;
    score: number;
    matched: boolean;
    relationLabel: string | null;
    evidenceRefs: string[];
  } | null;
};

const MATCHED_FACTS_CAP = 6;
const SNAPSHOT_CAP = 20;

export function discoverSnapshot(result: HybridDiscoverResult): DiscoverSnapshotRow[] {
  return result.results.slice(0, SNAPSHOT_CAP).map((row, index) => snapshotRow(row, index));
}

function snapshotRow(row: HybridResultRow, index: number): DiscoverSnapshotRow {
  return {
    rank: index + 1,
    code: row.code,
    name: row.name,
    probability: row.probability,
    hero: row.hero?.formatted ?? null,
    matchedFacts: (row.semantic?.matchedFacts ?? []).slice(0, MATCHED_FACTS_CAP),
    judgement: row.judgement
      ? {
          capability: row.judgement.capability,
          score: row.judgement.score,
          matched: row.judgement.matched,
          relationLabel: row.judgement.relationLabel,
          evidenceRefs: row.judgement.evidenceRefs.map((ref) => ref.ref),
        }
      : null,
  };
}

export type DiscoverCompletedInput = {
  searchId: string;
  sessionId: string | null;
  result: HybridDiscoverResult;
  /** Query-level Jev rollup for orders whose Jev call this layer made (null →
   * the pipeline's own events carry the rollup under the same trace id). */
  jevSummary: { calls: number; tokens: number; costUsd: number | null; latencyMs: number | null } | null;
  cached: boolean;
  replayOfSearchId?: string | null;
  organicEligibility?: OrganicEligibility;
  serverMs: number;
  store?: TelemetryStore;
};

export async function discoverCompleted(input: DiscoverCompletedInput): Promise<{ jevValue: JevValue | null }> {
  const { result } = input;
  const snapshot = discoverSnapshot(result);
  await emit(
    "DISCOVER_RESPONSE_READY",
    "search",
    {
      cached: input.cached,
      replayOfSearchId: input.replayOfSearchId ?? null,
      organicEligibility: input.organicEligibility ?? null,
      serverMs: round2(input.serverMs),
      plan: result.plan,
      parser: result.parser,
      execution: {
        order: result.execution.order,
        degraded: result.execution.degraded,
        degradedReason: result.execution.degradedReason,
        decidedBy: result.execution.decidedBy,
        counts: result.execution.counts,
          selection: result.execution.selection ?? null,
        marketDate: result.execution.marketDate,
        stateDigest16: result.execution.stateDigest16,
        timings: result.execution.timings,
      },
      planCaption: result.planCaption,
      intelligence: result.intelligence ?? null,
      resultCount: result.results.length,
      snapshot,
      jevSummary: input.jevSummary,
      jevValue: result.jevValue ?? null,
      searchLogRef: result.searchId ? { file: "data/search_log/search_log.jsonl", searchId: result.searchId } : null,
    },
    { searchId: input.searchId, sessionId: input.sessionId, store: input.store },
  );
  return { jevValue: result.jevValue ?? null };
}

export async function discoverFailed(input: { searchId: string | null; sessionId: string | null; message: string; store?: TelemetryStore }): Promise<void> {
  await emitIncident("SEARCH_FAILED", { stage: "discover", message: input.message.slice(0, 500) }, { searchId: input.searchId, severity: "error", store: input.store });
}

const round2 = (n: number) => Math.round(n * 100) / 100;
