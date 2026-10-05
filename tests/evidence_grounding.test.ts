import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runHybridQuery as runCurrentHybridQuery, type HybridExecuteOptions } from "../lib/hybrid/execute";
const runHybridQuery = (raw: string, options: HybridExecuteOptions = {}) => runCurrentHybridQuery(raw, { ...options, legacyReplay: true });
import { loadCommittedMarketStateManifest, loadMarketStateRows } from "../lib/market/state";
import { HYBRID_PRESETS } from "../lib/hybrid/presets";
import { RecordedJudgeProvider, type RecordedCall } from "../lib/jev/recorded";
import { setJevProviderOverride } from "../lib/jev/cloud";
import { evidenceViewsFor, presentDiscoverResult } from "../lib/atlas/evidence";

/**
 * Evidence grounding, mechanical (Phase 3.4 §20). The H10 replay drives the
 * REAL executor and the REAL judge adapter over a recorded cloud payload, so
 * the surfaced judgements are production-shaped. Everything the UI would show
 * must survive these four properties:
 *
 *   A. every displayed evidence resolves (refs → verbatim Atlas text);
 *   B. explanation ⊆ provided evidenceRefs      (tests/evidence_explain.test.ts);
 *   C. no invented source label                 (tests/evidence_view.test.ts);
 *   D. no orphan judgement — every surfaced decision carries evidence.
 */

/** The recorded H10 subset judge as a replay provider (real adapter, no network). */
function h10RecordedProvider(): RecordedJudgeProvider {
  const doc = JSON.parse(readFileSync(resolve(__dirname, "fixtures/semantic/judge/h10-subset.json"), "utf8")) as {
    request: Record<string, unknown>;
    response: { model: string | null; answers: unknown; usage: { input_tokens: number; output_tokens: number } };
  };
  const call: RecordedCall = {
    kind: "rerank",
    request: doc.request,
    response: doc.response,
    meta: { latencyMs: 0, inputTokens: doc.response.usage.input_tokens, outputTokens: doc.response.usage.output_tokens },
  };
  return new RecordedJudgeProvider([call], { label: "H10 grounding" }).withLabel("H10 grounding");
}

afterEach(() => {
  setJevProviderOverride(null);
});

describe("evidence grounding — no judgement without resolvable evidence (§20 A/D)", () => {
  it("every surfaced H10 judgement carries evidence refs that resolve verbatim", async () => {
    setJevProviderOverride(h10RecordedProvider());
    const manifest = loadCommittedMarketStateManifest();
    const result = await runHybridQuery(HYBRID_PRESETS.H10, { log: false, marketInject: { manifest, rows: manifest ? loadMarketStateRows(manifest.latestTradingDay, manifest) ?? undefined : undefined } });
    expect(result.execution.decidedBy).toBe("jev");
    expect(result.results.length).toBeGreaterThan(0);

    for (const row of result.results) {
      // D — no orphan judgement.
      expect(row.judgement, `row ${row.code} must carry a live judgement`).not.toBeNull();
      expect(row.judgement!.evidenceRefs.length, `row ${row.code} judgement must cite evidence`).toBeGreaterThan(0);
      for (const ref of row.judgement!.evidenceRefs) expect(ref.companyId).toBe(row.code);
      // A — every ref resolves, to the verbatim text, never partially.
      const views = evidenceViewsFor(row.judgement!.evidenceRefs);
      expect(views, `row ${row.code} evidence must resolve`).not.toBeNull();
      expect(views!.length).toBe(row.judgement!.evidenceRefs.length);
      for (const view of views!) expect(view.text.length).toBeGreaterThan(0);
      // Presented shape agrees: what the API would ship is exactly the resolved views.
      const presented = presentDiscoverResult({ ...result, results: [row] } as typeof result);
      expect(presented.results[0].evidence).toEqual(views);
    }
  });

  it("degraded answers surface no judgements at all (the blend is not a judgement)", async () => {
    const manifest = loadCommittedMarketStateManifest();
    const result = await runHybridQuery(HYBRID_PRESETS.H10, { log: false, skipJev: true, marketInject: { manifest, rows: manifest ? loadMarketStateRows(manifest.latestTradingDay, manifest) ?? undefined : undefined } });
    for (const row of result.results) {
      expect(row.judgement).toBeNull();
      const presented = presentDiscoverResult({ ...result, results: [row] } as typeof result);
      expect(presented.results[0].evidence).toBeNull();
    }
  });
});
