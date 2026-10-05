/**
 * Baseline diff + stability (§21/§22/§35) — deliberately simple:
 *
 *   npm run quality:discovery:compare -- --base r1 --target r2
 *   npm run quality:discovery:compare -- --stability r1 r2 r3
 *
 * The diff lists what changed between two runs of the same benchmark version:
 * new/lost Top10 entries, must-anchor presence flips, new negative intrusions,
 * rank/score movement for common companies, status flips, and headline metric
 * deltas. It interprets nothing — a future Jev upgrade protocol (§39) reads it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBenchmark, parseBenchmark, SNAPSHOTS_DIR, type BenchmarkDoc } from "./benchmark";
import { computeStability, type CaseRecord, type StabilityReport } from "./metrics";

function loadRecords(label: string): CaseRecord[] {
  const path = resolve(SNAPSHOTS_DIR, label, "results.jsonl");
  if (!existsSync(path)) die(`snapshot ${label} has no results.jsonl at ${path}`);
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CaseRecord);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

type CaseDiff = {
  id: string;
  statusFlip: boolean;
  mustLost: string[];
  mustGained: string[];
  newNegativeIntrusions: string[];
  enteredTop10: string[];
  leftTop10: string[];
  rankMovement: { code: string; from: number; to: number }[];
  scoreDrift: { code: string; from: number; to: number }[];
};

function diffCase(doc: BenchmarkDoc, base: CaseRecord, target: CaseRecord): CaseDiff {
  const benchCase = doc.cases.find((row) => row.id === base.id);
  const must = benchCase?.anchors?.mustInclude?.map((anchor) => anchor.code) ?? [];
  const negative = benchCase?.anchors?.negative?.map((anchor) => anchor.code) ?? [];
  const top10 = (record: CaseRecord) => new Set(record.results.filter((row) => row.rank <= 10).map((row) => row.code));
  const base10 = top10(base);
  const target10 = top10(target);
  const intrudes = (record: CaseRecord, code: string) =>
    record.results.some((row) => row.rank <= 10 && row.code === code && ((row.matched ?? false) || (row.score ?? 0) >= 0.6));
  const rankMovement: CaseDiff["rankMovement"] = [];
  const scoreDrift: CaseDiff["scoreDrift"] = [];
  for (const row of base.results) {
    const twin = target.results.find((candidate) => candidate.code === row.code);
    if (!twin) continue;
    if (row.rank !== twin.rank && (row.rank <= 20 || twin.rank <= 20)) rankMovement.push({ code: row.code, from: row.rank, to: twin.rank });
    if (row.score !== null && twin.score !== null && Math.abs(row.score - twin.score) > 0.02) scoreDrift.push({ code: row.code, from: row.score, to: twin.score });
  }
  return {
    id: base.id,
    statusFlip: base.status !== target.status,
    mustLost: must.filter((code) => base10.has(code) && !target10.has(code)),
    mustGained: must.filter((code) => !base10.has(code) && target10.has(code)),
    newNegativeIntrusions: negative.filter((code) => !intrudes(base, code) && intrudes(target, code)),
    enteredTop10: [...target10].filter((code) => !base10.has(code)),
    leftTop10: [...base10].filter((code) => !target10.has(code)),
    rankMovement,
    scoreDrift,
  };
}

function diffMain(doc: BenchmarkDoc, baseLabel: string, targetLabel: string): void {
  const baseRecords = loadRecords(baseLabel);
  const targetRecords = loadRecords(targetLabel);
  const targetDir = resolve(SNAPSHOTS_DIR, targetLabel);
  const diffs: CaseDiff[] = [];
  for (const baseRecord of baseRecords) {
    const targetRecord = targetRecords.find((row) => row.id === baseRecord.id);
    if (!targetRecord) continue;
    diffs.push(diffCase(doc, baseRecord, targetRecord));
  }
  const interesting = diffs.filter(
    (diff) => diff.statusFlip || diff.mustLost.length > 0 || diff.newNegativeIntrusions.length > 0 || diff.enteredTop10.length > 0 || diff.leftTop10.length > 0,
  );
  const lines: string[] = [];
  lines.push(`# Compare: ${baseLabel} → ${targetLabel}`);
  lines.push("");
  lines.push(`cases compared: ${diffs.length} · with changes: ${interesting.length}`);
  lines.push("");
  for (const diff of interesting) {
    const bits: string[] = [];
    if (diff.statusFlip) bits.push("status flip");
    if (diff.mustLost.length) bits.push(`MUST LOST: ${diff.mustLost.join(",")}`);
    if (diff.mustGained.length) bits.push(`must gained: ${diff.mustGained.join(",")}`);
    if (diff.newNegativeIntrusions.length) bits.push(`NEW NEGATIVE INTRUSION: ${diff.newNegativeIntrusions.join(",")}`);
    if (diff.enteredTop10.length) bits.push(`entered Top10: ${diff.enteredTop10.join(",")}`);
    if (diff.leftTop10.length) bits.push(`left Top10: ${diff.leftTop10.join(",")}`);
    const moved = diff.rankMovement.slice(0, 4).map((move) => `${move.code} ${move.from}→${move.to}`).join(", ");
    lines.push(`- ${diff.id}: ${bits.join(" · ")}${moved ? ` · rank moves: ${moved}` : ""}`);
  }
  if (interesting.length === 0) lines.push("- no Top10/anchor/status changes");
  lines.push("");
  const report = `${lines.join("\n")}\n`;
  writeFileSync(resolve(targetDir, `compare-vs-${baseLabel}.md`), report);
  writeFileSync(resolve(targetDir, `compare-vs-${baseLabel}.json`), `${JSON.stringify(diffs, null, 2)}\n`);
  console.log(report);
  console.log(`written: compare-vs-${baseLabel}.{md,json} in ${targetDir}`);
}

function stabilityMain(labels: string[]): void {
  const doc = parseBenchmark(loadBenchmark());
  const runs = labels.map((label) => ({ label, records: loadRecords(label) }));
  const report: StabilityReport = computeStability(doc, runs);
  const path = resolve(SNAPSHOTS_DIR, "stability.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  for (const pair of report.pairs) {
    console.log(
      `${pair.base} ↔ ${pair.target}: overlap@5 ${(pair.overlapTop5 * 100).toFixed(0)}% · @10 ${(pair.overlapTop10 * 100).toFixed(0)}% · @20 ${(pair.overlapTop20 * 100).toFixed(0)}% · |Δrank| ${(pair.meanAbsRankDelta ?? 0).toFixed(2)} · |Δscore| ${(pair.meanAbsScoreDelta ?? 0).toFixed(3)} · must-agree ${(pair.mustAnchorPresenceAgreement * 100).toFixed(0)}% · status flips ${pair.attributionFlips}`,
    );
  }
  console.log(`written: ${path}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const stability = argv.indexOf("--stability") >= 0;
  if (stability) {
    const labels = argv.slice(argv.indexOf("--stability") + 1).filter((value) => !value.startsWith("--"));
    if (labels.length < 2) die("--stability needs at least two run labels");
    stabilityMain(labels);
    return;
  }
  const base = get("--base");
  const target = get("--target");
  if (!base || !target) die("--base <label> --target <label> (or --stability r1 r2 …)");
  diffMain(parseBenchmark(loadBenchmark()), base, target);
}

main();
