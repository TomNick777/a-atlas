import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CompanySourceFact } from "../lib/sourcefacts/contracts";

/**
 * Source Coverage Pass 2 — full-market scale-out locks。
 *
 * 这些断言锁「全池扩量后的真实证据」：抓取通道（含北交所修复）、 canonical join、
 * 残差桶全池守卫、旗舰六家的 corpus 保留。任何失败都意味着上游 payload、抓取
 * 管线或证据纪律发生了退化，必须重新调查而不是改测试。
 */

const ROOT = path.join(import.meta.dirname, "..");
const FACTS_FILE = path.join(ROOT, "data", "source_facts", "facts.jsonl");
const COMPANIES_FILE = path.join(ROOT, "data", "companies.json");
const CORPUS_FILE = path.join(ROOT, "data", "company-corpus", "companies.jsonl");

function loadFacts(): CompanySourceFact[] {
  return readFileSync(FACTS_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CompanySourceFact);
}

function loadCorpus(): Map<string, { symbol: string; name: string; searchableText: string; sourceFacts?: Array<{ term: string; factType: string; evidence: string }> }> {
  const docs = new Map<string, { symbol: string; name: string; searchableText: string; sourceFacts?: Array<{ term: string; factType: string; evidence: string }> }>();
  for (const line of readFileSync(CORPUS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as { symbol: string; name: string; searchableText: string; sourceFacts?: Array<{ term: string; factType: string; evidence: string }> };
    docs.set(doc.symbol, doc);
  }
  return docs;
}

describe("source facts full-market scale — coverage honesty", () => {
  const facts = loadFacts();
  const companies = new Map(
    ((JSON.parse(readFileSync(COMPANIES_FILE, "utf8")) as { companies: Array<{ code: string; name: string }> }).companies).map((company) => [company.code, company.name]),
  );

  it("every fact joins the canonical company pool by code with matching canonical name", () => {
    const orphans: string[] = [];
    const mismatches: string[] = [];
    for (const fact of facts) {
      const canonical = companies.get(fact.companyCode);
      if (!canonical) orphans.push(fact.companyCode);
      else if (fact.companyName !== canonical) mismatches.push(`${fact.companyCode}: ${fact.companyName} != ${canonical}`);
    }
    expect(orphans, `orphan codes: ${orphans.slice(0, 5).join(",")}`).toEqual([]);
    expect(mismatches, `name mismatches: ${mismatches.slice(0, 5).join("; ")}`).toEqual([]);
  });

  it("the layer consumed all three Source A feeds at market scale", () => {
    const sourceIds = new Set(facts.map((fact) => fact.source.sourceId));
    expect([...sourceIds].some((id) => id.startsWith("akshare:stock_zyjs_ths")), "THS 主营介绍通道缺席").toBe(true);
    expect([...sourceIds].some((id) => id.startsWith("akshare:stock_profile_cninfo")), "巨潮公司资料通道缺席").toBe(true);
    expect([...sourceIds].some((id) => id.startsWith("akshare:stock_zygc_em")), "东财主营构成通道缺席").toBe(true);
  });

  it("residual buckets and report markers never become corpus-facing terms", () => {
    const bad: string[] = [];
    for (const fact of facts) {
      for (const term of fact.terms) {
        if (/抵销|抵消|小计|下角料|调整项目|分部间|租赁收入|平衡项目/.test(term)) bad.push(`${fact.factId}: ${term}`);
        if (/^[（(][一二三四五六七八九十\d]{1,3}[)）]/.test(term)) bad.push(`${fact.factId}: ${term}（枚举标记）`);
      }
    }
    expect(bad, bad.slice(0, 5).join("; ")).toEqual([]);
  });
});

describe("source facts full-market scale — real fetched evidence (channel locks)", () => {
  const facts = loadFacts();
  const byCode = new Map<string, CompanySourceFact[]>();
  for (const fact of facts) {
    const bucket = byCode.get(fact.companyCode) ?? [];
    bucket.push(fact);
    byCode.set(fact.companyCode, bucket);
  }

  it("北交所通道：京城股份(920002) carries 叉车轴承 facts via the BJ symbol fix", () => {
    const bj = byCode.get("920002") ?? [];
    expect(bj.some((fact) => fact.terms.includes("叉车轴承")), "920002 缺「叉车轴承」").toBe(true);
  });

  it("金融通道：平安银行(000001) carries 商业银行业务", () => {
    const bank = byCode.get("000001") ?? [];
    expect(bank.some((fact) => fact.terms.includes("商业银行业务")), "000001 缺「商业银行业务」").toBe(true);
  });

  it("制造通道：比亚迪(002594) carries 汽车/手机部件 history rows", () => {
    const byd = byCode.get("002594") ?? [];
    const terms = new Set(byd.flatMap((fact) => fact.terms));
    expect(terms.has("汽车") || terms.has("汽车及相关产品"), "002594 缺汽车产品行").toBe(true);
    expect([...terms].some((term) => term.includes("手机部件")), "002594 缺手机部件行").toBe(true);
  });

  it("normalize 层丢弃实证：万科Ａ(000002) carries 商品住宅 from THS", () => {
    const vanke = byCode.get("000002") ?? [];
    expect(vanke.some((fact) => fact.terms.includes("商品住宅")), "000002 缺「商品住宅」").toBe(true);
  });

  it("上游真空如实分类：必贝特(688759) has THS facts but zero zygc rows", () => {
    const bbt = byCode.get("688759") ?? [];
    expect(bbt.length, "688759 应有 THS/巨潮事实").toBeGreaterThan(0);
    expect(bbt.some((fact) => fact.source.sourceType === "filing_product_split"), "688759 上游无 zygc 数据，不应有产品构成事实").toBe(false);
  });
});

describe("source facts full-market scale — flagship corpus retention (Pass 1 锁不因扩量丢失)", () => {
  const docs = loadCorpus();

  it("格力/美的 空调词面仍在 corpus searchableText", () => {
    expect(docs.get("000651")!.searchableText).toContain("家用空调");
    expect(docs.get("000333")!.searchableText).toContain("暖通空调");
  });

  it("伺服三家 伺服词面仍在 corpus searchableText", () => {
    for (const code of ["300124", "688320", "603416"]) {
      expect(docs.get(code)!.searchableText).toContain("伺服");
    }
  });

  it("时代电气 IGBT/功率半导体 词面仍在 corpus searchableText", () => {
    const text = docs.get("688187")!.searchableText;
    expect(text).toContain("IGBT");
    expect(text).toContain("功率半导体");
  });
});
