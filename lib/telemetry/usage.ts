import type { TelemetryStore } from "./store";
import type { TelemetryEnvelope } from "./types";
import { getSearchRun } from "../search/log";

/**
 * Usage summary + trace rebuild (usage spec §13/§14/§15).
 *
 * Pure readers over the append-only telemetry stream (+ the search log for the
 * inspector). Descriptive statistics only — no composite score, no benchmark
 * knowledge, no second judge. Everything here is recomputable from the events;
 * this module exists so the dashboard page, the inspector page and the export
 * bundle share ONE definition of each number.
 */

export type UsageRange = { since: string; until: string };

export type UsageSummary = {
  range: UsageRange;
  generatedAt: string;
  search: {
    searches: number;
    organic: number;
    cacheHits: number;
    organicFresh: number;
    noResult: number;
    unsupported: number;
    degraded: number;
    noResultRate: number | null;
    reformulationRate: number | null;
  };
  latency: {
    serverMs: { p50: number | null; p95: number | null; max: number | null };
    clientVisibleMs: { p50: number | null; p95: number | null };
    stageMedianMs: { parser: number | null; semantic: number | null; market: number | null; merge: number | null };
    pipelineMedianMs: { parse: number | null; retrieval: number | null; rerank: number | null; total: number | null };
  };
  jev: {
    calls: number;
    searchesWithJev: number;
    callsPerSearch: number | null;
    tokensTotal: number;
    tokensPerSearch: number | null;
    costTotalUsd: number;
    costPerSearchUsd: number | null;
    costIsEstimated: true;
    zeroJevOrganicSearches: number;
    cacheHits: number;
    byCapability: Record<string, { calls: number; tokens: number; costUsd: number; degraded: number }>;
  };
  interaction: {
    openDetail: number;
    clickRate: number | null;
    avgClickedRank: number | null;
    top1Clicks: number;
    top3Clicks: number;
    requeries: number;
    feedback: { good: number; neutral: number; bad: number; reasons: Record<string, number> };
  };
};

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * sorted.length) - 1));
  return Math.round(sorted[at] * 100) / 100;
}

