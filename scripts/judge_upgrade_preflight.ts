/** Local coordinates only. Does not probe providers, fetch, train or change defaults. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadDataset } from "../lib/companies";
import { loadCommittedMarketStateManifest } from "../lib/market/state";
import { loadBenchmark, parseBenchmark, loadGoldenEvidence, benchmarkSha256 } from "../quality/discovery/runner/benchmark";

const outputArg = process.argv.indexOf("--output");
if (outputArg < 0 || !process.argv[outputArg + 1]) throw new Error("--output <new private JSON path> is required");
const output = resolve(process.argv[outputArg + 1]);
if (![".local", "reports"].some(root => output.startsWith(resolve(root) + "/") || output.startsWith(resolve(root) + "\\"))) throw new Error("Preflight output must stay in .local/ or reports/");
if (existsSync(output)) throw new Error("Preflight observations cannot be overwritten");
globalThis.fetch = async () => { throw new Error("Network is disabled for upgrade preflight"); };
const problems: string[] = [];
const dataset = loadDataset();
const benchmark = parseBenchmark(loadBenchmark());
const market = loadCommittedMarketStateManifest();
const golden = loadGoldenEvidence();
const corpusDigest = dataset.corpus?.contentDigest16 ?? null;
if (corpusDigest !== benchmark.corpusContentDigest16) problems.push("CORPUS_COORDINATE_MISMATCH");
if (market?.latestTradingDay !== benchmark.marketDate) problems.push("MARKET_DATE_MISMATCH");
if (golden.corpusContentDigest16 !== benchmark.corpusContentDigest16) problems.push("GOLDEN_CORPUS_MISMATCH");
const companies = new Map(dataset.companies.map(company => [company.code, company]));
for (const entry of golden.entries) {
  const company = companies.get(entry.code);
  if (!company || entry.requiredTerms.some(term => !(company.searchProfileText ?? "").includes(term))) problems.push(`GOLDEN_EVIDENCE_MISMATCH:${entry.id}`);
}
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const diff = execFileSync("git", ["diff", "HEAD", "--", ".", ":(exclude)package-lock.json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const report = {
  schemaVersion: 1, createdAt: new Date().toISOString(), mode: "local-preflight-only", cloudCalls: 0,
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), trackedDiffSha256: sha(diff),
  // Diff hash alone excludes untracked sources; keep an explicit inventory for review.
  untrackedCode: execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean).map(file => ({ file, sha256: sha(readFileSync(file)) })),
  coordinates: { corpusDigest, benchmarkCorpusDigest: benchmark.corpusContentDigest16, marketDate: market?.latestTradingDay ?? null, benchmarkMarketDate: benchmark.marketDate, marketDigest: market?.contentDigest.value ?? null, benchmarkSha256: benchmarkSha256(benchmark) },
  goldenEntries: golden.entries.length, localCoordinatesReady: problems.length === 0, problems,
  candidates: [{ provider: "jev", model: "jev-1.13.0", role: "baseline" }, { provider: "jev", model: "jev-1.14.0", role: "candidate" }, { provider: "drex", model: "drex-v2.0", role: "candidate" }],
  acceptance: { repetitionsPerModel: 2, cloudBudgetApproved: false, changeProductionDefault: false, note: "Resolve coordinates and register explicit call/USD limits before any LIVE run. No automatic corpus, market or benchmark rewrite." },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ output, localCoordinatesReady: report.localCoordinatesReady, problems, cloudCalls: 0 }));
