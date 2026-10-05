/**
 * Jev Discovery Quality Benchmark — offline contract tests (Phase 3.5).
 *
 * The runner itself talks to the wire (npm run quality:discovery, LIVE only);
 * these tests pin the dataset contract and the pure metric layer, so the
 * coordinate system cannot silently rot: schema, anchor existence in the
 * corpus, golden-evidence verbatim facts at the pinned digest, mechanical
 * metric behaviour, and the runner's import seam.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkSha256,
  FAMILIES,
  loadBenchmark,
  loadGoldenEvidence,
  parseBenchmark,
  type BenchmarkDoc,
} from "../quality/discovery/runner/benchmark";
import {
  computeMetrics,
  computeStability,
  mechanicalHint,
  type CaseRecord,
  type LabelsDoc,
  type ResultRecord,
} from "../quality/discovery/runner/metrics";
import { loadDataset } from "../lib/companies";

const doc: BenchmarkDoc = parseBenchmark(loadBenchmark());
const dataset = loadDataset();
const corpusByCode = new Map(dataset.companies.map((company) => [company.code, company]));

describe("discovery quality benchmark v1 — dataset contract", () => {
  it("stays a representative, non-monstrous set over all eight families", () => {
    expect(doc.benchmarkVersion).toBe("v1.2");
    expect(doc.cases.length).toBeGreaterThanOrEqual(40);
    expect(doc.cases.length).toBeLessThanOrEqual(60);
    for (const family of FAMILIES) {
      expect(doc.cases.filter((row) => row.family === family).length, `family ${family} must be covered`).toBeGreaterThan(0);
    }
    expect(new Set(doc.cases.map((row) => row.id)).size).toBe(doc.cases.length);
  });

  it("freezes the coordinate system it measures", () => {
    expect(doc.corpusContentDigest16).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.corpusContentDigest16).toBe(dataset.corpus?.contentDigest16 ?? "");
    expect(doc.marketDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("only anchors companies that exist in the corpus, with a stated reason", () => {
    for (const row of doc.cases) {
      for (const bucket of ["mustInclude", "shouldInclude", "negative"] as const) {
        for (const anchor of row.anchors?.[bucket] ?? []) {
          expect(corpusByCode.has(anchor.code), `${row.id}: anchor ${anchor.code} not in corpus`).toBe(true);
          expect(anchor.reason.length).toBeGreaterThan(3);
        }
      }
    }
  });

  it("keeps mustInclude restrained — only corpus-verified flagship samples", () => {
    const mustCases = doc.cases.filter((row) => (row.anchors?.mustInclude?.length ?? 0) > 0);
    expect(mustCases.length).toBeGreaterThan(0);
    expect(mustCases.length).toBeLessThanOrEqual(15);
    for (const row of mustCases) {
      for (const anchor of row.anchors?.mustInclude ?? []) {
        const text = corpusByCode.get(anchor.code)?.searchProfileText ?? "";
        const probe = row.requiredEvidence ?? [];
        // A must anchor must have at least one required-evidence term in its
        // verbatim corpus text — that is what makes it "must" rather than "should".
        expect(probe.some((term) => text.includes(term)), `${row.id}: must anchor ${anchor.code} lacks verbatim corpus evidence`).toBe(true);
      }
    }
  });

  it("comparison cases carry exactly two corpus-backed subjects", () => {
    const comparisons = doc.cases.filter((row) => row.family === "comparison");
    expect(comparisons.length).toBeGreaterThanOrEqual(4);
    for (const row of comparisons) {
      expect(row.subjects?.length).toBe(2);
      for (const code of row.subjects ?? []) expect(corpusByCode.has(code), `${row.id}: subject ${code} not in corpus`).toBe(true);
    }
  });
});

describe("golden evidence (§29) — corpus still carries the flagship facts", () => {
  const golden = loadGoldenEvidence();

  it("is pinned to the same corpus digest as the benchmark", () => {
    expect(golden.corpusContentDigest16).toBe(doc.corpusContentDigest16);
    expect(golden.entries.length).toBeGreaterThanOrEqual(10);
  });

  it("finds every required term verbatim in the current corpus", () => {
    for (const entry of golden.entries) {
      const company = corpusByCode.get(entry.code);
      expect(company, `${entry.id}: ${entry.code} missing`).toBeDefined();
      expect(company?.name).toBe(entry.name);
      const text = company?.searchProfileText ?? "";
      for (const term of entry.requiredTerms) {
        expect(text.includes(term), `${entry.id}: 「${term}」 no longer verbatim in ${entry.code} corpus text — corpus moved, re-freeze the benchmark`).toBe(true);
      }
    }
  });
});

// ---- synthetic record helpers for the pure metric layer --------------------

function row(over: Partial<ResultRecord>): ResultRecord {
  return {
    rank: 1,
    code: "000001",
    name: "平安银行",
    capability: "semantic_match",
    score: 0.7,
    matched: true,
    relationLabel: null,
    judged: true,
    evidenceRefs: [{ companyId: "000001", ref: "judge-profile:000001" }],
    evidenceResolved: true,
    evidenceExcerpt: "主营业务：伺服系统。",
    evidenceTermHits: ["伺服"],
    marketCapYi: 300,
    heroKey: null,
    ...over,
  };
}

function record(over: Partial<CaseRecord>): CaseRecord {
  return {
    id: "A02",
    family: "explicit_product",
    query: "做工业机器人伺服系统",
    kind: "discover",
    mode: "live",
    status: "ok",
    error: null,
    planUnsupported: null,
    executionOrder: "semantic-only",
    decidedBy: "jev",
    degraded: false,
    degradedReason: null,
    parserVersion: "hybrid-parser-v2",
    parseMs: 1,
    timings: { totalMs: 100, semanticMs: 80, marketMs: null },
    capability: null,
    wireCalls: 2,
    results: [row({})],
    comparison: null,
    explanation: null,
    ...over,
  };
}

const syntheticCase = doc.cases.find((row) => row.id === "A02") as NonNullable<BenchmarkDoc["cases"][number]>;

describe("mechanical metrics", () => {
  it("computes must-recall, intrusion and grounding from records", () => {
    const records = [
      record({
        results: [
          row({ rank: 1, code: "300124", name: "汇川技术", evidenceTermHits: ["伺服"] }),
          row({ rank: 2, code: "600519", name: "贵州茅台", score: 0.8, matched: true, evidenceTermHits: [], evidenceExcerpt: "主营业务：茅台酒及系列酒。" }),
        ],
      }),
    ];
    const metrics = computeMetrics(doc, "t", "live", records, null);
    expect(metrics.global.mustIncludeRecall.top5).toBe(1);
    expect(metrics.global.negativeIntrusion.top5).toBe(1);
    expect(metrics.evidence.evidenceRefResolutionRate).toBe(1);
    expect(metrics.global.orphanJudgementRate).toBe(0);
    expect(metrics.evidence.directEvidenceRateTop1).toBe(1);
  });

  it("treats an expected honest refusal as success, not failure (§10)", () => {
    const caseRecord = record({ id: "F08", family: "ambiguous", status: "ambiguous_refusal", planUnsupported: { intent: "ambiguous_query", detail: "x" }, results: [] });
    const metrics = computeMetrics(doc, "t", "live", [caseRecord], null);
    expect(metrics.global.querySuccessRate).toBe(1);
    expect(metrics.byCase[0].mechanicalHint).toBe("EXPECTED_REJECTION");
  });

  it("maps failures to the mechanical taxonomy (§25)", () => {
    expect(mechanicalHint(record({ status: "error", error: "boom" }), syntheticCase)).toBe("RUNTIME_ERROR");
    expect(mechanicalHint(record({ status: "unsupported", planUnsupported: { intent: "unsupported_market_field", detail: "x" } }), syntheticCase)).toBe("PARSER_UNSUPPORTED");
    expect(
      mechanicalHint(record({ results: [row({ rank: 1, code: "600519", matched: true, score: 0.9 })] }), doc.cases.find((row) => row.id === "H03") as NonNullable<BenchmarkDoc["cases"][number]>),
    ).toBe("NEGATIVE_INTRUSION");
    expect(
      mechanicalHint(record({ results: [] }), syntheticCase),
    ).toBe("JEV_SEMANTIC_MISS");
  });

  it("requires explanation grounding to be verbatim or it shows up broken", () => {
    const grounded = record({ explanation: { subjectCode: "300124", status: "ok", insufficientEvidence: false, lines: 2, groundedRefs: true, groundedVerbatim: true } });
    const broken = record({ explanation: { subjectCode: "300124", status: "ok", insufficientEvidence: false, lines: 2, groundedRefs: false, groundedVerbatim: false } });
    expect(computeMetrics(doc, "t", "live", [grounded], null).evidence.explanationGroundingRate).toBe(1);
    expect(computeMetrics(doc, "t", "live", [broken], null).evidence.explanationGroundingRate).toBe(0);
  });

  it("applies human labels as a separate dimension (§19/§23), never a merged score", () => {
    const labels: LabelsDoc = {
      runLabel: "t",
      reviewedBy: "test",
      reviewedAt: "2026-09-29",
      method: "synthetic",
      cases: { A02: { reviewed: true, results: { "300124": "DIRECT", "600519": "UNSUPPORTED" } } },
    };
    const records = [
      record({
        results: [
          row({ rank: 1, code: "300124", name: "汇川技术" }),
          row({ rank: 2, code: "600519", name: "贵州茅台", score: 0.8, matched: true, evidenceTermHits: [] }),
        ],
      }),
    ];
    const metrics = computeMetrics(doc, "t", "live", records, labels);
    expect(metrics.humanReview?.reviewedCases).toBe(1);
    expect(metrics.humanReview?.labeledResults).toBe(2);
    expect(metrics.humanReview?.evidenceWeightedPrecisionTop10 ?? 0).toBeGreaterThan(0);
    expect(metrics.humanReview?.evidenceWeightedPrecisionTop10 ?? 1).toBeLessThan(1);
    expect((metrics as unknown as { overallScore?: number }).overallScore).toBeUndefined();
  });
});

describe("stability across runs (§21/§22)", () => {
  it("measures overlap and drift without merging quality", () => {
    const results = [
      row({ rank: 1, code: "300124", name: "汇川技术", score: 0.7 }),
      row({ rank: 2, code: "688320", name: "禾川科技", score: 0.6 }),
    ];
    const resultsB = [
      row({ rank: 1, code: "300124", name: "汇川技术", score: 0.72 }),
      row({ rank: 2, code: "603416", name: "信捷电气", score: 0.55 }),
    ];
    const runA = record({ results });
    const runB = record({ results: resultsB });
    const report = computeStability(doc, [
      { label: "r1", records: [runA] },
      { label: "r2", records: [runB] },
    ]);
    expect(report.pairs[0].overlapTop5).toBeCloseTo(0.5);
    expect(report.pairs[0].meanAbsScoreDelta ?? 0).toBeLessThan(0.05);
    expect(report.pairs[0].mustAnchorPresenceAgreement).toBe(1);
  });
});

describe("benchmark digest pinning", () => {
  it("is stable for the frozen dataset", () => {
    expect(benchmarkSha256(doc)).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(resolve("quality/discovery/benchmark-v1.json"), "utf-8")).toContain('"benchmarkVersion": "v1.2"');
  });
});

describe("runner seam discipline", () => {
  it("touches lib/jev only through the capabilities seam", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".ts")) files.push(full);
      }
    };
    walk(resolve("quality"));
    expect(files.length).toBeGreaterThan(0);
    // Wire-shape knowledge stays out of the runner entirely — it observes
    // through the seam; only the URL matcher (accounting) and the production
    // endpoint preflight may name the endpoint, mirroring scripts/ convention.
    const endpointAware = /[/\\](accounting|run)\.ts$/;
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      const jevImports = text.match(/from "[^"]*lib\/jev\/[^"]*"/g) ?? [];
      for (const statement of jevImports) {
        expect(statement.includes("lib/jev/capabilities"), `${file}: ${statement} bypasses the capabilities seam`).toBe(true);
      }
      expect(text).not.toMatch(/askNoul|askGraded|how_to_judge|looking_for|JEV_TIMING|JEV_PRICE_PER_TOKEN/);
      if (!endpointAware.test(file)) {
        expect(text, `${file}: unexpected endpoint knowledge`).not.toMatch(/systemone|typesafe\.ai/);
      }
    }
  });
});
