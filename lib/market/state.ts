/**
 * Market State loaders — pinned reads of published runtime or committed artifacts.
 *
 * The state layer is the only thing Market Query reads (plus the slim company
 * universe for identity join). If the state artifact is absent or misaligned,
 * queries answer `available: false` with the reason — they never fall back to
 * live vendor calls or to Company Facts.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MarketQuoteFile, MarketStateManifest, MarketStateRow } from "./contracts";
import { withSnapshotPin } from "./retention";

const DATA = path.join(process.cwd(), "data", "market");
const RUNTIME = path.join(process.cwd(), "data", "market-runtime");
const UNIVERSE_JSON = path.join(process.cwd(), "data", "companies.json");

export type MarketUniverse = {
  code: string;
  name: string;
  exchange: "SH" | "SZ" | "BJ";
  board: string;
  industry: string;
  listedAt?: string;
};

let universeCache: { sha16: string; count: number; byCode: Map<string, MarketUniverse> } | null = null;

/** Slim read-only company universe (identity join + listing dates). Deliberately
 * separate from lib/companies.ts, which loads the discovery semantic layer. */
export function loadMarketUniverse(): { sha16: string; count: number; byCode: Map<string, MarketUniverse> } {
  if (universeCache) return universeCache;
  const raw = readFileSync(UNIVERSE_JSON);
  const sha16 = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const doc = JSON.parse(raw.toString("utf-8")) as { generatedAt: string; companies: Array<Record<string, unknown>> };
  const byCode = new Map<string, MarketUniverse>();
  for (const c of doc.companies) {
    byCode.set(c.code as string, {
      code: c.code as string,
      name: c.name as string,
      exchange: c.exchange as "SH" | "SZ" | "BJ",
      board: c.board as string,
      industry: c.industry as string,
      listedAt: (c.listedAt as string | undefined) ?? undefined,
    });
  }
  universeCache = { sha16, count: byCode.size, byCode };
  return universeCache;
}

/** Refresh publishes an immutable directory, then atomically replaces this pointer. */
export function marketDataDirectory(): string {
  const pointer = path.join(RUNTIME, "current.json");
  if (!existsSync(pointer)) return DATA;
  const { snapshotId } = JSON.parse(readFileSync(pointer, "utf8")) as { snapshotId: string };
  if (!/^[a-zA-Z0-9_-]+$/.test(snapshotId)) throw new Error("Invalid market runtime snapshotId");
  return path.join(RUNTIME, "snapshots", snapshotId);
}

// The manifest object's source survives a pointer switch during a request.
const manifestDirectories = new WeakMap<MarketStateManifest, string>();

export function marketDirectoryFor(manifest: MarketStateManifest): string {
  return manifestDirectories.get(manifest) ?? marketDataDirectory();
}

export function marketHistoryDirectory(manifest: MarketStateManifest): string {
  if (!manifest.runtime) return marketDirectoryFor(manifest);
  const identity = manifest.runtime.historySnapshotId;
  if (identity === null) return DATA;
  if (!/^[a-zA-Z0-9_-]+$/.test(identity)) throw new Error("Invalid market history snapshotId");
  return path.join(RUNTIME, "snapshots", identity);
}

/** Latest published manifest (baseline if no runtime has been published). */
export function loadMarketStateManifest(): MarketStateManifest | null {
  return readManifest(marketDataDirectory());
}

/** Explicit historical replay input; never follows the live pointer. */
export function loadCommittedMarketStateManifest(): MarketStateManifest | null {
  return readManifest(DATA);
}

function readManifest(directory: string): MarketStateManifest | null {
  const file = path.join(directory, "state", "manifest.json");
  if (!existsSync(file)) return null;
  const manifest = withSnapshotPin(directory, () => JSON.parse(readFileSync(file, "utf-8")) as MarketStateManifest);
  manifestDirectories.set(manifest, directory);
  return manifest;
}

const rowsCache = new Map<string, MarketStateRow[]>();

export function loadMarketStateRows(date: string, manifest = loadMarketStateManifest()): MarketStateRow[] | null {
  const directory = manifest ? marketDirectoryFor(manifest) : marketDataDirectory();
  const digest = manifest?.materializedDates.includes(date) ? manifest.contentDigest.value : null;
  const key = `${directory}:${date}:${digest}`;
  const hit = rowsCache.get(key);
  if (hit) return hit;
  const file = path.join(directory, "state", `${date}.jsonl`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf-8");
  if (digest && createHash("sha256").update(text).digest("hex") !== digest) throw new Error(`Market State digest mismatch: ${date}`);
  const rows = text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MarketStateRow);
  // Bound memory even when a long-running Web consumes many snapshots.
  if (rowsCache.size >= 4) rowsCache.delete(rowsCache.keys().next().value!);
  rowsCache.set(key, rows);
  return rows;
}

export function loadQuoteFile(date: string): MarketQuoteFile | null {
  const directory = marketDataDirectory();
  const file = path.join(directory, "quote", `${date}.json`);
  if (!existsSync(file)) return null;
  return withSnapshotPin(directory, () => JSON.parse(readFileSync(file, "utf-8")) as MarketQuoteFile);
}
