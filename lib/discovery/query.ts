import { loadDataset } from "../companies";
import { profileTermHits } from "../atlas/evidence";
import { compileHybridQuery } from "../hybrid/compile";
import type { PlanResolution } from "../hybrid/compile";
import type { HybridDiscoverResult, HybridResultRow } from "../hybrid/contracts";
import { runSearch, type SearchOptions } from "../search/pipeline";
import type { Company, SearchResult } from "../types";
import { COMPANY_DISCOVERY_SCOPE } from "./contracts";
import { METRIC_ALTERNATION, OPERATOR_WORDS, SYMBOL_OPERATORS } from "../planner/grammar";

// Some metric comparisons are deliberately outside the frozen parser's DSL.
// They must still be refused at the product boundary, not sent to a judge as
// company facts. Reuse market grammar only; no business vocabulary is added.
const metricCondition = new RegExp(`(?:${METRIC_ALTERNATION})\\s*(?:${[
  ...OPERATOR_WORDS.flatMap(group => group.words),
  ...SYMBOL_OPERATORS.map(operator => operator.symbol),
].join("|")})`);

/** Product boundary, independent of the frozen market/benchmark executors. */
export function compileCompanyQuery(raw: string): PlanResolution {
  // Reuse the existing deterministic grammar as a scope guard. Never strip a
  // market condition and silently answer only the remaining business query.
  const resolution = compileHybridQuery(raw);
  const outsideScope = resolution.plan.market || resolution.plan.comparison || resolution.plan.selection || metricCondition.test(raw);
  if (!outsideScope && !resolution.plan.unsupported) {
    return { ...resolution, plan: { ...resolution.plan, semantic: { query: raw } } };
  }
  if (!outsideScope) {
    return { ...resolution, plan: { ...resolution.plan, unsupported: {
      ...resolution.plan.unsupported!, detail: `${COMPANY_DISCOVERY_SCOPE} ${resolution.plan.unsupported!.detail}`,
    } } };
  }
  return {
    ...resolution,
    plan: {
      ...resolution.plan,
      market: null,
      semantic: null,
      comparison: null,
      selection: undefined,
      heroMetric: null,
      execution: { order: "unsupported" },
      unsupported: { intent: "company-discovery-only", detail: COMPANY_DISCOVERY_SCOPE },
    },
  };
}

export type CompanyDiscoveryOptions = SearchOptions & {
  /** Offline verification seams; never accepted from the HTTP request. */
  searchEngine?: (query: string, options: SearchOptions) => Promise<SearchResult>;
  companies?: Company[];
};

export async function runCompanyDiscovery(raw: string, options: CompanyDiscoveryOptions = {}): Promise<HybridDiscoverResult> {
  const started = performance.now();
  const { plan, provenance: parser } = compileCompanyQuery(raw);
  const base: HybridDiscoverResult = {
    query: raw,
    plan,
    parser,
    results: [],
    planCaption: plan.unsupported?.detail ?? "",
    searchId: options.traceId ?? null,
    ms: 0,
    intelligence: null,
    marketSnapshot: null,
    execution: {
      order: plan.execution.order,
      degraded: false,
      degradedReason: plan.unsupported?.intent ?? null,
      decidedBy: null,
      counts: {},
      marketDate: null,
      stateDigest16: null,
      timings: { parserMs: parser.parseMs, semanticMs: null, marketMs: null, mergeMs: null, totalMs: 0 },
    },
  };
  const finish = () => {
    base.ms = Math.round((performance.now() - started) * 100) / 100;
    base.execution.timings.totalMs = base.ms;
    return base;
  };
  if (plan.unsupported || plan.execution.order !== "semantic-only") return finish();

  const semanticStarted = performance.now();
  const { searchEngine = runSearch, companies: injectedCompanies, ...searchOptions } = options;
  const outcome = await searchEngine(raw, searchOptions);
  const semanticMs = Math.round((performance.now() - semanticStarted) * 100) / 100;
  const companies = injectedCompanies ?? loadDataset().companies;
  const byCode = new Map(companies.map(company => [company.code, company]));
  // Preserve the search engine's order and eligibility cut. A live rejection
  // must not become a match merely to fill the historical nine-card minimum.
  // Retrieval-only results remain explicitly degraded, without judgements.
  const eligible = outcome.hits.slice(0, outcome.matches).filter(hit =>
    outcome.degraded || (outcome.judgements?.[hit.code]?.matched === true && outcome.judgements[hit.code].evidenceRefs.length > 0),
  );
  base.results = eligible.map((hit): HybridResultRow => {
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
      semantic: { query: raw, score: hit.probability, matchedFacts: company ? profileTermHits(raw, company) : [] },
      market: null,
      hero: null,
      judgement: outcome.degraded ? null : outcome.judgements?.[hit.code] ?? null,
    };
  });
  base.searchId = options.traceId ?? outcome.searchId ?? null;
  base.intelligence = outcome.intelligence ?? null;
  base.execution.degraded = outcome.degraded;
  base.execution.degradedReason = outcome.degraded ? outcome.judge?.outcome ?? null : null;
  base.execution.decidedBy = outcome.decidedBy;
  base.execution.counts = { semanticCandidates: outcome.hits.length, semanticEligible: eligible.length };
  base.execution.timings.semanticMs = semanticMs;
  base.planCaption = eligible.length ? "" : "当前公司资料中没有找到有证据支持的匹配。";
  return finish();
}
