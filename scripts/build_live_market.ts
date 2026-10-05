/** Deterministic quote projection over the existing daily derivation, no network. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildDerivedState } from "../lib/market/derive";
import type { MarketDataRow, MarketQuoteFile, MarketStateManifest } from "../lib/market/contracts";

const [captureFile, historyDirectory, outputDirectory] = process.argv.slice(2);
if (!captureFile || !historyDirectory || !outputDirectory) throw new Error("capture, history and output directories required");
const capture = JSON.parse(readFileSync(captureFile, "utf8"));
if (!capture.publishable) throw new Error(`Source rejected: ${capture.failures.join(", ")}`);
const universeBytes = readFileSync(path.join(process.cwd(), "data", "companies.json"));
const universeSha16 = createHash("sha256").update(universeBytes).digest("hex").slice(0, 16);
if (capture.universeSha16 !== universeSha16) throw new Error("Company pool changed during capture");
const companies = JSON.parse(universeBytes.toString()).companies as Array<{code: string; name: string; exchange: string; listedAt?: string}>;
const identities = new Map(companies.map(c => [c.code, c]));
const history = JSON.parse(readFileSync(path.join(historyDirectory, "state", "manifest.json"), "utf8")) as MarketStateManifest;
const target = capture.context.tradeDate as string;
if (!history.tradingDays.includes(capture.context.previousDate)) throw new Error("Previous completed trading day is missing; refresh history before publishing");
const days = [...new Set([...history.tradingDays.filter(d => d <= target), target])].sort();
const dayRows = new Map<string, Map<string, MarketDataRow>>();
for (const day of days.filter(d => d !== target)) {
  const file = path.join(historyDirectory, "daily", `${day}.jsonl`);
  if (!existsSync(file)) throw new Error(`History missing ${day}`);
  dayRows.set(day, new Map(readFileSync(file, "utf8").trim().split("\n").map(line => {
    const row = JSON.parse(line) as MarketDataRow;
    if (row.date !== day) throw new Error("History date mismatch");
    return [row.code, row];
  })));
}
const current = new Map<string, MarketDataRow>();
const quote: MarketQuoteFile = { schemaVersion: "1.0.0", date: target, source: "Tencent raw projection atlas-tencent-raw-1", fetchedAt: capture.endedAt, coherence: {checked: 0, lastCloseMatchRate: 0, priceMatchRate: 0, changePctMatchRate: 0}, rowCount: 0, rows: {} };
for (const [code, entry] of Object.entries(capture.rows) as Array<[string, {status: string; symbol: string; source: Record<string, number>} ]>) {
  if (entry.status !== "VALID") continue;
  const q = entry.source;
  const company = identities.get(code);
  if (!company || entry.symbol !== `${company.exchange.toLowerCase()}${code}`) throw new Error("Quote identity mismatch");
  current.set(code, { date: target, code, market: company.exchange.toLowerCase() as MarketDataRow["market"], name: company.name,
    prevClose: q.last_close, open: q.open, high: q.high, low: q.low, close: q.price, volume: q.volumeShares, amount: q.amount_precise_wan * 10000 });
  quote.rows[code] = { turnoverPct: q.turnover_pct, marketCapYi: q.mcap_yi, floatMarketCapYi: q.float_mcap_yi,
    limitUp: q.limit_up > 0 ? q.limit_up : null, limitDown: q.limit_down > 0 ? q.limit_down : null, stale: false };
}
dayRows.set(target, current);
quote.rowCount = current.size;
const derived = buildDerivedState({ tradingDays: days, dayRows, targetDate: target, quote, listedAt: new Map(companies.map(c => [c.code, c.listedAt])) });
const digest = createHash("sha256").update(derived.jsonl).digest("hex");
const manifest: MarketStateManifest = {
  ...history, builderVersion: "market-live-builder-1", generatedAt: capture.endedAt, latestTradingDay: target, tradingDays: days,
  window: { tradingDays: days.length, start: days[0], end: target },
  inputs: { dailyFiles: days.length - 1, universeSha16, universeCount: companies.length, quoteFile: `${target}.json`, quoteCoherence: null },
  materializedDates: [target], contentDigest: {algorithm: "sha256", scope: `state/${target}.jsonl`, value: digest},
  perDate: { [target]: { rows: current.size, sha16: digest.slice(0, 16) } }, audit: derived.audit,
  runtime: { mode: "quote", historySnapshotId: path.basename(historyDirectory) === "market" ? null : path.basename(historyDirectory),
    source: "腾讯财经", tradeDate: target, phase: capture.context.phase, startedAt: capture.startedAt, endedAt: capture.endedAt,
    sourceTimeMin: capture.sourceTimeMin, sourceTimeMax: capture.sourceTimeMax, collectionSeconds: capture.collectionSeconds,
    counts: capture.counts, coverage: capture.validCoverage, policy: capture.policy, snapshotId: path.basename(outputDirectory) },
};
mkdirSync(path.join(outputDirectory, "state"), {recursive: true});
mkdirSync(path.join(outputDirectory, "quote"), {recursive: true});
writeFileSync(path.join(outputDirectory, "state", `${target}.jsonl`), derived.jsonl);
writeFileSync(path.join(outputDirectory, "quote", `${target}.json`), JSON.stringify(quote));
writeFileSync(path.join(outputDirectory, "state", "manifest.json"), JSON.stringify(manifest));
console.log(JSON.stringify({date: target, rows: current.size, digest, snapshotId: path.basename(outputDirectory)}));
