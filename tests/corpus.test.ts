import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CORPUS_SCHEMA_VERSION,
  SEARCHABLE_TEXT_CAP,
  validateCompanyKnowledgeDocument,
  type CompanyKnowledgeDocument,
  type CorpusManifest,
} from "../lib/corpus/contracts";
import { loadDataset } from "../lib/companies";
import { SOURCE_FACTS_SCHEMA_VERSION } from "../lib/sourcefacts/contracts";
import type { Company, Dataset } from "../lib/types";

/**
 * Phase 2 §十四 — corpus 数据质量不变量。
 *
 * 语料是 committed artifact：这里的每一断言都以「在盘文件」为准，
 * 锁的是 5567 份文档的整体纪律，不是单次构建的偶然。
 */

const ROOT = path.resolve(__dirname, "..");
const JSONL = path.join(ROOT, "data", "company-corpus", "companies.jsonl");
const MANIFEST = path.join(ROOT, "data", "company-corpus", "manifest.json");

function loadCorpus(): { docs: CompanyKnowledgeDocument[]; manifest: CorpusManifest; raw: string } {
  const raw = readFileSync(JSONL, "utf8");
  const docs = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CompanyKnowledgeDocument);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as CorpusManifest;
  return { docs, manifest, raw };
}

function loadCompanies(): Company[] {
  const dataset = JSON.parse(readFileSync(path.join(ROOT, "data", "companies.json"), "utf8")) as Dataset;
  return dataset.companies;
}

/** 与 tests/refocus.test.ts 同一份退役栈词表（语料数据本身也必须零残留）。 */
const BANNED = [
  /vibe[-_]?(research|astock|port)/i,
  /a-atlas-research/i,
  /ATLAS_RESEARCH_URL/i,
  /ATLAS_DEEPDIVE/i,
  /duanxian/i,
  /review_agent/i,
  /deepdive/i,
  /daily[-_]?review/i,
  /backtest/i,
  /\bmyreports\b/i,
  /mode[-_]?card/i,
  /watchlist/i,
  /\bjournal\b/i,
  /\bportfolio\b/i,
  /askai/i,
  /VR_API_KEY/i,
  /VIBE_PORT/i,
  /\b8910\b/,
];

describe("company knowledge corpus — artifact integrity", () => {
  it("artifact is committed and manifest digest matches the JSONL bytes", () => {
    expect(existsSync(JSONL)).toBe(true);
    expect(existsSync(MANIFEST)).toBe(true);
    const { docs, manifest, raw } = loadCorpus();
    expect(manifest.contentDigest.scope).toBe("companies.jsonl");
    expect(manifest.contentDigest.algorithm).toBe("sha256");
    expect(createHash("sha256").update(raw, "utf8").digest("hex")).toBe(manifest.contentDigest.value);
    expect(manifest.companyCount).toBe(docs.length);
    expect(manifest.schemaVersion).toBe(CORPUS_SCHEMA_VERSION);
  });

  it("every document passes the structural contract", () => {
    const { docs } = loadCorpus();
    const issues: string[] = [];
    for (const doc of docs) {
      for (const issue of validateCompanyKnowledgeDocument(doc)) issues.push(issue);
      expect(doc.schemaVersion).toBe(CORPUS_SCHEMA_VERSION);
    }
    expect(issues, issues.slice(0, 10).join("\n")).toEqual([]);
  });

  it("symbols are unique 6-digit canonical codes aligned with the canonical universe", () => {
    const { docs, manifest } = loadCorpus();
    const companies = loadCompanies();
    const symbols = new Set(docs.map((doc) => doc.symbol));
    expect(symbols.size).toBe(docs.length);
    expect(docs.length).toBe(companies.length);
    expect(manifest.companyCount).toBe(companies.length);
    for (const company of companies) expect(symbols.has(company.code)).toBe(true);
  });

  it("manifest stats are honest (empty/duplicates/length recomputed from bytes)", () => {
    const { docs, manifest } = loadCorpus();
    const empty = docs.filter((doc) => !doc.searchableText).length;
    const duplicates = docs.length - new Set(docs.map((doc) => doc.symbol)).size;
    const avg = Math.round(docs.reduce((sum, doc) => sum + doc.searchableText.length, 0) / docs.length);
    const max = Math.max(...docs.map((doc) => doc.searchableText.length));
    expect(manifest.stats.emptySearchableText).toBe(empty);
    expect(manifest.stats.duplicateSymbols).toBe(duplicates);
    expect(manifest.stats.avgSearchableTextChars).toBe(avg);
    expect(manifest.stats.maxSearchableTextChars).toBe(max);
    expect(max).toBeLessThanOrEqual(SEARCHABLE_TEXT_CAP);
  });
});

