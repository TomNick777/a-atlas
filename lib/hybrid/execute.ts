/**
 * Hybrid executor (Phase 2) — runs a HybridQueryPlan against the two existing
 * deterministic layers. It never fuses scores: each execution order has exactly
 * one rank authority.
 *
 *   semantic-only   → runSearch(raw) untouched (§14): same path, same logs.
 *   market-only     → runMarketQuery(plan.market) untouched (Phase 1).
 *   semantic-first  → runSearch(residual) decides WHO is eligible (the existing
 *                     SHOWN / matchCount contract); the market metric ranks the
 *                     eligible set. Semantic score is a tie-breaker only.
 *   market-first    → runMarketQuery picks the top-N set by the metric; the
 *                     judge scores THAT set (no corpus-wide retrieval that could
 *                     miss a member), SHOWN eligibility keeps the matches, and
 *                     the market metric keeps the order.
 *
 * No fallback judge: when the cloud is unavailable, market-first scores come
 * from the same deterministic retrieval blend the search pipeline uses, and the
 * answer is labelled DEGRADED with the provider's own outcome (§11).
 *
 * Timings (§19): parser / semantic / market / merge / total are measured on
 * every run — the market join must never become the bottleneck.
 */

import { loadDataset } from "../companies";
import type { Company, ResultJudgement, SearchIntelligence } from "../types";
import { constraintsFromQuery } from "../search/constraints";
import { buildLexicalIndex } from "../text/tokenize";
import { wordScores, meaningScores } from "../search/retrieve";
import { embedQuery } from "../text/embed";
import { mockScores, runJevJudgement, subjectsOf, runMarketEligibility, type EligibilityBatch } from "../jev/capabilities";
import { profileTermHits } from "../atlas/evidence";
import { SHOWN, fuse } from "../search/score";
import { runSearch } from "../search/pipeline";
import type { MarketField, MarketStateManifest, MarketStateRow } from "../market/contracts";
import { applyMarketFilters, runMarketQuery, sortMarketRows } from "../market/query";
import { dailyMarketCaption, marketAvailability, marketSnapshotCaption } from "../market/session";
import { prepareMarketForQuery } from "../market/refresh";
import { loadMarketStateManifest, loadMarketStateRows } from "../market/state";
import { loadPrevTradingDaySnapshot, passesDayComparison, type PrevDayRow } from "../market/prevday";
import type { RequestOrigin } from "../telemetry/organic";
import { computeJevValue, recordJevCall } from "../telemetry/jev";
import { drainSystemOneObservations } from "../jev/capabilities";
import { heroMetricOf, HERO_LABELS, formatHeroValue } from "./hero";
import { compileHybridQuery, compileLegacyHybridQuery } from "./compile";
import { selectMarketMembers, type SelectionBudget } from "./market-selection";
import type {
  ComparisonSpec,
  HeroMetric,
  HybridDiscoverResult,
  HybridExecution,
  HybridQueryPlan,
  HybridResultRow,
  MarketEvidence,
} from "./contracts";

const DISPLAY_LIMIT = 20;

/** What the semantic layer hands back — runSearch's shape, narrowed. */
export type SemanticOutcome = {
  hits: Array<{ code: string; name: string; probability: number; industry: string; swLevel1Industry: string; province: string; business: string }>;
  matches: number;
  searchId: string | null;
  degraded: boolean;
  decidedBy: "jev" | "retrieval";
  judgeOutcome: string | null;
  intelligence?: SearchIntelligence;
  /** Live judgements by code (Phase 3.4); absent when the answer is degraded. */
  judgements?: Record<string, ResultJudgement>;
};

export type SubsetScores = { scores: number[]; live: boolean; model: string | null; outcome: string | null; intelligence?: SearchIntelligence; judgements?: Record<string, ResultJudgement>; /** Usage Baseline: what the judgement cost (contract facts only; absent for blends). */ jev?: { capability: string; contractVersion: string; status: string; outcome: string | null; tokens: number; costUsd: number | null; judgeMs: number; totalMs: number; chunks: number; answeredChunks: number; decisions: number; matchedFalse: number } | null };

export type HybridExecuteOptions = {
  /** Frozen pre-M3 execution replay, never exposed as API input. */
  legacyReplay?: boolean;
  eligibilityJudge?: (query: string, companies: Company[], deadlineAt: number, remainingCost: number) => Promise<EligibilityBatch>;
  selectionBudget?: SelectionBudget;
  skipJev?: boolean;
  signal?: AbortSignal;
  origin?: RequestOrigin;
  sessionId?: string | null;
  log?: boolean;
  /** The API detected corrupted query bytes — recorded on the search run. */
  corrupt?: boolean;
  /**
   * Usage Baseline: the ONE trace id for this search, minted by the API route.
   * Every execution order (including market-only, which never touches the
   * pipeline) and both Jev call sites carry it; a label only, never a decision
   * input.
   */
  traceId?: string;
  /** DI for deterministic tests / offline replay (§17): replaces runSearch. */
  semanticEngine?: (query: string) => Promise<SemanticOutcome> | SemanticOutcome;
  /** DI for deterministic tests: scores a fixed market subset. */
  subsetScorer?: (query: string, companies: Company[]) => Promise<SubsetScores> | SubsetScores;
  /** DI for deterministic tests: market state inject (same shape as runMarketQuery). */
  marketInject?: { manifest?: MarketStateManifest | null; rows?: MarketStateRow[]; companies?: Company[] };
  /** DI for deterministic tests: the company universe for identity join + judging. */
  companies?: Company[];
  /** Phase 3 DI: previous-trading-day rows for comparison eligibility. */
  prevDayInject?: { byCode: Map<string, PrevDayRow> } | null;
};

