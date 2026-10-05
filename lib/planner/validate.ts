/**
 * Plan Validator (Phase 3 §13) — the deterministic safety boundary between the
 * LLM and the executor. Three layers, all must pass (§17):
 *
 *   1. structural   — the JSON has exactly the allowed keys/shapes (unknown
 *                     fields are REJECTED, never silently ignored);
 *   2. semantic     — cross-field rules (unsupported exclusivity, non-empty
 *                     plans, limit with nothing to rank);
 *   3. capability   — every field/op/value against the QueryCapabilityRegistry
 *                     (unknown field, invalid operator, out-of-range value,
 *                     non-postFilterable postFilter, bad date → reject).
 *
 * The validator never rewrites the model's intent: it accepts or rejects.
 * Normalization (defaults, order derivation) happens only after acceptance.
 */

import { QUERY_CAPABILITY_REGISTRY, fieldCapability, isPostFilterable } from "./capabilities";
import type { PlannerOutput, PlannerOutputFilter, PlannerValidation } from "./contracts";

const REG = QUERY_CAPABILITY_REGISTRY;
const NUMERIC_OPS = new Set([">=", ">", "<=", "<", "==", "!="]);
const COMPARISON_OPS = new Set<string>(REG.comparison.ops);

function reason(path: string, problem: string): string {
  return `${path}: ${problem}`;
}

function checkFilter(filter: unknown, path: string, postFilter: boolean): string[] {
  const problems: string[] = [];
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    return [reason(path, "必须是 {field, op, value} 对象。")];
  }
  const allowed = new Set(["field", "op", "value"]);
  for (const key of Object.keys(filter as object)) {
    if (!allowed.has(key)) problems.push(reason(`${path}.${key}`, "非法字段——filter 只允许 field/op/value。"));
  }
  const f = filter as PlannerOutputFilter;
  const cap = typeof f.field === "string" ? fieldCapability(f.field) : null;
  if (!cap) {
    problems.push(reason(`${path}.field`, `未知字段「${String(f.field)}」——不在 capability registry（禁止编造 momentum_score/hotness 等不存在的能力）。`));
    return problems;
  }
  if (postFilter ? !isPostFilterable(cap.field) : !cap.filterable) {
    problems.push(reason(`${path}.field`, `字段「${f.field}」不可用作 ${postFilter ? "postFilter" : "filter"}。`));
  }
  if (typeof f.op !== "string" || !NUMERIC_OPS.has(f.op)) {
    problems.push(reason(`${path}.op`, `非法操作符「${String(f.op)}」。`));
  } else if (!cap.ops.includes(f.op as never)) {
    problems.push(reason(`${path}.op`, `字段「${f.field}」（${cap.type}）不支持操作符「${f.op}」（允许：${cap.ops.join("/")}）。`));
  }
  if (cap.type === "boolean") {
    if (typeof f.value !== "boolean") problems.push(reason(`${path}.value`, `布尔字段「${f.field}」的 value 必须是 true/false。`));
  } else if (typeof f.value !== "number" || !Number.isFinite(f.value)) {
    problems.push(reason(`${path}.value`, `数值字段「${f.field}」的 value 必须是有限数字（不得传字符串）。`));
  } else if (cap.range && (f.value < cap.range.min || f.value > cap.range.max)) {
    problems.push(reason(`${path}.value`, `数值 ${f.value} 超出「${f.field}」（${cap.label}，单位 ${cap.unit}）的合理范围 ${cap.range.min}–${cap.range.max}——疑似单位错误。`));
  }
  return problems;
}

function checkFilters(filters: unknown, path: string, postFilter: boolean, max: number): string[] {
  if (filters === undefined || filters === null) return [];
  if (!Array.isArray(filters)) return [reason(path, "必须是数组。")];
  const problems: string[] = [];
  if (filters.length > max) problems.push(reason(path, `条件数量 ${filters.length} 超过上限 ${max}。`));
  const seen = new Set<string>();
  for (const [index, filter] of filters.entries()) {
    problems.push(...checkFilter(filter, `${path}[${index}]`, postFilter));
    if (typeof filter === "object" && filter !== null) {
      const f = filter as PlannerOutputFilter;
      const key = `${f.field}|${f.op}|${String(f.value)}`;
      if (seen.has(key)) problems.push(reason(`${path}[${index}]`, `重复条件 ${key}。`));
      seen.add(key);
    }
  }
  return problems;
}

