import { jevProvider } from "../lib/jev/cloud";
import { getJevCloudProvider } from "../lib/jev/cloud";
import { jevBaseUrl, typesafeKey } from "../lib/env";
import { PRODUCTION_CONTRACT, manifestStampOf, verifyJudgeIdentity } from "../lib/telemetry/contract";
import { defaultStore } from "../lib/telemetry/store";
import { probeJudgeIdentity, probeDataServiceHealth } from "../lib/telemetry/runtime";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "./load-env";

/**
 * npm run telemetry:status — one glance at the production identity.
 *
 * The rule the Laya era enforced and the cloud era keeps: the judge identity is
 * read from what actually answered, never from what config claims. For a cloud
 * model that means one real call, because `jev-latest` is an alias.
 * Nothing here prints a key; the only key fact reported is its length.
 */

loadLocalEnv();

function manifestOnDisk(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "data", "search_index_manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main() {
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { events } = await defaultStore.readEvents();
  const starts = events.filter((event) => event.eventType === "APP_START");
  const heartbeats = events.filter((event) => event.eventType === "RUNTIME_HEARTBEAT");
  const lastHeartbeat = heartbeats.at(-1);
  const organic = events.filter((event) => event.eventType === "SEARCH_RECEIVED" && event.payload.organicEligibility === "CANDIDATE");
  const lastOrganic = organic.at(-1);
  const incidents24h = (await defaultStore.readIncidents()).filter((event) => event.timestamp >= since24h);
  const responses24h = events.filter((event) => event.eventType === "SEARCH_RESPONSE_READY" && event.timestamp >= since24h);
  const degraded24h = responses24h.filter((event) => event.payload.degraded === true);
  const decidedByJev = responses24h.filter((event) => event.payload.decidedBy === "jev");
  const diskManifest = manifestStampOf(manifestOnDisk());

  // Actual identity: live call now, last heartbeat as fallback evidence.
  let probe: Awaited<ReturnType<typeof probeJudgeIdentity>> | null = null;
  try {
    probe = await probeJudgeIdentity();
  } catch (error) {
    probe = null;
    console.warn(`[status] Jev identity probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const provider = getJevCloudProvider();
  const status = probe?.status ?? provider.status();
  const stats = probe?.stats ?? provider.stats();
  const verdict = probe?.verdict ?? verifyJudgeIdentity(status.lastAnsweredModel, status.configured);
  const identitySource = probe ? "live identity probe" : lastHeartbeat ? `last heartbeat ${lastHeartbeat.timestamp}` : "no answer observed";
  const data = await probeDataServiceHealth();
  const key = typesafeKey();

  const lines = [
    `=== A-Atlas runtime status ===`,
    ``,
    `[production tuple]`,
    `  contract judge        : ${PRODUCTION_CONTRACT.provider} ${PRODUCTION_CONTRACT.judgeModel} (alias ${PRODUCTION_CONTRACT.judgeModelAlias})`,
    `  ACTUAL judge model    : ${verdict.actualModel ?? "UNKNOWN — Jev never answered"}  (${identitySource})`,
    `  identity              : ${verdict.status.toUpperCase()}${verdict.reason ? ` — ${verdict.reason}` : ""}`,
    `  knowledge             : ${diskManifest.knowledgeVersions ?? "unknown"}`,
    `  contract knowledge    : ${PRODUCTION_CONTRACT.knowledgeVersion} / ${PRODUCTION_CONTRACT.materialAttributionVersion}`,
    `  retrieval             : ${PRODUCTION_CONTRACT.retrievalVersion}`,
    ``,
    `[judge provider]`,
    `  endpoint              : ${jevBaseUrl().replace(/^https:\/\//, "")}${process.env.JEV_BASE_URL ? "  (stub override in effect)" : ""}`,
    `  key configured        : ${key ? "yes" : "no"} (length ${key?.length ?? 0})`,
    `  breaker               : ${status.breaker.state}, consecutiveFailures=${status.breaker.consecutiveFailures}, trips=${status.breaker.trips}${status.breaker.lastTripReason ? `, lastReason=${status.breaker.lastTripReason}` : ""}`,
    `  in flight             : ${status.inFlight}`,
    `  calls                 : ${stats.calls} ok=${stats.ok} retries=${stats.retries} timeouts=${stats.timeouts} rateLimited=${stats.rateLimited} serverErrors=${stats.serverErrors} networkErrors=${stats.networkErrors} unauthorized=${stats.unauthorized} breakerRejected=${stats.breakerRejected} budgetExhausted=${stats.budgetExhausted}`,
    `  latency               : p50=${stats.latencyMs.p50 ?? "-"}ms p95=${stats.latencyMs.p95 ?? "-"}ms max=${stats.latencyMs.max ?? "-"}ms`,
    `  tokens                : in=${stats.inputTokens} out=${stats.outputTokens} estUsd=${stats.estimatedCostUsd}`,
    ``,
    `[core runtime]`,
    `  next PID/port         : ${starts.at(-1)?.runtime.pid ?? "?"} / ${starts.at(-1)?.payload.port ?? "?"}  (APP_START ${starts.at(-1)?.timestamp ?? "none"})`,
    `  data (a-atlas-data)   : ${data.ok ? "HEALTHY" : "UNREACHABLE"} version=${data.version ?? "-"} latency=${data.latencyMs}ms${data.error ? ` error=${data.error}` : ""}`,
    `  last heartbeat        : ${lastHeartbeat ? `${lastHeartbeat.timestamp} (searches=${lastHeartbeat.payload.searchesSinceLastHeartbeat}, errors=${lastHeartbeat.payload.errorsSinceLastHeartbeat})` : "none"}`,
    `  manifest (disk)       : builtAt=${diskManifest.builtAt ?? "none"} datasetSha16=${diskManifest.datasetSha16 ?? "none"}`,
    ``,
    `[evidence, last 24h]`,
    `  organic searches      : ${organic.filter((event) => event.timestamp >= since24h).length} (all-time ${organic.length})`,
    `  decided by Jev        : ${decidedByJev.length} of ${responses24h.length} responses`,
    `  degraded searches     : ${degraded24h.length}`,
    `  last organic search   : ${lastOrganic ? `${lastOrganic.timestamp} "${String(lastOrganic.payload.rawQuery).slice(0, 40)}" (${lastOrganic.searchId})` : "none"}`,
    `  incidents             : ${incidents24h.length}${incidents24h.length ? ` — ${incidents24h.map((incident) => incident.eventType).join(", ")}` : ""}`,
  ];
  console.log(lines.join("\n"));
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        { contract: PRODUCTION_CONTRACT, status, stats, verdict, diskManifest, data, lastHeartbeat: lastHeartbeat?.payload ?? null, configured: jevProvider().configured() },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