type MarketSource = {
  manifest: MarketStateManifest | null;
  resolved: string | null;
  byCode: Map<string, MarketStateRow> | null;
  unavailableReason: string | null;
  stateDigest16: string | null;
};

function marketSource(plan: HybridQueryPlan, inject?: HybridExecuteOptions["marketInject"]): MarketSource {
  const manifest = inject?.manifest !== undefined ? inject.manifest : loadMarketStateManifest();
  if (!plan.market) {
    return { manifest, resolved: null, byCode: null, unavailableReason: null, stateDigest16: manifest?.contentDigest.value.slice(0, 16) ?? null };
  }
  if (!manifest) {
    return {
      manifest: null,
      resolved: null,
      byCode: null,
      unavailableReason: "Market State 尚未构建（缺少 data/market/state/manifest.json）。请先运行 npm run market:build。",
      stateDigest16: null,
    };
  }
  const resolved = manifest.latestTradingDay;
  if (!inject) {
    const { reason } = marketAvailability(manifest);
    if (reason) return { manifest, resolved, byCode: null, unavailableReason: reason, stateDigest16: manifest.contentDigest.value.slice(0, 16) };
  }
  const rows = inject?.rows ?? loadMarketStateRows(resolved, manifest);
  if (!rows) {
    return { manifest, resolved, byCode: null, unavailableReason: `交易日 ${resolved} 的状态文件缺失（manifest 声称已物化）。`, stateDigest16: manifest.contentDigest.value.slice(0, 16) };
  }
  const filtered = applyMarketFilters(rows, plan.market.filters);
  return {
    manifest,
    resolved,
    byCode: new Map(filtered.map((row) => [row.code, row])),
    unavailableReason: null,
    stateDigest16: manifest.contentDigest.value.slice(0, 16),
  };
}

/** Deterministic corpus word hits: ontology must-terms + query tokens found in
 * the company's own text. No new matching machinery — the same term-in-text
 * check the search log's queryMatch uses (single authority: lib/atlas/evidence). */
function matchedFacts(query: string, company: Company | undefined): string[] {
  if (!company) return [];
  return profileTermHits(query, company);
}

function marketEvidence(row: MarketEvidence["state"], tradeDate: string, hero: HeroMetric | null): MarketEvidence {
  return { tradeDate, metric: hero, state: row };
}

function heroFor(key: string | null | undefined, row: Record<string, unknown> | undefined): HeroMetric | null {
  if (!key || !row) return null;
  const value = (row[key] as number | boolean | null | undefined) ?? null;
  return heroMetricOf(key as MarketField, value);
}

const OP_TEXT: Record<string, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<", "==": "=", "!=": "≠" };

/** One filter as caption text (§30): 成交额 > 50亿 / 涨停 / 20日涨幅 ≥ 10%. */
function describeFilter(filter: { field: MarketField; op: string; value: number | boolean }): string {
  const label = HERO_LABELS[filter.field];
  if (typeof filter.value === "boolean") return filter.value ? label : `非${label}`;
  return `${label} ${OP_TEXT[filter.op] ?? filter.op} ${formatHeroValue(filter.field, filter.value)}`;
}

function planCaptionFor(plan: HybridQueryPlan, resolved: string | null, reason: string | null): string {
  if (plan.unsupported) return `未支持的意图（${plan.unsupported.intent}）：${plan.unsupported.detail}`;
  if (reason) return `市场状态不可用：${reason}`;
  if (!plan.market) return "";
  const heroLabel = plan.heroMetric?.label ?? "";
  // One caption format for the one parser (Phase 3.2): 语义「储能」 · 20日涨幅 > 10% · 按成交额排序.
  const parts: string[] = [resolved ? dailyMarketCaption(resolved) : "交易日未知"];
  if (plan.semantic) parts.push(`语义「${plan.semantic.query}」`);
  for (const filter of plan.market.filters) parts.push(describeFilter(filter));
  if (plan.market.postFilters?.length) {
    parts.push(`前${plan.market.limit}中${plan.market.postFilters.map(describeFilter).join("、")}`);
  } else if (typeof plan.market.limit === "number") {
    parts.push(`前${plan.market.limit}`);
  }
  if (plan.comparison) parts.push(`${HERO_LABELS[plan.comparison.field]}${OP_TEXT[plan.comparison.op]}上一交易日`);
  if (plan.market.sort) parts.push(`按${heroLabel}排序`);
  if (!plan.semantic) parts.push("全市场");
  return parts.join(" · ");
}

