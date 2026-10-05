import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseBenchmark, loadBenchmarkCases, BENCHMARK_CATEGORIES } from "../lib/discovery/benchmark";
import { FAILURE_CATEGORIES, traceVerdict, type TraceObservation } from "../lib/discovery/failureTaxonomy";
import { inspectQuery } from "../lib/discovery/inspector";
import { resetDatasetCache } from "../lib/companies";
import type { CompanyKnowledgeDocument } from "../lib/corpus/contracts";

/**
 * Phase 3 §26 — benchmark / inspector 不变量。
 *
 * benchmark 是冻结的 committed 数据集：这些断言锁 schema、符号有效性、
 * 证据回指（防跨公司串证）、taxonomy 枚举、Inspector 输出结构与检索确定性。
 * 全部离线（retrieval 模式），不调云、不依赖 judge。
 */

const ROOT = path.resolve(__dirname, "..");

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
}

function loadCorpusDocs(): Map<string, CompanyKnowledgeDocument> {
  const raw = readFileSync(path.join(ROOT, "data", "company-corpus", "companies.jsonl"), "utf8");
  const docs = new Map<string, CompanyKnowledgeDocument>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as CompanyKnowledgeDocument;
    docs.set(doc.symbol, doc);
  }
  return docs;
}

describe("discovery benchmark contract", () => {
  const cases = loadBenchmarkCases(ROOT);

  it("parses and stays within the v1 size envelope", () => {
    expect(cases.length).toBeGreaterThanOrEqual(80);
    expect(cases.length).toBeLessThanOrEqual(120);
  });

  it("ids are unique and well-formed", () => {
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(cases.length);
    for (const c of cases) expect(c.id).toMatch(/^[A-I]\d{2}$/);
  });

  it("categories are from the fixed nine", () => {
    for (const c of cases) expect(BENCHMARK_CATEGORIES).toContain(c.category);
    for (const category of BENCHMARK_CATEGORIES) {
      expect(cases.some((c) => c.category === category), `category ${category} covered`).toBe(true);
    }
  });

  it("queries are user-plausible strings", () => {
    for (const c of cases) {
      expect(c.query.length).toBeGreaterThanOrEqual(2);
      expect(c.query.length).toBeLessThanOrEqual(120);
      expect(c.query).toBe(c.query.trim());
    }
  });

  it("referenced symbols are canonical 6-digit codes present in the dataset", () => {
    const dataset = loadJson("data/companies.json") as { companies: Array<{ code: string }> };
    const known = new Set(dataset.companies.map((c) => c.code));
    for (const c of cases) {
      for (const code of [...(c.expected?.strongMatches ?? []), ...(c.expected?.acceptableMatches ?? []), ...(c.expected?.exclusions ?? [])]) {
        expect(code).toMatch(/^\d{6}$/);
        expect(known.has(code), `${c.id}: ${code} in companies.json`).toBe(true);
      }
    }
  });

  it("graded cases carry expectations; no-unique-answer cases declare themselves", () => {
    for (const c of cases) {
      if (c.noUniqueAnswer) continue;
      const expected = c.expected ?? {};
      expect((expected.strongMatches?.length ?? 0) + (expected.acceptableMatches?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it("expected-evidence audit back-points to the right company's corpus document (no cross-company contamination)", () => {
    const audit = loadJson("evaluation/discovery/expected-evidence.json") as {
      cases: Record<string, Record<string, { role: string; corpusVerified: boolean; evidence: Array<{ field: string; quote: string }> }>>;
    };
    const docs = loadCorpusDocs();
    const caseIds = new Set(cases.map((c) => c.id));
    for (const [caseId, entries] of Object.entries(audit.cases)) {
      expect(caseIds.has(caseId)).toBe(true);
      for (const [code, entry] of Object.entries(entries)) {
        expect(["strong", "acceptable"]).toContain(entry.role);
        const doc = docs.get(code);
        expect(doc, `${caseId}:${code} has corpus doc`).toBeDefined();
        if (!doc) continue;
        for (const hit of entry.evidence) {
          const quote = hit.quote.replaceAll("…", "");
          expect(quote.length).toBeGreaterThan(0);
          if (hit.field === "searchableText") {
            expect(doc.searchableText.includes(quote), `${caseId}:${code} quote in its own searchableText`).toBe(true);
          } else {
            const fields = JSON.stringify(doc);
            expect(fields.includes(quote), `${caseId}:${code} quote in its own document`).toBe(true);
          }
        }
      }
    }
  });

  it("benchmark digest pin matches the corpus on disk (runner refuses drift)", () => {
    const audit = loadJson("evaluation/discovery/expected-evidence.json") as { corpusContentDigest16: string };
    const raw = readFileSync(path.join(ROOT, "data", "company-corpus", "companies.jsonl"));
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    expect(audit.corpusContentDigest16).toBe(createHash("sha256").update(raw).digest("hex").slice(0, 16));
  });
});

describe("failure taxonomy", () => {
  it("enum covers F0–F10 exactly", () => {
    expect(FAILURE_CATEGORIES).toHaveLength(11);
    expect(FAILURE_CATEGORIES[0]).toBe("F0");
    expect(FAILURE_CATEGORIES[10]).toBe("F10");
  });

  const base: TraceObservation = {
    corpusActive: true,
    textTermHits: [],
    structuredTermHits: [],
    inCandidatePool: false,
    poolRank: null,
    judgeScore: null,
    zeroReason: null,
    finalRank: null,
    inMatches: false,
  };

  it("classifies corpus-lack as F1 and structured-only presence as F2", () => {
    expect(traceVerdict(base).category).toBe("F1");
    expect(traceVerdict({ ...base, structuredTermHits: ["伺服"] }).category).toBe("F2");
    expect(traceVerdict({ ...base, textTermHits: ["伺服"] }).category).toBe("F4");
  });

  it("classifies constraint zeroing as F7 (before pool/judge layers)", () => {
    const obs: TraceObservation = { ...base, textTermHits: ["伺服"], inCandidatePool: true, poolRank: 5, zeroReason: "exclusion_pattern", judgeScore: 0.9 };
    expect(traceVerdict(obs).category).toBe("F7");
  });

  it("classifies low judge score as F5 and surfacing as pass", () => {
    const judged: TraceObservation = { ...base, textTermHits: ["伺服"], inCandidatePool: true, poolRank: 5, judgeScore: 0.1 };
    expect(traceVerdict(judged).category).toBe("F5");
    const passed: TraceObservation = { ...judged, judgeScore: 0.9, finalRank: 3, inMatches: true };
    expect(traceVerdict(passed).category).toBeNull();
    expect(traceVerdict(passed).stage).toBe("surfaced");
  });

  it("flags ranking when inside matches but beyond top10", () => {
    const ranked: TraceObservation = { ...base, textTermHits: ["伺服"], inCandidatePool: true, poolRank: 5, judgeScore: 0.9, finalRank: 14, inMatches: true };
    expect(traceVerdict(ranked).category).toBe("F6");
  });
});

describe("discovery inspector (retrieval mode, offline)", () => {
  it("produces a structurally complete report for an arbitrary query", { timeout: 20_000 }, async () => {
    // Full-corpus retrieval is heavy IO; the 5s default went false-red under
    // larger suite parallelism (Phase 3 suite additions), not under any change.
    resetDatasetCache();
    const report = await inspectQuery("做汽车座椅的公司", { mode: "retrieval", expect: ["603085", "603997"] });
    expect(report.identity.corpusActive).toBe(true);
    expect(report.identity.corpusContentDigest16).toBeTruthy();
    expect(report.identity.retrievalVersion).toBe("v3-rrf60-corpus");
    expect(report.query.spec.must).toContain("座椅");
    expect(report.retrieval.candidates.length).toBeGreaterThan(0);
    expect(report.retrieval.candidates.length).toBeLessThanOrEqual(50);
    expect(report.retrieval.candidates[0].rrfScore).toBeGreaterThanOrEqual(report.retrieval.candidates[1].rrfScore);
    expect(report.final.rankingSource).toBe("rrf_order");
    expect(report.evidence.length).toBe(report.retrieval.candidates.length);
    expect(report.traces).toHaveLength(2);
    for (const trace of report.traces) {
      expect(trace.inDataset).toBe(true);
      expect(trace.verdict.stage).toBeTruthy();
      expect(trace.verdict.detail).toBeTruthy();
    }
    const seatTrace = report.traces.find((t) => t.code === "603085");
    expect(seatTrace?.inCandidatePool).toBe(true);
    expect(seatTrace?.textTermHits).toContain("座椅");
  });

  it("is deterministic under fixed inputs", async () => {
    resetDatasetCache();
    const first = await inspectQuery("做存储芯片的公司", { mode: "retrieval" });
    resetDatasetCache();
    const second = await inspectQuery("做存储芯片的公司", { mode: "retrieval" });
    const codesOf = (report: Awaited<ReturnType<typeof inspectQuery>>) => report.retrieval.candidates.map((c) => c.code);
    expect(codesOf(first)).toEqual(codesOf(second));
    expect(first.final.ranking.map((r) => r.code)).toEqual(second.final.ranking.map((r) => r.code));
  });

  it("propagates the corpus digest into the identity block", async () => {
    resetDatasetCache();
    const manifest = loadJson("data/company-corpus/manifest.json") as { contentDigest: { value: string } };
    const report = await inspectQuery("谐波减速器", { mode: "retrieval" });
    expect(report.identity.corpusContentDigest16).toBe(manifest.contentDigest.value.slice(0, 16));
  });
});

describe("retired stack regression", () => {
  it("no Vibe / :8910 references in discovery evaluation code", () => {
    const files = [
      "lib/discovery/inspector.ts",
      "lib/discovery/failureTaxonomy.ts",
      "lib/discovery/benchmark.ts",
      "scripts/discovery_inspect.ts",
      "scripts/discovery_benchmark.ts",
      "scripts/build_expected_evidence.ts",
    ];
    for (const file of files) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(/vibe|8910|backtest|watchlist/i.test(text), `${file} clean of retired-stack vocabulary`).toBe(false);
    }
  });
});
