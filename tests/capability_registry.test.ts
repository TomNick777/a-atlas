import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MARKET_FIELDS } from "../lib/market/contracts";
import { QUERY_CAPABILITY_REGISTRY, fieldCapability, isPostFilterable, queryCapabilities } from "../lib/planner/capabilities";
import { validatePlannerOutput } from "../lib/planner/validate";
import { normalizePlannerPlan } from "../lib/planner/normalize";
import { PARSER_V2_VERSION } from "../lib/planner/contracts";
import { QUERY_GRAMMAR_REGISTRY_VERSION, grammarSummary } from "../lib/planner/grammar";

/**
 * Phase 3 §13/§14, Jev-First since Phase 3.2 — the capability registry is the
 * single authority on what the EXECUTOR can answer; the validator is the
 * deterministic safety boundary between any plan source and the executor.
 * Every illegal class of plan output is rejected (§H of the Phase 3 report),
 * never silently ignored. The grammar registry (§14 Phase 3.2) stays aligned:
 * it describes how capabilities are WRITTEN, never what they MEAN.
 */

describe("capability registry — integrity (§14)", () => {
  it("describes exactly the Market State fields, nothing invented, nothing missing", () => {
    expect(new Set(QUERY_CAPABILITY_REGISTRY.fields.map((f) => f.field))).toEqual(new Set<string>(MARKET_FIELDS));
  });

  it("postFilterable is exactly the fields the executor's market rows carry", () => {
    const carried = ["close", "pctChange", "volume", "amount", "turnoverRate", "marketCapYi", "isLimitUp", "isLimitDown", "limitUpStreak", "return5d", "return20d", "volumeRatio20d"];
    for (const f of QUERY_CAPABILITY_REGISTRY.fields) {
      expect(f.postFilterable).toBe(carried.includes(f.field));
      expect(isPostFilterable(f.field)).toBe(f.postFilterable);
    }
  });

  it("boolean fields only ever offer ==/!=; numeric fields offer the full set", () => {
    for (const f of QUERY_CAPABILITY_REGISTRY.fields) {
      if (f.type === "boolean") expect(f.ops).toEqual(["==", "!="]);
      else expect(f.ops).toContain(">=");
    }
  });

  it("comparison exposes only day-over-day computable fields with a PREV baseline", () => {
    expect(QUERY_CAPABILITY_REGISTRY.comparison.fields).toEqual(["amount", "volume", "close"]);
    expect(QUERY_CAPABILITY_REGISTRY.comparison.baseline).toBe("PREV_TRADING_DAY");
  });

  it("the parser versions converge on the single authoritative parser", () => {
    expect(QUERY_CAPABILITY_REGISTRY.parserVersions).toEqual({ authoritative: PARSER_V2_VERSION, v1Baseline: "hybrid-planner-v1" });
    expect(queryCapabilities().registryVersion).toBe("query-capability-registry-1");
  });
});

const ok = (output: unknown) => expect(validatePlannerOutput(output)).toMatchObject({ ok: true });

