import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  validateCompanySourceFact,
  type CompanySourceFact,
} from "../lib/sourcefacts/contracts";
import type { CompanyKnowledgeDocument, CorpusManifest } from "../lib/corpus/contracts";

/**
 * Phase 3.6 — Evidence Coverage Expansion 的证据纪律锁。
 *
 * facts 层：新追加的年报通道事实必须逐条过 CompanySourceFact 合同、
 * 带完整 provenance 与时间语义、公司内无重复原文。
 * corpus 投影：evidenceSpans 必须逐字回指 factId、完整落在 searchableText。
 * benchmark 隔离（§30/§31）：production corpus 路径不许引用 quality/discovery、
 * 不许出现 benchmark query/锚点公司字面量——过拟合边界必须机械可证。
 */

const ROOT = path.resolve(__dirname, "..");
const FACTS_FILE = path.join(ROOT, "data", "source_facts", "facts.jsonl");
const JSONL = path.join(ROOT, "data", "company-corpus", "companies.jsonl");
const MANIFEST = path.join(ROOT, "data", "company-corpus", "manifest.json");
const BENCHMARK = path.join(ROOT, "quality", "discovery", "benchmark-v1.json");

function loadFacts(): CompanySourceFact[] {
  // 96MB JSONL：模块级缓存一次装载——每个 worker 重复 parse 在并行负载下会
  // 超过 vitest 默认 5s 超时（实测 flake）。测试只读，缓存安全。
  if (!loadFacts.cache) {
    loadFacts.cache = readFileSync(FACTS_FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as CompanySourceFact);
  }
  return loadFacts.cache;
}
loadFacts.cache = null as CompanySourceFact[] | null;

function loadCorpus(): { docs: CompanyKnowledgeDocument[]; manifest: CorpusManifest } {
  if (!loadCorpus.cache) {
    const docs = readFileSync(JSONL, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as CompanyKnowledgeDocument);
    loadCorpus.cache = { docs, manifest: JSON.parse(readFileSync(MANIFEST, "utf8")) as CorpusManifest };
  }
  return loadCorpus.cache;
}
loadCorpus.cache = null as { docs: CompanyKnowledgeDocument[]; manifest: CorpusManifest } | null;

/** production corpus 生成路径（builder / acquisition / extraction / 契约）。
 *  这份清单扩到这里；给生成路径加新文件时必须同步，漏掉就是隔离缺口。
 *  Phase 3.7 增：evidence_surface_* 四个脚本（公告/官网/抽样/抽取）。 */
const PRODUCTION_CORPUS_FILES = [
  "scripts/build_company_corpus.ts",
  "scripts/evidence_coverage_fetch_annual.py",
  "scripts/evidence_coverage_extract_evidence.py",
  "scripts/evidence_surface_sample.py",
  "scripts/evidence_surface_fetch_announcements.py",
  "scripts/evidence_surface_fetch_products.py",
  "scripts/evidence_surface_extract.py",
  "lib/corpus/contracts.ts",
  "lib/sourcefacts/contracts.ts",
];

