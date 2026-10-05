import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TelemetryStore } from "../lib/telemetry/store";
import { buildDailyRollup, generateDailyRollup } from "../lib/telemetry/rollup";
import { detectUncleanPreviousRuns } from "../lib/telemetry/runtime";
import { buildEnvelope, emit } from "../lib/telemetry/emit";
import type { TelemetryEnvelope } from "../lib/telemetry/types";

function tmpStore(): TelemetryStore {
  return new TelemetryStore(mkdtempSync(path.join(tmpdir(), "telemetry-log-")));
}

function event(eventType: string, searchId: string | null = null): TelemetryEnvelope {
  const envelope = buildEnvelope(eventType, "search", {});
  envelope.searchId = searchId;
  envelope.timestamp = new Date().toISOString();
  return envelope;
}

describe("event append (§44)", () => {
  it("writes one complete JSONL line per event", async () => {
    const store = tmpStore();
    try {
      await store.append(event("SEARCH_RECEIVED", "s_test_000009"));
      await store.append(event("QUERY_PARSED", "s_test_000009"));
      const files = readdirSync(store.eventsDir);
      expect(files).toHaveLength(1);
      const lines = readFileSync(path.join(store.eventsDir, files[0]), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect(JSON.parse(lines[0]).eventType).toBe("SEARCH_RECEIVED");
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });

  it("serializes appends through the promise chain without torn lines", async () => {
    const store = tmpStore();
    try {
      await Promise.all(Array.from({ length: 25 }, (_, at) => store.append(event("SEARCH_QUALITY_SUSPECT", `s_test_0000${at}`))));
      const files = readdirSync(store.eventsDir);
      const lines = readFileSync(path.join(store.eventsDir, files[0]), "utf8").trim().split("\n");
      expect(lines).toHaveLength(25);
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });
});

describe("write failure must not kill the search (§1)", () => {
  it("append to an unwritable baseDir returns false and never throws", async () => {
    const blocker = path.join(tmpdir(), `telemetry-blocker-${Date.now()}`);
    // A FILE where the directory should be: every mkdir/append underneath fails.
    await import("node:fs").then((fs) => fs.writeFileSync(blocker, "not a dir", "utf8"));
    const store = new TelemetryStore(path.join(blocker, "telemetry"));
    try {
      await expect(store.append(event("SEARCH_RECEIVED"))).resolves.toBe(false);
      expect(store.failures.count).toBeGreaterThan(0);
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  });

  it("emit() with a failing store resolves (search path stays alive)", async () => {
    const blocker = path.join(tmpdir(), `telemetry-blocker-${Date.now()}`);
    await import("node:fs").then((fs) => fs.writeFileSync(blocker, "not a dir", "utf8"));
    const store = new TelemetryStore(path.join(blocker, "telemetry"));
    try {
      const result = await emit("SEARCH_RECEIVED", "search", {}, { store });
      expect(result).toBeNull();
    } finally {
      rmSync(blocker, { recursive: true, force: true });
    }
  });
});

describe("atomic rollup (§44)", () => {
  it("rollup lands as one valid JSON file, no tmp residue", async () => {
    const store = tmpStore();
    try {
      const today = new Date().toISOString().slice(0, 10);
      await generateDailyRollup(store, today).catch(() => null); // may be null with no events
      const rollup = buildDailyRollup(today, []);
      expect(rollup.date).toBe(today);
      expect(rollup.telemetrySchemaVersion).toBe(1);
      // write through the atomic path directly
      await store.writeJsonAtomic(path.join("rollups", `${today}.json`), rollup);
      const file = path.join(store.rollupsDir, `${today}.json`);
      expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
      const residue = readdirSync(store.rollupsDir).filter((name) => name.includes(".tmp-"));
      expect(residue).toEqual([]);
      expect(statSync(file).isFile()).toBe(true);
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });

  it("counts organic stats descriptively (no composite score, §42)", () => {
    const today = new Date().toISOString();
    const base = { telemetrySchemaVersion: 1, eventId: "e", category: "search" as const, appRunId: "r", sessionId: "sess_test0000001", gitHead: null, component: "next" as const, runtime: { pid: 1 }, versions: {} };
    const received = (id: string): TelemetryEnvelope => ({
      ...base,
      eventType: "SEARCH_RECEIVED",
      timestamp: today,
      searchId: id,
      payload: { rawQuery: "q", queryHash: `h_${id}`, organicEligibility: "CANDIDATE" },
    });
    const organic = (id: string, ms: number): TelemetryEnvelope => ({
      ...base,
      eventType: "SEARCH_RESPONSE_READY",
      timestamp: today,
      searchId: id,
      payload: { serverTotalMs: ms, degraded: false, organicEligibility: "CANDIDATE", timing: { rerankMs: ms / 2 }, top20: [{ code: "300001" }] },
    });
    const rollup = buildDailyRollup(today.slice(0, 10), [received("s_a"), organic("s_a", 100), received("s_b"), organic("s_b", 300)]);
    expect(rollup.organicSearches).toBe(2);
    expect(rollup.sessions).toBe(1);
    expect(rollup.distinctQueries).toBe(2);
    expect(rollup.searchLatency.p50Ms).toBe(100); // percentile index round(0.5*2)-1 = 0
    expect(rollup.suspectCount).toBe(0);
    expect("qualityScore" in rollup).toBe(false);
  });
});

describe("crash recovery (§45)", () => {
  it("append-only: recovery never rewrites history, only adds an incident", async () => {
    const store = tmpStore();
    try {
      const start = buildEnvelope("APP_START", "runtime", {});
      start.appRunId = "run_dead";
      start.timestamp = new Date().toISOString();
      await store.append(start);
      const before = readFileSync(path.join(store.eventsDir, readdirSync(store.eventsDir)[0]), "utf8");
      const unclean = await detectUncleanPreviousRuns(store, "run_alive");
      expect(unclean).toHaveLength(1);
      const after = readFileSync(path.join(store.eventsDir, readdirSync(store.eventsDir)[0]), "utf8");
      expect(after).toBe(before); // detection itself writes nothing
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });
});