describe("plan validator — every illegal class is rejected (§13/§H)", () => {
  it("accepts a well-formed multi-filter plan", () => {
    ok({
      semantic: "机器人",
      market: { date: "LATEST_TRADING_DAY", filters: [{ field: "amount", op: ">", value: 5e9 }, { field: "turnoverRate", op: ">", value: 5 }], postFilters: [], sort: null, limit: null },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
  });

  it("rejects an unknown (invented) field — momentum_score / hotness / future_return", () => {
    for (const field of ["momentum_score", "hotness", "future_return", "quality"]) {
      const result = validatePlannerOutput({
        semantic: null,
        market: { filters: [{ field, op: ">", value: 1 }], postFilters: [], sort: null, limit: null },
        comparison: null, unsupported: null, notes: [], assumptions: [],
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reasons.join(" ")).toContain("未知字段");
    }
  });

  it("rejects an invalid operator", () => {
    const result = validatePlannerOutput({
      semantic: null,
      market: { filters: [{ field: "amount", op: ">>>", value: 1 }], postFilters: [], sort: null, limit: null },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects an operator the field does not support (boolean == with a number)", () => {
    const result = validatePlannerOutput({
      semantic: null,
      market: { filters: [{ field: "isLimitUp", op: "==", value: 1 }], postFilters: [], sort: null, limit: null },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reasons.join(" ")).toContain("true/false");
  });

  it("rejects an invalid sort field and a malformed direction", () => {
    const base = { comparison: null, unsupported: null, notes: [], assumptions: [] };
    const bad1 = validatePlannerOutput({ semantic: null, market: { filters: [], postFilters: [], sort: { field: "hotness", direction: "desc" }, limit: null }, ...base });
    const bad2 = validatePlannerOutput({ semantic: null, market: { filters: [], postFilters: [], sort: { field: "amount", direction: "up" }, limit: null }, ...base });
    expect(bad1).toMatchObject({ ok: false });
    expect(bad2).toMatchObject({ ok: false });
  });

  it("rejects a bad date expression — yesterday is not queryable", () => {
    const result = validatePlannerOutput({
      semantic: null,
      market: { date: "PREV_TRADING_DAY", filters: [], postFilters: [], sort: null, limit: null },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reasons.join(" ")).toContain("LATEST_TRADING_DAY");
  });

  it("rejects an out-of-range numeric value (unit mix-up)", () => {
    const result = validatePlannerOutput({
      semantic: null,
      market: { filters: [{ field: "pctChange", op: ">", value: 500 }], postFilters: [], sort: null, limit: null },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reasons.join(" ")).toContain("范围");
  });

  it("rejects an illegal execution mode — a plan source cannot emit an order at all", () => {
    const result = validatePlannerOutput({
      semantic: null,
      market: { filters: [], postFilters: [], sort: { field: "amount", direction: "desc" }, limit: null },
      execution: { order: "market-only" },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reasons.join(" ")).toContain("非法顶层字段");
  });

  it("rejects a non-postFilterable field used as postFilter", () => {
    const result = validatePlannerOutput({
      semantic: null,
      market: { filters: [], postFilters: [{ field: "avgVolume20d", op: ">", value: 1 }], sort: { field: "amount", direction: "desc" }, limit: 50 },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects an unknown unsupported intent and a mixed refusal+plan", () => {
    const base = { semantic: null, market: null, comparison: null, notes: [], assumptions: [] };
    const badIntent = validatePlannerOutput({ ...base, unsupported: { intent: "make_money", detail: "x" } });
    const mixed = validatePlannerOutput({ ...base, market: { filters: [], postFilters: [], sort: { field: "amount", direction: "desc" }, limit: null }, unsupported: { intent: "investment_advice", detail: "x" } });
    expect(badIntent).toMatchObject({ ok: false });
    expect(mixed).toMatchObject({ ok: false });
  });

  it("rejects the empty plan — neither compiled nor refused", () => {
    const result = validatePlannerOutput({ semantic: null, market: null, comparison: null, unsupported: null, notes: [], assumptions: [] });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reasons.join(" ")).toContain("空计划");
  });

  it("rejects a stated top-N with nothing to rank by (topn_without_metric)", () => {
    const result = validatePlannerOutput({
      semantic: "机器人",
      market: { filters: [], postFilters: [], sort: null, limit: 20 },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects an out-of-bounds limit, oversized filter arrays and duplicate filters", () => {
    const base = { comparison: null, unsupported: null, notes: [], assumptions: [] };
    expect(validatePlannerOutput({ semantic: null, market: { filters: [], postFilters: [], sort: { field: "amount", direction: "desc" }, limit: 400 }, ...base })).toMatchObject({ ok: false });
    expect(validatePlannerOutput({ semantic: null, market: { filters: [
      { field: "amount", op: ">", value: 1 }, { field: "volume", op: ">", value: 1 }, { field: "close", op: ">", value: 1 }, { field: "pctChange", op: ">", value: 1 },
    ], postFilters: [], sort: null, limit: null }, ...base })).toMatchObject({ ok: false });
    expect(validatePlannerOutput({ semantic: null, market: { filters: [{ field: "amount", op: ">", value: 1 }, { field: "amount", op: ">", value: 1 }], postFilters: [], sort: null, limit: null }, ...base })).toMatchObject({ ok: false });
  });

  it("rejects a comparison on a non-computable field", () => {
    const result = validatePlannerOutput({
      semantic: "机器人",
      market: { filters: [], postFilters: [], sort: null, limit: null },
      comparison: { field: "turnoverRate", op: ">" },
      unsupported: null, notes: [], assumptions: [],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("accepts a refusal shape with everything else null", () => {
    ok({ semantic: null, market: null, comparison: null, unsupported: { intent: "investment_advice", detail: "不做买卖建议" }, notes: [], assumptions: [] });
  });
});

describe("capability spot checks", () => {
  it("amount is in 元 with a wide range; marketCapYi is 亿元", () => {
    expect(fieldCapability("amount")?.unit).toBe("元");
    expect(fieldCapability("marketCapYi")?.unit).toBe("亿元");
    expect(fieldCapability("volumeRatio20d")?.unit).toBe("倍");
  });
});

describe("query grammar registry — the write-side contract (Phase 3.2 §14/§16)", () => {
  it("carries a stable version and a complete summary for the report/CLI", () => {
    expect(QUERY_GRAMMAR_REGISTRY_VERSION).toBe("query-grammar-2");
    const summary = grammarSummary() as Record<string, unknown>;
    for (const key of ["time", "numeric", "operators", "marketFieldAliases", "topN", "postFilter", "comparison", "ambiguity", "unsupported", "semanticBoundary"]) {
      expect(summary[key], key).toBeDefined();
    }
  });

  it("stays semantic-free: no industry/product/concept word ever enters the grammar (§16)", () => {
    const src = readFileSync("lib/planner/grammar.ts", "utf8");
    for (const word of ["机器人", "半导体", "储能", "光模块", "创新药", "消费电子", "AI芯片", "人形机器人"]) {
      expect(src).not.toContain(word);
    }
  });

  it("the normalizer stamps the authoritative parser version on compiled plans", () => {
    const normalized = normalizePlannerPlan("今天成交额超过50亿的机器人公司", {
      semantic: "机器人",
      market: { date: "LATEST_TRADING_DAY", filters: [{ field: "amount", op: ">", value: 5e9 }], postFilters: [], sort: null, limit: null },
      comparison: null, unsupported: null, notes: [], assumptions: [],
    });
    expect(normalized).toMatchObject({ ok: true });
    if (normalized.ok) expect(normalized.plan.plannerVersion).toBe(PARSER_V2_VERSION);
  });
});
