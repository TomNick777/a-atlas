import { LruCache } from "@/lib/cache";
import { parseMarketQuerySpec, runMarketQuery } from "@/lib/market/query";
import type { MarketQueryResult } from "@/lib/market/contracts";
import { prepareMarketSnapshot } from "@/lib/market/refresh";
import { loadMarketStateManifest } from "@/lib/market/state";
import { marketAvailability } from "@/lib/market/session";

/**
 * Market Intelligence Phase 1 query endpoint — the deterministic Market State
 * layer only. Phase 1 deliberately ships API + CLI (no UI surface): the query
 * spec is structured, "今天…" style language resolution happens in a later
 * phase on top of this. Responses come from committed byte-pinned state, never
 * live vendor calls, so this route is cheap and does not touch the data
 * service (:8920).
 */

const cache = new LruCache<MarketQueryResult>(32);

const specCache = new LruCache<ReturnType<typeof parseMarketQuerySpec>>(32);

export async function POST(request: Request) {
  const started = performance.now();
  const body = (await request.json().catch(() => null)) as unknown;
  const parsed = specCache.get(JSON.stringify(body ?? null)) ?? parseMarketQuerySpec(body);
  specCache.set(JSON.stringify(body ?? null), parsed);
  if ("error" in parsed) return Response.json({ available: false, reason: parsed.error }, { status: 400 });

  if (!parsed.spec.date || parsed.spec.date === "LATEST_TRADING_DAY") await prepareMarketSnapshot();
  const manifest = loadMarketStateManifest();
  const key = `${manifest?.contentDigest.value}:${manifest?.runtime?.snapshotId}:${manifest ? marketAvailability(manifest).reason : "missing"}:${JSON.stringify(parsed.spec)}`;
  const hit = cache.get(key);
  const ms = Math.round(performance.now() - started);
  if (hit) return Response.json({ ...hit, cached: true, ms });

  const result = runMarketQuery(parsed.spec);
  if (result.available) cache.set(key, result);
  return Response.json({ ...result, cached: false, ms: Math.round(performance.now() - started) });
}

export async function GET() {
  await prepareMarketSnapshot();
  // Layer status: what a caller needs to know before querying.
  const result = runMarketQuery({ sort: { field: "amount", direction: "desc" }, limit: 1 });
  if (!result.available) return Response.json({ available: false, reason: result.reason });
  return Response.json({
    available: true,
    latestTradingDay: result.latestTradingDay,
    tradingDays: result.provenance.tradingDays,
    stateDigest16: result.provenance.stateDigest16,
    dailySource: result.provenance.dailySource,
    quoteSource: result.provenance.quoteSource,
  });
}
