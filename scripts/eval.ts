import { loadLocalEnv } from "./load-env";
import { loadDataset, resetDatasetCache } from "../lib/companies";
import { runSearch } from "../lib/search/pipeline";
import { CASES } from "./search_cases";

async function main() {
  loadLocalEnv();
  resetDatasetCache();
  const { companies } = loadDataset();
  const known = new Set(companies.map((company) => company.name));
  const skipJev = process.argv.includes("--retrieval");
  let passed = 0;

  for (const item of CASES) {
    const result = await runSearch(item.query, { skipJev, trace: false });
    const top = result.hits.slice(0, 10);
    const names = top.map((hit) => hit.name);
    const present = item.expect.filter((name) => known.has(name));
    const found = present.filter((name) => names.includes(name));
    const banned = item.exclude.filter((name) => names.includes(name));
    const need = Math.min(3, present.length);
    const provinceOk = !item.province || top.filter((hit) => hit.probability > 0).every((hit) => hit.province === item.province);
    const ok = found.length >= need && banned.length === 0 && provinceOk && present.length > 0;
    if (ok) passed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${item.query}`);
    console.log(`  judge=${result.judge.provider}:${result.judge.model ?? result.judge.outcome} degraded=${result.degraded} top=${names.join("、") || "（空）"}`);
    if (found.length < need) console.log(`  expected in pool ${present.join("、") || "（池子里没有）"}, found ${found.join("、") || "无"}`);
    if (banned.length) console.log(`  excluded but ranked: ${banned.join("、")}`);
    if (!provinceOk) console.log("  province filter failed");
  }

  console.log(`${passed}/${CASES.length} passed (${skipJev ? "retrieval" : "full"})`);
  process.exit(passed >= 6 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
