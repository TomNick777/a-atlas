/**
 * Query compiler (Phase 3.2) — the ONE authoritative path from a raw query to
 * an executable plan.
 *
 *   User Query → Deterministic Parser V2 → PlannerOutput
 *              → Validator (capability registry) → Normalizer (frozen defaults)
 *              → HybridQueryPlan
 *
 * Queries the V2 grammar does not claim fall through to the frozen V1 parse
 * (byte-identical Phase 2 behaviour); V1 refusal disciplines stay final. There
 * is no LLM anywhere on this path — "route" is always "deterministic", and a
 * parser output that fails its own validator is a grammar/registry drift and
 * fails loudly (never silently guessed).
 */

import { parseQueryOutput } from "./parser-v2";
import { parseHybridQuery, parseNumber, SORT_RULES } from "./planner";
import { SELECTION_COUNT_RE, MARKET_SUBSET_RE, MARKET_ALL_RE } from "../planner/grammar";
import { validatePlannerOutput } from "../planner/validate";
import { normalizePlannerPlan } from "../planner/normalize";
import { PARSER_V2_VERSION, deterministicProvenance, type ParserProvenance } from "../planner/contracts";
import { MARKET_SELECTION_VERSION, type HybridQueryPlan } from "./contracts";

export type PlanResolution = {
  plan: HybridQueryPlan;
  provenance: ParserProvenance;
};

export function compileLegacyHybridQuery(rawInput: string): PlanResolution {
  const raw = rawInput.trim();
  const started = performance.now();

  const output = parseQueryOutput(raw);
  let plan: HybridQueryPlan;
  if (!output) {
    // No V2 construct: the frozen V1 parse is the answer, byte-identical.
    plan = { ...parseHybridQuery(raw), plannerVersion: PARSER_V2_VERSION };
  } else {
    const validation = validatePlannerOutput(output);
    if (!validation.ok) {
      throw new Error(`parser-v2 emitted an invalid plan for「${raw}」: ${validation.reasons.slice(0, 3).join("；")}`);
    }
    const normalized = normalizePlannerPlan(raw, validation.output);
    if (!normalized.ok) {
      throw new Error(`parser-v2 plan rejected by the normalizer for「${raw}」: ${normalized.reject.join("；")}`);
    }
    plan = normalized.plan;
  }

  return { plan, provenance: deterministicProvenance(Math.round(performance.now() - started)) };
}

/** Scope syntax contains only quantity/set operators; the business residual is
 * passed through verbatim. The frozen compiler remains an explicit replay API. */
export function compileHybridQuery(rawInput: string): PlanResolution {
  const raw = rawInput.trim();
  // These are set/quantity words, never a business vocabulary.
  const count = SELECTION_COUNT_RE.exec(raw);
  const scopeCut = MARKET_SUBSET_RE.test(raw);
  const marketAll = raw.match(MARKET_ALL_RE) !== null;
  let resolution = compileLegacyHybridQuery(raw.replace(MARKET_ALL_RE, ""));
  if (!resolution.plan.market) return compileLegacyHybridQuery(raw);
  const countFollowsSort = count && SORT_RULES.some(({ re }) => {
    const sort = re.exec(raw);
    return sort && sort.index + sort[0].length <= count.index && /^[的\s]*$/.test(raw.slice(sort.index + sort[0].length, count.index));
  });
  if (count && countFollowsSort && resolution.plan.market.limit === null && !resolution.plan.unsupported) {
    const stripped = raw.slice(0, count.index) + raw.slice(count.index + count[0].length);
    resolution = compileLegacyHybridQuery(stripped.replace(MARKET_ALL_RE, ""));
    if (resolution.plan.market) resolution.plan.market.limit = parseNumber(count[1]);
  }
  const plan = { ...resolution.plan, raw };
  if (plan.market && plan.semantic && !plan.unsupported) {
    const limit = plan.market.limit ?? 20;
    if (limit < 1 || limit > 100) {
      plan.execution = { order: "unsupported" };
      plan.unsupported = { intent: "unsupported_limit", detail: "业务行情查询数量必须为 1–100。" };
    } else {
      const scope = scopeCut || marketAll || Boolean(plan.market.postFilters?.length) ? "market-topn-subset" : "business-topk";
      plan.selection = { version: MARKET_SELECTION_VERSION, scope, limit };
      plan.execution = { order: scope === "business-topk" ? "semantic-first" : "market-first" };
      plan.plannerVersion = `${plan.plannerVersion}+${MARKET_SELECTION_VERSION}`;
    }
  }
  return { ...resolution, plan };
}
