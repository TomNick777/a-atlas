import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listSearchRuns } from "../lib/search/log";
import { CONCEPT_GROUPS } from "../search/ontology/concepts";

/**
 * Offline search-health analysis (规格第二十二/二十三节). Reads the append-only
 * log and classifies failures:
 *   Repeat Offender  — same company saturates Top-20 across unrelated queries
 *   Score Collapse   — Top-20 graded spread too small to trust
 *   Exclusion Failure — a candidate whose own text matches the query's exclusion still reached Top-20
 *   KNOWLEDGE_GAP    — query opened concept groups but candidate texts never name
 *                      any group term → PROFILE_GAP / ONTOLOGY_GAP, NOT a rerank bug
 *   Ranking Failure  — concept-term-bearing candidates present in Top-200 but below Top-20
 * Writes reports/search-health/search_health_YYYYMMDD.{json,md}.
 */

type Finding = {
  type: string;
  searchId?: string;
  query?: string;
  detail: string;
  codes?: string[];
};

async function main() {
  const runs = await listSearchRuns();
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const findings: Finding[] = [];
  const real = runs.filter((r) => !r.cached && !r.versions.degraded);

  // Repeat Offender: company in Top-20 of many distinct queries with weak grades.
  const perCompany = new Map<string, { name: string; queries: Set<string>; gradeSum: number; gradeN: number; queriesLow: Set<string> }>();
  for (const run of real) {
    const byCode = new Map(run.candidates.map((c) => [c.code, c]));
    for (const top of run.result.top20) {
      const row = byCode.get(top.code);
      let entry = perCompany.get(top.code);
      if (!entry) perCompany.set(top.code, (entry = { name: top.name, queries: new Set(), gradeSum: 0, gradeN: 0, queriesLow: new Set() }));
      entry.queries.add(run.query.raw);
      if (row?.reranker?.grade != null) {
        entry.gradeSum += row.reranker.grade;
        entry.gradeN += 1;
        if (row.reranker.grade <= 1) entry.queriesLow.add(run.query.raw);
      }
    }
  }
  for (const [code, entry] of perCompany) {
    const meanGrade = entry.gradeN ? entry.gradeSum / entry.gradeN : null;
    if (entry.queries.size >= 5 && meanGrade != null && meanGrade < 1.5) {
      findings.push({
        type: "REPEAT_OFFENDER",
        detail: `${entry.name}(${code}) 进入 ${entry.queries.size} 个不同 query 的 Top-20,平均 grade ${meanGrade.toFixed(2)}(≤1.5)`,
        codes: [code],
      });
    }
  }

  for (const run of real) {
    const byCode = new Map(run.candidates.map((c) => [c.code, c]));
    const graded = run.result.top20.map((t) => byCode.get(t.code)?.reranker?.grade).filter((g): g is number => g != null);

    // Score Collapse
    if (graded.length >= 5 && Math.max(...graded) - Math.min(...graded) < 0.34) {
      findings.push({
        type: "SCORE_COLLAPSE",
        searchId: run.searchId,
        query: run.query.raw,
        detail: `Top-20 grade spread ${(Math.max(...graded) - Math.min(...graded)).toFixed(2)} < 0.34,排序不可信`,
      });
    }

    // Exclusion Failure: exclusion patterns matched but company still displayed.
    for (const top of run.result.top20) {
      const row = byCode.get(top.code);
      if (row?.queryMatch.matchedExclusion.length) {
        findings.push({
          type: "EXCLUSION_FAILURE",
          searchId: run.searchId,
          query: run.query.raw,
          detail: `${top.name}(${top.code}) 命中排除类 [${row.queryMatch.matchedExclusion.join("、")}] 仍进入 Top-20(fuse 已清零则不会出现;出现说明排序阈值路径异常)`,
          codes: [top.code],
        });
      }
    }

    // Knowledge Gap / Ranking Failure: concept groups opened by the query.
    const terms = run.query.querySpec.concepts.flatMap((c) => CONCEPT_GROUPS[c] ?? []);
    // matchedMust is only populated when the query itself names ontology terms
    // (spec.must); without must terms the per-company matcher has no signal, so
    // skip the gap analysis instead of reporting a false PROFILE_GAP.
    if (terms.length && run.query.querySpec.must.length && run.candidates.length) {
      const poolWithTerms = run.candidates.filter((c) => c.queryMatch.matchedMust.length).length;
      if (poolWithTerms === 0) {
        findings.push({
          type: "KNOWLEDGE_GAP:PROFILE_GAP",
          searchId: run.searchId,
          query: run.query.raw,
          detail: `Query 打开概念组 [${run.query.querySpec.concepts.join("、")}](${terms.length} 词),但 Top-200 无一家被 must 词命中——词面/知识双重缺口,不是 rerank 的错`,
        });
      } else {
        const inTop20 = run.result.top20.filter((t) => byCode.get(t.code)?.queryMatch.matchedMust.length).length;
        if (inTop20 === 0) {
          findings.push({
            type: "RANKING_FAILURE",
            searchId: run.searchId,
            query: run.query.raw,
            detail: `${poolWithTerms} 家候选含概念词但无一进入 Top-20`,
          });
        }
      }
    }
  }

  const dir = path.join(process.cwd(), "reports", "search-health");
  mkdirSync(dir, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    runsAnalyzed: runs.length,
    realRuns: real.length,
    findingCounts: findings.reduce<Record<string, number>>((acc, f) => ((acc[f.type] = (acc[f.type] ?? 0) + 1), acc), {}),
    findings,
  };
  writeFileSync(path.join(dir, `search_health_${date}.json`), JSON.stringify(summary, null, 1));

  const lines = [
    `# Search Health ${date}`,
    "",
    `分析 ${real.length} 条真实搜索(共 ${runs.length} 条含缓存)。发现 ${findings.length} 项:`,
    "",
  ];
  for (const [type, n] of Object.entries(summary.findingCounts)) lines.push(`- ${type}: ${n}`);
  lines.push("");
  for (const f of findings.slice(0, 80)) {
    lines.push(`- **${f.type}** ${f.query ? `「${f.query}」` : ""}${f.detail}`);
  }
  writeFileSync(path.join(dir, `search_health_${date}.md`), lines.join("\n") + "\n");

  console.log(`runs analyzed: ${real.length} real / ${runs.length} total`);
  for (const [type, n] of Object.entries(summary.findingCounts)) console.log(`  ${type}: ${n}`);
  console.log(`wrote reports/search-health/search_health_${date}.{json,md}`);
}

main();
