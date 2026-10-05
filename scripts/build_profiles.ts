import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeCompany, type RawCompany } from "../lib/profile";
import type { Dataset } from "../lib/types";

const root = process.cwd();
const dir = path.join(root, "data", "raw", "companies");

/**
 * 申万一级行业（2021 版）成分表，scripts/fetch_sw_industry.py 抓取。
 * 申万宏源官方口径；北交所与未入类的次新股不在表里，落 "unknown"。
 */
type SwMapFile = {
  source: string;
  classification: string;
  fetchedAt: string;
  level1: { code: string; name: string; count: number }[];
  map: Record<string, { industry: string; industryCode: string }>;
};

function loadSwMap(): SwMapFile | null {
  const file = path.join(root, "data", "raw", "sw", "level1_map.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as SwMapFile;
}

const sw = loadSwMap();
if (!sw) {
  console.error("data/raw/sw/level1_map.json missing; run: npm run data:sw");
  process.exit(1);
}

const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
const companies = files.map((name) => {
  const raw = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as RawCompany;
  return normalizeCompany({ ...raw, swLevel1Industry: sw.map[raw.code]?.industry });
});
companies.sort((a, b) => a.code.localeCompare(b.code));

const dataset: Dataset = { generatedAt: new Date().toISOString(), companies };
mkdirSync(path.join(root, "data"), { recursive: true });
writeFileSync(path.join(root, "data", "companies.json"), JSON.stringify(dataset));

const health = {
  count: companies.length,
  withBusiness: companies.filter((company) => company.businessDescription).length,
  withIndustry: companies.filter((company) => company.industry).length,
  withSw: companies.filter((company) => company.swLevel1Industry !== "unknown").length,
  swUnknown: companies.filter((company) => company.swLevel1Industry === "unknown").length,
  swIndustries: sw.level1.length,
  swSource: sw.source,
  swClassification: sw.classification,
  swFetchedAt: sw.fetchedAt,
  withProvince: companies.filter((company) => company.region.province).length,
  withProducts: companies.filter((company) => company.mainProducts.length).length,
  withConcepts: companies.filter((company) => company.concepts.length).length,
  withOverseas: companies.filter((company) => company.overseasRevenueShare != null).length,
};
writeFileSync(path.join(root, "data", "health.json"), JSON.stringify(health, null, 2));
console.log(health);
if (health.withBusiness < companies.length * 0.7) {
  console.error("too many companies have no business description");
  process.exit(1);
}