/** Default semantic engine: today's discovery path, unchanged. */
async function defaultSemanticEngine(query: string, options: HybridExecuteOptions): Promise<SemanticOutcome> {
  const result = await runSearch(query, {
    signal: options.signal,
    log: options.log,
    origin: options.origin,
    sessionId: options.sessionId,
    corrupt: options.corrupt,
    traceId: options.traceId,
  });
  return {
    hits: result.hits.map((hit) => ({
      code: hit.code,
      name: hit.name,
      probability: hit.probability,
      industry: hit.industry,
      swLevel1Industry: hit.swLevel1Industry,
      province: hit.province,
      business: hit.business,
    })),
    matches: result.matches,
    searchId: result.searchId ?? null,
    degraded: result.degraded,
    decidedBy: result.decidedBy === "jev" ? "jev" : "retrieval",
    judgeOutcome: result.judge?.outcome ?? null,
    intelligence: result.intelligence,
    judgements: result.judgements,
  };
}

async function blendScores(query: string, subset: Company[], companies: Company[]): Promise<SubsetScores> {
  const { vectors } = loadDataset();
  const indexOf = new Map(companies.map((company, index) => [company.code, index] as const));
  const indexes = subset.map((company) => indexOf.get(company.code)).filter((index): index is number => index !== undefined);
  const texts = companies.map((company) => company.searchableText);
  const words = wordScores(buildLexicalIndex(texts), query, companies.length);
  const queryVector = vectors ? await embedQuery(query) : null;
  const meaning = queryVector ? meaningScores(queryVector, vectors, companies.length) : companies.map(() => 0);
  const scores = mockScores(indexes.map((index) => meaning[index]), indexes.map((index) => words[index]));
  return { scores, live: true, model: null, outcome: null };
}

/** Default market-first scorer: the deterministic-resolved Jev judgement
 * capability (match, or relation when the residual says so) on the market set
 * itself; the deterministic retrieval blend (same primitives as the pipeline's
 * local()) when the judge is unavailable — always labelled, never a second judge. */
async function defaultSubsetScorer(query: string, subset: Company[], options: HybridExecuteOptions): Promise<SubsetScores> {
  if (!subset.length) return { scores: [], live: true, model: null, outcome: null };
  if (options.skipJev) {
    return { ...(await blendScores(query, subset, universe(options))), live: true, model: null, outcome: "not_requested" };
  }
  const scoredAt = Date.now();
  const judgement = await runJevJudgement(query, subjectsOf(subset, "zh"), { signal: options.signal });
  // §4 Jev cost trace for the market-first scorer — the pipeline never sees
  // this call, so the executor records it under the search's trace id itself.
  if (options.traceId) {
    const observations = drainSystemOneObservations(scoredAt);
    void recordJevCall({
      searchId: options.traceId,
      sessionId: options.sessionId ?? null,
      invocation: "market_first_scoring",
      capability: judgement.capability,
      contractVersion: judgement.contractVersion,
      runtimeModel: judgement.runtimeModel,
      status: judgement.status,
      outcome: judgement.outcome ?? null,
      subjectCount: subset.length,
      decisionCount: judgement.decisions.length,
      chunkCount: judgement.chunks,
      answeredChunks: judgement.answeredChunks,
      tokens: judgement.tokens,
      costUsd: judgement.costUsd,
      judgeMs: judgement.timings.judgeMs,
      totalMs: judgement.timings.totalMs,
      retries: observations.filter((row) => row.attempt > 1).length,
      timeouts: observations.filter((row) => row.outcome === "timeout" || row.outcome === "connect_timeout").length,
    });
  }
  if (judgement.live) {
    return {
      scores: judgement.decisions.map((decision) => decision.score),
      live: true,
      model: judgement.runtimeModel,
      outcome: "ok",
      intelligence: {
        provider: "jev",
        capability: judgement.capability,
        contractVersion: judgement.contractVersion,
        runtimeModel: judgement.runtimeModel,
        degraded: false,
      },
      jev: {
        capability: judgement.capability,
        contractVersion: judgement.contractVersion,
        status: judgement.status,
        outcome: judgement.outcome ?? null,
        tokens: judgement.tokens,
        costUsd: judgement.costUsd,
        judgeMs: judgement.timings.judgeMs,
        totalMs: judgement.timings.totalMs,
        chunks: judgement.chunks,
        answeredChunks: judgement.answeredChunks,
        decisions: judgement.decisions.length,
        matchedFalse: judgement.decisions.filter((decision) => !decision.matched).length,
      },
      judgements: Object.fromEntries(
        judgement.decisions.map((decision) => [
          decision.companyId,
          {
            capability: judgement.capability,
            query,
            score: decision.score,
            matched: decision.matched,
            relationLabel: "relationLabel" in decision ? decision.relationLabel : null,
            evidenceRefs: decision.evidenceRefs,
          } satisfies ResultJudgement,
        ]),
      ),
    };
  }
  const blend = await blendScores(query, subset, universe(options));
  return {
    scores: blend.scores,
    live: false,
    model: judgement.runtimeModel,
    outcome: judgement.outcome ?? "bad_response",
    intelligence: {
      provider: "none",
      capability: judgement.capability,
      contractVersion: judgement.contractVersion,
      runtimeModel: judgement.runtimeModel,
      degraded: true,
    },
    jev: {
      capability: judgement.capability,
      contractVersion: judgement.contractVersion,
      status: judgement.status,
      outcome: judgement.outcome ?? null,
      tokens: judgement.tokens,
      costUsd: judgement.costUsd,
      judgeMs: judgement.timings.judgeMs,
      totalMs: judgement.timings.totalMs,
      chunks: judgement.chunks,
      answeredChunks: judgement.answeredChunks,
      decisions: judgement.decisions.length,
      matchedFalse: judgement.decisions.filter((decision) => !decision.matched).length,
    },
  };
}

