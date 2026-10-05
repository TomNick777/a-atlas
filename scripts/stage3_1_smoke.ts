import { readFileSync } from "node:fs";
import path from "node:path";
import { runSearch } from "../lib/search/pipeline";
import { requireLayaLane } from "./require-laya-lane";

requireLayaLane("stage3_1_smoke.ts");


/**
 * Stage 3.1 生产链路 smoke(规格第十九节 production/search-log/inspect smoke):
 *   真实 Laya sidecar(LAYA_URL) 跑一条半导体查询 → 打印结果与 degraded 位,
 *   并回读 search_log 最后一条,核对版本块(规格第十七节):
 *   semiconductorEnrichmentVersion / derivationVersion / sourceSnapshotId。
 *
 * Usage: LAYA_URL=http://127.0.0.1:8787 npx tsx scripts/stage3_1_smoke.ts
 */
async function main() {
  const r = await runSearch("半导体刻蚀设备厂商", { log: true, origin: "smoke" });
  console.log("degraded:", r.degraded);
  console.log("top8:", r.hits.slice(0, 8).map((h) => `${h.name}:${h.probability}`).join(" "));
  const logPath = path.join(process.cwd(), "data", "search_log", "search_log.jsonl");
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  console.log("last search log:", last.timestamp, "|", JSON.stringify(last.query?.raw ?? last.query));
  console.log("log versions:", JSON.stringify({
    semiconductorEnrichmentVersion: last.versions?.semiconductorEnrichmentVersion,
    derivationVersion: last.versions?.derivationVersion,
    sourceSnapshotId: last.versions?.sourceSnapshotId,
    profileEdition: last.versions?.profileEdition,
    degraded: last.versions?.degraded,
  }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
