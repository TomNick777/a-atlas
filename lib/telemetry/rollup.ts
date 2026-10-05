import path from "node:path";
import { existsSync } from "node:fs";
import { emit } from "./emit";
import { defaultStore, type TelemetryStore } from "./store";
import type { TelemetryEnvelope } from "./types";

/**
 * Daily rollup (规格 §35): descriptive statistics only — no composite quality
 * score (§42). Raw heartbeat samples age out conceptually via the rollup; the
 * event stream itself stays append-only and intact.
 */

export type DailyRollup = {
  date: string;
  generatedAt: string;
  telemetrySchemaVersion: number;
  appStarts: number;
  sessions: number;
  organicSearches: number;
  distinctQueries: number;
  searchesByDomain: Record<string, number>;
  searchLatency: { p50Ms: number | null; p95Ms: number | null };
  rerankLatency: { p50Ms: number | null; p95Ms: number | null };
  degradedCount: number;
  timeoutCount: number;
  incidentCount: number;
  incidentsByType: Record<string, number>;
  topRepeatOffenders: { code: string; queryCount: number }[];
  reformulationRate: number | null;
  clickedResultRate: number | null;
  suspectCount: number;
  heartbeats: number;
};

export function buildDailyRollup(date: string, events: TelemetryEnvelope[], now = new Date().toISOString()): DailyRollup {
  const searchReceived = events.filter((event) => event.eventType === "SEARCH_RECEIVED");
  const responses = events.filter((event) => event.eventType === "SEARCH_RESPONSE_READY");
  const organic = searchReceived.filter((event) => event.payload.organicEligibility === "CANDIDATE");
  const organicIds = new Set(organic.map((event) => event.searchId));
  const organicResponses = responses.filter((event) => event.searchId != null && organicIds.has(event.searchId));

  const searchLatencies = organicResponses.map((event) => Number(event.payload.serverTotalMs)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const rerankLatencies = organicResponses.flatMap((event) => {
    const timing = event.payload.timing as { rerankMs?: number } | undefined;
    const value = timing?.rerankMs;
    return typeof value === "number" && value > 0 ? [value] : [];
  }).sort((a, b) => a - b);

  const domains: Record<string, number> = {};
  for (const event of organic) {
    const parsed = events.find((row) => row.eventType === "QUERY_PARSED" && row.searchId === event.searchId);
    const first = (parsed?.payload.concepts as string[] | undefined)?.[0] ?? "未分类";
    domains[first] = (domains[first] ?? 0) + 1;
  }

  const repeat = new Map<string, Set<string>>();
  for (const event of organicResponses) {
    const top20 = (event.payload.top20 as { code: string }[] | undefined) ?? [];
    for (const row of top20.slice(0, 10)) {
      const queries = repeat.get(row.code) ?? new Set<string>();
      queries.add(event.searchId ?? "");
      repeat.set(row.code, queries);
    }
  }
  const offenders = [...repeat.entries()]
    .map(([code, queries]) => ({ code, queryCount: queries.size }))
    .filter((row) => row.queryCount >= 5)
    .sort((a, b) => b.queryCount - a.queryCount)
    .slice(0, 10);

  const reformulated = organic.filter((event) => Boolean(event.payload.reformulationGroupId)).length;
  const clicks = events.filter((event) => event.eventType === "RESULT_CLICK" && event.searchId != null && organicIds.has(event.searchId)).length;

  const incidents = events.filter((event) => event.category === "incident");
  const incidentsByType: Record<string, number> = {};
  for (const incident of incidents) incidentsByType[incident.eventType] = (incidentsByType[incident.eventType] ?? 0) + 1;

  return {
    date,
    generatedAt: now,
    telemetrySchemaVersion: 1,
    appStarts: events.filter((event) => event.eventType === "APP_START").length,
    sessions: new Set(searchReceived.map((event) => event.sessionId).filter(Boolean)).size,
    organicSearches: organic.length,
    distinctQueries: new Set(organic.map((event) => event.payload.queryHash)).size,
    searchesByDomain: domains,
    searchLatency: { p50Ms: percentile(searchLatencies, 0.5), p95Ms: percentile(searchLatencies, 0.95) },
    rerankLatency: { p50Ms: percentile(rerankLatencies, 0.5), p95Ms: percentile(rerankLatencies, 0.95) },
    degradedCount: organicResponses.filter((event) => event.payload.degraded === true).length,
    timeoutCount: incidentsByType["SEARCH_TIMEOUT"] ?? 0,
    incidentCount: incidents.length,
    incidentsByType,
    topRepeatOffenders: offenders,
    reformulationRate: organic.length ? Math.round((reformulated / organic.length) * 1000) / 1000 : null,
    clickedResultRate: organic.length ? Math.round((clicks / organic.length) * 1000) / 1000 : null,
    suspectCount: events.filter((event) => event.eventType === "SEARCH_QUALITY_SUSPECT").length,
    heartbeats: events.filter((event) => event.eventType === "RUNTIME_HEARTBEAT").length,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * sorted.length) - 1));
  return Math.round(sorted[at] * 100) / 100;
}

export async function generateDailyRollup(store: TelemetryStore, date: string): Promise<DailyRollup | null> {
  const { events } = await store.readEvents({ since: `${date}T00:00:00.000Z`, until: `${date}T23:59:59.999Z` });
  if (!events.length) return null;
  const rollup = buildDailyRollup(date, events);
  await store.writeJsonAtomic(path.join("rollups", `${date}.json`), rollup);
  return rollup;
}

/** Startup catch-up: roll yesterday up if it never happened (best effort, async). */
export async function catchUpRollups(store: TelemetryStore = defaultStore, today = new Date()): Promise<string[]> {
  const generated: string[] = [];
  for (const offset of [1, 0]) {
    const day = new Date(today.getTime() - offset * 24 * 3600_000);
    const date = day.toISOString().slice(0, 10);
    try {
      if (existsSync(path.join(store.rollupsDir, `${date}.json`))) continue;
      const rollup = await generateDailyRollup(store, date);
      if (rollup) generated.push(date);
    } catch {
      /* best effort */
    }
  }
  return generated;
}

export async function emitRollupEvent(date: string, rollup: DailyRollup): Promise<void> {
  await emit("ROLLUP_GENERATED", "runtime", { date, organicSearches: rollup.organicSearches, incidentCount: rollup.incidentCount });
}
