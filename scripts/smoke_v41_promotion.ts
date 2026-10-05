/**
 * §18 post-promotion smoke: six unrelated queries straight against the RUNNING
 * production sidecar (LAYA_URL, default port 8787). Smoke only — no tuning, no
 * training, nothing written to search_log (this bypasses the app's log path).
 * Pool is a fixed mixed bag so each query has true hits and true distractors.
 *
 * Usage: npx tsx scripts/smoke_v41_promotion.ts
 */

import { loadDataset } from "../lib/companies";
import { judgeGraded } from "../lib/jev/judge";
import { requireLayaLane } from "./require-laya-lane";

requireLayaLane("smoke_v41_promotion.ts");


const QUERIES = ["ALD设备", "PVD靶材", "半导体设备零部件", "铜资源", "工业机器人零部件", "数据中心液冷"];
const POOL_CODES = [
  "688147", // 微导纳米 ALD
  "688072", // 拓荆科技 沉积
  "688012", // 中微公司 刻蚀
  "300666", // 江丰电子 靶材
  "688605", // 先锋精科 部件
  "002371", // 北方华创 设备
  "000923", // 河钢资源 铜矿
  "600490", // 鹏欣资源 铜矿
  "000630", // 铜陵有色 铜冶炼
  "688017", // 绿的谐波 减速器
  "002472", // 双环传动 齿轮
  "003018", // 金富科技 液冷
  "300499", // 高澜股份 液冷
  "600519", // 贵州茅台 对照
  "600036", // 招商银行 对照
];

async function main() {
  const base = process.env.LAYA_URL?.trim() || "http://127.0.0.1:8787";
  process.env.LAYA_URL = base; // judgeGraded reads layaUrl() from the process env
  const health = await (await fetch(`${base}/health`)).json();
  console.log("production sidecar:", JSON.stringify(health));
  const { companies } = loadDataset();
  const byCode = new Map(companies.map((c) => [c.code, c]));
  const pool = POOL_CODES.map((code) => byCode.get(code)).filter(Boolean);
  let pass = 0;
  let fail = 0;
  for (const query of QUERIES) {
    const verdict = await judgeGraded(query, pool as never);
    if (!verdict?.live) {
      console.log(`✗ ${query}: sidecar not live`);
      fail += 1;
      continue;
    }
    const ranked = pool
      .map((company, at) => ({ code: company!.code, name: company!.name, grade: Math.round((verdict.scores[at] ?? 0) * 3) }))
      .sort((a, b) => b.grade - a.grade);
    const top = ranked.filter((row) => row.grade > 0).slice(0, 4);
    console.log(`✓ ${query}: ${top.map((row) => `${row.name}(g${row.grade})`).join(" ") || "(all zero)"}`);
    pass += 1;
  }
  console.log(`smoke: ${pass}/${QUERIES.length} answered`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
