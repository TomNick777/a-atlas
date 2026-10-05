/**
 * Environment pin for a quality run (benchmark §20): a baseline is only
 * comparable when we know exactly what produced it. Everything here is read
 * from production modules or manifests — never hand-typed.
 */
import { execSync } from "node:child_process";
import { loadDataset } from "../../../lib/companies";
import { loadCommittedMarketStateManifest } from "../../../lib/market/state";
import { JEV_CAPABILITY_CONTRACT_VERSIONS, JEV_CAPABILITY_REGISTRY_VERSION, JEV_PRODUCTION_MODEL, jevJudgeAvailability, jevJudgeRuntime } from "../../../lib/jev/capabilities";
import { QUERY_GRAMMAR_REGISTRY_VERSION } from "../../../lib/planner/grammar";
import { PARSER_V2_VERSION } from "../../../lib/planner/contracts";
import { HYBRID_PLANNER_VERSION, MARKET_SELECTION_VERSION } from "../../../lib/hybrid/contracts";
import { MARKET_ELIGIBILITY_VERSION } from "../../../lib/jev/capabilities";
import { EVIDENCE_VIEW_VERSION } from "../../../lib/atlas/evidence";
import { PRODUCTION_CONTRACT } from "../../../lib/telemetry/contract";
import { jevBaseUrl, jevModel } from "../../../lib/env";

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "unknown";
  }
}

export type EnvironmentPin = {
  runAt: string;
  gitHead: string;
  gitDirtyFiles: number;
  atlasTags: string[];
  node: string;
  platform: string;
  benchmark: { version: string; sha16: string };
  corpus: { digest16: string; companyCount: number };
  market: { digest16: string; latestTradingDay: string | null };
  jev: {
    endpoint: string;
    aliasRequested: string;
    productionContract: string;
    answeredModel: string | null;
    configured: boolean;
    breaker: unknown;
  };
  versions: {
    parser: string;
    plannerV1Baseline: string;
    queryGrammarRegistry: string;
    capabilityRegistry: string;
    capabilityContracts: Record<string, string>;
    evidenceView: string;
    retrieval: string;
    knowledge: string;
    marketSelection: string;
    marketEligibility: string;
  };
};

export function collectEnvironmentPin(benchmark: { benchmarkVersion: string; sha16: string }): EnvironmentPin {
  const dataset = loadDataset();
  const market = loadCommittedMarketStateManifest();
  return {
    runAt: new Date().toISOString(),
    gitHead: git("rev-parse HEAD"),
    gitDirtyFiles: git("status --porcelain").split("\n").filter((line) => line.trim()).length,
    atlasTags: git("tag --points-at HEAD").split("\n").filter(Boolean),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    benchmark: { version: benchmark.benchmarkVersion, sha16: benchmark.sha16 },
    corpus: { digest16: dataset.corpus?.contentDigest16 ?? "", companyCount: dataset.companies.length },
    market: { digest16: (market?.contentDigest.value ?? "").slice(0, 16), latestTradingDay: market?.latestTradingDay ?? null },
    jev: {
      endpoint: jevBaseUrl(),
      aliasRequested: jevModel(),
      productionContract: JEV_PRODUCTION_MODEL,
      answeredModel: jevJudgeRuntime().status.lastAnsweredModel,
      configured: jevJudgeAvailability().configured,
      breaker: jevJudgeAvailability().breaker,
    },
    versions: {
      parser: PARSER_V2_VERSION,
      marketSelection: MARKET_SELECTION_VERSION,
      marketEligibility: MARKET_ELIGIBILITY_VERSION,
      plannerV1Baseline: HYBRID_PLANNER_VERSION,
      queryGrammarRegistry: QUERY_GRAMMAR_REGISTRY_VERSION,
      capabilityRegistry: JEV_CAPABILITY_REGISTRY_VERSION,
      capabilityContracts: { ...JEV_CAPABILITY_CONTRACT_VERSIONS },
      evidenceView: EVIDENCE_VIEW_VERSION,
      retrieval: PRODUCTION_CONTRACT.retrievalVersion,
      knowledge: PRODUCTION_CONTRACT.knowledgeVersion,
    },
  };
}
