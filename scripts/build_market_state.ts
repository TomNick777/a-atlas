/**
 * Market State builder — deterministic derivation from the captured Market
 * Data artifacts into the committed, byte-pinned Market State.
 *
 * Mirrors the Company Knowledge Corpus builder discipline:
 *   - pure derivation (lib/market/derive.ts) over committed inputs;
 *   - LF JSONL, sorted by code, byte-identical on rebuild;
 *   - --check rebuilds in memory and compares bytes with the on-disk artifact
 *     (CI gate: npm run market:check).
 *
 * Inputs (all committed, never the network):
 *   data/market/daily/<date>.jsonl   objective vendor rows (tdx full-market package)
 *   data/market/quote/<date>.json    coherence-audited Tencent snapshot (latest day)
 *   data/market/ingest.json          the captured trading-day window
 *   data/companies.json              identity + listing dates (read-only join)
 *
 * Outputs:
 *   data/market/state/<date>.jsonl   derived state rows for a materialized date
 *   data/market/state/manifest.json  window, digests, audit (latestTradingDay ...)
 *
 * Usage:
 *   npx tsx scripts/build_market_state.ts [--date YYYY-MM-DD] [--check]
 *
 * By default only the latest trading day is materialized (that is what every
 * Phase 1 canonical query reads). --date materializes any other captured day
 * deterministically; historical turnover stays null there by design.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "path";

import type { MarketDataRow, MarketQuoteFile, MarketStateManifest } from "../lib/market/contracts";
import { buildDerivedState } from "../lib/market/derive";

const REPO = path.resolve(__dirname, "..");
const dataDirIndex = process.argv.indexOf("--data-dir");
const MARKET_DIR = dataDirIndex >= 0 ? path.resolve(process.argv[dataDirIndex + 1]) : path.join(REPO, "data", "market");
const INGEST = path.join(MARKET_DIR, "ingest.json");
const STATE_DIR = path.join(MARKET_DIR, "state");
const UNIVERSE = path.join(REPO, "data", "companies.json");

const BUILDER_VERSION = "market-state-builder-1.0.0";
const SCHEMA_VERSION = "1.0.0";

const check = process.argv.includes("--check");
const dateArgIndex = process.argv.indexOf("--date");
const dateArg = dateArgIndex >= 0 ? process.argv[dateArgIndex + 1] : undefined;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readDayRows(date: string): Map<string, MarketDataRow> {
  const file = path.join(MARKET_DIR, "daily", `${date}.jsonl`);
  const rows = new Map<string, MarketDataRow>();
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as MarketDataRow;
    if (row.date !== date) throw new Error(`${file}: row carries date ${row.date}, file is for ${date}`);
    rows.set(row.code, row);
  }
  return rows;
}

function readUniverse(): { byCode: Map<string, string | undefined>; sha16: string; count: number } {
  const raw = readFileSync(UNIVERSE);
  const sha16 = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const doc = JSON.parse(raw.toString("utf-8")) as { companies: Array<{ code: string; listedAt?: string }> };
  const byCode = new Map<string, string | undefined>();
  for (const c of doc.companies) byCode.set(c.code, c.listedAt);
  return { byCode, sha16, count: doc.companies.length };
}

function buildFor(targetDate: string, tradingDays: string[], universe: ReturnType<typeof readUniverse>, quote: MarketQuoteFile | null) {
  const dayRows = new Map<string, Map<string, MarketDataRow>>();
  for (const date of tradingDays) dayRows.set(date, readDayRows(date));
  return buildDerivedState({
    tradingDays,
    dayRows,
    quote: quote && quote.date === targetDate ? quote : null,
    targetDate,
    listedAt: universe.byCode,
  });
}

function main(): number {
  if (!existsSync(INGEST)) {
    console.error("market state build FAILED: data/market/ingest.json missing — run npm run market:fetch first");
    return 1;
  }
  const ingest = JSON.parse(readFileSync(INGEST, "utf-8")) as {
    tradingDays: string[];
    window: { start: string; end: string };
    universe: { sha16: string; count: number };
  };
  const tradingDays = [...ingest.tradingDays].sort(); // ascending
  const latestTradingDay = tradingDays[tradingDays.length - 1];
  const targetDate = dateArg ?? latestTradingDay;
  if (!tradingDays.includes(targetDate)) {
    console.error(`market state build FAILED: ${targetDate} is not in the captured window (${tradingDays[0]}..${latestTradingDay})`);
    return 1;
  }

  const universe = readUniverse();
  const quotePath = path.join(MARKET_DIR, "quote", `${latestTradingDay}.json`);
  const quote: MarketQuoteFile | null = existsSync(quotePath) ? JSON.parse(readFileSync(quotePath, "utf-8")) : null;

  const { jsonl, rows, audit } = buildFor(targetDate, tradingDays, universe, quote);
  const digest = sha256(jsonl);

  const manifest: MarketStateManifest = {
    schemaVersion: SCHEMA_VERSION,
    builderVersion: BUILDER_VERSION,
    generatedAt: new Date().toISOString(),
    latestTradingDay,
    tradingDays,
    window: { tradingDays: tradingDays.length, start: tradingDays[0], end: latestTradingDay },
    inputs: {
      dailyFiles: tradingDays.length,
      universeSha16: universe.sha16,
      universeCount: universe.count,
      quoteFile: quote ? `${quote.date}.json` : null,
      quoteCoherence: quote ? { lastCloseMatchRate: quote.coherence.lastCloseMatchRate } : null,
    },
    materializedDates: [targetDate],
    contentDigest: { algorithm: "sha256", scope: `state/${targetDate}.jsonl`, value: digest },
    perDate: { [targetDate]: { rows: rows.length, sha16: digest.slice(0, 16) } },
    audit: {
      limitBasisCounts: Object.fromEntries(Object.entries(audit.limitBasisCounts).sort()),
      isLimitUpCount: audit.isLimitUpCount,
      isLimitDownCount: audit.isLimitDownCount,
      turnoverCoverage: audit.turnoverCoverage,
      snapshotLimitCrossCheck: audit.snapshotLimitCrossCheck,
    },
  };

  if (check) {
    const stateFile = path.join(STATE_DIR, `${targetDate}.jsonl`);
    const failures: string[] = [];
    if (!existsSync(stateFile)) {
      failures.push(`state/${targetDate}.jsonl missing`);
    } else {
      const onDisk = readFileSync(stateFile, "utf-8");
      if (onDisk !== jsonl) failures.push(`state/${targetDate}.jsonl differs from rebuild`);
    }
    const manifestPath = path.join(STATE_DIR, "manifest.json");
    if (!existsSync(manifestPath)) {
      failures.push("state/manifest.json missing");
    } else {
      const onDisk = JSON.parse(readFileSync(manifestPath, "utf-8")) as MarketStateManifest;
      if (onDisk.contentDigest.value !== digest) failures.push("manifest contentDigest differs from rebuild");
      if (onDisk.latestTradingDay !== latestTradingDay) failures.push("manifest latestTradingDay differs from captured window");
      if (JSON.stringify(onDisk.tradingDays) !== JSON.stringify(tradingDays)) failures.push("manifest tradingDays differ from ingest");
    }
    if (failures.length) {
      console.error("market --check FAILED:");
      for (const f of failures) console.error(`  - ${f}`);
      return 1;
    }
    console.log(`market --check ok: ${rows.length} rows for ${targetDate}, digest ${digest.slice(0, 16)}, byte-identical rebuild`);
    return 0;
  }

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(path.join(STATE_DIR, `${targetDate}.jsonl`), jsonl, { encoding: "utf-8", flag: "w" });
  // Keep only materialized dates that this builder produced; a --date build
  // replaces the manifest's single materialized date by design (the canonical
  // query surface is the latest day).
  writeFileSync(path.join(STATE_DIR, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n", {
    encoding: "utf-8",
    flag: "w",
  });
  console.log(
    `market state: ${rows.length} rows for ${targetDate} (latest ${latestTradingDay}), sha256 ${digest.slice(0, 16)}`,
  );
  console.log(
    `audit: limitUp ${audit.isLimitUpCount}, limitDown ${audit.isLimitDownCount}, turnover coverage ${audit.turnoverCoverage}, bases ${JSON.stringify(manifest.audit.limitBasisCounts)}`,
  );
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error("market state build FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
}
