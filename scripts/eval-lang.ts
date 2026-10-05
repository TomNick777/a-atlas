import { loadLocalEnv } from "./load-env";
import { loadDataset, resetDatasetCache } from "../lib/companies";
import { runSearch } from "../lib/search/pipeline";
import { CASES } from "./search_cases";

/**
 * Same queries, same pool, Chinese judgeText versus English judgeText.
 * English stays off the product path until this script shows it wins top-5 overlap.
 * With no English profiles the measurement is reported and skipped.
 */
async function main() {
  loadLocalEnv();
  resetDatasetCache();
  const { companies } = loadDataset();
  const covered = companies.filter((company) => company.judgeTextEn).length;
  console.log(`judgeTextEn ${covered}/${companies.length}`);
  if (!covered) {
    console.log("没有英文 judgeText，对照不跑。当前判断读中文。");
    return;
  }

  let zhWins = 0;
  let enWins = 0;
  for (const item of CASES) {
    const zh = await runSearch(item.query, { judgeLanguage: "zh" });
    const en = await runSearch(item.query, { judgeLanguage: "en" });
    const zhNames = new Set(zh.hits.slice(0, 5).map((hit) => hit.name));
    const enNames = en.hits.slice(0, 5).map((hit) => hit.name);
    const overlap = enNames.filter((name) => zhNames.has(name)).length;
    const zhHit = item.expect.filter((name) => zh.hits.slice(0, 5).some((hit) => hit.name === name)).length;
    const enHit = item.expect.filter((name) => en.hits.slice(0, 5).some((hit) => hit.name === name)).length;
    if (zhHit >= enHit) zhWins += 1;
    if (enHit > zhHit) enWins += 1;
    console.log(`${item.query} overlap=${overlap}/5 zh=${zhHit} en=${enHit} zhJudge=${zh.judge.provider} enJudge=${en.judge.provider}`);
  }
  console.log(enWins > zhWins ? "英文 judgeText 更好，再考虑翻译步骤。" : "中文不差于英文，不建翻译步骤。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
