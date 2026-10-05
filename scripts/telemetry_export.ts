import { readFileSync, readdirSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCTION_CONTRACT, manifestStampOf } from "../lib/telemetry/contract";
import { defaultStore } from "../lib/telemetry/store";

/**
 * npm run telemetry:export -- --since 7d [--redact] (规格 §36-§38)
 * One self-contained research bundle for offline study. --redact masks keys,
 * tokens, emails, phone numbers, URL secrets and local user paths; stock
 * queries are research payload and stay.
 */

function parseSince(): number {
  const inline = process.argv.find((arg) => arg.startsWith("--since="))?.split("=")[1];
  const flagAt = process.argv.indexOf("--since");
  const value = inline ?? (flagAt >= 0 ? process.argv[flagAt + 1] : undefined) ?? "7d";
  const match = /^(\d+)(d|h)$/.exec(value);
  if (!match) return 7 * 24 * 3600_000;
  return Number(match[1]) * (match[2] === "d" ? 24 : 1) * 3600_000;
}

const REDACTIONS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9_-]{8,}/g, label: "<key>" },
  { re: /(api[_-]?key|token|authorization|bearer)\s*[=:]\s*\S+/gi, label: "$1=<secret>" },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: "<email>" },
  { re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, label: "<phone>" },
  { re: /([?&](?:key|token|secret|password|sig)=)[^&\s]+/gi, label: "$1<redacted>" },
  { re: /[A-Za-z]:\\Users\\[^\\/:*?"<>|\s]+/g, label: "~" },
  { re: /\/home\/[^/\s]+/g, label: "~" },
  { re: /\/Users\/[^/\s]+/g, label: "~" },
];

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return REDACTIONS.reduce((text, { re, label }) => text.replace(re, label), value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, row]) => [key, redact(row)]));
  }
  return value;
}
async function main() {
  const sinceMs = parseSince();
  const since = new Date(Date.now() - sinceMs).toISOString();
  const redactOn = process.argv.includes("--redact");
  const { events, corruptLines } = await defaultStore.readEvents({ since });
  const incidents = (await defaultStore.readIncidents()).filter((incident) => incident.timestamp >= since);

  const organic = events.filter((event) => event.eventType === "SEARCH_RECEIVED" && event.payload.organicEligibility === "CANDIDATE");
  const organicIds = new Set(organic.map((event) => event.searchId));
  const responses = events.filter((event) => event.eventType === "SEARCH_RESPONSE_READY" && event.searchId != null && organicIds.has(event.searchId));
  const bySearch = new Map(responses.map((event) => [event.searchId, event]));

  const manifest = manifestStampOf(
    existsSync(path.join(process.cwd(), "data", "search_index_manifest.json"))
      ? (JSON.parse(readFileSync(path.join(process.cwd(), "data", "search_index_manifest.json"), "utf8")) as Record<string, unknown>)
      : null,
  );
  const lastReady = events.filter((event) => event.eventType === "APP_READY").at(-1);

  const bundle = {
    bundleVersion: 2,
    generatedAt: new Date().toISOString(),
    since,
    redacted: redactOn,
    environment: {
      productionContract: PRODUCTION_CONTRACT,
      manifestOnDisk: manifest,
      lastAppReady: lastReady?.payload ?? null,
      telemetrySchemaVersion: 1,
    },
    appRuns: events
      .filter((event) => ["APP_START", "APP_READY", "APP_STOP", "APP_CRASH", "NEXT_RESTART", "PREVIOUS_RUN_UNCLEAN_EXIT"].includes(event.eventType))
      .map((event) => ({ timestamp: event.timestamp, appRunId: event.appRunId, eventType: event.eventType, payload: event.payload })),
    // Usage Baseline (§15): the discover surface IS the product entry, so the
    // export's primary search unit is the discover trace — one row per real
    // search, every execution order.
    discoverSearches: (() => {
      const received = events.filter((event) => event.eventType === "DISCOVER_RECEIVED");
      const readyBySearch = new Map(
        events.filter((event) => event.eventType === "DISCOVER_RESPONSE_READY").map((event) => [event.searchId, event]),
      );
      return received.map((event) => {
        const ready = readyBySearch.get(event.searchId);
        return {
          searchId: event.searchId,
          receivedAt: event.timestamp,
          sessionId: event.sessionId,
          query: event.payload.rawQuery,
          queryHash: event.payload.queryHash,
          requestOrigin: event.payload.requestOrigin,
          cached: event.payload.cached,
          reformulationGroupId: event.payload.reformulationGroupId,
          previousSearchId: event.payload.previousSearchId,
          marketIdentity: event.payload.marketIdentity,
          outcome: ready
            ? {
                serverMs: ready.payload.serverMs,
                plan: ready.payload.plan,
                parser: ready.payload.parser,
                execution: ready.payload.execution,
                intelligence: ready.payload.intelligence ?? null,
                resultCount: ready.payload.resultCount,
                snapshot: ready.payload.snapshot,
                jevSummary: ready.payload.jevSummary,
                jevValue: ready.payload.jevValue,
              }
            : null,
        };
      });
    })(),
    jevCalls: events
      .filter((event) => event.eventType === "JEV_CALL")
      .map((event) => ({ timestamp: event.timestamp, searchId: event.searchId, payload: event.payload })),
    organicSearches: organic.map((event) => {
      const response = bySearch.get(event.searchId);
      return {
        searchId: event.searchId,
        receivedAt: event.timestamp,
        sessionId: event.sessionId,
        query: event.payload.rawQuery,
        queryHash: event.payload.queryHash,
        reformulationGroupId: event.payload.reformulationGroupId,
        previousSearchId: event.payload.previousSearchId,
        searchLogRef: event.payload.searchLogRef,
        outcome: response
          ? {
              serverTotalMs: response.payload.serverTotalMs,
              timing: response.payload.timing,
              degraded: response.payload.degraded,
              degradedReason: response.payload.degradedReason,
              matches: response.payload.matches,
              resultSnapshotHash: response.payload.resultSnapshotHash,
              top20: response.payload.top20,
              jevSummary: response.payload.jevSummary ?? null,
              jevValue: response.payload.jevValue ?? null,
              judgedByCode: response.payload.judgedByCode ?? null,
              productionTuple: response.payload.productionTuple,
            }
          : null,
      };
    }),
    feedback: events
      .filter((event) => event.eventType === "SEARCH_FEEDBACK")
      .map((event) => ({ timestamp: event.timestamp, searchId: event.searchId, sessionId: event.sessionId, payload: event.payload })),
    timings: {
      serverTotalMs: responses.map((event) => event.payload.serverTotalMs).filter((n) => typeof n === "number"),
      rerankMs: responses.map((event) => (event.payload.timing as { rerankMs?: number })?.rerankMs).filter((n) => typeof n === "number"),
    },
    incidents: incidents.map((incident) => ({ timestamp: incident.timestamp, eventType: incident.eventType, searchId: incident.searchId, payload: incident.payload })),
    interactions: events
      .filter((event) => event.category === "interaction")
      .map((event) => ({ timestamp: event.timestamp, eventType: event.eventType, searchId: event.searchId, sessionId: event.sessionId, payload: event.payload })),
    qualitySuspects: events
      .filter((event) => event.eventType === "SEARCH_QUALITY_SUSPECT")
      .map((event) => ({ timestamp: event.timestamp, searchId: event.searchId, kind: event.payload.kind, evidence: event.payload.evidence })),
    dailySummaries: listRollups().filter((rollup) => rollup.date >= since.slice(0, 10)),
    corruptLines,
  };

  const final = redactOn ? (redact(bundle) as typeof bundle) : bundle;
  const format = (process.argv.find((arg) => arg.startsWith("--format="))?.split("=")[1] ?? "json").toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  if (format === "jsonl") {
    // §15 machine-readable line format: the raw event stream, one envelope per
    // line — jq / DataFrame ready. `--redact` applies line-by-line too.
    const file = `events-${stamp}.jsonl`;
    await mkdir(defaultStore.exportsDir, { recursive: true });
    const rows = (redactOn ? events.map((event) => redact(event)) : events) as unknown[];
    await writeFile(path.join(defaultStore.exportsDir, file), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    console.log(`wrote data/telemetry/exports/${file} (redacted=${redactOn}, since=${since}, format=jsonl, events=${rows.length})`);
    return;
  }
  const file = `research-bundle-${stamp}.json`;
  await defaultStore.writeJsonAtomic(path.join("exports", file), final);
  console.log(`wrote data/telemetry/exports/${file} (redacted=${redactOn}, since=${since})`);
  console.log(`discover searches: ${bundle.discoverSearches.length}, organic searches: ${bundle.organicSearches.length}, jev calls: ${bundle.jevCalls.length}, incidents: ${bundle.incidents.length}, suspects: ${bundle.qualitySuspects.length}`);
}

function listRollups(): { date: string }[] {
  try {
    return readdirSync(defaultStore.rollupsDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => ({ date: name.slice(0, 10) }))
      .sort();
  } catch {
    return [];
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
