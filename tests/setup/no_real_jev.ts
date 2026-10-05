/**
 * Deterministic-suite network guard (Phase 2.1 §14, Jev-First since Phase 3.2).
 *
 * npm test is the offline layer: unit, parser, executor, H1–H10 fixture
 * replay, payload contract. If anything in that layer reaches for the real
 * network the suite FAILS FAST — a warning would let accidental API
 * consumption hide inside green runs. Localhost stays allowed (the stub
 * endpoint and any local service contract checks are not the cloud).
 *
 * Tests that stub fetch themselves (vi.stubGlobal) replace this wrapper
 * wholesale and are unaffected; unstubbing restores the guard.
 */

const REMOTE = /^https?:\/\//i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|::1|\[\w*::1\])(:\d+)?$/i;
const JEV_LIKE = /systemone|typesafe\.ai/i;

const original = globalThis.fetch;
if (typeof original === "function") {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let raw = "";
    try {
      raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    } catch {
      raw = "";
    }
    if (raw && REMOTE.test(raw)) {
      let host = "";
      try {
        host = new URL(raw).hostname;
      } catch {
        host = "";
      }
      if (host && !LOCAL_HOST.test(host)) {
        const hint = JEV_LIKE.test(raw)
          ? "Unexpected cloud API access in deterministic test (Phase 2.1 §14). " +
            "Jev Cloud is the ONLY cloud consumer — real calls may come only from the sanctioned " +
            "live suites (npm run test:jev-live, npm run semantic:fixtures:refresh). " +
            "Inject offline behaviour instead: fixtureSemanticEngine() for the semantic engine, " +
            "setJevProviderOverride(new RecordedJudgeProvider(...)) for the judge seam, or the " +
            "provider DI already offered by runHybridQuery."
          : "Unexpected outbound network access in deterministic test (Phase 2.1 §14). " +
            "Tests must be offline: stub fetch or use committed fixtures.";
        throw new Error(hint);
      }
    }
    return original.call(globalThis, input, init);
  }) as typeof fetch;
}
