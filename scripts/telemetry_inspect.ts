import { defaultStore } from "../lib/telemetry/store";
import { getSearchRun } from "../lib/search/log";

/**
 * npm run telemetry:inspect -- <searchId> (规格 §39) — the single-search
 * research entry point: full event timeline + search_log row + tuple +
 * Top20 + incidents + interactions.
 */

const time = (iso: string) => iso.slice(11, 23);
const brief = (payload: Record<string, unknown>, keys: string[]): string =>
  keys
    .map((key) => {
      const value = payload[key];
      if (value === undefined) return null;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${text.length > 90 ? `${text.slice(0, 90)}…` : text}`;
    })
    .filter(Boolean)
    .join(" ");

const SEARCH_KEYS = ["requestOrigin", "cached", "organicEligibility", "reformulationGroupId", "previousSearchId", "queryHash"];

async function main() {
  const searchId = process.argv[2];
  if (!searchId) {
    console.error("usage: npm run telemetry:inspect -- <searchId>");
    process.exit(1);
  }
  const { events } = await defaultStore.readEvents({ searchId });
  const run = await getSearchRun(searchId);
  if (!events.length && !run) {
    console.log(`no evidence found for ${searchId}`);
    process.exit(1);
  }

  console.log(`=== Telemetry timeline: ${searchId} ===`);
  for (const event of events) {
    const keys =
      event.eventType === "SEARCH_RECEIVED"
        ? SEARCH_KEYS
        : event.eventType === "DISCOVER_RECEIVED"
          ? ["requestOrigin", "cached", "organicEligibility", "reformulationGroupId", "previousSearchId", "queryHash", "marketIdentity"]
          : event.eventType === "DISCOVER_RESPONSE_READY"
            ? ["cached", "serverMs", "execution", "jevSummary", "resultCount", "resultSnapshotHash"]
            : event.eventType === "JEV_CALL"
              ? ["invocation", "capability", "contractVersion", "runtimeModel", "status", "outcome", "tokens", "costUsd", "judgeMs", "retries", "timeouts", "cacheHit"]
              : event.eventType === "SEARCH_FEEDBACK"
                ? ["rating", "reason", "query", "clientTs", "serverVerifiedLink"]
                : event.eventType === "QUERY_PARSED"
                  ? ["parserVersion", "concepts", "must", "exclude", "requestedRole"]
                  : event.eventType === "RETRIEVAL_COMPLETED"
                    ? ["timings", "candidateCount", "fusedBeforeCap", "droppedByHardFilter", "bm25TopN", "vectorTopN", "top200Hash"]
                    : event.eventType === "RERANK_COMPLETED"
                      ? ["backend", "candidateCount", "batchCount", "rerankMs", "timeouts", "retries"]
                      : event.eventType === "SEARCH_RESPONSE_READY"
                        ? ["serverTotalMs", "timing", "degraded", "degradedReason", "fallbackUsed", "organicEligibility", "resultSnapshotHash", "candidateCount", "jevSummary"]
                        : event.eventType === "SEARCH_QUALITY_SUSPECT"
                          ? ["kind", "verdict", "evidence"]
                          : event.eventType === "SEARCH_RENDERED" || event.eventType === "SEARCH_RESULTS_VISIBLE"
                            ? ["serverMs", "clientTotalMs", "timeToVisibleResultsMs", "matches"]
                            : [];
    console.log(`${time(event.timestamp)}  ${event.component.padEnd(8)} ${event.eventType.padEnd(26)} ${brief(event.payload, keys)}`);
  }

  if (run) {
    console.log(`\n--- search_log ${run.timestamp} ---`);
    console.log(`query     : ${JSON.stringify(run.query.raw)}  (normalized: ${JSON.stringify(run.query.normalized)})`);
    console.log(`querySpec : ${JSON.stringify(run.query.querySpec)}`);
    console.log(`versions  : ${JSON.stringify(run.versions)}`);
    console.log(`timing    : ${JSON.stringify(run.timing)}`);
    console.log(`retrieval : pool=${run.retrieval.poolSize} bm25Top=${run.retrieval.bm25Top.length} vectorTop=${run.retrieval.vectorTop.length}`);
    console.log(
      `top20     :\n${run.candidates
        .slice(0, 20)
        .map((row) => `  #${String(row.rank).padStart(2)} ${row.code} ${row.name}  grade=${row.reranker?.grade ?? "-"} score=${row.reranker?.score ?? "-"} rrf=${row.retrieval.rrfScore}`)
        .join("\n")}`,
    );
  }

  const incidents = (await defaultStore.readIncidents()).filter((incident) => incident.searchId === searchId);
  if (incidents.length) {
    console.log(`\n--- incidents ---`);
    for (const incident of incidents) console.log(`${time(incident.timestamp)} ${incident.eventType} ${JSON.stringify(incident.payload).slice(0, 200)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
