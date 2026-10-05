import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CompanySourceFact } from "../lib/sourcefacts/contracts";
import type { CompanyKnowledgeDocument, CorpusManifest } from "../lib/corpus/contracts";

/**
 * Phase 3.7 — Evidence Surface Expansion 的证据纪律锁。
 *
 * Surface A（公告，point-in-time relation）：披露时点一等公民、强度/类型/方向
 * 全部来自原文词面且可机械解释、送样永不被升级成供货（§5-§9）。
 * Surface B（官网产品页）：逐字原文、页面噪声守卫、外部文本永不成为指令（§50）。
 * 强度规则顺序机械锁定：sampling/trial/planned 永远先于 confirmed 判定——
 * 规则表被重排导致「送样→已供货」升级时测试即红（§7 本阶段最重要纪律）。
 * Corpus 投影：新 surface 的 sources 行、stats 与字节一致（诚实性）。
 */

const ROOT = path.resolve(__dirname, "..");
const FACTS_FILE = path.join(ROOT, "data", "source_facts", "facts.jsonl");
const FACTS_MANIFEST = path.join(ROOT, "data", "source_facts", "manifest.json");
const JSONL = path.join(ROOT, "data", "company-corpus", "companies.jsonl");
const MANIFEST = path.join(ROOT, "data", "company-corpus", "manifest.json");