describe("company knowledge corpus — fact boundary (no contamination, no fabrication)", () => {
  it("every claim traces back to that company's own rows in companies.json", () => {
    const { docs } = loadCorpus();
    const bySymbol = new Map(loadCompanies().map((company) => [company.code, company]));
    let checked = 0;
    for (const doc of docs) {
      const company = bySymbol.get(doc.symbol);
      // 主键对齐：串号（把 A 公司事实写进 B 文档）必然在这里断裂。
      expect(company, doc.symbol).toBeTruthy();
      if (!company) continue;
      expect(doc.name).toBe(company.name);
      expect(doc.fullName).toBe(company.fullName);
      expect(doc.identity.industry).toBe(company.industry);
      expect(doc.identity.swIndustry).toBe(company.swLevel1Industry);
      expect(doc.identity.province).toBe(company.region.province);
      expect(doc.identity.exchange).toBe(company.exchange);
      expect(doc.profile).toBe(company.companyDescription.slice(0, 2000));
      expect(doc.business).toEqual(company.businessDescription ? [company.businessDescription] : []);
      expect(doc.products).toEqual(company.mainProducts.map((item) => item.name));
      expect(doc.concepts).toEqual(company.concepts);
      expect(doc.overseasRevenueShare).toBe(company.overseasRevenueShare);
      doc.revenueMix.forEach((row, at) => {
        const product = company.mainProducts.find((item) => item.name === row.name);
        expect(product, `${doc.symbol} revenueMix ${row.name}`).toBeTruthy();
        expect(row.ratio).toBe(product?.revenueShare);
        expect(row.dimension).toBe("按产品");
        void at;
      });
      // 主题证据回指：非知识标签的证据必须能在该公司自己的事实文本里找到。
      const ownText = `${company.businessDescription}${company.mainProducts.map((item) => item.name).join("、")}`;
      for (const theme of doc.themes) {
        if (theme.dimension === "semiconductorKnowledge") {
          expect(theme.evidence.startsWith("stage3:")).toBe(true);
          continue;
        }
        expect(
          ownText.includes(theme.evidence),
          `${doc.symbol} theme ${theme.label} evidence "${theme.evidence}" not in own facts`,
        ).toBe(true);
      }
      // 别名可回指：ST 前缀剥离、全称短形、或简介中的明示更名。
      for (const alias of doc.aliases) {
        const traceable =
          alias === company.name.replace(/^\*?ST/i, "") ||
          company.fullName.includes(alias) ||
          company.companyDescription.includes(alias);
        expect(traceable, `${doc.symbol} alias "${alias}" untraceable`).toBe(true);
      }
      checked += 1;
    }
    expect(checked).toBe(docs.length);
  });

  it("searchableText carries the identity line and the company's own business text", () => {
    const { docs } = loadCorpus();
    const bySymbol = new Map(loadCompanies().map((company) => [company.code, company]));
    for (const doc of docs) {
      const company = bySymbol.get(doc.symbol)!;
      expect(doc.searchableText.startsWith(`公司：${doc.name}（${doc.symbol}`)).toBe(true);
      if (company.businessDescription) {
        expect(doc.searchableText.includes(company.businessDescription.slice(0, 200) || "\u0000")).toBe(true);
      }
    }
  });
});

describe("company knowledge corpus — runtime consumes the artifact", () => {
  it("loadDataset attaches the corpus as the semantic layer with matching vectors", () => {
    const loaded = loadDataset();
    expect(loaded.corpus).toBeTruthy();
    const { docs, manifest } = loadCorpus();
    expect(loaded.corpus!.companyCount).toBe(docs.length);
    expect(loaded.corpus!.contentDigest16).toBe(manifest.contentDigest.value.slice(0, 16));
    expect(loaded.corpus!.schemaVersion).toBe(CORPUS_SCHEMA_VERSION);
    const maotai = loaded.companies.find((company) => company.code === "600519");
    const maotaiDoc = docs.find((doc) => doc.symbol === "600519")!;
    expect(maotai?.searchProfileText).toBe(maotaiDoc.searchableText);
    expect(loaded.vectors?.length).toBe(loaded.companies.length * 512);
  });

  it("corpus artifact carries zero references to the retired stack", () => {
    const { raw } = loadCorpus();
    const manifestRaw = readFileSync(MANIFEST, "utf8");
    for (const pattern of BANNED) {
      expect(pattern.test(raw), String(pattern)).toBe(false);
      expect(pattern.test(manifestRaw), String(pattern)).toBe(false);
    }
  });
});

describe("company knowledge corpus — source facts layer (Source Coverage)", () => {
  const FACTS_FILE = path.join(ROOT, "data", "source_facts", "facts.jsonl");

  it("manifest records the source-facts layer version honestly", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as CorpusManifest & { sourceFactsVersion?: string };
    const hasLayer = existsSync(FACTS_FILE);
    expect(manifest.sourceFactsVersion).toBe(hasLayer ? SOURCE_FACTS_SCHEMA_VERSION : "none");
  });

  it("every sourceFacts entry resolves to a real fact whose rawText contains the term", () => {
    const { docs, manifest } = loadCorpus();
    const withFacts = docs.filter((doc) => doc.sourceFacts?.length);
    expect(withFacts.length).toBe(manifest.stats.sourceFactsCoverage);
    if (!existsSync(FACTS_FILE)) return;
    const facts = new Map(
      readFileSync(FACTS_FILE, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const fact = JSON.parse(line) as { factId: string; companyCode: string; rawText: string; factType: string };
          return [fact.factId, fact] as const;
        }),
    );
    for (const doc of withFacts) {
      for (const entry of doc.sourceFacts ?? []) {
        const fact = facts.get(entry.evidence);
        expect(fact, `${doc.symbol} ${entry.term} → ${entry.evidence} 不存在`).toBeTruthy();
        expect(fact?.companyCode).toBe(doc.symbol);
        expect(fact?.rawText.includes(entry.term), `${doc.symbol} term「${entry.term}」不在 fact rawText 内`).toBe(true);
        expect(fact?.factType).toBe(entry.factType);
        // 来源事实行必须落进检索文本（否则 facts 只存不检，Pass 1 的目标落空）。
        expect(doc.searchableText.includes(`来源事实：`)).toBe(true);
        expect(doc.searchableText.includes(entry.term), `${doc.symbol} term「${entry.term}」未进 searchableText`).toBe(true);
      }
    }
  });
});
