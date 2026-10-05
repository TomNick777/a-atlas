import { describe, expect, it } from "vitest";
import { loadDataset } from "@/lib/companies";
import { judgeProfileRef } from "@/lib/jev/capabilities";
import {
  evidenceViewsFor,
  presentDiscoverResult,
  presentSearchResult,
  profileTermHits,
  resolveEvidenceRef,
} from "@/lib/atlas/evidence";
import type { ResultJudgement } from "@/lib/types";
import type { HybridDiscoverResult } from "@/lib/hybrid/contracts";

/**
 * Evidence UX contract (Phase 3.4): every ref Atlas surfaces resolves to the
 * verbatim fact the judge read; unresolvable refs never become views; a
 * presented row without a judgement carries neither judgement nor evidence.
 */

describe("evidence view — ref resolution", () => {
  it("resolves judge-profile refs to the verbatim profile text Jev read", () => {
    const { companies } = loadDataset();
    const company = companies.find((entry) => entry.searchProfileText)!;
    const view = resolveEvidenceRef(judgeProfileRef(company.code));
    expect(view).not.toBeNull();
    expect(view!.text).toBe(company.searchProfileText);
    expect(view!.kind).toBe("judge_profile");
    expect(view!.label.length).toBeGreaterThan(0);
    expect(view!.provenance.source.length).toBeGreaterThan(0);
  });

  it("returns null for refs it cannot resolve (never invents an excerpt)", () => {
    expect(resolveEvidenceRef("judge-profile:999999")).toBeNull();
    expect(resolveEvidenceRef("topic:机器人")).toBeNull();
    expect(resolveEvidenceRef("")).toBeNull();
  });

  it("evidenceViewsFor is all-or-null: no partially grounded evidence lists", () => {
    const { companies } = loadDataset();
    const company = companies.find((entry) => entry.searchProfileText)!;
    expect(evidenceViewsFor([{ companyId: company.code, ref: judgeProfileRef(company.code) }])).toHaveLength(1);
    expect(
      evidenceViewsFor([
        { companyId: company.code, ref: judgeProfileRef(company.code) },
        { companyId: "999999", ref: judgeProfileRef("999999") },
      ]),
    ).toBeNull();
  });
});

describe("evidence view — repeated profile term hints", () => {
  it("keeps matches tied to each company's current text and returns independent arrays", () => {
    const company = loadDataset().companies[0];
    const query = "传感器，江苏";
    const first = profileTermHits(query, { ...company, searchProfileText: "传感器 江苏" });
    expect(first).toEqual(["传感器", "江苏"]);
    first.push("污染");
    expect(profileTermHits(query, { ...company, searchProfileText: "传感器" })).toEqual(["传感器"]);
    expect(profileTermHits(query, { ...company, searchProfileText: "", judgeText: "江苏" })).toEqual(["江苏"]);
    expect(profileTermHits(query, { ...company, searchProfileText: "无匹配词" })).toEqual([]);
  });

  it("preserves literal case and empty-query behavior across repeated calls", () => {
    const company = { ...loadDataset().companies[0], searchProfileText: "SENSOR" };
    expect(profileTermHits("SENSOR", company)).toEqual(["SENSOR"]);
    expect(profileTermHits("sensor", company)).toEqual([]);
    expect(profileTermHits("", company)).toEqual([]);
    expect(profileTermHits("SENSOR", company)).toEqual(["SENSOR"]);
  });
});

function syntheticJudgement(code: string): ResultJudgement {
  return {
    capability: "semantic_match",
    query: "做人形机器人减速器",
    score: 0.94,
    matched: true,
    relationLabel: null,
    evidenceRefs: [{ companyId: code, ref: judgeProfileRef(code) }],
  };
}

describe("evidence view — result presentation", () => {
  it("search hits carry their judgement and resolved evidence; degraded rows carry neither", () => {
    const { companies } = loadDataset();
    const company = companies.find((entry) => entry.searchProfileText)!;
    const other = companies.find((entry) => entry.code !== company.code && entry.searchProfileText)!;
    const result = presentSearchResult({
      query: "做人形机器人减速器",
      hits: [
        { code: company.code, name: company.name, probability: 0.94, industry: company.industry, swLevel1Industry: company.swLevel1Industry, province: company.region.province, business: company.businessDescription },
        { code: other.code, name: other.name, probability: 0.31, industry: other.industry, swLevel1Industry: other.swLevel1Industry, province: other.region.province, business: other.businessDescription },
      ],
      matches: 1,
      degraded: false,
      judge: { provider: "jev", model: "test-model", outcome: "ok" },
      tokens: 0,
      costUsd: null,
      decidedBy: "jev",
      judgements: { [company.code]: syntheticJudgement(company.code) },
    });
    expect(result.hits[0].judgement?.score).toBe(0.94);
    expect(result.hits[0].evidence).toHaveLength(1);
    expect(result.hits[0].evidence![0].text).toBe(company.searchProfileText);
    // No judgement → no evidence claims at all.
    expect(result.hits[1].judgement).toBeNull();
    expect(result.hits[1].evidence).toBeNull();
  });

  it("discover rows carry judgement + evidence from the domain row", () => {
    const { companies } = loadDataset();
    const company = companies.find((entry) => entry.searchProfileText)!;
    const domain = {
      query: "做人形机器人减速器",
      plan: { plannerVersion: "t", raw: "q", semantic: null, market: null, execution: { order: "semantic-only" as const }, heroMetric: null, notes: [], unsupported: null },
      parser: { route: "deterministic", version: "t" },
      execution: { order: "semantic-only" as const, timings: { parserMs: 0, semanticMs: null, marketMs: null, mergeMs: null, totalMs: 0 }, degraded: false, degradedReason: null, decidedBy: "jev" as const, counts: {}, marketDate: null, stateDigest16: null },
      results: [
        {
          code: company.code,
          name: company.name,
          exchange: null,
          board: null,
          industry: null,
          swLevel1Industry: null,
          province: null,
          business: null,
          probability: 0.94,
          semantic: { query: "做人形机器人减速器", score: 0.94, matchedFacts: ["谐波减速器"] },
          market: null,
          hero: null,
          judgement: syntheticJudgement(company.code),
        },
      ],
      planCaption: "",
      intelligence: null,
      searchId: null,
      ms: 0,
    } as unknown as HybridDiscoverResult;
    const presented = presentDiscoverResult(domain);
    expect(presented.results[0].judgement?.evidenceRefs).toHaveLength(1);
    expect(presented.results[0].evidence![0].text).toBe(company.searchProfileText);
  });

  it("a judgement whose refs fail resolution presents evidence: null (unavailable, never fabricated)", () => {
    const judgement = { ...syntheticJudgement("999999"), evidenceRefs: [{ companyId: "999999", ref: judgeProfileRef("999999") }] };
    const presented = presentSearchResult({
      query: "q",
      hits: [{ code: "999999", name: "不存在", probability: 0.5, industry: "i", swLevel1Industry: "s", province: "p", business: "b" }],
      matches: 1,
      degraded: false,
      judge: { provider: "jev", model: "m", outcome: "ok" },
      tokens: 0,
      costUsd: null,
      decidedBy: "jev",
      judgements: { "999999": judgement },
    });
    expect(presented.hits[0].judgement).not.toBeNull();
    expect(presented.hits[0].evidence).toBeNull();
  });
});
