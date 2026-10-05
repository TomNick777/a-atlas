import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dailyMarketAvailability, dailyMarketSession, type TradingCalendar } from "../lib/market/session";
import { deriveFixture, fixtureManifest, LATEST } from "./fixtures/market_fixture";

const calendar = JSON.parse(readFileSync("data/market-calendar/2026.json", "utf8")) as TradingCalendar;
const at = (local: string) => new Date(`${local}+08:00`);

describe("live market date safety", () => {
  it("uses the last actual trading day during National Day, including a working weekend", () => {
    expect(dailyMarketSession(at("2026-10-02T12:00:00"), calendar)).toMatchObject({ phase: "closed", targetDate: "2026-09-30" });
    expect(dailyMarketSession(at("2026-10-10T12:00:00"), calendar)).toMatchObject({ phase: "closed", targetDate: "2026-10-09" });
    expect(dailyMarketAvailability("2026-09-28", at("2026-10-02T12:00:00"), calendar).reason).toContain("2026-09-30");
    expect(dailyMarketAvailability("2026-09-30", at("2026-10-02T12:00:00"), calendar).reason).toBeNull();
  });
  it("distinguishes preopen, intraday including lunch, and unpublished close", () => {
    expect(dailyMarketSession(at("2026-10-08T09:14:00"), calendar)).toMatchObject({ phase: "preopen", targetDate: "2026-09-30" });
    for (const time of ["09:15:00", "12:00:00", "14:59:00"]) {
      expect(dailyMarketAvailability("2026-09-30", at(`2026-10-08T${time}`), calendar).reason).toContain("尚不能提供当天排行");
    }
    expect(dailyMarketAvailability("2026-09-30", at("2026-10-08T15:00:00"), calendar).reason).toContain("尚未更新");
    expect(dailyMarketAvailability("2026-10-08", at("2026-10-08T15:00:00"), calendar).reason).toBeNull();
  });
  it("does not guess an uncovered year or previous year holiday", () => {
    expect(dailyMarketSession(at("2027-01-02T12:00:00"), calendar).targetDate).toBeNull();
    expect(dailyMarketSession(at("2026-01-02T12:00:00"), calendar).targetDate).toBeNull();
  });
});

describe("snapshot publication and warm-process reads", () => {
  const scratch: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("observes a new snapshot on the same date, pins earlier reads, and keeps baseline replay separate", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "atlas-market-")); scratch.push(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.resetModules();
    const state = await import("../lib/market/state");
    const { rows } = deriveFixture();
    function writeSnapshot(directory: string, close: number) {
      mkdirSync(path.join(directory, "state"), { recursive: true });
      const jsonl = JSON.stringify({ ...rows[0], close }) + "\n";
      const manifest = { ...fixtureManifest(), contentDigest: { ...fixtureManifest().contentDigest, value: createHash("sha256").update(jsonl).digest("hex") } };
      writeFileSync(path.join(directory, "state", `${LATEST}.jsonl`), jsonl);
      writeFileSync(path.join(directory, "state", "manifest.json"), JSON.stringify(manifest));
    }
    expect(state.loadMarketStateManifest()).toBeNull(); // absence is not cached forever
    writeSnapshot(path.join(root, "data", "market"), 10);
    const baseline = state.loadCommittedMarketStateManifest()!;
    expect(state.loadMarketStateRows(LATEST, baseline)![0].close).toBe(10);
    const runtime = path.join(root, "data", "market-runtime");
    writeSnapshot(path.join(runtime, "snapshots", "first"), 11);
    writeFileSync(path.join(runtime, "current.json"), JSON.stringify({ snapshotId: "first" }));
    const first = state.loadMarketStateManifest()!;
    expect(state.loadMarketStateRows(LATEST, first)![0].close).toBe(11);
    writeSnapshot(path.join(runtime, "snapshots", "second"), 12);
    writeFileSync(path.join(runtime, "current.json"), JSON.stringify({ snapshotId: "second" }));
    expect(state.loadMarketStateRows(LATEST, state.loadMarketStateManifest())![0].close).toBe(12);
    expect(state.loadMarketStateRows(LATEST, first)![0].close).toBe(11);
    expect(state.loadMarketStateRows(LATEST, state.loadCommittedMarketStateManifest())![0].close).toBe(10);
    writeFileSync(path.join(runtime, "snapshots", "second", "state", `${LATEST}.jsonl`), "{}\n");
    // A new content identity claiming corrupt bytes must fail rather than publish data.
    const corrupt = state.loadMarketStateManifest()!;
    corrupt.contentDigest.value = "0".repeat(64);
    expect(() => state.loadMarketStateRows(LATEST, corrupt)).toThrow("digest mismatch");
    writeFileSync(path.join(runtime, "current.json"), JSON.stringify({ snapshotId: "../escape" }));
    expect(() => state.loadMarketStateManifest()).toThrow("Invalid market runtime");
  });
});
