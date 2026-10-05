/** Local snapshot maintenance; never reads corpus, search traces or judge state. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const MARKET_RETENTION = { days: 7, latest: 2 } as const;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const processOwner = `${process.pid}-${randomUUID()}`;
const pins = new Map<string, { count: number; file: string }>();

function releasePin(key: string) {
  const pin = pins.get(key);
  if (!pin || --pin.count > 0) return;
  pins.delete(key);
  try { unlinkSync(pin.file); } catch { /* A leftover marker conservatively retains the snapshot. */ }
}
const finalized = new FinalizationRegistry<string>(releasePin);

function assertPlain(file: string, directory: boolean) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Snapshot retention refuses links or unexpected file types");
}

/** Keep files alive while a request still owns its manifest. GC may delay
 * release, but can never release the protection before the manifest itself. */
export function withSnapshotPin<T extends object>(directory: string, read: () => T): T {
  const runtime = path.join(process.cwd(), "data", "market-runtime");
  const snapshots = path.join(runtime, "snapshots");
  if (path.dirname(directory) !== snapshots) return read(); // committed replay is never pruned
  const identity = path.basename(directory);
  if (!validId(identity)) throw new Error("Invalid snapshot pin identity");
  const guard = path.join(runtime, "prune.lock");
  if (existsSync(guard)) throw new Error("Market snapshot maintenance in progress; retry");
  assertPlain(runtime, true);
  assertPlain(snapshots, true);
  assertPlain(directory, true);
  const leaseRoot = path.join(runtime, "leases");
  if (existsSync(leaseRoot)) assertPlain(leaseRoot, true);
  mkdirSync(leaseRoot, { recursive: true });
  assertPlain(leaseRoot, true);
  const leaseDirectory = path.join(leaseRoot, identity);
  if (existsSync(leaseDirectory)) assertPlain(leaseDirectory, true);
  mkdirSync(leaseDirectory, { recursive: true });
  assertPlain(leaseDirectory, true);
  const key = `${runtime}:${identity}`;
  let pin = pins.get(key);
  if (!pin) {
    const file = path.join(leaseDirectory, `${processOwner}.json`);
    writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    pin = { count: 0, file };
    pins.set(key, pin);
  }
  pin.count++;
  try {
    // Close the race with a pruner that acquired its lock after the first check.
    if (existsSync(guard)) throw new Error("Market snapshot maintenance in progress; retry");
    const owner = read();
    finalized.register(owner, key);
    return owner;
  } catch (error) {
    releasePin(key);
    throw error;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    // Only ESRCH proves that the owner no longer exists; permission failures retain it.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export type RetentionResult = { apply: boolean; retained: string[]; candidates: string[]; removed: string[] };

/** Uses the publication lock, so an unfinished capture can never be a candidate.
 * Any corrupt identity, manifest or lease aborts before the first deletion. */
export function pruneMarketSnapshots(options: { apply?: boolean; now?: number; runtime?: string } = {}): RetentionResult {
  const runtime = path.resolve(options.runtime ?? path.join(process.cwd(), "data", "market-runtime"));
  const result: RetentionResult = { apply: options.apply ?? false, retained: [], candidates: [], removed: [] };
  const snapshots = path.join(runtime, "snapshots");
  if (!existsSync(snapshots)) return result;
  assertPlain(runtime, true);
  assertPlain(snapshots, true);
  const publicationLock = path.join(runtime, "refresh.lock");
  const readerGuard = path.join(runtime, "prune.lock");
  mkdirSync(publicationLock); // existing owner/stale lock is never stolen
  let guardOwned = false;
  try {
    mkdirSync(readerGuard);
    guardOwned = true;
    const manifests = new Map<string, { time: number; history: string | null }>();
    for (const identity of readdirSync(snapshots)) {
      if (!validId(identity)) throw new Error("Invalid snapshot directory identity");
      const directory = path.join(snapshots, identity);
      assertPlain(directory, true);
      assertPlain(path.join(directory, "state"), true);
      const file = path.join(directory, "state", "manifest.json");
      assertPlain(file, false);
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      const time = Date.parse(manifest.generatedAt);
      const history = manifest.runtime ? manifest.runtime.historySnapshotId : null;
      if (!Number.isFinite(time) || (history !== null && !validId(history))) throw new Error("Invalid snapshot retention manifest");
      manifests.set(identity, { time, history });
    }
    const pointerFile = path.join(runtime, "current.json");
    assertPlain(pointerFile, false);
    const current = JSON.parse(readFileSync(pointerFile, "utf8")).snapshotId;
    if (!validId(current) || !manifests.has(current)) throw new Error("Current snapshot missing or invalid; retention aborted");
    const keep = new Set<string>([current]);
    const ordered = [...manifests].sort((a, b) => b[1].time - a[1].time || a[0].localeCompare(b[0]));
    const cutoff = (options.now ?? Date.now()) - MARKET_RETENTION.days * 86400000;
    for (const [index, [identity, manifest]] of ordered.entries()) {
      if (index < MARKET_RETENTION.latest || manifest.time >= cutoff) keep.add(identity);
    }
    const leases = path.join(runtime, "leases");
    const staleLeases: string[] = [];
    if (existsSync(leases)) {
      assertPlain(leases, true);
      for (const identity of readdirSync(leases)) {
        if (!validId(identity)) throw new Error("Invalid snapshot lease identity");
        const directory = path.join(leases, identity);
        assertPlain(directory, true);
        for (const name of readdirSync(directory)) {
          if (!/^\d+-[a-zA-Z0-9-]+\.json$/.test(name)) throw new Error("Invalid snapshot lease filename");
          const file = path.join(directory, name);
          assertPlain(file, false);
          const { pid } = JSON.parse(readFileSync(file, "utf8"));
          if (!Number.isSafeInteger(pid) || pid < 1 || Number(name.split("-")[0]) !== pid) throw new Error("Invalid snapshot lease owner");
          if (alive(pid)) {
            if (!manifests.has(identity)) throw new Error("An active reader's snapshot is missing");
            keep.add(identity);
          } else staleLeases.push(file);
        }
      }
    }
    // Transitive references from every retained snapshot, including active readers.
    for (const identity of keep) {
      const history = manifests.get(identity)!.history;
      if (history !== null) {
        if (!manifests.has(history)) throw new Error("Referenced market history snapshot is missing");
        keep.add(history);
      }
    }
    result.retained = [...keep].sort();
    result.candidates = ordered.map(([identity]) => identity).filter(identity => !keep.has(identity));
    if (result.apply) {
      for (const file of staleLeases) unlinkSync(file);
      for (const identity of result.candidates) {
        const target = path.resolve(snapshots, identity);
        if (path.dirname(target) !== snapshots) throw new Error("Retention target escaped snapshot root");
        assertPlain(target, true);
        rmSync(target, { recursive: true });
        result.removed.push(identity);
      }
    }
    return result;
  } finally {
    if (guardOwned) rmdirSync(readerGuard);
    rmdirSync(publicationLock);
  }
}
