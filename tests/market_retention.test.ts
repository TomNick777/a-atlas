import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneMarketSnapshots, withSnapshotPin } from "../lib/market/retention";

const now = Date.parse("2026-10-04T12:00:00Z");
const scratch: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "atlas-retention-"));
  scratch.push(root);
  const runtime = path.join(root, "data", "market-runtime");
  function snapshot(id: string, days: number, history: string | null = null) {
    const directory = path.join(runtime, "snapshots", id);
    mkdirSync(path.join(directory, "state"), { recursive: true });
    writeFileSync(path.join(directory, "state", "manifest.json"), JSON.stringify({ generatedAt: new Date(now - days * 86400000).toISOString(), runtime: { historySnapshotId: history } }));
    return directory;
  }
  snapshot("current", 1, "history");
  snapshot("history", 20);
  snapshot("recent", 6);
  snapshot("expired", 10);
  writeFileSync(path.join(runtime, "current.json"), JSON.stringify({ snapshotId: "current" }));
  return { root, runtime, snapshot, run: (apply = false) => pruneMarketSnapshots({ runtime, now, apply }) };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("market snapshot retention", () => {
  it("defaults to preview, retains referenced history and releases both locks", () => {
    const f = fixture();
    expect(f.run()).toEqual({ apply: false, retained: ["current", "history", "recent"], candidates: ["expired"], removed: [] });
    expect(existsSync(path.join(f.runtime, "snapshots", "expired"))).toBe(true);
    expect(existsSync(path.join(f.runtime, "refresh.lock"))).toBe(false);
    expect(existsSync(path.join(f.runtime, "prune.lock"))).toBe(false);
    expect(f.run(true).removed).toEqual(["expired"]);
    expect(existsSync(path.join(f.runtime, "snapshots", "history"))).toBe(true);
    expect(existsSync(path.join(f.runtime, "snapshots", "expired"))).toBe(false);
  });

  it("keeps at least the latest two even after seven days, and the current pointer independently", () => {
    const f = fixture();
    f.snapshot("current", 90);
    f.snapshot("recent", 30);
    f.snapshot("expired", 40);
    expect(f.run(true)).toMatchObject({ retained: ["current", "history", "recent"], removed: ["expired"] });
  });

  it("pins a reader across pointer changes and transitively retains its old history", () => {
    const f = fixture();
    f.snapshot("expired", 10, "older-history");
    f.snapshot("older-history", 50, "oldest-history");
    f.snapshot("oldest-history", 60);
    vi.spyOn(process, "cwd").mockReturnValue(f.root);
    const directory = path.join(f.runtime, "snapshots", "expired");
    const owner = withSnapshotPin(directory, () => JSON.parse(readFileSync(path.join(directory, "state", "manifest.json"), "utf8")));
    expect(readdirSync(path.join(f.runtime, "leases", "expired"))).toHaveLength(1);
    expect(f.run(true).retained).toEqual(["current", "expired", "history", "older-history", "oldest-history", "recent"]);
    expect(owner.runtime.historySnapshotId).toBe("older-history"); // owner remains live
  });

  it("removes dead reader markers only on apply; an uncertain owner remains protected", () => {
    const f = fixture();
    const leases = path.join(f.runtime, "leases", "expired");
    mkdirSync(leases, { recursive: true });
    const file = path.join(leases, "123456-dead.json");
    writeFileSync(file, JSON.stringify({ pid: 123456 }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("permission"), { code: "EPERM" }); });
    expect(f.run().candidates).toEqual([]);
    kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(f.run().candidates).toEqual(["expired"]);
    expect(existsSync(file)).toBe(true);
    expect(f.run(true).removed).toEqual(["expired"]);
    expect(existsSync(file)).toBe(false);
  });

  it("aborts before removing snapshots or stale leases when a retained history is missing", () => {
    const f = fixture();
    f.snapshot("current", 1, "missing");
    const leases = path.join(f.runtime, "leases", "expired");
    mkdirSync(leases, { recursive: true });
    const file = path.join(leases, "123456-dead.json");
    writeFileSync(file, JSON.stringify({ pid: 123456 }));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(() => f.run(true)).toThrow("history snapshot is missing");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(f.runtime, "snapshots", "expired"))).toBe(true);
    expect(existsSync(path.join(f.runtime, "refresh.lock"))).toBe(false);
  });

  it("refuses publication and pruning locks without stealing them; readers refuse maintenance", () => {
    const f = fixture();
    const lock = path.join(f.runtime, "refresh.lock");
    mkdirSync(lock);
    expect(() => f.run(true)).toThrow();
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
    mkdirSync(path.join(f.runtime, "prune.lock"));
    expect(() => f.run(true)).toThrow();
    expect(existsSync(path.join(f.runtime, "refresh.lock"))).toBe(false);
    vi.spyOn(process, "cwd").mockReturnValue(f.root);
    const read = vi.fn(() => ({}));
    expect(() => withSnapshotPin(path.join(f.runtime, "snapshots", "current"), read)).toThrow("maintenance");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an invalid pointer or corrupt manifest without deleting any snapshot", () => {
    const f = fixture();
    writeFileSync(path.join(f.runtime, "current.json"), JSON.stringify({ snapshotId: "../escape" }));
    expect(() => f.run(true)).toThrow("Current snapshot");
    writeFileSync(path.join(f.runtime, "current.json"), JSON.stringify({ snapshotId: "current" }));
    writeFileSync(path.join(f.runtime, "snapshots", "expired", "state", "manifest.json"), "{}");
    expect(() => f.run(true)).toThrow("Invalid snapshot retention manifest");
    expect(readdirSync(path.join(f.runtime, "snapshots"))).toHaveLength(4);
  });

  it("refuses directory links rather than following them outside the snapshot root", () => {
    const f = fixture();
    const outside = path.join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    symlinkSync(outside, path.join(f.runtime, "snapshots", "linked"), "junction");
    expect(() => f.run(true)).toThrow("refuses links");
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });
});
