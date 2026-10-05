/**
 * Market Intelligence Phase 2 — Hybrid Market Discovery contracts
 * (reports/HYBRID_MARKET_DISCOVERY/REPORT.md).
 *
 * The contract: natural language is compiled by a deterministic planner into a
 * serializable HybridQueryPlan; the executor runs that plan against the
 * existing discovery (semantic) path and the Phase 1 Market Query (market)
 * path — never fusing the two scores. Rank order always comes from exactly one
 * side:
 *
 *   semantic-only   — today's discovery, untouched (plan.market === null)
 *   market-only     — Phase 1 Market Query, untouched (plan.semantic === null)
 *   semantic-first  — semantic decides WHO is eligible, market metric ranks
 *   market-first    — market metric picks the set, semantic decides WHO matches
 *
 * Determinism (§17): the plan is a pure function of (raw, plannerVersion).
 * Given the same corpus, market snapshot and planner version, the candidate
 * set and ranking are reproducible; the cloud judge only ever decides
 * membership (as in existing discovery), and `skipJev` replay is fully
 * deterministic for offline fixtures.
 */

import type { MarketField, MarketQuerySpec, MarketStateRow } from "../market/contracts";
import type { ParserProvenance } from "../planner/contracts";
import type { ResultJudgement, SearchIntelligence } from "../types";
import type { JevValue } from "../telemetry/jev";

/** Bumped when parse rules change; recorded in every plan. */
export const HYBRID_PLANNER_VERSION = "hybrid-planner-v1";
export const MARKET_SELECTION_VERSION = "market-selection-1";
export type MarketSelectionScope = "business-topk" | "market-topn-subset";

export type ExecutionOrder = "semantic-only" | "market-only" | "semantic-first" | "market-first" | "unsupported";

/** The market half of a plan. `date` is always LATEST_TRADING_DAY in Phase 2 —
 * explicit trading dates are not part of the frozen vocabulary. Phase 3 v2
 * adds optional `postFilters`: eligibility applied AFTER the top-N cut
 * (「成交额前100里涨停」— the cut is by the metric, the filter keeps members). */
export type MarketIntent = {
  date: "LATEST_TRADING_DAY";
  filters: NonNullable<MarketQuerySpec["filters"]>;
  sort: NonNullable<MarketQuerySpec["sort"]> | null;
  /** Top-N the query stated (成交额前20); null when unstated. */
  limit: number | null;
  /** v2 only — post-cut eligibility. Absent (undefined) on V1 plans. */
  postFilters?: NonNullable<MarketQuerySpec["filters"]>;
};

/** §10 (Phase 3) — day-over-day comparison eligibility: `today.field op
 * previousTradingDay.field`. Left is always LATEST_TRADING_DAY, right is
 * always PREV_TRADING_DAY (frozen v2 shape); the field set is the capability
 * registry's comparison list — exactly what Market Data daily rows can answer.
 * Evaluated deterministically against Market Data daily rows — the Market
 * State artifact is untouched. */
export type ComparisonSpec = {
  field: "amount" | "volume" | "close";
  op: ">" | ">=" | "<" | "<=";
};

export type HybridQueryPlan = {
  plannerVersion: string;
  raw: string;
  /** The semantic residual (§4) — what the market words left behind. */
  semantic: { query: string } | null;
  market: MarketIntent | null;
  execution: { order: ExecutionOrder };
  /** Which field the result card leads with (§9) — decided by the plan, not the UI. */
  heroMetric: { key: MarketField; label: string } | null;
  /** Recorded interpretations of ambiguous phrasing (§12) — never silent. */
  notes: string[];
  /** §13 — the query asks for something Phase 2 must not pretend to answer. */
  unsupported: { intent: string; detail: string } | null;
  /** Phase 3 v2 (LLM route only) — day-over-day comparison eligibility. */
  comparison?: ComparisonSpec | null;
  /** Phase 3 v2 — defaults the normalizer applied (distinct from the model's
   * own interpretation notes; both are recorded, never silent). */
  assumptions?: string[];
  selection?: { version: typeof MARKET_SELECTION_VERSION; scope: MarketSelectionScope; limit: number };
};

/** A formatted hero metric value: the number that explains the rank. */
export type HeroMetric = {
  key: MarketField;
  label: string;
  value: number | boolean | null;
  formatted: string;
};

