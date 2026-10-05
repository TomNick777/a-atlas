/**
 * Jev Discovery Quality Benchmark — dataset contract (Phase 3.5).
 *
 * The benchmark is an observation instrument, not a target to optimize.
 * This module is the single parser for quality/discovery/benchmark-v1.json:
 * schema validation, anchor sanity, and the corpus-digest drift guard.
 *
 * Anchors are deliberately restrained (benchmark §13): mustInclude only for
 * corpus-verified flagship samples, shouldInclude are observations, negative
 * anchors are obvious-unrelated controls. Queries are frozen user phrasings —
 * never reworded because results disappoint (§27).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const QUALITY_ROOT = resolve("quality/discovery");
export const SNAPSHOTS_DIR = resolve(QUALITY_ROOT, "snapshots");
export const REVIEWS_DIR = resolve(QUALITY_ROOT, "reviews");

export const BENCHMARK_VERSION = "v1.2";
// 数据集文件名保持 benchmark-v1.json：v1 是血统，v1.x 是坐标系修订
// （Phase 3.6 corpus 重钉，query/anchor/evaluator 逐字不变，§27/§28）。
export const BENCHMARK_FILE = resolve(QUALITY_ROOT, "benchmark-v1.json");
export const GOLDEN_EVIDENCE_FILE = resolve(QUALITY_ROOT, "golden-evidence.json");

export type FamilyId =
  | "explicit_product"
  | "broad_semantic"
  | "relation"
  | "comparison"
  | "composite"
  | "ambiguous"
  | "weak_concept"
  | "negative_control";

export const FAMILIES: readonly FamilyId[] = [
  "explicit_product",
  "broad_semantic",
  "relation",
  "comparison",
  "composite",
  "ambiguous",
  "weak_concept",
  "negative_control",
];

export type AnchorCompany = { code: string; reason: string };

export type BenchmarkAnchors = {
  mustInclude?: AnchorCompany[];
  shouldInclude?: AnchorCompany[];
  negative?: AnchorCompany[];
};

export type BenchmarkCase = {
  id: string;
  family: FamilyId;
  query: string;
  anchors?: BenchmarkAnchors;
  /** OR-terms probed mechanically against the resolved verbatim evidence text. */
  requiredEvidence?: string[];
  notes?: string;
  noUniqueAnswer?: boolean;
  expectedHonestRejection?: boolean;
  /** Family comparison only. */
  subjects?: [string, string];
  strictGradient?: { top: string; bottom: string };
};

export type BenchmarkDoc = {
  name: string;
  benchmarkVersion: string;
  schemaVersion: string;
  createdAt: string;
  corpusContentDigest16: string;
  marketDate: string;
  groundTruthMethod: string;
  caseSchema: Record<string, string>;
  families: Record<string, string>;
  cases: BenchmarkCase[];
};

export type GoldenEvidenceEntry = {
  id: string;
  caseId: string;
  code: string;
  name: string;
  requiredTerms: string[];
  quote: string;
  source: string;
};

export type GoldenEvidenceDoc = {
  version: string;
  purpose: string;
  corpusContentDigest16: string;
  entries: GoldenEvidenceEntry[];
};

export function benchmarkSha256(doc: BenchmarkDoc): string {
  return createHash("sha256").update(JSON.stringify(doc.cases.map((row) => [row.id, row.query, row.anchors ?? null]))).digest("hex").slice(0, 16);
}

function fail(message: string): never {
  throw new Error(`benchmark-v1 invalid: ${message}`);
}

export function parseBenchmark(input: unknown): BenchmarkDoc {
  const doc = input as BenchmarkDoc;
  if (!doc || typeof doc !== "object") fail("not an object");
  if (doc.benchmarkVersion !== BENCHMARK_VERSION) fail(`benchmarkVersion must be ${BENCHMARK_VERSION}`);
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) fail("cases missing");
  if (!/^[0-9a-f]{16}$/.test(doc.corpusContentDigest16 ?? "")) fail("corpusContentDigest16 must be a 16-hex digest");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.marketDate ?? "")) fail("marketDate must be YYYY-MM-DD");

  const seen = new Set<string>();
  for (const row of doc.cases) {
    if (!/^[A-H]\d{2}$/.test(row.id)) fail(`${row.id}: id must be family letter + two digits`);
    if (seen.has(row.id)) fail(`${row.id}: duplicate id`);
    seen.add(row.id);
    if (!FAMILIES.includes(row.family)) fail(`${row.id}: unknown family ${row.family}`);
    const letter = row.id[0];
    const expectedLetter = { explicit_product: "A", broad_semantic: "B", relation: "C", comparison: "D", composite: "E", ambiguous: "F", weak_concept: "G", negative_control: "H" }[row.family];
    if (letter !== expectedLetter) fail(`${row.id}: id letter ${letter} does not match family ${row.family}`);
    const query = row.query.trim();
    if (query.length < 2 || query.length > 120) fail(`${row.id}: query length out of range`);
    for (const bucket of ["mustInclude", "shouldInclude", "negative"] as const) {
      for (const anchor of row.anchors?.[bucket] ?? []) {
        if (!/^\d{6}$/.test(anchor.code)) fail(`${row.id}: anchor code must be 6 digits`);
        if (!anchor.reason || anchor.reason.trim().length < 4) fail(`${row.id}: anchor ${anchor.code} needs a reason — unverified codes stay out`);
      }
    }
    for (const term of row.requiredEvidence ?? []) {
      if (!term.trim()) fail(`${row.id}: empty requiredEvidence term`);
    }
    if (row.family === "comparison") {
      if (!row.subjects || row.subjects.length !== 2) fail(`${row.id}: comparison cases need exactly two subjects`);
      if (row.strictGradient && row.strictGradient.top === row.strictGradient.bottom) fail(`${row.id}: strictGradient needs two distinct codes`);
    } else if (row.subjects) {
      fail(`${row.id}: subjects only allowed on comparison cases`);
    }
  }
  return doc;
}

export function loadBenchmark(): BenchmarkDoc {
  if (!existsSync(BENCHMARK_FILE)) fail(`${BENCHMARK_FILE} missing`);
  return parseBenchmark(JSON.parse(readFileSync(BENCHMARK_FILE, "utf-8")));
}

export function loadGoldenEvidence(): GoldenEvidenceDoc {
  if (!existsSync(GOLDEN_EVIDENCE_FILE)) fail(`${GOLDEN_EVIDENCE_FILE} missing`);
  return JSON.parse(readFileSync(GOLDEN_EVIDENCE_FILE, "utf-8")) as GoldenEvidenceDoc;
}

/** Cases filtered by --family / --query selectors (null = all). */
export function selectCases(doc: BenchmarkDoc, families: string[] | null, ids: string[] | null): BenchmarkCase[] {
  return doc.cases.filter((row) => {
    if (families && !families.includes(row.family)) return false;
    if (ids && !ids.includes(row.id)) return false;
    return true;
  });
}
