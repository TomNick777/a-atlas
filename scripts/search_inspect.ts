import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getSearchRun } from "../lib/search/log";

/**
 * Replay one historical search (规格第十六/二十六节):
 *   npm run search:inspect -- <searchId> [--company <code>] [--knowledge N]
 *
 * 版本块之后:若该次搜索的 profile 带 Stage 3 半导体 enrichment,则对 Top-N 里
 * 的 enrichment 公司(或 --company 指定的公司)显示知识链——
 *   为什么召回(工艺标签) → 知识来源(年报+页码) → DERIVED(process/equipment)
 *   → BM25/vector/Laya 逐层分数。人工验收无需翻库。
 */

type EnrichmentRecord = {
  code: string;
  level: string;
  manufacturingStages: string[];
  processCapabilities: {
    process?: string;
    specificProcess?: string;
    equipmentType?: string;
    materialType?: string;
    componentType?: string;
    role: string;
    evidenceIds: string[];
    ruleId: string;
    status: string;
    attribution?: string;
    evidenceQuality?: string;
    processExposure?: string[];
  }[];
  equipmentTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  materialTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  componentTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  retrievalLabels: string[];
  attributionLedger?: { process?: string; specificProcess?: string; equipmentType?: string; attribution: string; evidenceIds: string[]; ruleId: string }[];
};

type EvidenceRecord = {
  evidenceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceDate: string;
  documentSha256?: string;
  locator: { page?: number; section?: string; field?: string; period?: string };
  evidenceText: string;
  authorityTier: number;
  status: string;
  asOfDate: string;
};

function loadKnowledge(): { byCode: Map<string, EnrichmentRecord>; evidence: Map<string, EvidenceRecord> } | null {
  const dir = path.join(process.cwd(), "data", "enrichment", "semiconductor");
  if (!existsSync(path.join(dir, "enrichment.json"))) return null;
  const records = (JSON.parse(readFileSync(path.join(dir, "enrichment.json"), "utf8")).records ?? []) as EnrichmentRecord[];
  const byCode = new Map(records.map((r) => [r.code, r]));
  const evidence = new Map<string, EvidenceRecord>();
  if (existsSync(path.join(dir, "evidence.json"))) {
    for (const e of (JSON.parse(readFileSync(path.join(dir, "evidence.json"), "utf8")).evidence ?? []) as EvidenceRecord[]) {
      evidence.set(e.evidenceId, e);
    }
  }
  return { byCode, evidence };
}

