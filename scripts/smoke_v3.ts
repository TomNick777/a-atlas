import { runSearch } from "../lib/search/pipeline";
async function main() {
  for (const q of ["给数据中心做液冷散热的公司", "铜价上涨可能直接受益的资源类公司，不要铜加工企业", "人形机器人上游核心零部件，但不要整机厂"]) {
    const t0 = Date.now();
    const r = await runSearch(q, { skipJev: true, trace: true });
    console.log(`\n${q}  (${((Date.now()-t0)/1000).toFixed(2)}s, degraded=${r.degraded})`);
    console.log("  top10:", r.hits.slice(0, 10).map((h) => `${h.name}:${h.probability}`).join(" "));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
