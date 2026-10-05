import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SOURCE_FACTS_SCHEMA_VERSION,
  SOURCE_FACT_TYPES,
  validateCompanySourceFact,
  type CompanySourceFact,
} from "../lib/sourcefacts/contracts";

const ROOT = path.join(import.meta.dirname, "..");
const FACTS_FILE = path.join(ROOT, "data", "source_facts", "facts.jsonl");
const MANIFEST_FILE = path.join(ROOT, "data", "source_facts", "manifest.json");

function loadFacts(): CompanySourceFact[] {
  if (!existsSync(FACTS_FILE)) return [];
  return readFileSync(FACTS_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CompanySourceFact);
}

describe("source fact contract — structure and invariants", () => {
  it("accepts a well-formed fact with provenance and verbatim rawText", () => {
    const issues = validateCompanySourceFact({
      schemaVersion: SOURCE_FACTS_SCHEMA_VERSION,
      factId: "sf_300124_000001",
      companyCode: "300124",
      companyName: "汇川技术",
      factType: "product",
      terms: ["伺服系统"],
      rawText: "公司通用伺服系统在中国市场的份额约31%",
      source: { sourceId: "cninfo:annual_report", sourceName: "巨潮年报", sourceType: "filing_annual_report", locator: "http://static.cninfo.com.cn/x.pdf#page=13" },
      retrievedAt: "2026-09-28T23:00:00+08:00",
    });
    expect(issues).toEqual([]);
  });

  it("rejects terms that are not substrings of rawText (traceability break)", () => {
    const issues = validateCompanySourceFact({
      schemaVersion: SOURCE_FACTS_SCHEMA_VERSION,
      factId: "sf_300124_000001",
      companyCode: "300124",
      companyName: "汇川技术",
      factType: "product",
      terms: ["不存在词"],
      rawText: "公司通用伺服系统在中国市场的份额约31%",
      source: { sourceId: "cninfo:annual_report", sourceName: "巨潮年报", sourceType: "filing_annual_report" },
      retrievedAt: "2026-09-28T23:00:00+08:00",
    });
    expect(issues.some((issue) => issue.includes("子串"))).toBe(true);
  });

  it("rejects missing provenance, bad identity, and invalid fact types", () => {
    const base: CompanySourceFact = {
      schemaVersion: SOURCE_FACTS_SCHEMA_VERSION,
      factId: "sf_300124_000001",
      companyCode: "300124",
      companyName: "汇川技术",
      factType: "product",
      terms: [],
      rawText: "主营业务文本",
      source: { sourceId: "x", sourceName: "x", sourceType: "x" },
      retrievedAt: "2026-09-28T23:00:00+08:00",
    };
    expect(validateCompanySourceFact({ ...base, factType: "hallucination" as never }).some((i) => i.includes("factType"))).toBe(true);
    expect(validateCompanySourceFact({ ...base, rawText: "  " }).some((i) => i.includes("rawText"))).toBe(true);
    expect(
      validateCompanySourceFact({ ...base, source: { sourceId: "", sourceName: "", sourceType: "" } }).some((i) => i.includes("provenance")),
    ).toBe(true);
    expect(validateCompanySourceFact({ ...base, companyCode: "30012" }).some((i) => i.includes("6 位"))).toBe(true);
    expect(validateCompanySourceFact({ ...base, retrievedAt: "not-a-date" }).some((i) => i.includes("retrievedAt"))).toBe(true);
  });
});

describe("source facts artifact — committed evidence integrity", () => {
  it("manifest digest matches facts.jsonl bytes and schema version is pinned", () => {
    expect(existsSync(FACTS_FILE), "data/source_facts/facts.jsonl must be committed").toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as {
      schemaVersion: string;
      contentDigest: { value: string };
      factCount: number;
    };
    expect(manifest.schemaVersion).toBe(SOURCE_FACTS_SCHEMA_VERSION);
    const raw = readFileSync(FACTS_FILE, "utf8");
    expect(createHash("sha256").update(raw, "utf8").digest("hex")).toBe(manifest.contentDigest.value);
    const facts = loadFacts();
    expect(facts.length).toBe(manifest.factCount);
  });

  it("every committed fact passes the contract", () => {
    for (const fact of loadFacts()) {
      expect(validateCompanySourceFact(fact), fact.factId).toEqual([]);
    }
  });

  it("factIds are unique and sorted by (companyCode, factId)", () => {
    const facts = loadFacts();
    const ids = facts.map((fact) => fact.factId);
    expect(new Set(ids).size).toBe(ids.length);
    const sorted = [...facts].sort((a, b) => a.companyCode.localeCompare(b.companyCode) || a.factId.localeCompare(b.factId));
    expect(ids).toEqual(sorted.map((fact) => fact.factId));
  });

  it("every factType is from the closed enumeration", () => {
    for (const fact of loadFacts()) {
      expect(SOURCE_FACT_TYPES).toContain(fact.factType);
    }
  });
});

describe("source facts artifact — flagship coverage locks (real fetched evidence)", () => {
  const facts = loadFacts();
  const byCode = new Map<string, CompanySourceFact[]>();
  for (const fact of facts) {
    const bucket = byCode.get(fact.companyCode) ?? [];
    bucket.push(fact);
    byCode.set(fact.companyCode, bucket);
  }
  const companyFacts = (code: string) => byCode.get(code) ?? [];

  /**
   * 这些断言锁的是「真实抓到的 source evidence」：任一断言失败意味着
   * 上游 payload、抓取管线或证据纪律发生了退化，必须重新调查而不是改测试。
   */
  it("格力/美的 carry air-conditioning source evidence", () => {
    const gree = companyFacts("000651");
    const greeText = gree.map((fact) => fact.rawText).join("\n");
    expect(gree.some((fact) => fact.terms.includes("家用空调")), "格力缺「家用空调」证据").toBe(true);
    expect(greeText).toContain("空气调节器");
    const midea = companyFacts("000333");
    const mideaText = midea.map((fact) => fact.rawText).join("\n");
    expect(mideaText).toContain("暖通空调");
    expect(mideaText).toContain("中央空调");
  });

  it("汇川/禾川/信捷 carry servo source evidence", () => {
    for (const [code, name] of [["300124", "汇川"], ["688320", "禾川"], ["603416", "信捷"]] as const) {
      const factsOf = companyFacts(code);
      const servo = factsOf.filter((fact) => fact.terms.some((term) => term.includes("伺服")));
      expect(servo.length, `${name}缺「伺服」证据`).toBeGreaterThan(0);
      expect(servo[0].rawText).toContain("伺服");
    }
  });

  it("时代电气 carries IGBT / 功率半导体 source evidence", () => {
    const times = companyFacts("688187");
    const text = times.map((fact) => fact.rawText).join("\n");
    expect(times.some((fact) => fact.terms.includes("IGBT")), "时代电气缺「IGBT」证据").toBe(true);
    expect(text).toContain("功率半导体");
  });

  it("annual-report evidence carries page-level provenance and artifact hash", () => {
    const reports = facts.filter((fact) => fact.source.sourceType === "filing_annual_report");
    expect(reports.length).toBeGreaterThan(0);
    for (const fact of reports) {
      expect(fact.source.locator).toMatch(/#page=\d+$/);
      expect(fact.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fact.source.date, `${fact.factId} 缺披露日期`).toBeTruthy();
    }
  });
});