export type SemanticEvidence = {
  query: string;
  /** Discovery probability (0..1) from the existing path; null when no semantic took part. */
  score: number | null;
  /** Deterministic corpus word hits — terms from the query found in company text. */
  matchedFacts: string[];
};

export type MarketEvidence = {
  tradeDate: string;
  metric: HeroMetric | null;
  state: Pick<
    MarketStateRow,
    | "close"
    | "pctChange"
    | "volume"
    | "amount"
    | "turnoverRate"
    | "marketCapYi"
    | "isLimitUp"
    | "isLimitDown"
    | "limitUpStreak"
    | "return5d"
    | "return20d"
    | "volumeRatio20d"
  >;
};

export type HybridResultRow = {
  /** Rank in the declared scope; a market TopN subset keeps original ranks. */
  rank?: number;
  code: string;
  name: string;
  exchange: "SH" | "SZ" | "BJ" | null;
  board: string | null;
  industry: string | null;
  /** Slim universe identity for market-only rows; full identity for rows that
   * passed the semantic layer. Null fields are honest absence. */
  swLevel1Industry: string | null;
  province: string | null;
  business: string | null;
  /** Semantic probability when the semantic layer took part (UI compatibility). */
  probability: number | null;
  semantic: SemanticEvidence | null;
  market: MarketEvidence | null;
  hero: HeroMetric | null;
  /** Phase 3.4 — the live Jev decision behind this row, with its evidenceRefs.
   * Null when no live judgement backs the row (degraded / market-only): the
   * deterministic blend is never dressed up as a judgement. Evidence text
   * resolves at the API boundary (lib/atlas/evidence), not in the domain. */
  judgement: ResultJudgement | null;
};

export type HybridExecutionTimings = {
  parserMs: number;
  semanticMs: number | null;
  marketMs: number | null;
  mergeMs: number | null;
  totalMs: number;
};

export type HybridExecution = {
  selection?: { scope: MarketSelectionScope; requested: number; pool: number; scanned: number; confirmed: number; unknown: number; cacheHits: number; batches: number; complete: boolean; stopped: string; budget: { maxScanned: number; maxBatches: number; maxMs: number; maxEstimatedCostUsd: number }; estimatedCostUsd: number };
  order: ExecutionOrder;
  timings: HybridExecutionTimings;
  /** Judge unavailable → deterministic blend, honestly labelled (never a second judge). */
  degraded: boolean;
  degradedReason: string | null;
  decidedBy: "jev" | "retrieval" | "market" | null;
  counts: {
    /** semantic-only/semantic-first: hits the discovery path returned. */
    semanticCandidates?: number;
    /** Rows that passed semantic eligibility (SHOWN contract / judge threshold). */
    semanticEligible?: number;
    /** market-first: size of the market set before semantic matching. */
    marketSetSize?: number;
    /** market-only/market-first: rows the market query considered (post-filter). */
    marketTotal?: number;
    /** v2: rows surviving the post-top-N eligibility (postFilters/comparison). */
    marketPostEligible?: number;
  };
  marketDate: string | null;
  stateDigest16: string | null;
};

export type HybridDiscoverResult = {
  marketSnapshot?: import("../market/contracts").MarketStateManifest["runtime"] | null;
  query: string;
  plan: HybridQueryPlan;
  /** Phase 3.2 §24 — which parser compiled the query. One route exists:
   * the deterministic parser (route/version only; no runtime fields). */
  parser: ParserProvenance;
  execution: HybridExecution;
  results: HybridResultRow[];
  /** One line the UI can show as "why this rank" (§16). Empty for semantic-only. */
  planCaption: string;
  /** Phase 3.3 — the Jev capability envelope behind the semantic judgement
   * (additive; the UI never has to read it). Null when no semantic ran. */
  intelligence?: SearchIntelligence | null;
  /** Present when the semantic discovery path ran (search-log correlation). */
  searchId: string | null;
  ms: number;
  /**
   * Usage Baseline (§5): the before/after-Jev comparison for the orders where
   * THIS layer owns both sides (market-first: the market set order vs the final
   * answer). Null elsewhere — semantic-only's comparison lives in the pipeline's
   * own events, and a null is never a faked "no change".
   */
  jevValue?: JevValue | null;
  /**
   * Usage Baseline (§4): query-level Jev rollup for the orders whose Jev call
   * this layer made itself (market-first). The pipeline's calls are rolled up
   * in its own events under the same trace id.
   */
  jevSummary?: { calls: number; tokens: number; costUsd: number | null; latencyMs: number | null } | null;
};
