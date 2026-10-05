/**
 * Plan Normalizer (Phase 3 §12 step 5) — compiles a VALIDATED PlannerOutput
 * into the HybridQueryPlan the executor runs. Deterministic: same validated
 * output → byte-identical plan. The normalizer is where the frozen defaults
 * live (§20): a threshold-less filter still ranks honestly, a comparison
 * without a stated sort ranks by the compared field — every default is
 * recorded in plan.assumptions, never silent.
 *
 * Order derivation is the single authority (§12: 只有一个 authoritative plan):
 * the model cannot pick an execution order; it is derived from what the plan
 * contains, exactly as the V1 planner derives it.
 */

import { HERO_LABELS } from "../hybrid/hero";
import { PARSER_V2_VERSION, type PlannerOutput, type PlannerOutputFilter } from "./contracts";
import type { ComparisonSpec, HybridQueryPlan, MarketIntent } from "../hybrid/contracts";
import type { MarketField, MarketQuerySpec } from "../market/contracts";

type MarketFilter = NonNullable<MarketQuerySpec["filters"]>[number];
type ComparisonField = ComparisonSpec["field"];

const MAX_NOTES = 8;
const MAX_NOTE_LEN = 200;

function sanitizeStrings(items: string[] | undefined): string[] {
  return (items ?? [])
    .map((item) => item.trim().slice(0, MAX_NOTE_LEN))
    .filter((item) => item.length > 0)
    .slice(0, MAX_NOTES);
}

function toFilters(items: PlannerOutputFilter[] | undefined): MarketFilter[] {
  return (items ?? []).map((f) => ({ field: f.field as MarketField, op: f.op as MarketFilter["op"], value: f.value as number | boolean }));
}

/** Frozen default-sort conventions for a threshold filter with no stated sort. */
function defaultSort(filters: MarketFilter[], comparison: ComparisonSpec | null): { field: MarketField; direction: "asc" | "desc" } | null {
  const byField = (field: MarketField) => filters.find((f) => f.field === field);
  const streak = byField("limitUpStreak");
  if (streak) return { field: "limitUpStreak", direction: "desc" };
  if (byField("isLimitDown")) return { field: "pctChange", direction: "asc" };
  const window = byField("return5d") ?? byField("return20d");
  if (window) return { field: window.field, direction: "desc" };
  const pct = byField("pctChange");
  if (pct) return { field: "pctChange", direction: typeof pct.value === "number" && pct.value < 0 ? "asc" : "desc" };
  if (byField("isLimitUp")) return { field: "pctChange", direction: "desc" };
  if (comparison) return { field: comparison.field, direction: "desc" };
  const first = filters[0];
  return first ? { field: first.field, direction: "desc" } : null;
}

export type NormalizedPlan =
  | { ok: true; plan: HybridQueryPlan }
  | { ok: false; reject: string[] };

export function normalizePlannerPlan(raw: string, output: PlannerOutput): NormalizedPlan {
  const notes = sanitizeStrings(output.notes);
  const modelAssumptions = sanitizeStrings(output.assumptions);
  const assumptions: string[] = [];

  if (output.unsupported) {
    return {
      ok: true,
      plan: {
        plannerVersion: PARSER_V2_VERSION,
        raw,
        semantic: null,
        market: null,
        execution: { order: "unsupported" },
        heroMetric: null,
        notes,
        assumptions: modelAssumptions,
        comparison: null,
        unsupported: { intent: output.unsupported.intent, detail: output.unsupported.detail },
      },
    };
  }

  const semanticText = typeof output.semantic === "string" ? output.semantic.trim() : "";
  const semantic = semanticText.length >= 2 ? semanticText : null;
  if (semanticText.length > 0 && !semantic) assumptions.push("语义残留不足 2 字，按 market-only 执行。");

  let comparison: ComparisonSpec | null = null;
  if (output.comparison) {
    comparison = { field: output.comparison.field as ComparisonField, op: output.comparison.op as ComparisonSpec["op"] };
  }

  let market: MarketIntent | null = null;
  if (output.market || comparison) {
    const filters = toFilters(output.market?.filters);
    let postFilters = toFilters(output.market?.postFilters);
    let limit = output.market?.limit ?? null;
    const sort =
      output.market?.sort && output.market.sort.direction !== undefined
        ? { field: output.market.sort.field as MarketField, direction: output.market.sort.direction as "asc" | "desc" }
        : null;

    // postFilters only mean something against a stated top-N cut; without the
    // cut they are plain eligibility filters (recorded, never silently moved).
    if (postFilters.length && typeof limit !== "number") {
      filters.push(...postFilters);
      postFilters = [];
      notes.push("postFilters 未搭配前 N 截断，按普通资格过滤处理。");
    }
    if (typeof limit === "number") limit = Math.round(limit);

    const hasMarket = filters.length > 0 || postFilters.length > 0 || sort !== null || typeof limit === "number" || comparison !== null;
    if (hasMarket) {
      let effectiveSort = sort;
      if (!effectiveSort) {
        if (typeof limit === "number" && !filters.length && !postFilters.length && !comparison) {
          return { ok: false, reject: ["声明了前 N 但没有任何排序维度——无法确定按什么取前 N（topn_without_metric）。"] };
        }
        const fallbackSort = defaultSort(filters, comparison);
        if (fallbackSort) {
          effectiveSort = fallbackSort;
          assumptions.push(`未指定排序：默认按${HERO_LABELS[fallbackSort.field]}${fallbackSort.direction === "desc" ? "从高到低" : "从低到高"}排序。`);
        } else if (typeof limit === "number") {
          return { ok: false, reject: ["声明了前 N 但没有任何排序维度——无法确定按什么取前 N（topn_without_metric）。"] };
        }
      }
      market = {
        date: "LATEST_TRADING_DAY",
        filters,
        sort: effectiveSort,
        limit: typeof limit === "number" ? limit : null,
        ...(postFilters.length ? { postFilters } : {}),
      };
    }
  }

  const hasMarket = market !== null;
  const order: HybridQueryPlan["execution"]["order"] = !hasMarket
    ? "semantic-only"
    : semantic
      ? typeof market!.limit === "number"
        ? "market-first"
        : "semantic-first"
      : "market-only";

  return {
    ok: true,
    plan: {
      plannerVersion: PARSER_V2_VERSION,
      raw,
      semantic: semantic ? { query: semantic } : null,
      market,
      execution: { order },
      heroMetric: market?.sort ? { key: market.sort.field, label: HERO_LABELS[market.sort.field] } : null,
      notes,
      assumptions: [...modelAssumptions, ...assumptions],
      comparison,
      unsupported: null,
    },
  };
}