function universe(options: HybridExecuteOptions): Company[] {
  return options.companies ?? options.marketInject?.companies ?? loadDataset().companies;
}

/** Eligibility helpers for the v2 plan surface — postFilters evaluate on the
 * market rows the executor carries; comparison joins the previous trading day.
 * Unknown (null) on either side never compares, never guesses. */
function postFilterPasses(row: Record<string, unknown>, filters: NonNullable<HybridQueryPlan["market"]>["postFilters"]): boolean {
  for (const filter of filters ?? []) {
    const value = row[filter.field] as number | boolean | null | undefined;
    if (value === null || value === undefined) return false;
    if (typeof filter.value === "boolean") {
      if (typeof value !== "boolean" || (filter.op === "==" ? value !== filter.value : value === filter.value)) return false;
      continue;
    }
    const v = value as number;
    switch (filter.op) {
      case ">=":
        if (!(v >= (filter.value as number))) return false;
        break;
      case ">":
        if (!(v > (filter.value as number))) return false;
        break;
      case "<=":
        if (!(v <= (filter.value as number))) return false;
        break;
      case "<":
        if (!(v < (filter.value as number))) return false;
        break;
      case "==":
        if (v !== (filter.value as number)) return false;
        break;
      case "!=":
        if (v === (filter.value as number)) return false;
        break;
    }
  }
  return true;
}

type PrevSource = ReturnType<typeof loadPrevTradingDaySnapshot>;

/** Resolve the comparison baseline once per run (only when the plan compares). */
function prevDaySource(plan: HybridQueryPlan, options: HybridExecuteOptions): PrevSource | null {
  if (!plan.comparison) return null;
  return loadPrevTradingDaySnapshot({
    manifest: options.marketInject?.manifest,
    byCode: options.prevDayInject?.byCode,
  });
}

