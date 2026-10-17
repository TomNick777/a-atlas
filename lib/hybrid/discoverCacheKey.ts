/** Maintenance compatibility only. The product cache never reads market state. */
import { loadDataset } from "../companies";
import { judgeCacheIdentity, MARKET_ELIGIBILITY_VERSION } from "../intelligence/capabilities";
import { PARSER_V2_VERSION } from "../planner/contracts";
import { HYBRID_PLANNER_VERSION } from "./contracts";
import { compileHybridQuery } from "./compile";
import { loadMarketStateManifest } from "../market/state";
import { dailyMarketSession, marketAvailability } from "../market/session";

export function discoverCacheKey(query: string): string {
  const { version } = loadDataset();
  const common = `${version}:${judgeCacheIdentity()}:${PARSER_V2_VERSION}:${HYBRID_PLANNER_VERSION}`;
  if (!compileHybridQuery(query).plan.market) return `${common}:semantic:${query.toLowerCase()}`;
  const manifest = loadMarketStateManifest();
  const session = dailyMarketSession();
  const ready = manifest?.runtime ? marketAvailability(manifest).reason ?? "ready" : "daily";
  return `${common}:${MARKET_ELIGIBILITY_VERSION}:${session.calendarDate}:${session.phase}:${session.targetDate}:${manifest?.contentDigest.value ?? "no-market"}:${manifest?.runtime?.snapshotId ?? "daily"}:${ready}:${query.toLowerCase()}`;
}
