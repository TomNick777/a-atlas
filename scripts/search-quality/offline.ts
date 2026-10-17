/** Offline observer of the current product boundary. Never a live quality score. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileCompanyQuery, runCompanyDiscovery } from "../../lib/discovery/query";
import { runSearch } from "../../lib/search/pipeline";
import type { SearchResult } from "../../lib/types";
import type { HybridDiscoverResult } from "../../lib/hybrid/contracts";
import { isValidSearchId } from "../../lib/telemetry/ids";

export type MeasurementCase = { id: string; query: string; traceId?: string; targetCodes?: string[] };
export function parseCases(raw: unknown): MeasurementCase[] {
  const cases = (raw as { cases?: unknown })?.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error("A nonempty cases array is required");
  const ids = new Set<string>();
  for (const row of cases) {
    if (!row || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id) ||
      typeof row.query !== "string" || row.query.length < 2 || row.query.length > 120 || row.query.trim() !== row.query ||
      (row.traceId !== undefined && (typeof row.traceId !== "string" || !isValidSearchId(row.traceId))) ||
      (row.targetCodes !== undefined && (!Array.isArray(row.targetCodes) || row.targetCodes.some((code: unknown) => typeof code !== "string" || !/^\d{6}$/.test(code))))) {
      throw new Error("Invalid/duplicate case id, raw query, trace id or canonical target code");
    }
    ids.add(row.id);
  }
  return cases as MeasurementCase[];
}

export function readSavedAnswer(traceId: string, query: string, root = join(process.cwd(), "data/discovery-answers")) {
  if (!isValidSearchId(traceId)) throw new Error("Invalid trace id");
  const bytes = readFileSync(join(root, `${traceId}.json`));
  const envelope = JSON.parse(bytes.toString("utf8"));
  if (envelope.schemaVersion !== 1 || envelope.id !== traceId || typeof envelope.payload !== "string" ||
    createHash("sha256").update(envelope.payload).digest("hex") !== envelope.sha256) throw new Error("Saved answer integrity check failed");
  const record = JSON.parse(envelope.payload) as { answer: HybridDiscoverResult; runtimeModel: string | null; corpusDigest: string; evidence: unknown };
  // Cached answers retain their original computation id inside the new trace's
  // integrity envelope. Never relabel that answer as a new model observation.
  if (record.answer.query !== query || !isValidSearchId(record.answer.searchId) || !Array.isArray(record.answer.results)) throw new Error("Saved answer query/trace mismatch");
  return { ...record, fileSha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function measureRetrievalCase(row: MeasurementCase) {
  let raw: SearchResult | null = null;
  const answer = await runCompanyDiscovery(row.query, {
    skipJev: true, log: false, trace: true, origin: "smoke",
    searchEngine: async (query, options) => { raw = await runSearch(query, options); return raw; },
  });
  const search = raw as SearchResult | null;
  const candidates = search?.trace?.finalists ?? [];
  return {
    id: row.id, query: row.query, mode: "retrieval-only", originalTraceId: row.traceId ?? null,
    answer, retrieval: search?.trace ? {
      candidateCodes: search.trace.finalists, constraints: search.trace.constraints,
      // Legacy trace channel scores are not necessarily V3 BM25/RRF scores.
      // Export membership only; degraded blend fields are not model decisions.
      channelCodes: Object.fromEntries(Object.entries(search.trace.channels).map(([key, hits]) => [key, hits.map(hit => hit.code)])),
    } : null,
    targets: (row.targetCodes ?? []).map(code => ({ code, candidateRank: candidates.includes(code) ? candidates.indexOf(code) + 1 : null,
      displayedRetrievalRank: answer.results.findIndex(result => result.code === code) + 1 || null })),
    judgementMeasured: false, groundTruth: "not-supplied; target codes are diagnostic probes, not a complete gold set",
  };
}

export async function measureSavedBoundary(row: MeasurementCase, root?: string) {
  if (!row.traceId) throw new Error("Saved-boundary replay requires traceId for every case");
  const saved = readSavedAnswer(row.traceId, row.query, root);
  const original = saved.answer;
  const unsupported = !!compileCompanyQuery(row.query).plan.unsupported;
  if (!unsupported && original.execution.decidedBy === "market") throw new Error("A market-only answer cannot be replayed as semantic evidence");
  const decidedBy = original.execution.decidedBy === "market" ? "retrieval" : original.execution.decidedBy ?? "retrieval";
  if (!unsupported && original.results.some(result => typeof result.probability !== "number" || !Number.isFinite(result.probability))) throw new Error("Saved semantic rows are missing their original scores");
  const outcome: SearchResult = {
    query: row.query, searchId: row.traceId,
    hits: unsupported ? [] : original.results.map(result => ({ code: result.code, name: result.name, probability: result.probability!,
      industry: result.industry ?? "", swLevel1Industry: result.swLevel1Industry ?? "", province: result.province ?? "", business: result.business ?? "" })),
    matches: original.results.length, degraded: original.execution.degraded,
    decidedBy,
    judge: { provider: decidedBy === "retrieval" ? "none" : decidedBy, model: saved.runtimeModel, outcome: "not_requested" },
    tokens: 0, costUsd: null,
    intelligence: original.intelligence ?? undefined,
    judgements: Object.fromEntries(original.results.filter(result => result.judgement).map(result => [result.code, result.judgement!])),
  };
  const answer = await runCompanyDiscovery(row.query, { log: false, origin: "replay", companies: [], searchEngine: async () => outcome });
  return {
    id: row.id, query: row.query, mode: "saved-boundary-replay", originalTraceId: row.traceId,
    computedSearchId: original.searchId, cacheReplay: original.searchId !== row.traceId,
    historicalModel: saved.runtimeModel, historicalCorpusDigest: saved.corpusDigest, savedFileSha256: saved.fileSha256,
    originalCount: original.results.length, replayedCount: answer.results.length,
    removedCodes: original.results.filter(result => !answer.results.some(next => next.code === result.code)).map(result => result.code),
    replayedCodes: answer.results.map(result => result.code), originalEvidence: saved.evidence,
    judgementMeasured: false,
    limitations: ["Only originally saved rows pass through today's boundary; no retrieval or model is rerun.",
      "Omitted historical candidates/decisions cannot be reconstructed. This is not a new answer or quality baseline."],
  };
}
