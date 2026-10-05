import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { CompanyKnowledgeDocument } from "../lib/corpus/contracts";
import type { Company, Dataset } from "../lib/types";

/**
 * Phase 2 §十三 — 固定 QA 抽样：五板全覆盖 + 十类公司形态。
 * 人工审阅用导出：每家给出 corpus 文档全文 + 与 companies.json 的对应行，
 * 按六问核对（像这家公司吗/漏主营吗/重复吗/观点当事实吗/幻觉吗/provenance 可定位吗）。
 *
 * Usage: npx tsx scripts/corpus_qa_samples.ts
 */

const root = process.cwd();
const PICKS: Array<{ pick: string; symbol: string }> = [
  { pick: "上海主板/大型消费", symbol: "600519" },
  { pick: "科创板/半导体", symbol: "688012" },
  { pick: "深圳主板/金融", symbol: "000001" },
  { pick: "创业板/工业制造", symbol: "300750" },
  { pick: "北交所", symbol: "920808" },
  { pick: "软件", symbol: "600588" },
  { pick: "医药", symbol: "600276" },
  { pick: "能源", symbol: "601857" },
  { pick: "多元业务", symbol: "000039" },
];

function main() {
  const docs = readFileSync(path.join(root, "data", "company-corpus", "companies.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CompanyKnowledgeDocument);
  const companies = (JSON.parse(readFileSync(path.join(root, "data", "companies.json"), "utf8")) as Dataset).companies;
  const docBySymbol = new Map(docs.map((doc) => [doc.symbol, doc]));
  const companyBySymbol = new Map(companies.map((company) => [company.code, company]));

  const st = companies.find((company) => /^\*?ST/i.test(company.name));
  if (st) PICKS.push({ pick: "ST 公司", symbol: st.code });
  const sparse = [...companies]
    .filter((company) => company.businessDescription && company.businessDescription.length <= 16)
    .sort((a, b) => a.businessDescription.length - b.businessDescription.length)[0];
  if (sparse) PICKS.push({ pick: "业务描述很少的公司", symbol: sparse.code });

  const samples = PICKS.map(({ pick, symbol }) => {
    const doc = docBySymbol.get(symbol);
    const company = companyBySymbol.get(symbol);
    if (!doc || !company) {
      return { pick, symbol, error: "not found in corpus/dataset" };
    }
    return {
      pick,
      symbol,
      doc,
      sourceRow: {
        businessDescription: company.businessDescription,
        mainProducts: company.mainProducts,
        companyDescriptionChars: company.companyDescription.length,
        concepts: company.concepts,
      },
      checks: {
        businessMatchesSource: doc.business[0] === company.businessDescription,
        productsMatchSource: JSON.stringify(doc.products) === JSON.stringify(company.mainProducts.map((item) => item.name)),
        themeEvidenceTraces: doc.themes.every(
          (theme) =>
            theme.dimension === "semiconductorKnowledge" ||
            `${company.businessDescription}${company.mainProducts.map((item) => item.name).join("、")}`.includes(theme.evidence),
        ),
        searchableTextChars: doc.searchableText.length,
      },
    };
  });

  const outDir = path.join(root, "reports", "PHASE2_CORPUS");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "qa_samples.json"), JSON.stringify(samples, null, 1) + "\n", "utf8");

  for (const sample of samples) {
    if ("error" in sample) {
      console.log(`== ${sample.pick} ${sample.symbol}: ${sample.error}`);
      continue;
    }
    console.log(`\n==== ${sample.pick} —— ${sample.symbol} ${sample.doc.name} ====`);
    console.log(sample.doc.searchableText);
    console.log(`aliases=${JSON.stringify(sample.doc.aliases)} themes=${sample.doc.themes.map((theme) => theme.label).join("、")} exclusions=${sample.doc.exclusions.map((row) => row.label).join("、")}`);
    console.log(`checks: ${JSON.stringify(sample.checks)}`);
  }
  console.log(`\nwrote reports/PHASE2_CORPUS/qa_samples.json (${samples.length} samples)`);
}

main();
