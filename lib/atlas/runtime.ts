/**
 * Runtime metrics + health model (Phase 4 §23/§33/§34; refocus 后组件 = Web + Data).
 *
 * Deliberately tiny: a ring buffer of counters in the Next process, readable from
 * one endpoint. No external monitoring, no dashboards — the question this exists to
 * answer is "刚才为什么坏了", and that is answerable from a snapshot plus the
 * incident file the telemetry layer already keeps.
 *
 * Health is three-valued and the split is the point (§23/§24):
 *   HEALTHY    Web + Data core runtime up, and remote dependencies answering
 *   DEGRADED   core runtime up, but something remote is not (Jev, a data source)
 *   UNHEALTHY  Web or Data itself is down
 * A Jev outage must never make the product UNHEALTHY: it only costs semantic
 * judgement on one page.
 */

import { jevJudgeRuntime } from "../jev/capabilities";
import { verifyJudgeIdentity } from "../telemetry/contract";

export type HealthLevel = "healthy" | "degraded" | "unhealthy";

type UpstreamRow = { path: string; ms: number; ok: boolean; code: string | null; layer: string | null; at: number };

const WINDOW = 200;

const store = globalThis as unknown as {
  __atlasRuntime?: {
    requests: number;
    activeRequests: number;
    upstream: UpstreamRow[];
    searchTotal: number;
    searchCacheHits: number;
    searchDegraded: number;
    startedAt: number;
  };
};

function counters() {
  store.__atlasRuntime ??= {
    requests: 0,
    activeRequests: 0,
    upstream: [],
    searchTotal: 0,
    searchCacheHits: 0,
    searchDegraded: 0,
    startedAt: Date.now(),
  };
  return store.__atlasRuntime;
}

export function noteRequestStart(): void {
  counters().requests += 1;
  counters().activeRequests += 1;
}

export function noteRequestEnd(): void {
  counters().activeRequests = Math.max(0, counters().activeRequests - 1);
}

/** Called by the data client for every stock-data service call, success or not. */
export function noteUpstream(row: Omit<UpstreamRow, "at">): void {
  const state = counters();
  state.upstream.push({ ...row, at: Date.now() });
  if (state.upstream.length > WINDOW) state.upstream.shift();
}

export function noteSearch(outcome: "ok" | "cache_hit" | "degraded"): void {
  const state = counters();
  if (outcome === "cache_hit") state.searchCacheHits += 1;
  if (outcome === "degraded") state.searchDegraded += 1;
  state.searchTotal += 1;
}

function percentile(values: number[], f: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
}

export function upstreamStats() {
  const rows = counters().upstream;
  const recent = rows.slice(-50);
  const byPath = new Map<string, { n: number; failures: number; timeouts: number; p95: number | null }>();
  for (const row of rows) {
    const bucket = byPath.get(row.path) ?? { n: 0, failures: 0, timeouts: 0, p95: null };
    bucket.n += 1;
    if (!row.ok) bucket.failures += 1;
    if (row.code === "TIMEOUT") bucket.timeouts += 1;
    byPath.set(row.path, bucket);
  }
  for (const [path, bucket] of byPath) bucket.p95 = percentile(rows.filter((row) => row.path === path).map((row) => row.ms), 0.95);
  return {
    calls: rows.length,
    failures: rows.filter((row) => !row.ok).length,
    timeouts: rows.filter((row) => row.code === "TIMEOUT").length,
    upstreamLayer: rows.filter((row) => row.layer === "upstream" && !row.ok).length,
    serviceLayer: rows.filter((row) => row.layer === "service" && !row.ok).length,
    latencyP50: percentile(recent.map((row) => row.ms), 0.5),
    latencyP95: percentile(recent.map((row) => row.ms), 0.95),
    perPath: Object.fromEntries(byPath),
  };
}

/**
 * §33/§34: is the source layer currently failing?
 *
 * "Any failure in the last 200 calls" would be wrong in the direction that matters:
 * after an outage ends, one old failure keeps the whole app DEGRADED forever and
 * nobody is told it recovered. So the question is per path and time-ordered —
 * the most recent outcome for that path, within a window.
 */
export function sourceHealth(windowMs = 60_000) {
  const rows = counters().upstream.filter((row) => Date.now() - row.at <= windowMs);
  const latest = new Map<string, UpstreamRow>();
  for (const row of rows) latest.set(row.path, row);
  const failing = [...latest.values()].filter((row) => !row.ok);
  return {
    failing: failing.length > 0,
    paths: failing.map((row) => row.path),
    recentFailures: rows.filter((row) => !row.ok).length,
    recentCalls: rows.length,
  };
}

/**
 * The health snapshot. `data` is probed by the caller (it needs a fetch), so
 * this stays synchronous and cheap enough to call from a health route or a test.
 */
export function healthOf(input: { dataReachable: boolean; dataVersion?: string | null; dataError?: string | null }) {
  const { status } = jevJudgeRuntime();
  const identity = verifyJudgeIdentity(status.lastAnsweredModel, status.configured);
  const upstream = upstreamStats();
  const sources = sourceHealth();

  const coreDown = !input.dataReachable;
  const jevDown = !status.configured || status.breaker.state === "open";

  const level: HealthLevel = coreDown ? "unhealthy" : jevDown || sources.failing || identity.status !== "verified" ? "degraded" : "healthy";

  return {
    status: level,
    ok: level !== "unhealthy",
    components: {
      web: true,
      data: { reachable: input.dataReachable, version: input.dataVersion ?? null, error: input.dataError ?? null },
    },
    remote: {
      jev: {
        provider: "jev",
        configured: status.configured,
        model: status.model,
        answeredModel: status.lastAnsweredModel,
        identity: identity.status,
        breaker: status.breaker.state,
        inFlight: status.inFlight,
        down: jevDown,
      },
      sources: { failing: sources.failing, failingPaths: sources.paths, windowCalls: sources.recentCalls, windowFailures: sources.recentFailures, ...upstream },
    },
    judge: {
      provider: status.configured ? "jev" : "none",
      model: status.lastAnsweredModel,
      configured: status.configured,
      breaker: status.breaker.state,
      identity: identity.status,
    },
  };
}

export function runtimeSnapshot(input: { dataReachable: boolean; dataVersion?: string | null; dataError?: string | null }) {
  const state = counters();
  const health = healthOf(input);
  return {
    ...health,
    uptimeMs: Date.now() - state.startedAt,
    pid: process.pid,
    memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    metrics: {
      requests: state.requests,
      activeRequests: state.activeRequests,
      searchTotal: state.searchTotal,
      searchCacheHits: state.searchCacheHits,
      searchDegraded: state.searchDegraded,
      jev: jevJudgeRuntime().stats,
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };
}

/** Test seam. */
export function resetRuntimeCounters(): void {
  store.__atlasRuntime = undefined;
}