async function main() {
  const args = process.argv.slice(2);
  const searchId = args[0];
  const companyArgIdx = args.indexOf("--company");
  const companyArg = companyArgIdx >= 0 ? args[companyArgIdx + 1] : null;
  const knowledgeN = args.includes("--knowledge") ? Number(args[args.indexOf("--knowledge") + 1]) || 5 : 5;
  if (!searchId) {
    console.error("usage: npm run search:inspect -- <searchId> [--company <code>] [--knowledge N]");
    process.exit(1);
  }
  const run = await getSearchRun(searchId);
  if (!run) {
    console.error(`no such searchId: ${searchId}`);
    process.exit(1);
  }

  const v = run.versions;
  console.log(`searchId   ${run.searchId}`);
  console.log(`timestamp  ${run.timestamp}`);
  console.log(`query      ${run.query.raw}${run.cached ? "  (cached replay)" : ""}`);
  console.log(`querySpec  concepts=[${run.query.querySpec.concepts.join("、")}] must=[${run.query.querySpec.must.join("、")}] expansions=${run.query.querySpec.expansionTerms.length} exclusions=[${run.query.querySpec.exclusions.join("、")}] attrs=${JSON.stringify(run.query.querySpec.attrs)}`);
  console.log(
    `versions   edition=${v.profileEdition} profile=${v.searchProfileVersion} ontology=${v.ontologyVersion} ` +
    `semiEnrichment=${v.semiconductorEnrichmentVersion ?? "-"} sources=${v.sourceSnapshotId ? v.sourceSnapshotId.slice(0, 8) : "-"} ` +
    `retrieval=${v.retrievalVersion} reranker=${v.rerankerModel} git=${(v.gitHead ?? "n/a").slice(0, 8)} dataset=${v.companyDatasetSha16}`,
  );
  console.log(`timing     parse=${run.timing.queryParseMs}ms retrieval=${run.timing.retrievalMs}ms rerank=${run.timing.rerankMs}ms total=${run.timing.totalMs}ms`);
  console.log(`pool       ${run.retrieval.poolSize} candidates; hard-filter excluded ${run.retrieval.excludedByHardFilter.length}`);
  console.log("");
  console.log("Top-200 candidate pool (rrf order):");
  console.log("rank | code   | name         | bm25(r/s)  | vec(r/s)   | rrf  | grade | score | excl");
  for (const row of run.candidates) {
    const top20Cut = row.rank <= 20 ? "*" : " ";
    console.log(
      `${String(row.rank).padStart(3)}${top20Cut} | ${row.code} | ${row.name.padEnd(10)} | ` +
      `${pad(row.retrieval.bm25Rank)}/${padScore(row.retrieval.bm25Score)} | ` +
      `${pad(row.retrieval.vectorRank)}/${padScore(row.retrieval.vectorScore)} | ` +
      `${padScore(row.retrieval.rrfScore, 5)} | ` +
      `${row.reranker?.grade ?? "-"} | ${padScore(row.reranker?.score, 5)} | ` +
      `${row.queryMatch.matchedExclusion.join(",") || ""}${row.queryMatch.zeroReason ? ` zero:${row.queryMatch.zeroReason}` : ""}`,
    );
  }
  console.log("");
  console.log(`Top-20 shown (${run.result.matches} above threshold):`);
  for (const row of run.result.top20) {
    console.log(`  ${row.rank}. ${row.name} (${row.code}) 匹配度 ${Math.round(row.score * 100)}%`);
  }

  // ---- Stage 3 knowledge provenance(规格第二十六节) ----
  const knowledge = loadKnowledge();
  if (!knowledge) return;
  const focus = companyArg
    ? run.candidates.filter((row) => row.code === companyArg)
    : run.result.top20.slice(0, knowledgeN).map((row) => run.candidates.find((c) => c.code === row.code)).filter(Boolean);
  const withKnowledge = focus.filter((row) => knowledge.byCode.has(row!.code));
  if (!withKnowledge.length) return;
  console.log("");
  console.log("Stage 3 knowledge provenance (semiconductor enrichment):");
  for (const row of withKnowledge) {
    const record = knowledge.byCode.get(row!.code)!;
    console.log(`  ── ${row!.name}(${row!.code}) level=${record.level} 检索rank=${row!.rank} bm25#${row!.retrieval.bm25Rank ?? "-"} vec#${row!.retrieval.vectorRank ?? "-"} laya=${row!.reranker ? `${row!.reranker.grade}/3` : "-"}`);
    console.log(`     为什么召回: ${(record.retrievalLabels || []).join("、") || "(无标签)"}`);
    console.log(`     环节: [${(record.manufacturingStages || []).join(", ")}]`);
    for (const cap of (record.processCapabilities || []).slice(0, 6)) {
      const what = [cap.process, cap.specificProcess, cap.equipmentType, cap.materialType, cap.componentType].filter(Boolean).join("/");
      const attr = cap.attribution ?? "DIRECT_COMPANY_CAPABILITY";
      const quality = cap.evidenceQuality ? ` quality=${cap.evidenceQuality}` : "";
      const exposure = cap.processExposure?.length ? ` processExposure=[${cap.processExposure.join("、")}]` : "";
      console.log(`     Derived: ${what} role=${cap.role} status=${cap.status}${quality} rule=${cap.ruleId}`);
      console.log(`     Attribution: ${attr}${exposure}`);
    }
    // §30:受测工艺曝光与被改释的归属 —— 「检测范围 ≠ 自有能力」显式可见
    const exposureCaps = (record.processCapabilities || []).filter((c) => c.processExposure?.length);
    for (const cap of exposureCaps.slice(0, 3)) {
      for (const p of cap.processExposure!.slice(0, 4)) {
        console.log(`     Capability: ${[cap.equipmentType].filter(Boolean).join("/") || cap.process} × ${p}: PROCESS_EXPOSURE — 不作为自有工艺设备能力参与检索`);
      }
    }
    const ledger = (record.attributionLedger ?? []).filter((l) => !["AMBIGUOUS", "PROCESS_EXPOSURE"].includes(l.attribution) && (l.equipmentType || l.specificProcess)).slice(0, 4);
    for (const l of ledger) {
      const what = [l.process, l.specificProcess, l.equipmentType].filter(Boolean).join("/");
      const ev0 = l.evidenceIds[0] ? knowledge.evidence.get(l.evidenceIds[0]) : undefined;
      const locator = ev0 ? [ev0.locator.page ? `p.${ev0.locator.page}` : ev0.locator.field, ev0.locator.section].filter(Boolean).join(" ") : "";
      console.log(`     改释: ${what}: ${l.attribution}${ev0 ? ` — 「${ev0.evidenceText.slice(0, 60)}…」(${locator})` : ""}`);
      console.log(`       Not searchable as owned equipment capability`);
    }
    const evidenceIds = [...new Set((record.processCapabilities || []).flatMap((c) => c.evidenceIds))].slice(0, 3);
    for (const id of evidenceIds) {
      const e = knowledge.evidence.get(id);
      if (!e) continue;
      const locator = [e.locator.page ? `p.${e.locator.page}` : e.locator.field, e.locator.section].filter(Boolean).join(" ");
      console.log(`     知识来源: [T${e.authorityTier} ${e.sourceType}] ${e.sourceTitle} ${locator} (${e.sourceDate}, sha${(e.documentSha256 ?? "").slice(0, 8)})`);
      console.log(`       「${e.evidenceText.slice(0, 110)}${e.evidenceText.length > 110 ? "…" : ""}」`);
    }
  }
}

const pad = (n: number | null) => (n == null ? "-" : String(n));
const padScore = (n: number | null | undefined, width = 5) => (n == null ? "-".padEnd(width) : n.toFixed(3).padEnd(width));

main();