/** §13 — the three validation layers. */
export function validatePlannerOutput(parsed: unknown): PlannerValidation {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reasons: ["输出必须是 JSON 对象。"] };
  }
  const problems: string[] = [];
  const allowedTop = new Set(["semantic", "market", "comparison", "unsupported", "notes", "assumptions"]);
  for (const key of Object.keys(parsed as object)) {
    if (!allowedTop.has(key)) problems.push(reason(key, "非法顶层字段——输出契约只允许 semantic/market/comparison/unsupported/notes/assumptions。"));
  }
  const out = parsed as PlannerOutput;

  // unsupported must be a well-formed refusal when present.
  let unsupportedIntent: string | null = null;
  if (out.unsupported !== undefined && out.unsupported !== null) {
    const u = out.unsupported as Record<string, unknown>;
    if (typeof u !== "object" || typeof u.intent !== "string" || typeof u.detail !== "string") {
      problems.push(reason("unsupported", "必须是 {intent, detail}。"));
    } else {
      if (!(REG.unsupportedIntents as readonly string[]).includes(u.intent)) {
        problems.push(reason("unsupported.intent", `未知意图「${u.intent}」——允许：${REG.unsupportedIntents.join("/")}。`));
      }
      if (u.detail.length > 200) problems.push(reason("unsupported.detail", "detail 超过 200 字。"));
      unsupportedIntent = u.intent;
    }
  }

  if (out.semantic !== undefined && out.semantic !== null) {
    if (typeof out.semantic !== "string") problems.push(reason("semantic", "必须是 string 或 null。"));
    else if (out.semantic.length && (out.semantic.length < REG.semantic.minLength || out.semantic.length > REG.semantic.maxLength)) {
      problems.push(reason("semantic", `长度 ${out.semantic.length} 超出 ${REG.semantic.minLength}–${REG.semantic.maxLength}（过短/过长都说明编译不干净）。`));
    }
  }

  let hasMarketContent = false;
  if (out.market !== undefined && out.market !== null) {
    if (typeof out.market !== "object" || Array.isArray(out.market)) {
      problems.push(reason("market", "必须是对象或 null。"));
    } else {
      const market = out.market as NonNullable<PlannerOutput["market"]> & Record<string, unknown>;
      const allowedMarket = new Set(["date", "filters", "postFilters", "sort", "limit"]);
      for (const key of Object.keys(market)) {
        if (!allowedMarket.has(key)) problems.push(reason(`market.${key}`, "非法字段——market 只允许 date/filters/postFilters/sort/limit。"));
      }
      if (market.date !== undefined && market.date !== null && market.date !== "LATEST_TRADING_DAY") {
        problems.push(reason("market.date", `「${String(market.date)}」不可查询——date 只能是 LATEST_TRADING_DAY（历史日不在能力内）。`));
      }
      problems.push(...checkFilters(market.filters, "market.filters", false, 3));
      problems.push(...checkFilters(market.postFilters, "market.postFilters", true, 2));
      if (market.sort !== undefined && market.sort !== null) {
        if (typeof market.sort !== "object" || Array.isArray(market.sort)) {
          problems.push(reason("market.sort", "必须是 {field, direction} 或 null。"));
        } else {
          const sort = market.sort as { field?: unknown; direction?: unknown };
          const extra = Object.keys(market.sort as object).filter((k) => k !== "field" && k !== "direction");
          for (const key of extra) problems.push(reason(`market.sort.${key}`, "非法字段。"));
          const cap = typeof sort.field === "string" ? fieldCapability(sort.field) : null;
          if (!cap) problems.push(reason("market.sort.field", `未知排序字段「${String(sort.field)}」。`));
          else if (!cap.sortable) problems.push(reason("market.sort.field", `字段「${sort.field}」不可排序。`));
          if (sort.direction !== "asc" && sort.direction !== "desc") problems.push(reason("market.sort.direction", `必须是 asc/desc，得到「${String(sort.direction)}」。`));
        }
      }
      if (market.limit !== undefined && market.limit !== null) {
        if (!Number.isInteger(market.limit) || (market.limit as number) < REG.market.limitBounds.min || (market.limit as number) > REG.market.limitBounds.max) {
          problems.push(reason("market.limit", `必须是 ${REG.market.limitBounds.min}–${REG.market.limitBounds.max} 的整数。`));
        }
      }
      hasMarketContent = Boolean(
        (Array.isArray(market.filters) && market.filters.length) ||
          (Array.isArray(market.postFilters) && market.postFilters.length) ||
          market.sort ||
          (typeof market.limit === "number" && market.limit > 0),
      );
    }
  }

  let hasComparison = false;
  if (out.comparison !== undefined && out.comparison !== null) {
    if (typeof out.comparison !== "object" || Array.isArray(out.comparison)) {
      problems.push(reason("comparison", "必须是 {field, op} 或 null。"));
    } else {
      const cmp = out.comparison as Record<string, unknown>;
      for (const key of Object.keys(cmp)) {
        if (key !== "field" && key !== "op") problems.push(reason(`comparison.${key}`, "非法字段——comparison 只允许 field/op（日期固定为 今日 vs PREV_TRADING_DAY）。"));
      }
      const cap = typeof cmp.field === "string" ? fieldCapability(cmp.field) : null;
      if (!cap || !(REG.comparison.fields as readonly string[]).includes(cap.field)) {
        problems.push(reason("comparison.field", `「${String(cmp.field)}」不可做日环比——允许：${REG.comparison.fields.join("/")}。`));
      }
      if (typeof cmp.op !== "string" || !COMPARISON_OPS.has(cmp.op)) {
        problems.push(reason("comparison.op", `非法比较操作符「${String(cmp.op)}」。`));
      }
      hasComparison = Boolean(cap && (REG.comparison.fields as readonly string[]).includes(cap.field) && typeof cmp.op === "string" && COMPARISON_OPS.has(cmp.op));
    }
  }

  if (out.notes !== undefined && (!Array.isArray(out.notes) || out.notes.some((n) => typeof n !== "string"))) {
    problems.push(reason("notes", "必须是字符串数组。"));
  } else if (Array.isArray(out.notes) && out.notes.length > 8) {
    problems.push(reason("notes", "超过 8 条。"));
  }
  if (out.assumptions !== undefined && (!Array.isArray(out.assumptions) || out.assumptions.some((n) => typeof n !== "string"))) {
    problems.push(reason("assumptions", "必须是字符串数组。"));
  } else if (Array.isArray(out.assumptions) && out.assumptions.length > 8) {
    problems.push(reason("assumptions", "超过 8 条。"));
  }

  // --- semantic layer: cross-field rules ---
  if (unsupportedIntent !== null) {
    if (out.semantic != null || out.market != null || out.comparison != null) {
      problems.push(reason("unsupported", "unsupported 非 null 时 semantic/market/comparison 必须全为 null（单一诚实拒绝）。"));
    }
  } else {
    const hasSemantic = typeof out.semantic === "string" && out.semantic.length > 0;
    if (!hasSemantic && !hasMarketContent && !hasComparison) {
      problems.push(reason("plan", "空计划：semantic/market/comparison 全空且无 unsupported——模型既未编译也未拒绝。"));
    }
    // A stated limit with nothing to rank by is V1's topn_without_metric rule.
    const market = out.market ?? null;
    const noRank = !market?.sort && !(Array.isArray(market?.filters) && market.filters.length) && !hasComparison;
    if (market && typeof market.limit === "number" && noRank) {
      problems.push(reason("market.limit", "声明了前 N 但没有任何排序维度/条件——无法确定按什么取前 N。"));
    }
  }

  if (problems.length) return { ok: false, reasons: problems };
  return { ok: true, output: parsed as PlannerOutput };
}