describe("evidence coverage — facts layer discipline (Phase 3.6)", () => {
  it("every fact row (including appended annual-report rows) passes the source-fact contract", () => {
    const facts = loadFacts();
    expect(facts.length).toBeGreaterThan(83_000);
    const issues: string[] = [];
    for (const fact of facts) {
      for (const issue of validateCompanySourceFact(fact)) issues.push(issue);
    }
    expect(issues, issues.slice(0, 10).join("\n")).toEqual([]);
  });

  it("annual-report facts carry full provenance and temporal semantics (no atemporal relation)", () => {
    const facts = loadFacts().filter((fact) => fact.source.sourceType === "filing_annual_report");
    expect(facts.length).toBeGreaterThan(10_000);
    for (const fact of facts) {
      // Pass 1 pilot 行的 sourceId 无 category 片段（cninfo:annual_report），
      // Phase 3.6 行带 #category——两代行都必须钉住披露时点与 artifact 指纹。
      expect(fact.source.sourceId.startsWith("cninfo:annual_report"), fact.factId).toBe(true);
      expect(fact.source.date, `${fact.factId} missing source.date`).toBeTruthy();
      expect(fact.artifactSha256, `${fact.factId} missing artifactSha256`).toBeTruthy();
      expect(fact.source.locator?.includes("#page="), `${fact.factId} locator missing page`).toBe(true);
    }
  });

  it("no duplicate rawText within a company for annual-report channel facts (exact-text dedup, §17)", () => {
    // 口径：只锁本阶段引入的年报通道（Pass 2 冻结行存在跨报告期的空白变体
    // 重复，属已冻结历史，不在本阶段重审）。
    const seen = new Map<string, string>();
    let checked = 0;
    for (const fact of loadFacts()) {
      if (fact.source.sourceType !== "filing_annual_report") continue;
      const key = fact.rawText.replace(/\s+/g, "");
      const first = seen.get(`${fact.companyCode}|${key}`);
      expect(first, `${fact.companyCode} duplicated rawText ${fact.factId} == ${first}: ${key.slice(0, 40)}`).toBeUndefined();
      seen.set(`${fact.companyCode}|${key}`, fact.factId);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(30_000);
  });

  it("factId sequence is contiguous per company with no collisions (append-only integrity)", () => {
    const seen = new Set<string>();
    const maxSeq = new Map<string, number>();
    for (const fact of loadFacts()) {
      expect(seen.has(fact.factId), `duplicate factId ${fact.factId}`).toBe(false);
      seen.add(fact.factId);
      const seq = Number(fact.factId.split("_")[2]);
      expect(seq).toBeGreaterThan(maxSeq.get(fact.companyCode) ?? 0);
      maxSeq.set(fact.companyCode, seq);
    }
  });
});

describe("evidence coverage — corpus projection (披露原文)", () => {
  it("every evidenceSpan resolves verbatim to its fact and lives fully inside searchableText", () => {
    const { docs, manifest } = loadCorpus();
    const facts = new Map(loadFacts().map((fact) => [fact.factId, fact]));
    let spanCount = 0;
    let covered = 0;
    for (const doc of docs) {
      const spans = doc.evidenceSpans ?? [];
      if (!spans.length) {
        expect(doc.searchableText.includes("披露原文："), `${doc.symbol} has line without spans`).toBe(false);
        continue;
      }
      covered += 1;
      spanCount += spans.length;
      expect(spans.length).toBeLessThanOrEqual(5);
      for (const span of spans) {
        const fact = facts.get(span.evidence);
        expect(fact, `${doc.symbol} ${span.evidence} 不存在`).toBeTruthy();
        expect(fact?.companyCode).toBe(doc.symbol);
        // 逐字相等，不是子串——span 投影零改写（§7 原文事实优先）。
        expect(fact?.rawText).toBe(span.text);
        expect(["relation", "product"]).toContain(span.factType);
        // Phase 3.6/3.7 三个披露/官方 surface 都允许进投影；其他 sourceType 不行。
        expect(
          ["filing_annual_report", "filing_announcement", "official_product_page"]).toContain(fact?.source.sourceType);
        expect(doc.searchableText.includes(span.text), `${doc.symbol} span ${span.evidence} 未进 searchableText`).toBe(true);
      }
      // 披露原文行 = spans 的有序拼接（与 builder 的确定性选取一致）。
      const line = doc.searchableText.split("\n").find((row) => row.startsWith("披露原文："));
      expect(line, `${doc.symbol} missing 披露原文 line`).toBeTruthy();
      const joined = spans.map((span) => span.text).join("；");
      expect(line).toBe(`披露原文：${joined}`);
      expect(joined.length).toBeLessThanOrEqual(280);
    }
    expect(manifest.stats.evidenceSpansCoverage).toBe(covered);
    expect(manifest.stats.evidenceSpanCount).toBe(spanCount);
    expect(covered).toBeGreaterThan(3000);
  });
});

describe("evidence coverage — benchmark isolation (§30/§31, anti-overfit boundary)", () => {
  it("production corpus generation path never references quality/discovery", () => {
    for (const rel of PRODUCTION_CORPUS_FILES) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      expect(/quality[/\\]discovery/.test(text), `${rel} references quality/discovery`).toBe(false);
    }
  });

  it("production corpus generation path contains no frozen benchmark query or anchor-company literals", () => {
    const benchmark = JSON.parse(readFileSync(BENCHMARK, "utf8")) as {
      cases: Array<{ id: string; query: string; anchors?: { mustInclude?: Array<{ code: string }>; shouldInclude?: Array<{ code: string; reason: string }>; negative?: Array<{ code: string; reason: string }> } }>;
    };
    const queries = benchmark.cases.map((entry) => entry.query).filter((query) => query.length >= 4);
    const anchorNames = new Set<string>();
    for (const entry of benchmark.cases) {
      for (const group of [entry.anchors?.shouldInclude ?? [], entry.anchors?.negative ?? []]) {
        for (const anchor of group) {
          const match = anchor.reason.match(/^(.{2,12}?)，/);
          if (match) anchorNames.add(match[1]);
        }
      }
    }
    expect(queries.length).toBeGreaterThan(40);
    for (const rel of PRODUCTION_CORPUS_FILES) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      for (const query of queries) {
        expect(text.includes(query), `${rel} contains benchmark query「${query}」`).toBe(false);
      }
    }
    // 锚点公司名只对 acquisition/extraction 脚本零容忍（source 选择发生地）；
    // builder 里的「同花顺」是 Phase 2 就在的数据源标签（ak.stock_zyjs_ths），
    // 先于 benchmark 存在，不是 benchmark 定向。Phase 3.7 surface 脚本同锁。
    for (const rel of [
      "scripts/evidence_coverage_fetch_annual.py",
      "scripts/evidence_coverage_extract_evidence.py",
      "scripts/evidence_surface_sample.py",
      "scripts/evidence_surface_fetch_announcements.py",
      "scripts/evidence_surface_fetch_products.py",
      "scripts/evidence_surface_extract.py",
    ]) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      for (const name of anchorNames) {
        expect(text.includes(name), `${rel} contains benchmark anchor company「${name}」`).toBe(false);
      }
    }
  });
});
