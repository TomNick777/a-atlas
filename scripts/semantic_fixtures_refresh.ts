/**
 * Semantic fixture refresh — explicit capture of real Jev answers into
 * committed, diffable fixtures (Phase 2.1 §9).
 *
 *   npm run semantic:fixtures:refresh -- --preset H1      one preset's fixtures
 *   npm run semantic:fixtures:refresh -- --all            every preset's fixtures
 *   npm run semantic:fixtures:refresh -- --query "机器人"  one residual query
 *
 * Requires TYPESAFE_API_KEY (real capture, no stub): every fixture records its
 * provenance (query, operation, Jev identity, retrieval options, digests,
 * capturedAt). Capturing from a degraded run refuses to write. The refresh run
 * itself is the only sanctioned live spend of this command.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { HYBRID_PRESETS } from "../lib/hybrid/presets";
import { runHybridQuery } from "../lib/hybrid/execute";
import { runSearch } from "../lib/search/pipeline";
import { getJevCloudProvider, setJevProviderOverride } from "../lib/jev/cloud";
import { TeeJudgeProvider, canonicalJson, type RecordedCall } from "../lib/jev/recorded";
import { JEV_PRODUCTION_MODEL } from "../lib/jev/provider";
import { jevBaseUrl, typesafeKey } from "../lib/env";
import { loadLocalEnv } from "./load-env";
import { loadDataset } from "../lib/companies";
import { loadMarketStateManifest } from "../lib/market/state";
import type { SemanticOutcome } from "../lib/hybrid/execute";

const ROOT = resolve(process.cwd(), "tests/fixtures/semantic");

/** Presets whose semantic step is full-corpus retrieval (the residual query). */
const RETRIEVAL_PRESETS = ["H1", "H2", "H3", "H5", "H6", "H7", "H8", "H9"];
/** H10's semantic step is the market-first subset judge, not full retrieval. */
const SUBSET_PRESET = "H10";
/** The H1 capture also records its first rerank chunk as the raw payload fixture. */
const CHUNK_PAYLOAD_PRESET = "H1";

const slugOf = (query: string) => createHash("sha1").update(query).digest("hex").slice(0, 8);

