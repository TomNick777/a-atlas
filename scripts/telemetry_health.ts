import { defaultStore } from "../lib/telemetry/store";
import type { DailyRollup } from "../lib/telemetry/rollup";

/**
 * npm run telemetry:health -- --days 7 (规格 §41) — scan recent telemetry for
 * drift, stale manifests, timeout spikes, latency regression, repeat offenders,
 * degraded rate and corrupt captures. Descriptive findings, no composite score
 * (§42: different problems stay separable).
 */

function argOf(name: string, fallback: number): number {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
  const at = process.argv.indexOf(`--${name}`);
  const value = inline ?? (at >= 0 ? process.argv[at + 1] : undefined);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values: number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * sorted.length) - 1))]);
}

async function main() {
  const days = argOf("days", 7);
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const { events, corruptLines } = await defaultStore.readEvents({ since });
  const incidents = (await defaultStore.readIncidents()).filter((incident) => incident.timestamp >= since);

  const byType = (type: string) => incidents.filter((incident) => incident.eventType === type);
  const responses = events.filter((event) => event.eventType === "SEARCH_RESPONSE_READY");
  const timeouts = byType("SEARCH_TIMEOUT");
  const identityDrift = byType("MODEL_IDENTITY_MISMATCH");
  const stale = byType("STALE_RUNTIME_DATASET");
  const degraded = responses.filter((event) => event.payload.degraded === true);

  // Latency regression: earlier half vs later half of the window.
  const mid = Date.parse(since) + (Date.now() - Date.parse(since)) / 2;
  const latencies = (from: number, to: number) =>
    responses.filter((event) => Date.parse(event.timestamp) >= from && Date.parse(event.timestamp) < to).map((event) => Number(event.payload.serverTotalMs)).filter(Number.isFinite);
  const early = { p50: percentile(latencies(Date.parse(since), mid), 0.5), p95: percentile(latencies(Date.parse(since), mid), 0.95) };
  const late = { p50: percentile(latencies(mid, Date.now()), 0.5), p95: percentile(latencies(mid, Date.now()), 0.95) };

  // Repeat offenders from snapshots (top10 across distinct queries).
  const repeat = new Map<string, Set<string>>();
  for (const event of responses) {
    if (event.payload.organicEligibility !== "CANDIDATE") continue;
    for (const row of (event.payload.top20 as { code: string }[] | undefined)?.slice(0, 10) ?? []) {
      const queries = repeat.get(row.code) ?? new Set<string>();
      queries.add(event.searchId ?? "");
      repeat.set(row.code, queries);
    }
  }
  const offenders = [...repeat.entries()].map(([code, queries]) => ({ code, queryCount: queries.size })).filter((row) => row.queryCount >= 5).sort((a, b) => b.queryCount - a.queryCount);

  const suspectsByKind: Record<string, number> = {};
  for (const event of events.filter((event) => event.eventType === "SEARCH_QUALITY_SUSPECT")) {
    const kind = String(event.payload.kind);
    suspectsByKind[kind] = (suspectsByKind[kind] ?? 0) + 1;
  }

  console.log(`=== Telemetry Health: last ${days}d (since ${since}) ===`);
  console.log(`events scanned        : ${events.length} (corrupt lines: ${corruptLines})`);
  console.log(`identity drift        : ${identityDrift.length}${identityDrift.length ? ` — ${JSON.stringify(identityDrift.at(-1)?.payload).slice(0, 160)}` : ""}`);
  console.log(`stale manifest        : ${stale.length}`);
  console.log(`search timeouts       : ${timeouts.length}`);
  console.log(`degraded rate         : ${responses.length ? `${degraded.length}/${responses.length} = ${Math.round((degraded.length / responses.length) * 100)}%` : "no searches"}`);
  console.log(`latency regression    : p50 ${early.p50} → ${late.p50} ms, p95 ${early.p95} → ${late.p95} ms`);
  console.log(`repeat offenders(≥5q) : ${offenders.length ? offenders.slice(0, 8).map((row) => `${row.code}×${row.queryCount}`).join(", ") : "none"}`);
  console.log(`incidents by type     : ${JSON.stringify(Object.fromEntries([...new Set(incidents.map((incident) => incident.eventType))].map((type) => [type, byType(type).length])))}`);
  console.log(`suspects by kind      : ${JSON.stringify(suspectsByKind)}`);

  // Rollup coverage.
  const rollups: DailyRollup[] = [];
  try {
    const { readdirSync, readFileSync } = await import("node:fs");
    for (const name of readdirSync(defaultStore.rollupsDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
      try {
        rollups.push(JSON.parse(readFileSync(`${defaultStore.rollupsDir}/${name}`, "utf8")) as DailyRollup);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no rollups yet */
  }
  if (rollups.length) console.log(`daily rollups         : ${rollups.length} files (latest ${rollups.at(-1)?.date}, organic=${rollups.at(-1)?.organicSearches})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
