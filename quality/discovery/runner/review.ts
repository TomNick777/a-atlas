/**
 * Human review surface (§36/§37): turn a snapshot into a reviewable markdown
 * sheet (Top5 + evidence excerpts + anchor status + label slots), and apply a
 * filled labels file back onto the snapshot (recomputing metrics.json with the
 * humanReview section).
 *
 *   npm run quality:discovery:review -- --from r1
 *   npm run quality:discovery:review -- --from r1 --labels reviews/r1-labels.json
 *
 * Report honesty rule (§37): only cases marked reviewed:true in the labels
 * file count as human reviewed; everything else stays mechanically evaluated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBenchmark, parseBenchmark, REVIEWS_DIR, SNAPSHOTS_DIR, type BenchmarkDoc } from "./benchmark";
import { computeMetrics, QUALITY_LABELS, type CaseRecord, type LabelsDoc, type QualityLabel } from "./metrics";

function snapshotDir(label: string): string {
  const dir = resolve(SNAPSHOTS_DIR, label);
  if (!existsSync(resolve(dir, "results.jsonl"))) {
    console.error(`snapshot ${label} has no results.jsonl at ${dir}`);
    process.exit(1);
  }
  return dir;
}

function loadRecords(dir: string): CaseRecord[] {
  return readFileSync(resolve(dir, "results.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CaseRecord);
}

function labelDoc(doc: BenchmarkDoc, records: CaseRecord[]): string {
  const lines: string[] = [];
  lines.push(`# Discovery quality review sheet — review Top5 per query, anchors, and suspicious high scores.`);
  lines.push("");
  lines.push("Labels (§19): DIRECT / VALID / WEAK / UNSUPPORTED / CONTRADICTORY / UNCERTAIN — definitions in quality/discovery/README.md.");
  lines.push("");
  for (const record of records) {
    const benchCase = doc.cases.find((row) => row.id === record.id);
    lines.push(`## ${record.id} — ${record.query}`);
    lines.push("");
    lines.push(`family: ${record.family} · status: ${record.status} · order: ${record.executionOrder ?? "—"} · decidedBy: ${record.decidedBy ?? "—"}${record.planUnsupported ? ` · unsupported: ${record.planUnsupported.intent}` : ""}`);
    const must = benchCase?.anchors?.mustInclude ?? [];
    const should = benchCase?.anchors?.shouldInclude ?? [];
    const negative = benchCase?.anchors?.negative ?? [];
    if (must.length || should.length || negative.length) {
      const hit = (code: string, k: number) => record.results.some((row) => row.rank <= k && row.code === code);
      lines.push(
        `anchors — must: ${must.map((anchor) => `${anchor.code}@${hit(anchor.code, 20) ? "✓" : "MISS"}`).join(", ") || "—"} · should: ${should.map((anchor) => `${anchor.code}@${hit(anchor.code, 20) ? "✓" : "—"}`).join(", ") || "—"} · negative-in-Top10: ${negative.filter((anchor) => hit(anchor.code, 10)).map((anchor) => anchor.code).join(", ") || "none"}`,
      );
    }
    lines.push("");
    lines.push("| rank | code | name | score | matched | termHits | evidence excerpt (verbatim) | label |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const row of record.results.filter((candidate) => candidate.rank <= 5)) {
      lines.push(`| ${row.rank} | ${row.code} | ${row.name} | ${row.score ?? "—"} | ${row.matched ?? "—"} | ${row.evidenceTermHits.join("/") || "—"} | ${(row.evidenceExcerpt ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ")} |  |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function labelTemplate(records: CaseRecord[]): LabelsDoc {
  const cases: LabelsDoc["cases"] = {};
  for (const record of records) {
    cases[record.id] = { reviewed: false, results: {}, attribution: undefined, notes: "" };
  }
  return { runLabel: "", reviewedBy: "", reviewedAt: "", method: "Top5 per query + anchors + suspicious high scores; definitions per README §labels", cases };
}

function applyLabels(dir: string, doc: BenchmarkDoc, records: CaseRecord[], labelsPath: string): void {
  const labels = JSON.parse(readFileSync(labelsPath, "utf-8")) as LabelsDoc;
  const problems: string[] = [];
  for (const [caseId, caseLabels] of Object.entries(labels.cases)) {
    const record = records.find((row) => row.id === caseId);
    if (!record) {
      problems.push(`labels reference unknown case ${caseId}`);
      continue;
    }
    for (const [code, label] of Object.entries(caseLabels.results ?? {})) {
      if (!QUALITY_LABELS.includes(label as QualityLabel)) problems.push(`${caseId}: unknown label ${label}`);
      if (!record.results.some((row) => row.code === code)) problems.push(`${caseId}: labeled code ${code} is not in the result set`);
    }
  }
  if (problems.length > 0) die(`labels invalid:\n  ${problems.join("\n  ")}`);
  writeFileSync(resolve(dir, "labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
  const metrics = computeMetrics(doc, labels.runLabel || dir.split(/[\\/]/).pop() || "", "live", records, labels);
  writeFileSync(resolve(dir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  const reviewed = Object.values(labels.cases).filter((caseLabels) => caseLabels.reviewed).length;
  console.log(`labels applied: ${reviewed} cases reviewed, ${metrics.humanReview?.labeledResults ?? 0} results labeled`);
  console.log(`evidence-weighted precision (Top10, labeled slice): ${metrics.humanReview?.evidenceWeightedPrecisionTop10 ?? "n/a"}`);
  console.log(`metrics.json recomputed at ${dir}`);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  let from: string | null = null;
  let labelsPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--from") from = argv[i + 1] ?? null;
    else if (argv[i] === "--labels") labelsPath = argv[i + 1] ?? null;
  }
  if (!from) die("--from <run label> required");
  const doc = parseBenchmark(loadBenchmark());
  const dir = snapshotDir(from);
  const records = loadRecords(dir);
  if (labelsPath) {
    applyLabels(dir, doc, records, resolve(labelsPath));
    return;
  }
  mkdirSync(REVIEWS_DIR, { recursive: true });
  const sheet = resolve(REVIEWS_DIR, `${from}-review.md`);
  writeFileSync(sheet, labelDoc(doc, records));
  const template = resolve(REVIEWS_DIR, `${from}-labels.template.json`);
  writeFileSync(template, `${JSON.stringify(labelTemplate(records), null, 2)}\n`);
  console.log(`review sheet: ${sheet}`);
  console.log(`labels template: ${template}`);
}

main();
