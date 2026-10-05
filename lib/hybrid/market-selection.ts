import type { EligibilityBatch, EligibilityDecision } from "../jev/capabilities";
import type { MarketSelectionScope, HybridExecution } from "./contracts";

export const MARKET_SELECTION_BUDGET = { batchSize: 50, maxScanned: 1000, maxBatches: 20, maxMs: 30000, maxEstimatedCostUsd: 0.05 } as const;
export type SelectionBudget = { batchSize: number; maxScanned: number; maxBatches: number; maxMs: number; maxEstimatedCostUsd: number };
export async function selectMarketMembers<T extends { code: string }>(
  ordered: T[], scope: MarketSelectionScope, requested: number,
  judge: (batch: T[], deadlineAt: number, remainingCost: number) => Promise<EligibilityBatch>,
  options: { signal?: AbortSignal; budget?: SelectionBudget } = {},
): Promise<{ selected: Array<{ row: T; decision: EligibilityDecision }>; selection: NonNullable<HybridExecution["selection"]> }> {
  const budget = options.budget ?? MARKET_SELECTION_BUDGET;
  const pool = scope === "market-topn-subset" ? ordered.slice(0, requested) : ordered;
  const deadline = Date.now() + budget.maxMs;
  const selected: Array<{ row: T; decision: EligibilityDecision }> = [];
  let scanned = 0, unknown = 0, batches = 0, cacheHits = 0, cost = 0, stopped = "pool_exhausted";
  for (let at = 0; at < pool.length;) {
    if (options.signal?.aborted) { stopped = "cancelled"; break; }
    if (Date.now() >= deadline) { stopped = "time_budget"; break; }
    if (scanned >= budget.maxScanned) { stopped = "scan_budget"; break; }
    if (batches >= budget.maxBatches) { stopped = "batch_budget"; break; }
    if (cost >= budget.maxEstimatedCostUsd) { stopped = "cost_budget"; break; }
    const batch = pool.slice(at, at + Math.min(budget.batchSize, budget.maxScanned - scanned));
    const result = await judge(batch, deadline, budget.maxEstimatedCostUsd - cost);
    cacheHits += result.cacheHits; cost += result.estimatedCostUsd; batches++;
    if (result.stopped === "cost_budget") { stopped = result.stopped; break; }
    scanned += batch.length; at += batch.length;
    for (const row of batch) {
      const decision = result.decisions.find(d => d.companyId === row.code);
      if (!decision || decision.state === "unknown" || (decision.state === "confirmed" && !decision.judgement?.evidenceRefs.length)) { unknown++; continue; }
      if (decision.state === "confirmed") selected.push({ row, decision });
      if (scope === "business-topk" && selected.length === requested) { stopped = "target_reached"; break; }
    }
    if (stopped === "target_reached") break;
    if (result.stopped) { stopped = result.stopped; break; }
  }
  const complete = unknown === 0 && (stopped === "target_reached" || (stopped === "pool_exhausted" && scanned === pool.length));
  return { selected, selection: { scope, requested, pool: pool.length, scanned, confirmed: selected.length, unknown, cacheHits, batches, complete, stopped, budget, estimatedCostUsd: cost } };
}