export async function runHybridQuery(raw: string, options: HybridExecuteOptions = {}): Promise<HybridDiscoverResult> {
  const started = performance.now();
  const resolution = options.legacyReplay ? compileLegacyHybridQuery(raw) : compileHybridQuery(raw);
  const plan = resolution.plan;
  const parserMs = resolution.provenance.parseMs;

  const base = {
    parserMs,
    semanticMs: null as number | null,
    marketMs: null as number | null,
    mergeMs: null as number | null,
  };
  let marketManifest: MarketStateManifest | null = null;
  const finish = (
    results: HybridResultRow[],
    execution: Omit<HybridExecution, "timings">,
    caption: string,
    searchId: string | null,
    intelligence?: HybridDiscoverResult["intelligence"],
  ): HybridDiscoverResult => {
    const timings = { ...base, totalMs: round(performance.now() - started) };
    const marketSnapshot = marketManifest?.runtime ?? null;
    const shownCaption = marketManifest && !options.marketInject && execution.marketDate
      ? `${marketSnapshotCaption(marketManifest)} · ${caption.replace(/^(?:今日休市 · |尚未开盘 · )?(?:交易日 )?\d{4}-\d{2}-\d{2}(?: 收盘)? · /, "").replace("全市场", "可用行情排行")}${plan.heroMetric?.key === "volumeRatio20d" ? " · 口径：当日累计量/前20个有成交交易日全天均量；盘中不代表全天放量" : ""}`
      : caption;
    return { query: raw, plan, parser: resolution.provenance, execution: { ...execution, timings }, results, planCaption: shownCaption, marketSnapshot, intelligence: intelligence ?? null, searchId, ms: timings.totalMs };
  };

  // Unsupported intent: nothing runs, nothing is guessed (§13).
  if (plan.execution.order === "unsupported") {
    return finish([], {
      order: "unsupported",
      degraded: false,
      degradedReason: plan.unsupported?.intent ?? null,
      decidedBy: null,
      counts: {},
      marketDate: null,
      stateDigest16: null,
    }, planCaptionFor(plan, null, null), options.traceId ?? null);
  }

  if (plan.execution.order === "semantic-only") {
    const semanticStarted = performance.now();
    const outcome = options.semanticEngine ? await options.semanticEngine(raw) : await defaultSemanticEngine(raw, options);
    const semanticMs = round(performance.now() - semanticStarted);
    const eligible = outcome.hits.slice(0, outcome.matches);
    const companies = universe(options);
    const byCode = new Map(companies.map((company) => [company.code, company] as const));
    const results: HybridResultRow[] = eligible.map((hit) => {
      const company = byCode.get(hit.code);
      return {
        code: hit.code,
        name: hit.name,
        exchange: company?.exchange ?? null,
        board: company?.board ?? null,
        industry: hit.industry,
        swLevel1Industry: hit.swLevel1Industry,
        province: hit.province,
        business: hit.business,
        probability: hit.probability,
        semantic: { query: raw, score: hit.probability, matchedFacts: matchedFacts(raw, company) },
        market: null,
        hero: null,
        judgement: outcome.judgements?.[hit.code] ?? null,
      };
    });
    const semanticOnlyResult = finish(results, {
      order: "semantic-only",
      degraded: outcome.degraded,
      degradedReason: outcome.degraded ? outcome.judgeOutcome : null,
      decidedBy: outcome.decidedBy,
      counts: { semanticCandidates: outcome.hits.length, semanticEligible: eligible.length },
      marketDate: null,
      stateDigest16: null,
    }, "", outcome.searchId, outcome.intelligence ?? null);
    return withTimings(semanticOnlyResult, { semanticMs });
  }

  const ratioRequested = plan.market?.sort?.field === "volumeRatio20d" || plan.market?.filters.some(f => f.field === "volumeRatio20d");
  if (!options.marketInject && ratioRequested && /量比/.test(raw) && !/20\s*(?:日|天).*?(?:均量|相对成交量)/.test(raw)) {
    const reason = "源端量比的计算基准尚未核验，暂不提供量比排行或筛选。可明确使用当日成交量相对前20日全天均量的比值。";
    return finish([], { order: plan.execution.order, degraded: true, degradedReason: reason, decidedBy: "market", counts: {}, marketDate: null, stateDigest16: null }, `市场指标不可用：${reason}`, options.traceId ?? null);
  }
  if (!options.marketInject && !options.skipJev) await prepareMarketForQuery(raw);
  const source = marketSource(plan, options.marketInject);
  marketManifest = source.manifest;
  if (source.unavailableReason) {
    return finish([], {
      order: plan.execution.order,
      degraded: true,
      degradedReason: source.unavailableReason,
      decidedBy: plan.execution.order === "market-only" ? "market" : null,
      counts: {},
      marketDate: null,
      stateDigest16: source.stateDigest16,
    }, planCaptionFor(plan, null, source.unavailableReason), options.traceId ?? null);
  }
  // Every subsequent market read uses this request's pinned manifest and rows.
  const pinnedMarket = options.marketInject ?? { manifest: source.manifest, rows: source.manifest ? loadMarketStateRows(source.manifest.latestTradingDay, source.manifest) ?? undefined : undefined };
  const heroKey = plan.heroMetric?.key ?? null;
  const postFilters = plan.market?.postFilters ?? [];
  const prev = prevDaySource(plan, { ...options, marketInject: { ...options.marketInject, manifest: source.manifest } });

  if (plan.execution.order === "market-only") {
    const marketStarted = performance.now();
    const result = runMarketQuery(
      { date: plan.market!.date, filters: plan.market!.filters, sort: plan.market!.sort ?? undefined, limit: plan.market!.limit ?? DISPLAY_LIMIT },
      options.marketInject ? { manifest: options.marketInject.manifest, rows: options.marketInject.rows } : pinnedMarket,
    );
    const marketMs = round(performance.now() - marketStarted);
    if (!result.available) {
      const unavailable = finish([], {
        order: "market-only",
        degraded: true,
        degradedReason: result.reason,
        decidedBy: "market",
        counts: {},
        marketDate: null,
        stateDigest16: source.stateDigest16,
      }, planCaptionFor(plan, null, result.reason), options.traceId ?? null);
      return withTimings(unavailable, { marketMs });
    }
    if (plan.comparison && prev && !prev.available) {
      const unavailable = finish([], {
        order: "market-only",
        degraded: true,
        degradedReason: prev.reason,
        decidedBy: "market",
        counts: { marketTotal: result.total },
        marketDate: result.date.resolved,
        stateDigest16: source.stateDigest16,
      }, planCaptionFor(plan, result.date.resolved, prev.reason), options.traceId ?? null);
      return withTimings(unavailable, { marketMs });
    }
    let eligibleRows = result.rows;
    if (postFilters.length) eligibleRows = eligibleRows.filter((row) => postFilterPasses(row, postFilters));
    if (plan.comparison && prev?.available) {
      eligibleRows = eligibleRows.filter((row) => passesDayComparison({ amount: row.amount, volume: row.volume, close: row.close }, plan.comparison!, prev.byCode.get(row.code)));
    }
    const results: HybridResultRow[] = eligibleRows.map((row) => {
      const hero = heroFor(heroKey, row);
      return {
        code: row.code,
        name: row.name,
        exchange: row.exchange,
        board: row.board,
        industry: row.industry,
        swLevel1Industry: null,
        province: null,
        business: null,
        probability: null,
        semantic: null,
        market: marketEvidence(marketStateView(row), result.date.resolved, hero),
        hero,
        judgement: null,
      };
    });
    const marketOnlyResult = finish(results, {
      order: "market-only",
      degraded: false,
      degradedReason: null,
      decidedBy: "market",
      counts: { marketTotal: result.total, marketPostEligible: eligibleRows.length },
      marketDate: result.date.resolved,
      stateDigest16: result.provenance.stateDigest16,
    }, planCaptionFor(plan, result.date.resolved, null), options.traceId ?? null);
    return withTimings(marketOnlyResult, { marketMs });
  }

  // ---- semantic-first / market-first need the market layer ----
  if (!source.byCode || !source.resolved) {
    return finish([], {
      order: plan.execution.order,
      degraded: true,
      degradedReason: source.unavailableReason,
      decidedBy: null,
      counts: {},
      marketDate: null,
      stateDigest16: source.stateDigest16,
    }, planCaptionFor(plan, null, source.unavailableReason), options.traceId ?? null);
  }
  if (plan.comparison && prev && !prev.available) {
    return finish([], {
      order: plan.execution.order,
      degraded: true,
      degradedReason: prev.reason,
      decidedBy: null,
      counts: {},
      marketDate: source.resolved,
      stateDigest16: source.stateDigest16,
    }, planCaptionFor(plan, source.resolved, prev.reason), options.traceId ?? null);
  }

  const semanticStarted = performance.now();

  if (plan.selection) {
    const { scope, limit } = plan.selection;
    const companies = new Map(universe(options).map(c => [c.code, c]));
    const field = plan.market!.sort!.field;
    let ordered = sortMarketRows([...source.byCode.values()].filter(row => {
      const v = row[field]; return v !== null && (typeof v === "boolean" || Number.isFinite(v));
    }), plan.market!.sort!);
    const marketRanks = new Map(ordered.map((row, i) => [row.code, i + 1]));
    // The TopN cut precedes all post-cut conditions and never backfills.
    if (scope === "market-topn-subset") ordered = ordered.slice(0, limit);
    ordered = ordered.filter(row => postFilterPasses(row, postFilters) && (!plan.comparison || !prev?.available || passesDayComparison({ amount: row.amount, volume: row.volume, close: row.close }, plan.comparison, prev.byCode.get(row.code))));
    let calls = 0, tokens = 0, latency = 0;
    let intelligence: SearchIntelligence | undefined;
    const selectionResult = await selectMarketMembers(ordered, scope, limit, async (batch, deadlineAt, remainingCost) => {
      const subset = batch.map(r => companies.get(r.code)).filter((c): c is Company => Boolean(c));
      if (options.eligibilityJudge) return options.eligibilityJudge(plan.semantic!.query, subset, deadlineAt, remainingCost);
      if (options.skipJev) return { decisions: batch.map(r => ({ companyId: r.code, state: "unknown" as const, judgement: null })), cacheHits: 0, estimatedCostUsd: 0, call: null };
      const at = Date.now();
      const dataset = loadDataset();
      const answer = await runMarketEligibility(plan.semantic!.query, subjectsOf(subset, "zh"), { signal: options.signal, deadlineAt, remainingEstimatedCostUsd: remainingCost, corpusDigest: dataset.corpus?.contentDigest16 ?? dataset.version });
      intelligence = answer.intelligence ?? intelligence;
      const call = answer.call;
      if (call) {
        calls++; tokens += call.tokens; latency += call.timings.totalMs;
        intelligence = { provider: call.live ? "jev" : "none", capability: call.capability, contractVersion: call.contractVersion, runtimeModel: call.runtimeModel, degraded: !call.live };
        if (options.traceId) {
          const observations = drainSystemOneObservations(at);
          void recordJevCall({ searchId: options.traceId, sessionId: options.sessionId, invocation: "market_first_scoring", capability: call.capability, contractVersion: call.contractVersion, runtimeModel: call.runtimeModel, status: call.status, outcome: call.outcome, subjectCount: subset.length - answer.cacheHits, decisionCount: call.decisions.length, chunkCount: call.chunks, answeredChunks: call.answeredChunks, tokens: call.tokens, costUsd: call.costUsd, judgeMs: call.timings.judgeMs, totalMs: call.timings.totalMs, retries: observations.filter(o => o.attempt > 1).length, timeouts: observations.filter(o => o.outcome === "timeout" || o.outcome === "connect_timeout").length });
        }
      }
      return answer;
    }, { signal: options.signal, budget: options.selectionBudget });
    const { selection } = selectionResult;
    const results = selectionResult.selected.map(({ row, decision }, index): HybridResultRow => {
      const c = companies.get(row.code)!;
      const hero = heroFor(heroKey, row);
      return { rank: scope === "market-topn-subset" ? marketRanks.get(row.code) : index + 1, code: row.code, name: c.name, exchange: c.exchange, board: c.board, industry: c.industry, swLevel1Industry: c.swLevel1Industry ?? null, province: c.region.province, business: c.businessDescription, probability: decision.judgement!.score, semantic: { query: plan.semantic!.query, score: decision.judgement!.score, matchedFacts: matchedFacts(plan.semantic!.query, c) }, market: marketEvidence(marketStateView(row), source.resolved!, hero), hero, judgement: decision.judgement };
    });
    const stopLabels: Record<string, string> = { scan_budget: "达到扫描上限", batch_budget: "达到批次上限", cost_budget: "达到估算费用上限", time_budget: "达到时间上限", cancelled: "请求取消", judge_unavailable: "业务判断服务不可用", target_reached: "已找到请求数量，但高位仍有未决公司", pool_exhausted: "已遍历集合" };
    const status = selection.complete ? (scope === "business-topk" && results.length < limit ? "已遍历可用行情集合，确认符合不足请求数量" : "资格判断完整") : `不完整：${selection.unknown} 家业务未决 · ${stopLabels[selection.stopped] ?? selection.stopped}`;
    const caption = `${planCaptionFor(plan, source.resolved, null)} · ${scope === "business-topk" ? "业务集合内排行" : "行情前N内业务子集（不补位）"} · 已扫描 ${selection.scanned}/${selection.pool} · ${status}`;
    const answer = finish(results, { order: plan.execution.order, degraded: !selection.complete, degradedReason: selection.complete ? null : status, decidedBy: "market", counts: { marketTotal: source.byCode.size, semanticCandidates: selection.scanned, semanticEligible: results.length }, marketDate: source.resolved, stateDigest16: source.stateDigest16, selection }, caption, options.traceId ?? null, intelligence);
    return withTimings({ ...answer, jevSummary: { calls, tokens, costUsd: selection.estimatedCostUsd, latencyMs: latency } }, { semanticMs: round(performance.now() - semanticStarted) });
  }

  if (plan.execution.order === "semantic-first") {
    const outcome = options.semanticEngine
      ? await options.semanticEngine(plan.semantic!.query)
      : await defaultSemanticEngine(plan.semantic!.query, options);
    const semanticMs = round(performance.now() - semanticStarted);
    const eligible = outcome.hits.slice(0, outcome.matches);
    // Eligibility = semantic AND market: source.byCode is already filter-applied,
    // so a hit missing from it FAILED the market filter and is dropped — a
    // company that does not meet「连续三个涨停」must not appear because its
    // semantic score was high. (A hit inside the set whose sort metric is null
    // still sorts last — unknown metric, honest nulls-last.)
    const hasFilters = plan.market!.filters.length > 0;
    const joined = eligible.map((hit) => ({ hit, row: source.byCode!.get(hit.code) ?? null }));
    let eligibleJoined = hasFilters ? joined.filter((entry) => entry.row !== null) : joined;
    // Comparison eligibility (v2): a semantic hit whose day-over-day condition
    // fails (or whose today/prev rows are unknown) is dropped — unknown never
    // compares, never guesses.
    if (plan.comparison && prev?.available) {
      eligibleJoined = eligibleJoined.filter((entry) => {
        if (entry.row === null) return false;
        return passesDayComparison({ amount: entry.row.amount, volume: entry.row.volume, close: entry.row.close }, plan.comparison!, prev.byCode.get(entry.hit.code));
      });
    }
    const companies = universe(options);
    const byCode = new Map(companies.map((company) => [company.code, company] as const));
    const mergeStarted = performance.now();
    const sort = plan.market!.sort!;
    const mul = sort.direction === "asc" ? 1 : -1;
    const entries = eligibleJoined
      .sort((a, b) => {
        const va = a.row ? (a.row[sort.field] as number | boolean | null) : null;
        const vb = b.row ? (b.row[sort.field] as number | boolean | null) : null;
        const codeTie = a.hit.code < b.hit.code ? -1 : 1;
        const semanticTie = b.hit.probability - a.hit.probability || codeTie;
        if (va === null && vb === null) return semanticTie;
        if (va === null) return 1; // nulls last, both directions (Phase 1 semantics)
        if (vb === null) return -1;
        if (typeof va === "boolean" || typeof vb === "boolean") {
          return ((va === true ? 1 : 0) - (vb === true ? 1 : 0)) * mul || semanticTie;
        }
        return ((va as number) - (vb as number)) * mul || semanticTie;
      });
    const results: HybridResultRow[] = entries.slice(0, DISPLAY_LIMIT).map(({ hit, row }) => {
      const hero = heroFor(heroKey, row ?? undefined);
      return {
        code: hit.code,
        name: hit.name,
        exchange: byCode.get(hit.code)?.exchange ?? null,
        board: byCode.get(hit.code)?.board ?? null,
        industry: hit.industry,
        swLevel1Industry: hit.swLevel1Industry,
        province: hit.province,
        business: hit.business,
        probability: hit.probability,
        semantic: { query: plan.semantic!.query, score: hit.probability, matchedFacts: matchedFacts(plan.semantic!.query, byCode.get(hit.code)) },
        market: row ? marketEvidence(marketStateView(row), source.resolved!, hero) : null,
        hero,
        judgement: outcome.judgements?.[hit.code] ?? null,
      };
    });
    const mergeMs = round(performance.now() - mergeStarted);
    const semanticFirstResult = finish(results, {
      order: "semantic-first",
      degraded: outcome.degraded,
      degradedReason: outcome.degraded ? outcome.judgeOutcome : null,
      decidedBy: outcome.decidedBy,
      counts: { semanticCandidates: outcome.hits.length, semanticEligible: eligibleJoined.length, marketTotal: source.byCode.size },
      marketDate: source.resolved,
      stateDigest16: source.stateDigest16,
    }, planCaptionFor(plan, source.resolved, null), outcome.searchId, outcome.intelligence ?? null);
    return withTimings(semanticFirstResult, { semanticMs, mergeMs });
  }

  // market-first: the market metric picks the set, the judge scores that set,
  // SHOWN keeps the matches, the market metric keeps the order.
  const marketStarted = performance.now();
  const marketResult = runMarketQuery(
    { date: plan.market!.date, filters: plan.market!.filters, sort: plan.market!.sort ?? undefined, limit: plan.market!.limit ?? DISPLAY_LIMIT },
    options.marketInject ? { manifest: options.marketInject.manifest, rows: options.marketInject.rows } : pinnedMarket,
  );
  const marketMs = round(performance.now() - marketStarted);
  if (!marketResult.available) {
    const unavailable = finish([], {
      order: "market-first",
      degraded: true,
      degradedReason: marketResult.reason,
      decidedBy: "market",
      counts: {},
      marketDate: null,
      stateDigest16: source.stateDigest16,
    }, planCaptionFor(plan, null, marketResult.reason), null);
    return withTimings(unavailable, { marketMs });
  }

  const companies = universe(options);
  const byCode = new Map(companies.map((company) => [company.code, company] as const));
  // Post-cut eligibility (v2): postFilters and the day-over-day comparison
  // narrow the top-N set BEFORE any judging — the judge only sees real members.
  const postEligibleRows = marketResult.rows.filter(
    (row) =>
      postFilterPasses(row, postFilters) &&
      (!(plan.comparison && prev?.available) || passesDayComparison({ amount: row.amount, volume: row.volume, close: row.close }, plan.comparison!, prev.byCode.get(row.code))),
  );
  const subset = postEligibleRows.map((row) => byCode.get(row.code)).filter((company): company is Company => company !== undefined);
  const scoredStarted = performance.now();
  const subsetScores = options.subsetScorer
    ? await options.subsetScorer(plan.semantic!.query, subset)
    : await defaultSubsetScorer(plan.semantic!.query, subset, options);
  const semanticMs = round(Math.max(0, scoredStarted - semanticStarted) + (performance.now() - scoredStarted) - marketMs);

  const mergeStarted = performance.now();
  const scored = new Map<string, number>();
  if (subset.length) {
    const constraints = constraintsFromQuery(plan.semantic!.query);
    const indexOf = new Map(companies.map((company, index) => [company.code, index] as const));
    const subsetIndexes = subset.map((company) => indexOf.get(company.code)!);
    // fuse() applies the query's constraints (province / drop-industries /
    // ontology exclusions) — the same zeroing the discovery path uses.
    const ranked = fuse(companies, subsetIndexes, subsetScores.scores, constraints);
    for (const row of ranked) if (row.probability >= SHOWN) scored.set(companies[row.index].code, row.probability);
  }
  const results: HybridResultRow[] = marketResult.rows
    .filter((row) => scored.has(row.code))
    .map((row) => {
      const company = byCode.get(row.code);
      const hero = heroFor(heroKey, row);
      return {
        code: row.code,
        name: row.name,
        exchange: row.exchange,
        board: row.board,
        industry: row.industry,
        swLevel1Industry: company?.swLevel1Industry ?? null,
        province: company?.region.province ?? null,
        business: company?.businessDescription ?? null,
        probability: scored.get(row.code) ?? null,
        semantic: { query: plan.semantic!.query, score: scored.get(row.code) ?? null, matchedFacts: matchedFacts(plan.semantic!.query, company) },
        market: marketEvidence(marketStateView(row), marketResult.date.resolved, hero),
        hero,
        judgement: subsetScores.judgements?.[row.code] ?? null,
      };
    });
  const mergeMs = round(performance.now() - mergeStarted);
  const decidedByJev = subsetScores.live && subsetScores.model ? "jev" : "retrieval";
  const marketFirstResult = finish(results, {
    order: "market-first",
    degraded: !subsetScores.live,
    degradedReason: subsetScores.live ? null : subsetScores.outcome,
    decidedBy: decidedByJev,
    counts: { marketSetSize: postEligibleRows.length, semanticEligible: results.length, marketTotal: marketResult.total },
    marketDate: marketResult.date.resolved,
    stateDigest16: marketResult.provenance.stateDigest16,
  }, planCaptionFor(plan, marketResult.date.resolved, null), options.traceId ?? null, subsetScores.intelligence ?? null);
  // §5 Jev value for the order this layer owns both sides of: the market metric
  // order Jev received vs the final answer (Jev decides WHO is shown, the
  // market metric keeps the order). Null when the judge did not decide.
  const jevValue =
    decidedByJev === "jev" && subsetScores.jev
      ? computeJevValue(
          postEligibleRows.map((row) => row.code),
          results.map((row) => row.code),
          subsetScores.jev.matchedFalse,
        )
      : null;
  // §4 query-level rollup for the Jev call this layer made itself.
  const jevSummary =
    subsetScores.jev && decidedByJev === "jev"
      ? {
          calls: 1,
          tokens: subsetScores.jev.tokens,
          costUsd: subsetScores.jev.costUsd,
          latencyMs: Math.round(subsetScores.jev.totalMs * 100) / 100,
        }
      : null;
  return withTimings({ ...marketFirstResult, jevValue, jevSummary }, { semanticMs, mergeMs, marketMs });
}

/** MarketResultRow (identity-enriched) read back as a plain state view. */
function marketStateView(row: Record<string, unknown>): MarketEvidence["state"] {
  return {
    close: row.close as number,
    pctChange: row.pctChange as number | null,
    volume: row.volume as number,
    amount: row.amount as number,
    turnoverRate: row.turnoverRate as number | null,
    marketCapYi: row.marketCapYi as number | null,
    isLimitUp: row.isLimitUp as boolean | null,
    isLimitDown: row.isLimitDown as boolean | null,
    limitUpStreak: row.limitUpStreak as number | null,
    return5d: row.return5d as number | null,
    return20d: row.return20d as number | null,
    volumeRatio20d: row.volumeRatio20d as number | null,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

function withTimings(result: HybridDiscoverResult, t: Partial<HybridExecution["timings"]>): HybridDiscoverResult {
  return { ...result, execution: { ...result.execution, timings: { ...result.execution.timings, ...t } } };
}
