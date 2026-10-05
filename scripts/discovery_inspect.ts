import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "./load-env";
import { resetDatasetCache } from "../lib/companies";
import { inspectQuery } from "../lib/discovery/inspector";

/**
 * Discovery Inspector CLI (DEV-only).
 *
 * npx tsx scripts/discovery_inspect.ts "<query>" [--expect 603085,603997] [--retrieval] [--json out.json]
 */

function section(title: string): void {
  console.log(`\n== ${title} ` + "=".repeat(Math.max(4, 66 - title.length * 2)));
}

async function main() {
  loadLocalEnv();
  resetDatasetCache();
  const argv = process.argv.slice(2);
  const query = argv.find((a) => !a.startsWith("--"));
  if (!query) {
    console.error('usage: npx tsx scripts/discovery_inspect.ts "<query>" [--expect 603085,603997] [--retrieval] [--json out.json]');
    process.exit(1);
  }
  const expectAt = process.argv.indexOf("--expect");
  const expect = expectAt > 0 ? (process.argv[expectAt + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const jsonAt = process.argv.indexOf("--json");
  const jsonArg = jsonAt > 0 ? process.argv[jsonAt + 1] : undefined;
  const mode = process.argv.includes("--retrieval") ? "retrieval" as const : "jev" as const;

  const report = await inspectQuery(query, { mode, expect });

  section("Query");
  console.log(`raw        : ${report.query.raw}`);
  console.log(`normalized : ${report.query.normalized}`);
  console.log(`spec       : must=${JSON.stringify(report.query.spec.must)} expansions=${report.query.spec.expansionTerms.length} exclusions=${JSON.stringify(report.query.spec.exclusions)} concepts=${JSON.stringify(report.query.spec.concepts)} attrs=${JSON.stringify(report.query.spec.attrs)}`);

  section("Identity");
  const id = report.identity;
  console.log(`corpus     : ${id.corpusActive ? `ACTIVE schema=${id.corpusSchemaVersion} digest=${id.corpusContentDigest16}` : "FALLBACK legacy profile layer"}`);
  console.log(`retrieval  : ${id.retrievalVersion} | dataset=${id.datasetVersion} | n=${id.companyCount}`);
  console.log(`ontology=${id.ontologyVersion} embedding=${id.embeddingModel ?? "?"}`);
  console.log(`judge      : expected=${id.judgeModelExpected ?? "-"} actual=${id.judgeModelActual ?? "-"} git=${(id.gitHead ?? "").slice(0, 10)}`);
  console.log(`mode       : ${report.mode} | totalMs=${report.timings.totalMs} retrievalMs=${report.retrieval.timings.retrievalMs} judgeMs=${report.judge.ms ?? "-"}`);

  section(`Candidates (Top-50 of pool ${report.retrieval.poolSize}; bm25=${report.retrieval.bm25TopN} vector=${report.retrieval.vectorTopN} hardFilterDropped=${report.retrieval.droppedByHardFilter})`);
  for (const c of report.retrieval.candidates) {
    const ch = c.channels.join("+") || "-";
    console.log(
      `#${String(c.rank).padStart(3)} ${c.code} ${c.name.padEnd(6, "　")} rrf=${c.rrfScore.toFixed(5)} [${ch}]` +
        (c.bm25Rank != null ? ` bm25#${c.bm25Rank}=${c.bm25Score?.toFixed(3)}` : "") +
        (c.vectorRank != null ? ` vec#${c.vectorRank}=${c.vectorScore?.toFixed(4)}` : "") +
        (c.judgeScore != null ? ` jev=${c.judgeScore.toFixed(3)}` : ""),
    );
  }

  section("Jev");
  console.log(`decidedBy=${report.judge.decidedBy} degraded=${report.judge.degraded} outcome=${report.judge.outcome ?? "-"} tokens=${report.judge.tokens} chunks=${report.judge.chunks}/${report.judge.answeredChunks} scored=${report.judge.scoredCandidates}`);

  section(`Final ranking (${report.final.rankingSource}; matches=${report.fusion.matches} threshold=${report.fusion.shownThreshold})`);
  for (const row of report.final.ranking.slice(0, 15)) {
    console.log(`#${String(row.rank).padStart(3)} ${row.code} ${row.name.padEnd(6, "　")} p=${row.probability.toFixed(2)}${row.jevScore != null ? ` jev=${row.jevScore.toFixed(3)}` : ""}${row.inMatches ? "" : "  (below matches cut)"}`);
  }

  section("Traces (expected symbols)");
  for (const t of report.traces) {
    if (!t.inDataset) {
      console.log(`✗ ${t.code} — 不在数据集中 → ${t.verdict.category} ${t.verdict.detail}`);
      continue;
    }
    console.log(`${t.finalRank != null && t.inMatches ? "✓" : "✗"} ${t.code} ${t.name}`);
    console.log(`   corpus词面命中: ${t.textTermHits.join("、") || "无"} | 结构化字段命中: ${t.structuredTermHits.join("、") || "无"}${t.evidenceSnippets.length ? ` | 「${t.evidenceSnippets[0]}」` : ""}`);
    console.log(`   pool=${t.inCandidatePool ? `#${t.poolRank}` : "未进"}${t.bm25Rank != null ? ` bm25#${t.bm25Rank}` : ""}${t.vectorRank != null ? ` vec#${t.vectorRank}` : ""}${t.standaloneVectorScore != null ? ` standaloneVec=${t.standaloneVectorScore}` : ""} judge=${t.judgeScore?.toFixed(3) ?? "-"} final=${t.finalRank ?? "-"}${t.zeroReason ? ` zeroed=${t.zeroReason}` : ""}`);
    console.log(`   → ${t.verdict.category ?? "-"} ${t.verdict.detail}`);
  }

  if (report.fusion.zeroed.length) {
    section(`Zeroed by constraints (${report.fusion.zeroed.length})`);
    for (const z of report.fusion.zeroed.slice(0, 10)) console.log(`${z.code} ${z.name} — ${z.reason}`);
  }
  if (report.retrieval.hardFilterExcluded.length) {
    section(`Hard-filter exclusions (${report.retrieval.hardFilterExcluded.length})`);
    for (const e of report.retrieval.hardFilterExcluded.slice(0, 10)) console.log(`${e.code} ${e.name} — ${e.reason}`);
  }

  if (jsonArg && jsonArg !== "--json") {
    writeFileSync(path.join(process.cwd(), jsonArg), JSON.stringify(report, null, 1) + "\n", "utf8");
    console.log(`\nwrote ${jsonArg}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