function median(values: number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export async function buildUsageSummary(store: TelemetryStore, range: UsageRange): Promise<UsageSummary> {
  const { events } = await store.readEvents({ since: range.since, until: range.until });
  const received = events.filter((event) => event.eventType === "DISCOVER_RECEIVED");
  const ready = events.filter((event) => event.eventType === "DISCOVER_RESPONSE_READY");
  const readyBySearch = new Map(ready.map((event) => [event.searchId, event]));
  const organic = received.filter((event) => event.payload.organicEligibility === "CANDIDATE");
  const organicIds = new Set(organic.map((event) => event.searchId));
  const organicReady = ready.filter((event) => event.searchId != null && organicIds.has(event.searchId));

  const cacheHits = received.filter((event) => event.payload.cached === true).length;
  const executionOf = (event: TelemetryEnvelope): { order?: string; degraded?: boolean; timings?: Record<string, unknown> } =>
    (event.payload.execution as { order?: string; degraded?: boolean; timings?: Record<string, unknown> } | undefined) ?? {};
  const noResult = organicReady.filter((event) => event.payload.resultCount === 0).length;
  const unsupported = organicReady.filter((event) => executionOf(event).order === "unsupported").length;
  const degraded = organicReady.filter((event) => executionOf(event).degraded === true).length;
  const reformulated = organic.filter((event) => Boolean(event.payload.reformulationGroupId)).length;

  const serverLatencies = organicReady.map((event) => num(event.payload.serverMs)).filter((n): n is number => n != null && n > 0).sort((a, b) => a - b);
  const clientVisible = events
    .filter((event) => event.eventType === "SEARCH_RESULTS_VISIBLE" && event.searchId != null && organicIds.has(event.searchId))
    .map((event) => num(event.payload.timeToVisibleResultsMs))
    .filter((n): n is number => n != null && n > 0)
    .sort((a, b) => a - b);
  const stageOf = (key: string): number[] =>
    organicReady
      .map((event) => num(executionOf(event).timings?.[key]))
      .filter((n): n is number => n != null && n >= 0);
  const pipelineStageOf = (key: string): number[] =>
    events
      .filter((event) => event.eventType === "SEARCH_RESPONSE_READY" && event.searchId != null && organicIds.has(event.searchId))
      .map((event) => num((event.payload.timing as Record<string, unknown> | undefined)?.[key]))
      .filter((n): n is number => n != null && n >= 0);
  const pipelineTotal = events
    .filter((event) => event.eventType === "SEARCH_RESPONSE_READY" && event.searchId != null && organicIds.has(event.searchId))
    .map((event) => num(event.payload.serverTotalMs))
    .filter((n): n is number => n != null && n > 0);

  // ---- Jev ----
  const jevCalls = events.filter((event) => event.eventType === "JEV_CALL");
  const searchIdsWithJev = new Set(jevCalls.map((event) => event.searchId));
  const tokens = jevCalls.map((event) => num(event.payload.tokens)).filter((n): n is number => n != null);
  const costs = jevCalls.map((event) => num(event.payload.costUsd)).filter((n): n is number => n != null);
  const byCapability: UsageSummary["jev"]["byCapability"] = {};
  for (const call of jevCalls) {
    const capability = String(call.payload.capability ?? "unknown");
    const bucket = (byCapability[capability] ??= { calls: 0, tokens: 0, costUsd: 0, degraded: 0 });
    bucket.calls += 1;
    bucket.tokens += num(call.payload.tokens) ?? 0;
    bucket.costUsd += num(call.payload.costUsd) ?? 0;
    if (call.payload.status === "degraded" || call.payload.status === "rejected") bucket.degraded += 1;
  }
  const zeroJev = organicReady.filter((event) => event.searchId != null && !searchIdsWithJev.has(event.searchId)).length;

  // ---- interactions ----
  const opens = events.filter((event) => event.eventType === "RESULT_OPEN_DETAIL" && event.searchId != null && organicIds.has(event.searchId));
  const clickedRanks: number[] = [];
  let top1 = 0;
  let top3 = 0;
  for (const open of opens) {
    const response = readyBySearch.get(open.searchId);
    const snapshot = (response?.payload.snapshot as { rank: number; code: string }[] | undefined) ?? [];
    const row = snapshot.find((entry) => entry.code === open.payload.code);
    if (row) {
      clickedRanks.push(row.rank);
      if (row.rank === 1) top1 += 1;
      if (row.rank <= 3) top3 += 1;
    }
  }
  const searchIdsWithClick = new Set(opens.map((event) => event.searchId));
  const requeries = events.filter((event) => event.eventType === "SEARCH_REQUERY" && event.searchId != null && organicIds.has(event.searchId)).length;

  // ---- feedback (§8): one rating per search (latest wins), reasons counted as sent ----
  const feedbackEvents = events.filter((event) => event.eventType === "SEARCH_FEEDBACK");
  const ratingBySearch = new Map<string, string>();
  const reasons: Record<string, number> = {};
  for (const event of feedbackEvents) {
    if (event.searchId == null || !organicIds.has(event.searchId)) continue;
    if (typeof event.payload.rating === "string") ratingBySearch.set(event.searchId, event.payload.rating);
    if (typeof event.payload.reason === "string") reasons[event.payload.reason] = (reasons[event.payload.reason] ?? 0) + 1;
  }
  const ratings = [...ratingBySearch.values()];

  const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : null);

  return {
    range,
    generatedAt: new Date().toISOString(),
    search: {
      searches: received.length,
      organic: organic.length,
      cacheHits,
      organicFresh: organic.length - organic.filter((event) => event.payload.cached === true).length,
      noResult,
      unsupported,
      degraded,
      noResultRate: rate(noResult, organicReady.length),
      reformulationRate: rate(reformulated, organic.length),
    },
    latency: {
      serverMs: { p50: percentile(serverLatencies, 0.5), p95: percentile(serverLatencies, 0.95), max: serverLatencies.length ? serverLatencies[serverLatencies.length - 1] : null },
      clientVisibleMs: { p50: percentile(clientVisible, 0.5), p95: percentile(clientVisible, 0.95) },
      stageMedianMs: {
        parser: median(stageOf("parserMs")),
        semantic: median(stageOf("semanticMs")),
        market: median(stageOf("marketMs")),
        merge: median(stageOf("mergeMs")),
      },
      pipelineMedianMs: {
        parse: median(pipelineStageOf("queryParseMs")),
        retrieval: median(pipelineStageOf("retrievalMs")),
        rerank: median(pipelineStageOf("rerankMs")),
        total: median(pipelineTotal),
      },
    },
    jev: {
      calls: jevCalls.length,
      searchesWithJev: searchIdsWithJev.size,
      callsPerSearch: rate(jevCalls.length, organicReady.length),
      tokensTotal: tokens.reduce((sum, n) => sum + n, 0),
      tokensPerSearch: rate(tokens.reduce((sum, n) => sum + n, 0), organicReady.length),
      costTotalUsd: Math.round(costs.reduce((sum, n) => sum + n, 0) * 1e6) / 1e6,
      costPerSearchUsd: organicReady.length ? Math.round(((costs.reduce((sum, n) => sum + n, 0)) / organicReady.length) * 1e6) / 1e6 : null,
      costIsEstimated: true,
      zeroJevOrganicSearches: zeroJev,
      cacheHits: jevCalls.filter((event) => event.payload.cacheHit === true).length,
      byCapability,
    },
    interaction: {
      openDetail: opens.length,
      clickRate: rate(searchIdsWithClick.size, organicReady.length),
      avgClickedRank: clickedRanks.length ? Math.round((clickedRanks.reduce((sum, n) => sum + n, 0) / clickedRanks.length) * 100) / 100 : null,
      top1Clicks: top1,
      top3Clicks: top3,
      requeries,
      feedback: {
        good: ratings.filter((rating) => rating === "good").length,
        neutral: ratings.filter((rating) => rating === "neutral").length,
        bad: ratings.filter((rating) => rating === "bad").length,
        reasons,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Trace Inspector (§14): one search, rebuilt from the stream.
// ---------------------------------------------------------------------------

export type TraceView = {
  searchId: string;
  received: TelemetryEnvelope | null;
  ready: TelemetryEnvelope | null;
  pipeline: TelemetryEnvelope[];
  jevCalls: TelemetryEnvelope[];
  interactions: TelemetryEnvelope[];
  feedback: TelemetryEnvelope[];
  incidents: TelemetryEnvelope[];
  searchLogRun: Awaited<ReturnType<typeof getSearchRun>>;
};

export async function buildTraceView(store: TelemetryStore, searchId: string): Promise<TraceView | null> {
  const { events } = await store.readEvents({ searchId });
  const incidents = (await store.readIncidents()).filter((incident) => incident.searchId === searchId);
  if (!events.length && !incidents.length) return null;
  const byType = (type: string) => events.filter((event) => event.eventType === type);
  return {
    searchId,
    received: byType("DISCOVER_RECEIVED")[0] ?? byType("SEARCH_RECEIVED")[0] ?? null,
    ready: byType("DISCOVER_RESPONSE_READY")[0] ?? byType("SEARCH_RESPONSE_READY")[0] ?? null,
    pipeline: events.filter((event) => event.category === "search" && !["DISCOVER_RECEIVED", "DISCOVER_RESPONSE_READY", "JEV_CALL"].includes(event.eventType)),
    jevCalls: byType("JEV_CALL"),
    interactions: events.filter((event) => event.category === "interaction"),
    feedback: byType("SEARCH_FEEDBACK"),
    incidents,
    searchLogRun: await getSearchRun(searchId),
  };
}
