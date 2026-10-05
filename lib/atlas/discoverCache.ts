/**
 * The discover answer cache (Phase 3.4) — moved out of the API route so the
 * evidence explanation surface can look up the EXACT result a user saw without
 * re-running it (and without paying Jev twice for one judgement).
 *
 * Key format is unchanged: corpus + judge identity + parser version + market
 * snapshot + normalized query. A plan answered from a different semantic
 * layer, parser or trading day must not survive.
 */
import { LruCache } from "@/lib/cache";
import { loadDataset } from "@/lib/companies";
import { judgeCacheIdentity, MARKET_ELIGIBILITY_VERSION } from "@/lib/jev/capabilities";
import { PARSER_V2_VERSION } from "@/lib/planner/contracts";
import { HYBRID_PLANNER_VERSION } from "@/lib/hybrid/contracts";
import { loadMarketStateManifest } from "@/lib/market/state";
import { dailyMarketSession, marketAvailability } from "@/lib/market/session";
import type { HybridDiscoverResult } from "@/lib/hybrid/contracts";
import { compileHybridQuery } from "@/lib/hybrid/compile";

export type DiscoverResult = HybridDiscoverResult;

const cache = new LruCache<DiscoverResult>(48);

export function discoverCacheKey(query: string): string {
  const { version } = loadDataset();
  const common = `${version}:${judgeCacheIdentity()}:${PARSER_V2_VERSION}:${HYBRID_PLANNER_VERSION}`;
  if (!compileHybridQuery(query).plan.market) return `${common}:semantic:${query.toLowerCase()}`;
  const manifest = loadMarketStateManifest();
  const session = dailyMarketSession();
  const ready = manifest?.runtime ? marketAvailability(manifest).reason ?? "ready" : "daily";
  return `${common}:${MARKET_ELIGIBILITY_VERSION}:${session.calendarDate}:${session.phase}:${session.targetDate}:${manifest?.contentDigest.value ?? "no-market"}:${manifest?.runtime?.snapshotId ?? "daily"}:${ready}:${query.toLowerCase()}`;
}

export function lookupDiscover(key: string): DiscoverResult | undefined {
  return cache.get(key);
}

export function storeDiscover(key: string, result: DiscoverResult): void {
  cache.set(key, result);
}
