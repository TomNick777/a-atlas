import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PRODUCTION_CONTRACT, manifestIsStale, manifestStampOf, verifyJudgeIdentity } from "../lib/telemetry/contract";
import { parseNetstatListeners } from "../lib/telemetry/runtime";
import { detectUncleanPreviousRuns } from "../lib/telemetry/runtime";
import { TelemetryStore } from "../lib/telemetry/store";
import { buildEnvelope } from "../lib/telemetry/emit";

function tmpStore(): TelemetryStore {
  return new TelemetryStore(mkdtempSync(path.join(tmpdir(), "telemetry-rt-")));
}

describe("judge identity verification (§47 in the cloud era)", () => {
  it("verifies the model that actually answered", () => {
    const verdict = verifyJudgeIdentity(PRODUCTION_CONTRACT.judgeModel, true);
    expect(verdict.status).toBe("verified");
    expect(verdict.actualModel).toBe(PRODUCTION_CONTRACT.judgeModel);
  });

  it("names drift when the cloud moves under the alias", () => {
    const verdict = verifyJudgeIdentity("jev-2.0.0", true);
    expect(verdict.status).toBe("drift");
    expect(verdict.reason).toContain("production contract expects");
    expect(verdict.expectedModel).toBe(PRODUCTION_CONTRACT.judgeModel);
  });

  it("reports unavailable, not mismatch, when nothing answered", () => {
    expect(verifyJudgeIdentity(null, true).status).toBe("unavailable");
  });

  it("reports unavailable when no key is configured (degraded is a design state, not a defect)", () => {
    const verdict = verifyJudgeIdentity(null, false);
    expect(verdict.status).toBe("unavailable");
    expect(verdict.reason).toContain("no Jev key");
  });

  it("never carries the alias as if it were the identity", () => {
    expect(verifyJudgeIdentity("jev-latest", true).status).toBe("drift");
  });
});

describe("port ownership (§8)", () => {
  it("parses netstat -ano LISTENING rows for the port", () => {
    const fixture = [
      "  TCP    127.0.0.1:8910         0.0.0.0:0              LISTENING       31415",
      "  TCP    127.0.0.1:89100        0.0.0.0:0              LISTENING       99",
      "  TCP    [::]:3000              [::]:0                 LISTENING       4242",
      "  TCP    127.0.0.1:8910         127.0.0.1:52000        ESTABLISHED     31415",
      "  UDP    127.0.0.1:8910         *:*                                    777",
    ].join("\n");
    expect(parseNetstatListeners(fixture, 8910)).toEqual([{ pid: 31415, localAddress: "127.0.0.1:8910" }]);
    expect(parseNetstatListeners(fixture, 3000)).toEqual([{ pid: 4242, localAddress: "[::]:3000" }]);
    expect(parseNetstatListeners("", 8910)).toEqual([]);
  });
});

describe("manifest staleness (§10)", () => {
  it("detects loaded-vs-disk drift", () => {
    const loaded = manifestStampOf({ builtAt: "2026-09-27T02:35:25.397Z", datasetSha16: "0ce8e558d16900a9" });
    const disk = manifestStampOf({ builtAt: "2026-09-28T00:00:00.000Z", datasetSha16: "0ce8e558d16900a9" });
    expect(manifestIsStale(loaded, disk)).toBe(true);
    expect(manifestIsStale(loaded, manifestStampOf({ builtAt: "2026-09-27T02:35:25.397Z", datasetSha16: "0ce8e558d16900a9" }))).toBe(false);
  });

  it("never reports stale before the dataset loaded", () => {
    expect(manifestIsStale(null, manifestStampOf({ builtAt: "x" }))).toBe(false);
  });

  it("is silent when the disk has no manifest at all", () => {
    const loaded = manifestStampOf({ builtAt: "x" });
    expect(manifestIsStale(loaded, manifestStampOf(null))).toBe(false);
  });
});

describe("crash recovery (§45)", () => {
  it("marks a previous run without APP_STOP as unclean", async () => {
    const store = tmpStore();
    try {
      const stop = buildEnvelope("APP_STOP", "runtime", { reason: "SIGINT" });
      const startClosed = buildEnvelope("APP_START", "runtime", { pid: 1 });
      startClosed.appRunId = "run_closed";
      stop.appRunId = "run_closed";
      startClosed.timestamp = stop.timestamp = new Date().toISOString();
      const startUnclean = buildEnvelope("APP_START", "runtime", { pid: 2 });
      startUnclean.appRunId = "run_unclean";
      startUnclean.timestamp = new Date().toISOString();
      await store.append(startClosed);
      await store.append(stop);
      await store.append(startUnclean);

      const unclean = await detectUncleanPreviousRuns(store, "run_current");
      expect(unclean.map((event) => event.appRunId)).toEqual(["run_unclean"]);
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });

  it("does not flag the current run or cleanly stopped runs", async () => {
    const store = tmpStore();
    try {
      const start = buildEnvelope("APP_START", "runtime", {});
      start.appRunId = "run_current";
      start.timestamp = new Date().toISOString();
      await store.append(start);
      expect(await detectUncleanPreviousRuns(store, "run_current")).toEqual([]);
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });
});
