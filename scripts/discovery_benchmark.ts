import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "./load-env";
import { resetDatasetCache } from "../lib/companies";
import { inspectQuery, corpusDigest16OnDisk } from "../lib/discovery/inspector";
import { parseBenchmark, type BenchmarkCase } from "../lib/discovery/benchmark";

/**
 * Discovery Benchmark runner (Phase 3, baseline & re-evaluation).
 *
 * Runs the frozen benchmark (evaluation/discovery/benchmark.v1.json) through the
 * Discovery Inspector — one real production-path search per case, with candidate
 * pool, judge scores and per-symbol traces captured. Computes Strong/Acceptable
 * recall, candidate recall, exclusion violations and mechanical failure hints.
 * Writes per-case results + aggregates; never mutates the benchmark.
 *
 * Usage:
 *   npx tsx scripts/discovery_benchmark.ts --out reports/PHASE3_DISCOVERY_BASELINE/baseline.json [--label baseline]
 *   [--ids A03,F01]  (subset for debugging)  [--mode retrieval]  (no judge)
 */

  const benchmarkPath = path.join(process.cwd(), "evaluation", "discovery", "benchmark.v1.json");
  const benchmark = parseBenchmark(JSON.parse(readFileSync(benchmarkPath, "utf8")));

const RETRIES = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  loadLocalEnv();
  resetDatasetCache();
  const outArg = process.argv[process.argv.indexOf("--out") + 1];
  if (!outArg) {
    console.error("--out <path> required");
    process.exit(1);
  }
  const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "run";
  const idsAt = process.argv.indexOf("--ids");
  const onlyIds = idsAt > 0 ? new Set((process.argv[idsAt + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const mode = process.argv.includes("--mode") && process.argv[process.argv.indexOf("--mode") + 1] === "retrieval" ? "retrieval" as const : "jev" as const;

  const benchmarkPath = path.join(process.cwd(), "evaluation", "discovery", "benchmark.v1.json");
  const benchmark = parseBenchmark(JSON.parse(readFileSync(benchmarkPath, "utf8")));
  const evidencePath = path.join(process.cwd(), "evaluation", "discovery", "expected-evidence.json");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
    corpusContentDigest16: string;
    cases: Record<string, Record<string, { role: string; corpusVerified: boolean }>>;
  };

  const digest = corpusDigest16OnDisk();
  if (evidence.corpusContentDigest16 !== digest) {
    console.error(`corpus digest drift: expected-evidence pinned ${evidence.corpusContentDigest16}, on-disk ${digest}. Refusing to run against a different corpus.`);
    process.exit(2);
  }

  const cases = benchmark.cases.filter((c) => !onlyIds || onlyIds.has(c.id));
  if (!cases.length) {
    console.error("no cases selected");
    process.exit(1);
  }

  // Warmup: embedding model load + BM25 index build + one cloud call.
  const warm = await inspectQuery("做连接器的公司", { mode });
  const identity = { ...warm.identity, corpusDigest16OnDisk: digest, benchmarkVersion: benchmark.benchmarkVersion };

  const rows: Array<Record<string, unknown>> = [];
  const started = performance.now();
  for (const kase of cases) {
    const expected = kase.expected ?? {};
    const strong = expected.strongMatches ?? [];
    const acceptable = expected.acceptableMatches ?? [];
    const exclusions = expected.exclusions ?? [];
    const expectSymbols = [...new Set([...strong, ...acceptable])];

    let report = await inspectQuery(kase.query, { mode, expect: expectSymbols });
    // Cloud hiccups are operational, not findings: retry a degraded judgement.
    for (let attempt = 1; attempt <= RETRIES && report.judge.degraded && mode === "jev"; attempt++) {
      console.log(`  [${kase.id}] degraded (${report.judge.outcome}), retry ${attempt}/${RETRIES}`);
      await sleep(1500 * attempt);
      report = await inspectQuery(kase.query, { mode, expect: expectSymbols });
    }

    const top10 = report.final.ranking.slice(0, 10);
    const top10Codes = top10.map((r) => r.code);
    const strongRanks = strong.map((code) => top10Codes.indexOf(code) + 1).filter((r) => r > 0);
    const acceptableRanks = [...strong, ...acceptable].map((code) => top10Codes.indexOf(code) + 1).filter((r) => r > 0);
    const violatedExclusions = exclusions.filter((code) => top10Codes.includes(code));
    const poolCodes = new Set(report.retrieval.candidates.map((c) => c.code));
    const strongInPool = strong.filter((code) => poolCodes.has(code));

    // Every expected symbol that did not make Top10 is a hint worth recording —
    // whether it was lost before the pool (F1/F2/F4), at the judge (F5), inside
    // matches but ranked 11+ (F6), or zeroed by a constraint (F7).
    const traceHints = report.traces.filter(
      (t) => !t.inDataset || !t.inMatches || (t.finalRank != null && t.finalRank > 10),
    );
    const evidenceByCase = evidence.cases[kase.id] ?? {};
    const unverifiedExpected = expectSymbols.filter((code) => evidenceByCase[code] && !evidenceByCase[code].corpusVerified);

    rows.push({
      id: kase.id,
      category: kase.category,
      query: kase.query,
      noUniqueAnswer: Boolean(kase.noUniqueAnswer),
      decidedBy: report.judge.decidedBy,
      degraded: report.judge.degraded,
      judgeOutcome: report.judge.outcome,
      judgeModel: report.identity.judgeModelActual,
      ms: report.timings.totalMs,
      judgeMs: report.judge.ms,
      matches: report.fusion.matches,
      poolSize: report.retrieval.poolSize,
      top10: top10.map((r, at) => ({
        rank: at + 1,
        code: r.code,
        name: r.name,
        probability: r.probability,
        jevScore: r.jevScore,
        evidenceTerms: report.evidence.find((e) => e.code === r.code)?.matchedTerms ?? [],
      })),
      metric: {
        strongTop1: strongRanks.includes(1),
        strongTop5: strongRanks.some((r) => r <= 5),
        strongTop10: strongRanks.some((r) => r <= 10),
        expectedTop10: acceptableRanks.some((r) => r <= 10),
        strongRanks,
        acceptableRanks,
        strongInPool50: strongInPool.length,
        strongExpected: strong.length,
        violatedExclusions,
      },
      failureHints: traceHints.map((t) => ({ code: t.code, name: t.name, category: t.verdict.category, stage: t.verdict.stage, detail: t.verdict.detail })),
      unverifiedExpected,
      notes: kase.notes ?? null,
    });
    const top1 = top10[0];
    const status = report.judge.degraded ? "DEGRADED" : kase.noUniqueAnswer ? "RUBRIC" : `${strongRanks[0] ? `strong@${strongRanks[0]}` : strong.length ? "MISS" : "n/a"}`;
    console.log(`[${kase.id}] ${status} ${report.timings.totalMs}ms  ${kase.query} -> ${top1 ? `${top1.name}(${top1.code})` : "（空）"}${violatedExclusions.length ? `  ⚠exclusion-violated:${violatedExclusions.join(",")}` : ""}`);
  }

  const graded = rows.filter((row) => !(row as { noUniqueAnswer: boolean }).noUniqueAnswer);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const strongCount = graded.filter((row) => (row as { metric: { strongExpected: number } }).metric.strongExpected > 0).length;
  const agg = {
    cases: rows.length,
    gradedCases: graded.length,
    rubricCases: rows.length - graded.length,
    strongRecallTop1: pct(graded.filter((row) => (row as { metric: { strongTop1: boolean } }).metric.strongTop1).length, strongCount),
    strongRecallTop5: pct(graded.filter((row) => (row as { metric: { strongTop5: boolean } }).metric.strongTop5).length, strongCount),
    strongRecallTop10: pct(graded.filter((row) => (row as { metric: { strongTop10: boolean } }).metric.strongTop10).length, strongCount),
    expectedRecallTop10: pct(graded.filter((row) => (row as { metric: { expectedTop10: boolean } }).metric.expectedTop10).length, graded.length),
    exclusionViolations: rows.reduce((sum, row) => sum + (row as { metric: { violatedExclusions: string[] } }).metric.violatedExclusions.length, 0),
    degradedRuns: rows.filter((row) => (row as { degraded: boolean }).degraded).length,
    medianMs: (() => {
      const values = rows.map((row) => (row as { ms: number }).ms).sort((a, b) => a - b);
      return values.length ? values[Math.floor(values.length / 2)] : null;
    })(),
  };

  const first = rows[0] as { judgeModel?: string | null } | undefined;
  const report = {
    label,
    generatedAt: new Date().toISOString(),
    benchmarkVersion: benchmark.benchmarkVersion,
    mode,
    corpusContentDigest16: digest,
    identity,
    totals: {
      wallMs: Math.round(performance.now() - started),
      judgeModelSeen: first?.judgeModel ?? null,
    },
    aggregates: agg,
    rows,
  };
  mkdirSync(path.dirname(path.join(process.cwd(), outArg)), { recursive: true });
  writeFileSync(path.join(process.cwd(), outArg), JSON.stringify(report, null, 1) + "\n", "utf8");
  console.log(`\n${label}: ${agg.cases} cases (${agg.gradedCases} graded, ${agg.rubricCases} rubric)`);
  console.log(`StrongRecall@1=${agg.strongRecallTop1}% @5=${agg.strongRecallTop5}% @10=${agg.strongRecallTop10}% | Expected@10=${agg.expectedRecallTop10}% | exclusionViolations=${agg.exclusionViolations} | degraded=${agg.degradedRuns} | medianMs=${agg.medianMs}`);
  console.log(`wrote ${outArg}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
