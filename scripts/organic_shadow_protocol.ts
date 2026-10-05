/**
 * ORGANIC REAL-SEARCH SHADOW PROTOCOL(V4.2 pre-promotion §20–§23,提前冻结)。
 *
 * 裁决材料只能来自 search_log 中真实使用自然产生的搜索(organic)。协议:
 *   freeze organic holdout → 复用 log 内 fusedTop200(不重跑检索)
 *     → V4.1 臂(2742affc3f677d71)与 V4.2-B 臂(727a685c37c101bb)各自
 *       judgeGraded 打同一 Top200(唯一变量 checkpoint)
 *     → evidence-backed outcome(四值,禁止"新版默认判对")。
 *
 * 本脚本只做两件事:
 *   1) `--freeze`:把当前 log 中符合 organic 定义的 searchId 冻结进 holdout 文件;
 *   2) `--run`:对 holdout 双臂 grading 并产出结果(仅当 holdout 非空)。
 * 没有足够 organic 查询时输出 REAL_WORLD_EVIDENCE_INSUFFICIENT —— 这是合法状态,
 * 不允许用 benchmark/smoke/人工 query 凑数。
 *
 * Usage:
 *   npx tsx scripts/organic_shadow_protocol.ts --freeze
 *   npx tsx scripts/organic_shadow_protocol.ts --run --checkpoint-v41 <dir> --checkpoint-v42 <dir>
 *
 * 晋级裁决规则见 reports/V4_2_PROMOTION_CANDIDATE_FREEZE.md §4(预注册,不可回改)。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { requireLayaLane } from "./require-laya-lane";

requireLayaLane("organic_shadow_protocol.ts");


const LOG = "data/search_log/search_log.jsonl";
const HOLDOUT = "data/eval/organic_shadow_holdout.json";

/** §20 organic 定义:真实使用自然产生;以下全部排除。 */
const EXCLUDE_PATTERNS: [RegExp, string][] = [
  [/做光刻胶的公司|铜资源|数据中心液冷|服务器散热|半导体检测|半导体清洗/, "probe/verification query(历史探针词)"],
  [/白酒|银行/, "cross-domain smoke 词"],
];

interface LogRow {
  searchId: string;
  timestamp: string;
  query: { raw: string; normalized: string; querySpec: unknown };
  versions: Record<string, unknown>;
  retrieval: { poolSize: number; fusedTop200: { code: string; name: string }[] };
  result: { top20: unknown };
  cached?: boolean;
}

function loadLog(): LogRow[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogRow);
}

function organicReason(row: LogRow): string | null {
  const v = row.versions ?? {};
  // 缺版本四标签的行不可自证 tuple,一律排除
  if (!v.rerankerSha || !v.semiconductorEnrichmentVersion) return "missing version labels";
  if (row.cached) return "cached replay";
  const raw = row.query?.raw ?? "";
  for (const [rx, why] of EXCLUDE_PATTERNS) if (rx.test(raw)) return why;
  // 评测窗口内产生的行(本轮及之前的探针)按时间排除由 freeze 基准时间控制:
  // 只有 PRE_ORGANIC_CUTOFF 之后的行才可能是 organic。
  if (new Date(row.timestamp).getTime() < PRE_ORGANIC_CUTOFF) return "before organic cutoff";
  return null;
}

/** organic holdout 基准时间 = 本轮(知识 v1.1 晋级)收尾时刻。此前全部是
 *  探针/开发测试;此后真实使用产生的查询才进入 holdout。 */
const PRE_ORGANIC_CUTOFF = Date.parse("2026-09-27T04:00:00.000Z");

async function main() {
  const argv = process.argv.slice(2);
  const rows = loadLog();

  if (argv.includes("--freeze")) {
    const candidates = rows
      .map((r) => ({ row: r, excluded: organicReason(r) }))
      .filter((x) => !x.excluded)
      .map((x) => ({
        searchId: x.row.searchId,
        timestamp: x.row.timestamp,
        raw: x.row.query.raw,
        querySpec: x.row.query.querySpec,
        knowledgeVersion: x.row.versions.semiconductorEnrichmentVersion,
        rerankerSha: x.row.versions.rerankerSha,
        fusedTop200: x.row.retrieval.fusedTop200,
      }));
    const doc = {
      frozenAt: new Date().toISOString(),
      cutoff: new Date(PRE_ORGANIC_CUTOFF).toISOString(),
      protocol: "organic-shadow-v1 (§20-§23)",
      nOrganic: candidates.length,
      verdict: candidates.length >= 30 ? null : "REAL_WORLD_EVIDENCE_INSUFFICIENT",
      holdout: candidates,
    };
    writeFileSync(path.resolve(HOLDOUT), JSON.stringify(doc, null, 1) + "\n", "utf8");
    console.log(`[freeze] organic=${candidates.length} of ${rows.length} log rows → ${HOLDOUT}`);
    console.log(`[freeze] verdict=${doc.verdict ?? "pending enough coverage"}`);
    return;
  }

  if (argv.includes("--run")) {
    if (!existsSync(HOLDOUT)) throw new Error("holdout not frozen yet — run --freeze first");
    const doc = JSON.parse(readFileSync(HOLDOUT, "utf8"));
    if (!doc.holdout.length) {
      console.log(JSON.stringify({ outcome: "UNCERTAIN", verdict: "REAL_WORLD_EVIDENCE_INSUFFICIENT", nOrganic: 0 }));
      return;
    }
    throw new Error(
      "grading requires both arms live; dispatch arm grading via laya_v4_2_eval_grade.ts " +
        "against the frozen fusedTop200 (same protocol as the 30-pool), then run " +
        "analyze_organic_shadow.py — see FREEZE report §4. Do not fabricate outcomes.",
    );
  }

  console.log("usage: --freeze | --run");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