function loadFacts(): CompanySourceFact[] {
  // 96MB JSONL：模块级缓存一次装载（并行负载下的 5s 超时 flake 防护）。
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

const RELATION_TYPES = new Set(["customer", "supplier", "cooperation", "certification", "joint_development", "project", "bid", "other"]);
const STRENGTHS = new Set(["planned", "sampling", "trial", "confirmed", "stated", "unclear"]);
const DIRECTIONS = new Set(["sells_to", "buys_from", "mutual", "unresolved"]);

describe("evidence surface — announcement channel discipline (Surface A, §5-§9)", () => {
  it("every announcement relation fact carries a disclosure date — time is first-class (§9)", () => {
    const facts = loadFacts().filter((fact) => fact.source.sourceType === "filing_announcement");
    if (!facts.length) return; // pilot 未运行时通道真空，不是失败
    for (const fact of facts) {
      expect(fact.source.date, `${fact.factId} missing 披露日`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fact.artifactSha256, `${fact.factId} missing artifact sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(fact.source.locator?.includes("#page="), `${fact.factId} locator missing page`).toBe(true);
      expect(fact.source.sourceId.startsWith("cninfo:announcement#"), fact.factId).toBe(true);
    }
  });

  it("relationType, strength AND direction are closed enums in sourceId (§5/§8, mechanically explainable)", () => {
    for (const fact of loadFacts()) {
      if (fact.source.sourceType !== "filing_announcement") continue;
      const fragment = fact.source.sourceId.split("#")[1] ?? "";
      const [rtype, strength, direction] = fragment.split(":");
      expect(RELATION_TYPES.has(rtype), `${fact.factId} 非法 relationType: ${rtype}`).toBe(true);
      expect(STRENGTHS.has(strength), `${fact.factId} 非法 strength: ${strength}`).toBe(true);
      // §8：方向一等保留——subject/relation/object/direction 缺一不可。
      expect(DIRECTIONS.has(direction), `${fact.factId} 非法 direction: ${direction}`).toBe(true);
    }
  });

  it("sampling strength is never upgraded to a confirmed-supply label (§7 — the core discipline)", () => {
    // 词面纪律：rawText 含送样/样品/样机的行，其 sourceId 强度只能是
    // sampling/planned/unclear——「送样」永远不许带着 confirmed 供货标签进库。
    const facts = loadFacts().filter((fact) => fact.source.sourceType === "filing_announcement");
    const samplingFacts = facts.filter((fact) => /送样|样品|样机|试样/.test(fact.rawText));
    for (const fact of samplingFacts) {
      const strength = fact.source.sourceId.split("#")[1]?.split(":")[1];
      expect(["sampling", "planned", "unclear"]).toContain(strength);
    }
    // 规则顺序机械锁：extractor 的强度判定表里 planned/sampling/trial 必须先于
    // confirmed——重排即升级，测试先红。
    const extractor = readFileSync(path.join(ROOT, "scripts", "evidence_surface_extract.py"), "utf8");
    const strengthBlock = extractor.slice(extractor.indexOf("STRENGTH_RULES"), extractor.indexOf("TYPE_RULES"));
    const order = [...strengthBlock.matchAll(/\("([a-z]+)", re\.compile/g)].map((m) => m[1]);
    expect(order.indexOf("sampling")).toBeGreaterThan(-1);
    expect(order.indexOf("sampling")).toBeLessThan(order.indexOf("confirmed"));
    expect(order.indexOf("trial")).toBeLessThan(order.indexOf("confirmed"));
  });

  it("certification / supplier-list selection is never labeled a supply contract (§7 关系状态不升级)", () => {
    for (const fact of loadFacts()) {
      if (fact.source.sourceType !== "filing_announcement") continue;
      if (/入选|入围|列入/.test(fact.rawText) && /(供应商名单|供应商目录|合格供应商)/.test(fact.rawText)) {
        expect(fact.source.sourceId.split("#")[1]?.split(":")[0], fact.factId).not.toBe("customer");
      }
    }
  });
});

describe("evidence surface — official product channel discipline (Surface B, §14-§20)", () => {
  it("product facts carry verbatim page provenance: URL + sha256 + retrievedAt (§19/§41)", () => {
    const facts = loadFacts().filter((fact) => fact.source.sourceType === "official_product_page");
    if (!facts.length) return;
    for (const fact of facts) {
      expect(fact.source.locator, `${fact.factId} missing page URL`).toMatch(/^https?:\/\//);
      expect(fact.artifactSha256, `${fact.factId} missing page sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(fact.retrievedAt, `${fact.factId} missing retrievedAt`).toBeTruthy();
      // 页面自报时间不可靠：不写 source.date（freshness 只记 retrievedAt，§26）。
      expect(fact.source.date, `${fact.factId} must not fabricate a page date`).toBeUndefined();
    }
  });

  it("product evidence is visible page text — no HTML artifacts, no script content (§50 injection discipline)", () => {
    for (const fact of loadFacts()) {
      if (fact.source.sourceType !== "official_product_page") continue;
      expect(fact.rawText, fact.factId).not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(fact.rawText.toLowerCase(), fact.factId).not.toContain("<script");
      expect(fact.rawText, fact.factId).not.toMatch(/javascript:|onerror\s*=|eval\(/i);
    }
  });

  it("product evidence passed the page-noise guard (no nav/legal boilerplate lines, §15)", () => {
    const noise = /版权所有|备案号|Cookie|隐私政策|登录|注册|关注我们|ICP|All [Rr]ights [Rr]eserved/;
    for (const fact of loadFacts()) {
      if (fact.source.sourceType !== "official_product_page") continue;
      expect(noise.test(fact.rawText), `${fact.factId} 噪声行漏守卫: ${fact.rawText.slice(0, 40)}`).toBe(false);
    }
  });
});

describe("evidence surface — corpus projection honesty (v1.3.0)", () => {
  it("announcement/product sources rows appear exactly when spans from that surface are projected", () => {
    const { docs, manifest } = loadCorpus();
    const facts = new Map(loadFacts().map((fact) => [fact.factId, fact]));
    let annCovered = 0;
    let prodCovered = 0;
    for (const doc of docs) {
      const hasAnnRow = doc.sources.some((source) => source.sourceType === "filing_announcement");
      const hasProdRow = doc.sources.some((source) => source.sourceType === "official_product_page");
      const spanFacts = (doc.evidenceSpans ?? []).map((span) => facts.get(span.evidence)).filter(Boolean);
      const hasAnnSpan = spanFacts.some((fact) => fact!.source.sourceType === "filing_announcement");
      const hasProdSpan = spanFacts.some((fact) => fact!.source.sourceType === "official_product_page");
      expect(hasAnnRow, `${doc.symbol} announcement sources row mismatch`).toBe(hasAnnSpan);
      expect(hasProdRow, `${doc.symbol} product sources row mismatch`).toBe(hasProdSpan);
      annCovered += hasAnnRow ? 1 : 0;
      prodCovered += hasProdRow ? 1 : 0;
    }
    expect(manifest.stats.announcementEvidenceCoverage).toBe(annCovered);
    expect(manifest.stats.officialProductEvidenceCoverage).toBe(prodCovered);
  });

  it("evidence line budget is unchanged: ≤5 spans, ≤280 chars, 披露原文 join exact", () => {
    const { docs } = loadCorpus();
    for (const doc of docs) {
      const spans = doc.evidenceSpans ?? [];
      if (!spans.length) continue;
      expect(spans.length).toBeLessThanOrEqual(5);
      const joined = spans.map((span) => span.text).join("；");
      expect(joined.length).toBeLessThanOrEqual(280);
      const line = doc.searchableText.split("\n").find((row) => row.startsWith("披露原文："));
      expect(line).toBe(`披露原文：${joined}`);
    }
  });
});

describe("evidence surface — facts manifest surface registry (§38/§39)", () => {
  it("manifest surfaces block records authority class and extractor version per surface", () => {
    const manifest = JSON.parse(readFileSync(FACTS_MANIFEST, "utf8")) as {
      schemaVersion: string;
      surfaces?: Record<string, { authorityClass: string; temporal: string; extractorVersion: string; factCount: number }>;
    };
    expect(manifest.schemaVersion).toBe("1.2.0");
    const surfaces = manifest.surfaces ?? {};
    for (const [id, surface] of Object.entries(surfaces)) {
      expect(surface.authorityClass, `${id} missing authorityClass`).toBeTruthy();
      expect(surface.temporal, `${id} missing temporal`).toBeTruthy();
      expect(surface.extractorVersion, `${id} missing extractorVersion`).toBeTruthy();
      expect(surface.factCount).toBeGreaterThanOrEqual(0);
    }
    if (surfaces.announcement) {
      expect(surfaces.announcement.authorityClass).toBe("regulatory_filing");
      expect(surfaces.announcement.temporal).toBe("point_in_time");
    }
    if (surfaces.official_product) {
      expect(surfaces.official_product.authorityClass).toBe("official_corporate_website");
    }
  });
});