function readIndex(): Record<string, string> {
  const file = resolve(ROOT, "index.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function provenance(calls: RecordedCall[]) {
  const dataset = loadDataset();
  const manifest = loadMarketStateManifest();
  const answered = [...new Set(calls.map((call) => call.response.model).filter(Boolean))];
  return {
    jevModelRequested: getJevCloudProvider().model,
    jevModelAnswered: answered.length === 1 ? answered[0] : answered,
    endpoint: jevBaseUrl().replace(/^https?:\/\//, ""),
    judgeLanguage: "zh" as const,
    retrievalPool: 200,
    judgeChunk: 100,
    jevDetail: 420,
    corpusDigest: dataset.version,
    marketTradingDay: manifest?.latestTradingDay ?? null,
    marketDigest: manifest?.contentDigest.value.slice(0, 16) ?? null,
    capturedAt: new Date().toISOString(),
  };
}

function assertHealthyCapture(calls: RecordedCall[], what: string): void {
  if (!calls.length) throw new Error(`${what}: capture recorded no Jev calls — refusing to write a fixture from nothing`);
  const degraded = calls.filter((call) => !call.response.model);
  if (degraded.length) throw new Error(`${what}: ${degraded.length} call(s) answered without a model identity — capture refused (degraded run must not become a fixture)`);
}

async function captureRetrieval(query: string): Promise<{ outcome: SemanticOutcome; calls: RecordedCall[] }> {
  const tee = new TeeJudgeProvider(getJevCloudProvider());
  setJevProviderOverride(tee);
  try {
    const result = await runSearch(query, { log: false });
    const outcome: SemanticOutcome = {
      hits: result.hits.map((hit) => ({
        code: hit.code,
        name: hit.name,
        probability: hit.probability,
        industry: hit.industry,
        swLevel1Industry: hit.swLevel1Industry,
        province: hit.province,
        business: hit.business,
      })),
      matches: result.matches,
      searchId: null,
      degraded: result.degraded,
      decidedBy: result.decidedBy === "jev" ? "jev" : "retrieval",
      judgeOutcome: result.judge?.outcome ?? null,
    };
    if (result.degraded || outcome.decidedBy !== "jev") {
      throw new Error(`capture for「${query}」did not answer live (degraded=${result.degraded}, decidedBy=${outcome.decidedBy}) — refusing to write a degraded fixture`);
    }
    return { outcome, calls: tee.calls };
  } finally {
    setJevProviderOverride(null);
  }
}

function writeRetrievalFixture(query: string, outcome: SemanticOutcome, calls: RecordedCall[]): string {
  assertHealthyCapture(calls, `retrieval「${query}」`);
  const slug = slugOf(query);
  const file = resolve(ROOT, "retrieval", `${slug}.json`);
  writeJson(file, {
    fixtureSchema: "atlas-semantic-retrieval-fixture/1",
    query,
    operation: "semantic-retrieval-v3",
    responseContract: "systemone-noul-v1",
    provenance: provenance(calls),
    /** The executor's SemanticOutcome contract, captured from the real path. */
    result: outcome,
  });
  return `retrieval/${slug}.json`;
}

function writeChunkPayloadFixture(query: string, calls: RecordedCall[]): string {
  assertHealthyCapture(calls, `chunk payload「${query}」`);
  const first = calls[0];
  const candidateCodes = Object.values(first.request.questions as Record<string, { instructions: { company: { code: string } } }>).map(
    (question) => question.instructions.company.code,
  );
  writeJson(resolve(ROOT, "judge", "h1-chunk1.json"), {
    fixtureSchema: "atlas-jev-judge-payload-fixture/1",
    query,
    operation: "judge-noul-chunk",
    purpose: "semantic rerank first chunk (H1, 200-candidate V3 pool)",
    responseContract: "systemone-noul-v1",
    provenance: { ...provenance(calls), candidateCount: candidateCodes.length },
    request: first.request,
    response: first.response,
  });
  return "judge/h1-chunk1.json";
}

async function captureSubsetPreset(raw: string): Promise<RecordedCall[]> {
  const tee = new TeeJudgeProvider(getJevCloudProvider());
  setJevProviderOverride(tee);
  try {
    const result = await runHybridQuery(raw, { log: false });
    if (result.execution.order !== "market-first" || result.execution.degraded || result.execution.decidedBy !== "jev") {
      throw new Error(`capture for「${raw}」did not answer live market-first (order=${result.execution.order}, degraded=${result.execution.degraded}, decidedBy=${result.execution.decidedBy})`);
    }
    return tee.calls;
  } finally {
    setJevProviderOverride(null);
  }
}

function writeSubsetPayloadFixture(raw: string, calls: RecordedCall[]): string {
  assertHealthyCapture(calls, `subset payload「${raw}」`);
  if (calls.length !== 1) throw new Error(`subset judge capture expected exactly 1 call, got ${calls.length} — market-first payload shape changed, do not force-write`);
  const call = calls[0];
  const lookingFor = String((call.request.state as { looking_for?: string } | undefined)?.looking_for ?? "");
  const questions = call.request.questions as Record<string, { instructions: { company: { code: string } } }>;
  const candidateCodes = Object.values(questions).map((question) => question.instructions.company.code);
  writeJson(resolve(ROOT, "judge", "h10-subset.json"), {
    fixtureSchema: "atlas-jev-judge-payload-fixture/1",
    query: lookingFor,
    operation: "judge-noul-chunk",
    purpose: `market-first subset judge (H10「${raw}」, market Top-20)`,
    responseContract: "systemone-noul-v1",
    provenance: { ...provenance(calls), candidateCount: candidateCodes.length },
    request: call.request,
    response: call.response,
  });
  return "judge/h10-subset.json";
}

async function main(): Promise<void> {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const presetIdx = args.indexOf("--preset");
  const queryIdx = args.indexOf("--query");
  if (!typesafeKey()) {
    console.error("TYPESAFE_API_KEY is empty — fixture refresh captures the REAL Jev cloud and cannot run without it.");
    console.error("Deterministic tests replay committed fixtures; they never capture. (CI uses the stub endpoint and never refreshes.)");
    process.exit(1);
  }
  if (getJevCloudProvider().model !== "jev-latest" || jevBaseUrl() !== "https://api.typesafe.ai/v1/systemone") {
    console.error(`refusing to capture against a non-production Jev surface (model=${getJevCloudProvider().model}, endpoint=${jevBaseUrl()})`);
    process.exit(1);
  }

  mkdirSync(resolve(ROOT, "retrieval"), { recursive: true });
  mkdirSync(resolve(ROOT, "judge"), { recursive: true });
  const index = readIndex();
  const written: string[] = [];
  let realCalls = 0;

  const presets = all ? [...RETRIEVAL_PRESETS, SUBSET_PRESET] : presetIdx >= 0 ? [(args[presetIdx + 1] ?? "").toUpperCase()].filter(Boolean) : [];
  const singleQuery = queryIdx >= 0 ? args[queryIdx + 1] : null;
  if (!all && !presets.length && !singleQuery) {
    console.error('usage: npm run semantic:fixtures:refresh -- --all | --preset H1..H10 | --query "残留语义"');
    process.exit(1);
  }

  for (const preset of presets) {
    const raw = HYBRID_PRESETS[preset];
    if (!raw) {
      console.error(`unknown preset ${preset} — known: ${Object.keys(HYBRID_PRESETS).join(", ")}`);
      process.exit(1);
    }
    if (preset === SUBSET_PRESET) {
      const calls = await captureSubsetPreset(raw);
      realCalls += calls.length;
      written.push(writeSubsetPayloadFixture(raw, calls));
      continue;
    }
    const residual = (await import("../lib/hybrid/compile")).compileHybridQuery(raw).plan.semantic?.query;
    if (!residual) throw new Error(`preset ${preset} has no semantic residual — it needs no retrieval fixture`);
    const { outcome, calls } = await captureRetrieval(residual);
    realCalls += calls.length;
    const existing = index[residual];
    if (existing && existing !== `retrieval/${slugOf(residual)}.json`) throw new Error(`index maps「${residual}」to ${existing} — slug collision, investigate before overwriting`);
    written.push(`retrieval/${residual} → ${writeRetrievalFixture(residual, outcome, calls)}`);
    index[residual] = `retrieval/${slugOf(residual)}.json`;
    if (preset === CHUNK_PAYLOAD_PRESET) written.push(writeChunkPayloadFixture(residual, calls));
  }

  if (singleQuery) {
    const { outcome, calls } = await captureRetrieval(singleQuery);
    realCalls += calls.length;
    written.push(`retrieval/${singleQuery} → ${writeRetrievalFixture(singleQuery, outcome, calls)}`);
    index[singleQuery] = `retrieval/${slugOf(singleQuery)}.json`;
  }

  writeJson(resolve(ROOT, "index.json"), index);
  console.log(`fixtures written (${realCalls} real Jev calls spent):`);
  for (const row of written) console.log(`  ${row}`);
  console.log(`production model in charge: ${JEV_PRODUCTION_MODEL}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
