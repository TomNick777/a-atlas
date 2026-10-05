import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadDataset } from "../lib/companies";
import { retrieveV3 } from "../lib/search/v3";
import { judgeGraded } from "../lib/jev/judge";
import { requireLayaLane } from "./require-laya-lane";

requireLayaLane("residual_triage.ts");


/**
 * Residual Failure Triage (V4.2 pre-work, NO TRAINING): audit the production
 * chain layer by layer for the four known residual failure classes.
 *
 * This script only OBSERVES the exact production chain —
 *   parseQuerySpec -> retrieveV3 (BM25 ⊕ bge RRF60, ontology hard filters, Top200)
 *   -> judgeGraded (Laya V4.1 0-3 head via the running sidecar, LAYA_URL) —
 * and dumps per-layer evidence for offline triage. It changes nothing in the
 * search stack; it runs the same functions the API runs (lib/search/*, lib/jev/*).
 *
 * The pool file carries each candidate's searchText so the V3 arm can be graded
 * offline later (same pool, no re-retrieval).
 *
 * Usage: npx tsx scripts/residual_triage.ts [--skip-grades] [--tag <name>]
 *   → data/eval/residual_triage_pools.json              (default)
 *   → data/eval/residual_triage_grades_v41.json         (default)
 *   → data/eval/residual_triage_pools_<tag>.json        (--tag kp1)
 *   → data/eval/residual_triage_grades_v41_<tag>.json   (--tag kp1)
 * --tag 只改输出文件名,query 集/协议与 Phase 1 完全一致(kp1 re-measure 用)。
 */

// Audit-only: make sure we hit the local V4.1 sidecar, never the cloud judge.
process.env.LAYA_URL ||= "http://127.0.0.1:8787";
delete process.env.TYPESAFE_API_KEY;

const TAG = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : null;

const QUERY_SETS: Record<string, string[]> = {
  photoresist: ["光刻胶", "半导体光刻胶", "做光刻胶的公司", "国产光刻胶材料", "给晶圆厂卖光刻胶的"],
  thermal: ["服务器散热", "服务器散热公司", "消费电子散热", "VC均热板", "导热材料", "数据中心液冷", "给数据中心做液冷散热的公司", "机房温控", "汽车热管理"],
  copper: ["铜资源", "铜涨价直接受益", "铜资源公司", "有铜矿的公司", "铜价上涨最直接受益的", "铜涨价谁赚钱", "不要铜加工", "上游铜矿", "铜资源不要铜加工"],
  distribution: ["半导体设备", "半导体材料", "人形机器人减速器", "AI", "白酒", "银行", "柴油发动机"],
};

type PoolRow = {
  code: string;
  name: string;
  rrfRank: number;
  bm25Rank: number | null;
  bm25Score: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  rrfScore: number;
  profile: string;
};

type PoolDoc = Record<string, {
  query: string;
  spec: { concepts: string[]; must: string[]; expansionTerms: string[]; exclusions: string[]; attrs: unknown };
  poolSize: number;
  candidates: PoolRow[];
}>;

type GradeDoc = Record<string, {
  query: string;
  poolSize: number;
  graded: number;
  grades: { code: string; name: string; rrfRank: number; grade: number }[];
}>;

async function main() {
  const skipGrades = process.argv.includes("--skip-grades");
  const { companies, version } = loadDataset();
  if (!companies.length) throw new Error("dataset empty");

  const pools: PoolDoc = {};
  const grades: GradeDoc = {};

  for (const [set, queries] of Object.entries(QUERY_SETS)) {
    for (const query of queries) {
      const key = `${set}::${query}`;
      const v3 = await retrieveV3(companies, query, version, async (text) => {
        const { embedQuery } = await import("../lib/text/embed");
        return embedQuery(text);
      });
      const candidates: PoolRow[] = v3.candidates.map((companyIndex, at) => {
        const company = companies[companyIndex];
        const info = v3.channelInfo.get(companyIndex);
        return {
          code: company.code,
          name: company.name,
          rrfRank: at + 1,
          bm25Rank: info?.bm25Rank ?? null,
          bm25Score: info?.bm25Score ?? null,
          vectorRank: info?.vectorRank ?? null,
          vectorScore: info?.vectorScore ?? null,
          rrfScore: info?.rrfScore ?? 0,
          profile: company.searchProfileText || company.judgeText,
        };
      });
      pools[key] = {
        query,
        spec: {
          concepts: v3.spec.concepts,
          must: v3.spec.must,
          expansionTerms: v3.spec.expansionTerms,
          exclusions: v3.spec.exclusions,
          attrs: v3.spec.attrs,
        },
        poolSize: candidates.length,
        candidates,
      };
      console.log(`[pool] ${key}: ${candidates.length} candidates, spec must=${JSON.stringify(v3.spec.must)} expand=${JSON.stringify(v3.spec.expansionTerms).slice(0, 80)}`);

      if (skipGrades) continue;
      const finalists = v3.candidates.map((i) => companies[i]);
      const verdict = await judgeGraded(query, finalists);
      if (!verdict?.live) {
        console.warn(`[grades] ${key}: sidecar not live — skipping grades`);
        continue;
      }
      const graded = v3.candidates.map((companyIndex, at) => ({
        code: companies[companyIndex].code,
        name: companies[companyIndex].name,
        rrfRank: at + 1,
        grade: Math.round((verdict.scores[at] ?? 0) * 3 * 1000) / 1000,
      }));
      grades[key] = { query, poolSize: candidates.length, graded: graded.length, grades: graded };
      const top10 = graded.slice(0, 10).map((g) => `${g.rrfRank}:${g.name}@${g.grade}`).join(" ");
      console.log(`[grades] ${key}: top10 ${top10}`);
    }
  }

  const outDir = path.join(process.cwd(), "data", "eval");
  const suffix = TAG ? `_${TAG}` : "";
  writeFileSync(path.join(outDir, `residual_triage_pools${suffix}.json`), JSON.stringify(pools, null, 1), "utf8");
  writeFileSync(path.join(outDir, `residual_triage_grades_v41${suffix}.json`), JSON.stringify(grades, null, 1), "utf8");
  console.log(`[done] pools=${Object.keys(pools).length} graded=${Object.keys(grades).length}${TAG ? ` tag=${TAG}` : ""}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
