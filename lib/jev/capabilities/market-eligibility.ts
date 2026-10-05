/** Strict membership adapter over the existing match/relation capabilities.
 * It never changes judge prompts, retrieval or semantic ranking. Unknown is a
 * first-class state; median fills and the exact midpoint are never eligibility.
 * Cache identity includes the complete provided facts, query and judge identity,
 * independently of the market snapshot. No failed/unknown decision is cached. */
import { createHash } from "node:crypto";
import { jevProvider } from "../cloud";
import { JEV_PRICE_PER_TOKEN } from "../provider";
import { runSemanticMatch } from "./semantic-match";
import { runSemanticRelation } from "./semantic-relation";
import { resolveJevCapability } from "./route";
import { JEV_CAPABILITY_CONTRACT_VERSIONS, type JudgementSubject, type SemanticMatchResult, type SemanticRelationResult } from "./contracts";
import type { ResultJudgement, SearchIntelligence } from "../../types";
import { MARKET_ELIGIBILITY_POLICY } from "./registry";

export const MARKET_ELIGIBILITY_VERSION = MARKET_ELIGIBILITY_POLICY.version;
export type EligibilityDecision = { companyId: string; state: "confirmed" | "rejected" | "unknown"; judgement: ResultJudgement | null };
export type EligibilityBatch = { decisions: EligibilityDecision[]; cacheHits: number; estimatedCostUsd: number; call: SemanticMatchResult | SemanticRelationResult | null; intelligence?: SearchIntelligence; stopped?: "cost_budget" | "judge_unavailable" };
const cache = new Map<string, { at: number; decision: EligibilityDecision }>();
const TTL = 6 * 60 * 60 * 1000;
export function resetMarketEligibilityCache(): void { cache.clear(); }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Admission estimate, not a billing guarantee: generous per-subject text and
 * answer allowance with retry margin; actual reported tokens settle each batch. */
export function eligibilityAdmissionCost(query: string, subjects: JudgementSubject[]): number {
  return (2000 + subjects.reduce((n, s) => n + JSON.stringify(s).length + query.length + 2000, 0)) * 2 * JEV_PRICE_PER_TOKEN;
}

export async function runMarketEligibility(query: string, subjects: JudgementSubject[], options: { signal?: AbortSignal; deadlineAt?: number; remainingEstimatedCostUsd: number; corpusDigest?: string }): Promise<EligibilityBatch> {
  const capability = resolveJevCapability(query).capability;
  const contract = JEV_CAPABILITY_CONTRACT_VERSIONS[capability];
  const keyOf = (subject: JudgementSubject) => {
    const status = jevProvider().status();
    return digest([MARKET_ELIGIBILITY_VERSION, options.corpusDigest, query, contract, status.model, status.lastAnsweredModel, status.endpoint, subject]);
  };
  const decisions = new Map<string, EligibilityDecision>();
  const pending: JudgementSubject[] = [];
  let cacheHits = 0;
  for (const subject of subjects) {
    const key = keyOf(subject), hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) {
      decisions.set(subject.companyId, hit.decision); cacheHits++;
      cache.delete(key); cache.set(key, hit);
    } else { cache.delete(key); pending.push(subject); }
  }
  if (pending.length && eligibilityAdmissionCost(query, pending) > options.remainingEstimatedCostUsd) {
    return { decisions: subjects.map(s => decisions.get(s.companyId) ?? { companyId: s.companyId, state: "unknown", judgement: null }), cacheHits, estimatedCostUsd: 0, call: null, stopped: "cost_budget" };
  }
  const call = pending.length ? capability === "semantic_relation"
    ? await runSemanticRelation({ relationQuery: query, subjects: pending }, options)
    : await runSemanticMatch({ query, subjects: pending }, options) : null;
  for (const subject of pending) {
    const d = call?.decisions.find(d => d.companyId === subject.companyId);
    const known = call?.live && call.runtimeModel && d?.known === true && Number.isFinite(d.score) && d.score !== 0.5 && subject.evidence.length > 0 && d.evidenceRefs.length > 0;
    const decision: EligibilityDecision = {
      companyId: subject.companyId, state: known ? d!.matched ? "confirmed" : "rejected" : "unknown",
      judgement: known ? { capability, query, score: d!.score, matched: d!.matched, relationLabel: d && "relationLabel" in d && typeof d.relationLabel === "string" ? d.relationLabel : null, evidenceRefs: d!.evidenceRefs } : null,
    };
    decisions.set(subject.companyId, decision);
    if (known) cache.set(keyOf(subject), { at: Date.now(), decision });
  }
  while (cache.size > 20000) cache.delete(cache.keys().next().value!);
  const runtimeModel = call?.runtimeModel ?? jevProvider().status().lastAnsweredModel;
  const live = call ? call.live : cacheHits === subjects.length;
  return { decisions: subjects.map(s => decisions.get(s.companyId)!), cacheHits, estimatedCostUsd: call?.costUsd ?? 0, call, intelligence: { provider: live ? "jev" : "none", capability, contractVersion: contract, runtimeModel, degraded: !live }, ...(call && !call.live ? { stopped: "judge_unavailable" as const } : {}) };
}
