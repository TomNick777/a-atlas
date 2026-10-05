/**
 * Query-plan layer contracts (Phase 3, Jev-First since Phase 3.2).
 *
 * The deterministic parser never speaks the executor's plan directly. It emits
 * a bounded PlannerOutput (§3: language understanding only), which the
 * deterministic validator (§13) checks against the QueryCapabilityRegistry
 * (§14) and the normalizer compiles into a HybridQueryPlan (lib/hybrid/
 * contracts) — the only shape the executor ever runs.
 *
 * Provenance (§24): every resolved plan records the parser route and version.
 * There is exactly one route since the general LLM planner runtime left the
 * production architecture.
 */

/** The authoritative parser version (Phase 3.2 §13 convergence). */
export const PARSER_V2_VERSION = "hybrid-parser-v2";

/** A filter exactly as an intermediate plan representation carries it —
 * stringly typed, pre-validation. */
export type PlannerOutputFilter = { field: string; op: string; value: number | boolean | string };

/** The bounded intermediate plan shape (Phase 3 §3 contract, retained): the
 * parser emits it, the deterministic validator checks it against the
 * QueryCapabilityRegistry, and the normalizer compiles it into the
 * HybridQueryPlan the executor runs. No model is involved anywhere on this
 * path — the shape is kept because the validator, the normalizer and their
 * frozen defaults are kept. */
export type PlannerOutput = {
  semantic?: string | null;
  market?: {
    date?: string;
    filters?: PlannerOutputFilter[];
    postFilters?: PlannerOutputFilter[];
    sort?: { field: string; direction: string } | null;
    limit?: number | null;
  } | null;
  comparison?: { field: string; op: string } | null;
  unsupported?: { intent: string; detail: string } | null;
  notes?: string[];
  assumptions?: string[];
};

/** Where a plan came from (§24). Attached to every HybridDiscoverResult.
 * There is exactly one route since Phase 3.2: the deterministic parser. */
export type ParserProvenance = {
  route: "deterministic";
  version: string;
  parseMs: number;
};

export function deterministicProvenance(parseMs: number): ParserProvenance {
  return { route: "deterministic", version: PARSER_V2_VERSION, parseMs };
}

/** Validator outcome (§13) — rejection carries machine-checkable reasons. */
export type PlannerValidation =
  | { ok: true; output: PlannerOutput }
  | { ok: false; reasons: string[] };
