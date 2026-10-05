import { LruCache } from "@/lib/cache";
import { loadDataset } from "@/lib/companies";
import { logCacheHit, runSearch } from "@/lib/search/pipeline";
import { judgeCacheIdentity } from "@/lib/jev/capabilities";
import { presentSearchResult } from "@/lib/atlas/evidence";
import { normalizeOrigin } from "@/lib/telemetry/organic";
import { isValidSessionId, newSearchId } from "@/lib/telemetry/ids";
import { corruptCapture } from "@/lib/telemetry/search";
import { noteSearch } from "@/lib/atlas/runtime";
import type { SearchResult } from "@/lib/types";

const cache = new LruCache<SearchResult>(48);

/**
 * In-flight dedup (§15). A user who presses Enter twice, or double-clicks the
 * search button, used to start two full searches and pay the judge twice for the
 * same answer. The second caller now awaits the first instead of re-asking.
 */
const inFlight = new Map<string, Promise<SearchResult>>();

export async function POST(request: Request) {
  const started = performance.now();
  const body = (await request.json().catch(() => null)) as { query?: unknown; origin?: unknown; sessionId?: unknown } | null;
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 120) : "";
  if (query.length < 2) return Response.json({ error: "至少输入 2 个字。" }, { status: 400 });

  // One trace id per real request (usage spec §2) — corrupt captures and
  // failures record under it too, instead of searchId: null.
  const traceId = newSearchId();

  // Corrupt capture (§32): a mojibake query (wrong console encoding, broken
  // client) still returns an answer today — record it as evidence, exclude it
  // from organic, and let the search proceed untouched.
  const corruptQuery = /\uFFFD/.test(query) || /[\u0000-\u0008\u000E-\u001F]/.test(query);
  if (corruptQuery) corruptCapture(traceId, "query carries U+FFFD/control chars (client encoding corruption)");

  // Who asked (telemetry §13): browser default organic_ui; scripted callers
  // declare developer/smoke/benchmark/replay/api via body or header.
  const headerOrigin = request.headers.get("x-search-origin");
  const { origin, invalidProvided } = normalizeOrigin(body?.origin ?? headerOrigin ?? undefined);
  const rawSession = body?.sessionId ?? request.headers.get("x-session-id");
  const sessionId = isValidSessionId(rawSession) ? rawSession : null;
  if (invalidProvided) corruptCapture(traceId, `invalid requestOrigin "${invalidProvided.slice(0, 40)}" fell back to organic_ui`);

  const { version } = loadDataset();
  // Cache identity carries the judge, not just the corpus: results ranked by a
  // different model must not survive a model move (§16).
  const key = `${version}:${judgeCacheIdentity()}:${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) {
    // Replay of a repeated query. Recorded so query-frequency signals survive,
    // and NOT re-run: replaying through runSearch used to ask Jev again (§15).
    logCacheHit(query, hit, { origin, sessionId });
    noteSearch("cache_hit");
    return Response.json({ ...presentSearchResult(hit), cached: true, ms: Math.round(performance.now() - started) });
  }

  let pending = inFlight.get(key);
  const fresh = pending === undefined;
  if (!pending) {
    pending = runSearch(query, {
      signal: fresh ? request.signal : undefined,
      trace: process.env.NODE_ENV !== "production",
      log: true,
      origin,
      sessionId,
      corrupt: corruptQuery,
      traceId,
    });
    inFlight.set(key, pending);
    // Whoever started the run owns caching it; followers only read.
    void pending
      .then((result) => {
        if (!result.degraded) cache.set(key, result);
      })
      .finally(() => inFlight.delete(key));
  }

  try {
    const result = await pending;
    noteSearch(result.degraded ? "degraded" : "ok");
    return Response.json({ ...presentSearchResult(result), cached: false, ms: Math.round(performance.now() - started) });
  } catch (error) {
    const { searchFailed, searchClientAborted } = await import("@/lib/telemetry/search");
    const message = error instanceof Error ? error.message : "搜索失败。";
    if (request.signal.aborted) {
      void searchClientAborted(traceId, sessionId);
      return new Response(null, { status: 499 });
    }
    void searchFailed(traceId, sessionId, message, message.toLowerCase().includes("timeout") ? "SEARCH_TIMEOUT" : "SEARCH_FAILED");
    return Response.json({ error: message }, { status: 503 });
  }
}
