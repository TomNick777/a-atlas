import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadLocalEnv } from "./load-env";
import { loadDataset, resetDatasetCache } from "../lib/companies";
import { runSearch } from "../lib/search/pipeline";
import { parseQuerySpec } from "../lib/search/querySpec";
import { tokensOf } from "../lib/text/tokenize";

/**
 * Phase 2 corpus discovery evaluation.
 *
 * 6 道上一阶段真实 Jev 回归题（reports/REFOCUS/search_regression.json 的原题）
 * + 10 道新 discovery 质量题（Phase 2 规格 §12）。每题记录：
 * decidedBy / degraded / judgeModel / top10 / 匹配 corpus 证据 / 延迟。
 * 质量观察用，不做断言（不硬编码唯一正确答案）。
 *
 * Usage: npx tsx scripts/corpus_discovery_eval.ts --out reports/PHASE2_CORPUS/<name>.json [--label baseline]
 */

const REGRESSION_QUERIES = [
  // 与 reports/REFOCUS/search_regression.json 同题（Refocus §I 六题）
  "光刻胶",
  "谐波减速器",
  "机器人",
  "半导体设备",
  "热管理",
  "给AI数据中心做散液的液冷公司，但不要纯软件",
];

const NEW_QUERIES = [
  "做工业机器视觉的公司",
  "做汽车座椅的公司",
  "主营宠物食品的公司",
  "做煤矿智能化设备的公司",
  "做工业机器人的公司",
  "做存储芯片相关产品的公司",
  "做黄金珠宝零售的公司",
  "给电网提供数字化设备的公司",
  "做新能源汽车零部件的公司",
  "主营医疗器械的公司",
];

function corpusDigest16(): string | null {
  const file = path.join(process.cwd(), "data", "company-corpus", "companies.jsonl");
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

function evidenceOf(query: string, text: string): { queryTerms: string[]; mustTerms: string[] } {
  const terms = [...new Set(tokensOf(query))].filter((term) => text.includes(term));
  const must = parseQuerySpec(query).must.filter((term) => text.includes(term));
  return { queryTerms: terms.slice(0, 12), mustTerms: must };
}

async function main() {
  loadLocalEnv();
  resetDatasetCache();
  const outArg = process.argv[process.argv.indexOf("--out") + 1];
  if (!outArg) {
    console.error("--out <path> required");
    process.exit(1);
  }
  const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "run";
  const { companies } = loadDataset();
  const byCode = new Map(companies.map((company) => [company.code, company]));

  // Warmup: model load + first cloud call; excluded from latency stats.
  await runSearch("做连接器的公司", { origin: "benchmark" });

  const rows: unknown[] = [];
  for (const query of [...REGRESSION_QUERIES, ...NEW_QUERIES]) {
    const started = performance.now();
    const result = await runSearch(query, { origin: "benchmark" });
    const ms = Math.round(performance.now() - started);
    const top10 = result.hits.slice(0, 10).map((hit, rank) => {
      const company = byCode.get(hit.code);
      return {
        rank: rank + 1,
        code: hit.code,
        name: hit.name,
        score: hit.probability,
        evidence: company ? evidenceOf(query, company.searchProfileText || company.judgeText) : null,
      };
    });
    rows.push({
      suite: REGRESSION_QUERIES.includes(query) ? "regression" : "new",
      query,
      decidedBy: result.decidedBy,
      degraded: result.degraded,
      judge: result.judge,
      tokens: result.tokens,
      costUsd: result.costUsd,
      ms,
      matches: result.matches,
      top10,
    });
    const top = top10[0];
    console.log(`[${label}] ${result.decidedBy}${result.degraded ? "/DEGRADED" : ""} ${ms}ms  ${query} -> ${top ? `${top.name}(${top.code})` : "（空）"}`);
  }

  const regression = rows.filter((row) => (row as { suite: string }).suite === "regression") as Array<{ ms: number }>;
  const fresh = rows.filter((row) => (row as { suite: string }).suite === "new") as Array<{ ms: number }>;
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  };
  const report = {
    label,
    generatedAt: new Date().toISOString(),
    gitHead: process.env.GIT_HEAD_OVERRIDE ?? null,
    companyCount: companies.length,
    corpusContentDigest16: corpusDigest16(),
    regressionQueries: REGRESSION_QUERIES.length,
    newQueries: NEW_QUERIES.length,
    latencyMs: { regressionMedian: median(regression.map((row) => row.ms)), newMedian: median(fresh.map((row) => row.ms)) },
    rows,
  };
  mkdirSync(path.dirname(path.join(process.cwd(), outArg)), { recursive: true });
  writeFileSync(path.join(process.cwd(), outArg), JSON.stringify(report, null, 1) + "\n", "utf8");
  console.log(`wrote ${outArg}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
