import { runHybridQuery } from "@/lib/hybrid/execute";
import { discoverCacheKey, lookupDiscover, storeDiscover } from "@/lib/atlas/discoverCache";
import { presentDiscoverResult } from "@/lib/atlas/evidence";
import { normalizeOrigin } from "@/lib/telemetry/organic";
import { isValidSessionId, newSearchId } from "@/lib/telemetry/ids";
import { corruptCapture } from "@/lib/telemetry/search";
import { discoverReceived, discoverCompleted, discoverFailed } from "@/lib/telemetry/discover";
import { noteSearch } from "@/lib/atlas/runtime";
import { prepareMarketForQuery } from "@/lib/market/refresh";

/**
 * Market Intelligence Phase 2 — Hybrid Market Discovery endpoint (§15).
 *
 * One entry for every natural-language discovery query: the deterministic
 * parser compiles the query into a plan, and the executor routes it —
 * semantic-only keeps the exact /api/search path, market-only keeps the exact
 * Phase 1 Market Query path, and the two hybrid orders join them without ever
 * fusing scores. The response carries the plan so the UI never re-derives
 * rankings and every answer is explainable (query → plan → execution → results).
 *
 * Phase 3.4: each row additionally carries its live judgement (when a Jev
 * decision backs it) with the resolved EvidenceView list — the UI contract in
 * lib/atlas/evidence. The cache stores the domain result; presentation is
 * applied after the cache on every path.
 *
 * Product Usage Baseline: EVERY real search gets ONE trace id, minted here
 * before anything runs — including cache replays, market-only answers and
 * unsupported intents, which the pipeline's own events never saw. Telemetry is
 * fire-and-forget: it cannot fail, delay or change the answer (§1.2).
 */
export async function POST(request: Request) {
  const started = performance.now();
  const body = (await request.json().catch(() => null)) as { query?: unknown; origin?: unknown; sessionId?: unknown } | null;
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 120) : "";
  if (query.length < 2) return Response.json({ error: "至少输入 2 个字。" }, { status: 400 });

  // One trace id per real search (usage spec §2), minted before anything runs —
  // cache replays, corrupt captures, market-only answers and unsupported
  // intents all carry it.
  const traceId = newSearchId();

  const corruptQuery = /\uFFFD/.test(query) || /[\u0000-\u0008\u000E-\u001F]/.test(query);
  if (corruptQuery) corruptCapture(traceId, "query carries U+FFFD/control chars (client encoding corruption)");

  const headerOrigin = request.headers.get("x-search-origin");
  const { origin, invalidProvided } = normalizeOrigin(body?.origin ?? headerOrigin ?? undefined);
  const rawSession = body?.sessionId ?? request.headers.get("x-session-id");
  const sessionId = isValidSessionId(rawSession) ? rawSession : null;
  if (invalidProvided) corruptCapture(traceId, `invalid requestOrigin "${invalidProvided.slice(0, 40)}" fell back to organic_ui`);

  let key: string;
  let hit: ReturnType<typeof lookupDiscover>;
  try {
    await prepareMarketForQuery(query);
    key = discoverCacheKey(query);
    hit = lookupDiscover(key);
  } catch (error) {
    // Maintenance can temporarily reject snapshot reads before execution starts.
    // This is still one received search with a trace and an explicit retryable error.
    void discoverReceived({ searchId: traceId, rawQuery: query, origin, sessionId, cached: false, corrupt: corruptQuery });
    const message = error instanceof Error ? error.message : "搜索失败。";
    void discoverFailed({ searchId: traceId, sessionId, message });
    return Response.json({ error: message, searchId: traceId }, { status: 503 });
  }
  if (hit) {
    // §9 cache observability: a replay is recorded with the answer the user
    // saw and the run that produced it — never re-executed, never re-judged.
    void discoverReceived({ searchId: traceId, rawQuery: query, origin, sessionId, cached: true, corrupt: corruptQuery });
    void discoverCompleted({
      searchId: traceId,
      sessionId,
      result: hit,
      jevSummary: null,
      cached: true,
      replayOfSearchId: hit.searchId ?? null,
      serverMs: performance.now() - started,
    });
    return Response.json({ ...presentDiscoverResult(hit), cached: true, searchId: traceId, ms: Math.round(performance.now() - started) });
  }

  void discoverReceived({ searchId: traceId, rawQuery: query, origin, sessionId, cached: false, corrupt: corruptQuery });

  let result;
  try {
    result = await runHybridQuery(query, { log: true, origin, sessionId, corrupt: corruptQuery, traceId });
  } catch (error) {
    // §10: a crash is a trace too — recorded with its message, answered 503.
    const message = error instanceof Error ? error.message : "搜索失败。";
    void discoverFailed({ searchId: traceId, sessionId, message });
    return Response.json({ error: message, searchId: traceId }, { status: 503 });
  }
  if (result.results.length && !result.execution.degraded) storeDiscover(key, result);
  if (result.execution.order !== "semantic-only") noteSearch(result.execution.degraded ? "degraded" : "ok");
  void discoverCompleted({
    searchId: traceId,
    sessionId,
    result,
    jevSummary: result.jevSummary ?? null,
    cached: false,
    serverMs: performance.now() - started,
  });
  return Response.json({ ...presentDiscoverResult(result), cached: false, searchId: traceId, ms: Math.round(performance.now() - started) });
}
