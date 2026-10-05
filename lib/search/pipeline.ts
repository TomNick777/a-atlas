import { loadDataset } from "../companies";
import {
  classify,
  drainSystemOneObservations,
  expectedCloudModel,
  jevJudgeAvailability,
  mockClassify,
  mockScores,
  MATCH_CHUNK as JUDGE_CHUNK,
  runJevJudgement,
  subjectsOf,
} from "../jev/capabilities";
import { jevModel } from "../env";
import type { JudgeReport, ResultJudgement, SearchResult, SearchTrace } from "../types";
import { buildLexicalIndex, type LexicalIndex } from "../text/tokenize";
import { embedQuery } from "../text/embed";
import { constraintsFromQuery, industryHitsDrop } from "./constraints";
import { finalistIndexes, meaningScores, nominate, wordScores, type Nomination } from "./retrieve";
import { exclusionCompanyPatterns } from "./querySpec";
import { fuse, matchCount } from "./score";
import { retrieveV3, lastRetrievalMs } from "./v3";
import { appendSearchRun, type SearchRun, type SearchRunRow } from "./log";
import { parseQuerySpec, QUERY_SPEC_PARSER_VERSION } from "./querySpec";
import { beginSearch, emitQueryParsed, retrievalCompleted, rerankEvent, searchResponseReady, searchClientAborted } from "../telemetry/search";
import { newSearchId } from "../telemetry/ids";
import { organicEligibilityFor, type RequestOrigin } from "../telemetry/organic";
import { computeJevValue, recordJevCall, type JevValue } from "../telemetry/jev";
import { ONTOLOGY_VERSION } from "../../search/ontology/index";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const lexStore = globalThis as unknown as { __lex?: { version: string; index: LexicalIndex } };

function lexical(version: string, texts: string[]): LexicalIndex {
  if (lexStore.__lex?.version === version) return lexStore.__lex.index;
  const index = buildLexicalIndex(texts);
  lexStore.__lex = { version, index };
  return index;
}

export type SearchOptions = {
  signal?: AbortSignal;
  trace?: boolean;
  /** Retrieval only. Used to measure the baseline Jev has to beat. */
  skipJev?: boolean;
  /** Which profile text Jev reads. English is only for the language measurement. */
  judgeLanguage?: "zh" | "en";
  /** Persist this run to data/search_log (production API sets it; evals don't). */
  log?: boolean;
  /** True when the API served this from the LRU cache (logged for query-frequency). */
  cached?: boolean;
  /** Who asked (telemetry §13): UI defaults organic_ui; scripts declare themselves. */
  origin?: RequestOrigin;
  /** Browser session id for cross-search correlation (reformulation, implicit signals). */
  sessionId?: string | null;
  /** The API detected corrupted query bytes (U+FFFD/control chars) — recorded, run excluded. */
  corrupt?: boolean;
  /**
   * Usage Baseline: the caller-owned trace id. The discover route mints ONE id
   * per real search so every execution order (including market-only, which
   * never reaches this pipeline) shares it; when absent, the pipeline mints its
   * own exactly as before. A label only — it never changes any decision.
   */
  traceId?: string;
};

const gitStore = globalThis as unknown as { __gitHead?: string | null };
function gitHead(): string | null {
  gitStore.__gitHead ??= (() => {
    try {
      return execSync("git rev-parse HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  })();
  return gitStore.__gitHead;
}

const shaStore = globalThis as unknown as { __datasetSha?: string | null };
function datasetSha16(): string | null {
  shaStore.__datasetSha ??= (() => {
    try {
      return createHash("sha256").update(readFileSync(path.join(process.cwd(), "data", "companies.json"))).digest("hex").slice(0, 16);
    } catch {
      return null;
    }
  })();
  return shaStore.__datasetSha;
}

// The judge identity the log row claims to have used. For a cloud model that
// identity is the version string the response carried back — never the alias we
// asked for, and never a hash of local weights (A-Atlas has none since Phase 4).
function judgeIdentityOf(report: JudgeReport): string {
  return report.model ?? `${report.provider}:${jevModel()}`;
}

export async function runSearch(raw: string, options: SearchOptions = {}): Promise<SearchResult> {
  const searchStarted = performance.now();
  const query = raw.trim().slice(0, 120);
  const { companies, vectors, version, edition, manifest, corpus } = loadDataset();
  // Which semantic layer decided retrieval — named in every telemetry row and
  // log line, so "what text was this search reading" is always answerable.
  const retrievalVersion = corpus ? "v3-rrf60-corpus" : `v3-rrf60-profile-${edition}`;
  const constraints = constraintsFromQuery(query);
  // Telemetry shares the search log's searchId (§4): one Search Run, one id.
  // A caller-supplied trace id (discover route) wins so the whole lifecycle —
  // including orders that never enter this pipeline — carries the same id.
  const searchId = options.traceId ?? newSearchId();
  const telemetryOn = options.log === true;
  const origin: RequestOrigin = options.origin ?? "organic_ui";
  const sessionId = options.sessionId ?? null;
  const corruptQuery = Boolean(options.corrupt) || query.length < 2;
  if (telemetryOn) {
    void beginSearch({
      searchId,
      rawQuery: raw.slice(0, 200),
      normalizedQuery: query,
      origin,
      sessionId,
      cached: options.cached ?? false,
      corrupt: corruptQuery,
    });
  }
  const availability = jevJudgeAvailability();
  const emptyJudge: JudgeReport = { provider: "none", model: null, outcome: availability.configured ? "bad_response" : "no_config" };
  const empty: SearchResult = {
    query,
    hits: [],
    matches: 0,
    degraded: true,
    judge: emptyJudge,
    tokens: 0,
    costUsd: null,
    decidedBy: "retrieval",
  };
  if (query.length < 2 || !companies.length) {
    if (telemetryOn) {
      void searchResponseReady({
        searchId,
        sessionId,
        serverTotalMs: performance.now() - searchStarted,
        queryParseMs: 0,
        retrievalMs: 0,
        rerankMs: 0,
        fusionMs: null,
        degraded: true,
        degradedReason: companies.length ? "empty_query" : "dataset_missing",
        fallbackUsed: null,
        decidedBy: "retrieval",
        judge: emptyJudge,
        matches: 0,
        actualJudgeModel: null,
        expectedJudgeModel: expectedCloudModel(),
        knowledgeVersion: null,
        retrievalVersion,
        organicEligibility: "EXCLUDED_CORRUPT",
        candidateCount: 0,
        fusedBeforeCap: 0,
        droppedByHardFilter: 0,
        bm25TopN: 0,
        vectorTopN: 0,
        vectorsFilePresent: Boolean(vectors),
        exclusionTypes: [],
        normalizedQuery: query,
        rerankTimeouts: 0,
        rerankErrors: 0,
        rerankRetries: 0,
        rerankRateLimited: 0,
        answeredChunks: 0,
        chunkCount: 0,
        breakerState: availability.breaker.state,
        top: [],
        top200Hash: null,
        jevSummary: null,
        jevValue: null,
        judgedByCode: null,
      });
    }
    return { ...empty, searchId };
  }

  // V3 candidate retrieval: QuerySpec expansion -> profile BM25 ⊕ profile embedding,
  // ontology hard filters, Top-200 pool (reports/LAYA_V3_RETRIEVAL_BENCHMARK.md).
  // Falls back to the legacy 4-channel nomination when profile vectors are missing.
  const parseStarted = performance.now();
  const spec = parseQuerySpec(query);
  const queryParseMs = performance.now() - parseStarted;
  if (telemetryOn) {
    emitQueryParsed({
      searchId,
      sessionId,
      raw,
      normalized: query,
      must: spec.must,
      should: spec.expansionTerms,
      exclude: spec.exclusions,
      concepts: spec.concepts,
      attrs: spec.attrs,
      parserVersion: QUERY_SPEC_PARSER_VERSION,
    });
  }
  const v3 = await retrieveV3(companies, query, version, embedQuery);
  const usingV3 = v3.candidates.length > 0;
  if (telemetryOn) {
    void retrievalCompleted({
      searchId,
      sessionId,
      timings: v3.timings,
      bm25TopN: v3.counts.bm25TopN,
      vectorTopN: v3.counts.vectorTopN,
      candidateCount: v3.candidates.length,
      fusedBeforeCap: v3.counts.fusedBeforeCap,
      droppedByHardFilter: v3.counts.droppedByHardFilter,
      top200Hash: createHash("sha256").update(v3.candidates.map((i) => companies[i]?.code ?? "").join(",")).digest("hex").slice(0, 16),
      vectorsFilePresent: Boolean(vectors),
      retrievalVersion,
    });
  }
  // V3 retrieval is deterministic and QuerySpec-driven. The choice classifier only
  // ever fed the legacy nomination buckets that V3 supersedes, so the V3 path does
  // not ask the cloud for an answer the ranker will not read. The legacy path is
  // untouched.
  const understanding =
    options.skipJev || usingV3 ? Promise.resolve(null) : classify(query, companies, { signal: options.signal });
  const index = lexical(version, companies.map((company) => company.searchableText));
  const words = wordScores(index, query, companies.length);
  const embedding = vectors ? embedQuery(query) : Promise.resolve(null);
  const [queryVector, understood] = await Promise.all([embedding, understanding]);
  if (options.signal?.aborted) {
    if (telemetryOn) void searchClientAborted(searchId, sessionId);
    return { ...empty, searchId };
  }

  const meaning = queryVector ? meaningScores(queryVector, vectors, companies.length) : companies.map(() => 0);
  const named = understood?.live ? understood : mockClassify(query, companies);
  // V3 supersedes the four-channel nomination; computing it anyway would cost a
  // full-pool blend + four sorts that nothing reads.
  const nomination = usingV3 ? null : nominate(companies, meaning, words, named.industries, named.concepts);
  const indexes = usingV3 ? v3.candidates : finalistIndexes(nomination as Nomination);
  const finalists = indexes.map((index) => companies[index]);

  let scores: number[];
  let tokens = understood?.tokens ?? 0;
  let judgeReport: JudgeReport = { provider: "none", model: null, outcome: availability.configured ? "bad_response" : "no_config" };
  let judgeCostUsd: number | null = null;
  let intelligence: SearchResult["intelligence"] | undefined = undefined;
  // Phase 3.4: live decisions keep their evidenceRefs — degraded median-fill
  // decisions are placeholders, never surfaced as judgements.
  let judgements: Record<string, ResultJudgement> | undefined = undefined;
  let decidedBy: SearchResult["decidedBy"] = "retrieval";
  let degraded = true;
  let rerankMs = 0;
  let rerankTimeouts = 0;
  let rerankErrors = 0;
  let rerankRetries = 0;
  let rerankRateLimited = 0;
  let answeredChunks = 0;
  let chunkCount = 0;
  // Usage Baseline: Jev cost/value facts captured from the capability's own
  // result — recorded in JEV_CALL / the response snapshot / the search log.
  let jevMeta: { capability: string; contractVersion: string; runtimeModel: string | null; status: string; outcome: string | null; judgeMs: number; totalMs: number; decisions: number } | null = null;
  let jevRemovedCount: number | null = null;
  const local = () => mockScores(indexes.map((index) => meaning[index]), indexes.map((index) => words[index]));

  if (options.skipJev) {
    scores = local();
    judgeReport = { provider: "none", model: null, outcome: "not_requested" };
  } else {
    // One budget for the whole rerank: the chunks share it, retries fit inside
    // it, and a slow cloud cannot hold the search request open past the
    // deadline — the capability owns that budget now; the pipeline only opens
    // the observation window it will drain for telemetry.
    const rerankStartedAt = performance.now();
    const rerankWindowStart = Date.now();
    chunkCount = Math.ceil(finalists.length / JUDGE_CHUNK);
    if (telemetryOn) rerankEvent({ searchId, sessionId, phase: "started", provider: "jev", candidateCount: finalists.length, batchCount: chunkCount });
    const match = await runJevJudgement(query, subjectsOf(finalists, options.judgeLanguage ?? "zh"), { signal: options.signal });
    rerankMs = performance.now() - rerankStartedAt;
    answeredChunks = match.answeredChunks;
    scores = match.decisions.map((decision) => decision.score);
    tokens += match.tokens;
    const observations = drainSystemOneObservations(rerankWindowStart);
    rerankTimeouts = observations.filter((row) => row.outcome === "timeout" || row.outcome === "connect_timeout").length;
    rerankErrors = observations.filter((row) => row.outcome === "network_error" || row.outcome === "server_error" || row.outcome === "bad_response" || row.outcome === "unauthorized" || row.outcome === "client_error").length;
    rerankRateLimited = observations.filter((row) => row.outcome === "rate_limited").length;
    rerankRetries = observations.filter((row) => row.attempt > 1).length;
    if (telemetryOn) {
      rerankEvent({
        searchId,
        sessionId,
        phase: "completed",
        provider: "jev",
        candidateCount: finalists.length,
        batchCount: chunkCount,
        rerankMs,
        timeouts: rerankTimeouts,
        errors: rerankErrors,
        retries: rerankRetries,
        rateLimited: rerankRateLimited,
        degraded: !match.live,
      });
      // §4 Jev cost trace: one event per capability invocation, from the
      // contract result the pipeline already holds — no extra call, no wire.
      void recordJevCall({
        searchId,
        sessionId,
        invocation: "discovery_rerank",
        capability: match.capability,
        contractVersion: match.contractVersion,
        runtimeModel: match.runtimeModel,
        status: match.status,
        outcome: match.outcome ?? null,
        subjectCount: finalists.length,
        decisionCount: match.decisions.length,
        chunkCount: match.chunks,
        answeredChunks: match.answeredChunks,
        tokens: match.tokens,
        costUsd: match.costUsd,
        judgeMs: match.timings.judgeMs,
        totalMs: match.timings.totalMs,
        retries: rerankRetries,
        timeouts: rerankTimeouts,
      });
    }
    jevMeta = {
      capability: match.capability,
      contractVersion: match.contractVersion,
      runtimeModel: match.runtimeModel,
      status: match.status,
      outcome: match.outcome ?? null,
      judgeMs: match.timings.judgeMs,
      totalMs: match.timings.totalMs,
      decisions: match.decisions.length,
    };
    if (match.live) {
      judgeReport = { provider: "jev", model: match.runtimeModel, outcome: "ok" };
      judgeCostUsd = match.costUsd;
      decidedBy = "jev";
      degraded = false;
      jevRemovedCount = match.decisions.filter((decision) => !decision.matched).length;
      const decided: Record<string, ResultJudgement> = {};
      for (const decision of match.decisions) {
        decided[decision.companyId] = {
          capability: match.capability,
          query,
          score: decision.score,
          matched: decision.matched,
          relationLabel: "relationLabel" in decision ? decision.relationLabel : null,
          evidenceRefs: decision.evidenceRefs,
        };
      }
      judgements = decided;
    } else {
      // Not a judgement: the deterministic retrieval blend, honestly labelled.
      scores = local();
      judgeReport = { provider: "none", model: match.runtimeModel, outcome: match.outcome ?? "bad_response" };
      decidedBy = "retrieval";
      degraded = true;
    }
    intelligence = {
      provider: match.live ? "jev" : "none",
      capability: match.capability,
      contractVersion: match.contractVersion,
      runtimeModel: match.runtimeModel,
      degraded: !match.live,
    };
  }

  const fusionStarted = performance.now();
  const ranked = fuse(companies, indexes, scores, constraints);
  const fusionMs = performance.now() - fusionStarted;
  const matches = matchCount(ranked);
  // §5 Jev value: did this call change the ranking? Pre-order is the retrieval
  // order Jev received; post-order is what the fusion produced. Derived purely
  // from arrays this function already computed — when Jev did not answer, the
  // value stays null (no before/after exists to compare), never faked.
  const jevValue: JevValue | null =
    jevMeta && decidedBy === "jev"
      ? computeJevValue(
          indexes.map((index) => companies[index].code),
          ranked.map((row) => companies[row.index].code),
          jevRemovedCount,
        )
      : null;
  const hits = ranked.slice(0, Math.max(matches, ranked.length)).map((row) => {
    const company = companies[row.index];
    return {
      code: company.code,
      name: company.name,
      probability: Math.round(row.probability * 100) / 100,
      industry: company.industry,
      swLevel1Industry: company.swLevel1Industry,
      province: company.region.province,
      business: company.businessDescription,
    };
  });

  // ---- Telemetry response snapshot (§20) + degraded evidence (§23) ----
  const exclusionPatterns = spec.exclusions.flatMap((type) =>
    exclusionCompanyPatterns(type).map((p) => ({ type, re: new RegExp(p) })),
  );
  // The reason is the provider's own outcome, not a guess derived from counters:
  // "why is this search degraded" must be answerable from the event alone (§34).
  const degradedReason: string | null = !degraded ? null : decidedBy === "jev" ? "fusion_dropped_all" : judgeReport.outcome;
  if (telemetryOn) {
    // §6: the top rows' judgement record — refs only (never corpus text) — plus
    // the query-level Jev rollup, so one event answers "what did this search
    // cost Jev and what did it change".
    const top20Codes = ranked.slice(0, 20).map((row) => companies[row.index].code);
    const judgedByCode: Record<string, { capability: string; matched: boolean; evidenceRefs: string[] }> = {};
    if (judgements) {
      for (const code of top20Codes) {
        const judgement = judgements[code];
        if (judgement) {
          judgedByCode[code] = {
            capability: judgement.capability,
            matched: judgement.matched,
            evidenceRefs: judgement.evidenceRefs.map((ref) => ref.ref),
          };
        }
      }
    }
    void searchResponseReady({
      searchId,
      sessionId,
      serverTotalMs: performance.now() - searchStarted,
      queryParseMs,
      retrievalMs: lastRetrievalMs(),
      rerankMs,
      fusionMs,
      degraded,
      degradedReason,
      fallbackUsed: decidedBy === "jev" ? null : "retrieval_blend",
      decidedBy,
      judge: judgeReport,
      matches,
      actualJudgeModel: judgeReport.model,
      expectedJudgeModel: expectedCloudModel(),
      knowledgeVersion: manifest?.semiconductorEnrichmentVersion ?? null,
      retrievalVersion,
      organicEligibility: organicEligibilityFor(origin, { cached: options.cached ?? false, corrupt: corruptQuery }),
      candidateCount: v3.candidates.length,
      fusedBeforeCap: v3.counts.fusedBeforeCap,
      droppedByHardFilter: v3.counts.droppedByHardFilter,
      bm25TopN: v3.counts.bm25TopN,
      vectorTopN: v3.counts.vectorTopN,
      vectorsFilePresent: Boolean(vectors),
      exclusionTypes: spec.exclusions,
      normalizedQuery: query,
      rerankTimeouts,
      rerankErrors,
      rerankRetries,
      rerankRateLimited,
      answeredChunks,
      chunkCount,
      breakerState: jevJudgeAvailability().breaker.state,
      top: ranked.slice(0, 20).map((row, at) => {
        const company = companies[row.index];
        return {
          rank: at + 1,
          code: company.code,
          name: company.name,
          grade: null,
          rerankerScore: round(row.jev),
          roles: [],
          matchedExclusionTypes: exclusionPatterns.filter(({ re }) => re.test(company.judgeText)).map(({ type }) => type),
        };
      }),
      top200Hash: createHash("sha256").update(v3.candidates.map((i) => companies[i]?.code ?? "").join(",")).digest("hex").slice(0, 16),
      jevSummary: jevMeta
        ? {
            calls: 1,
            tokens: tokens,
            costUsd: judgeCostUsd,
            latencyMs: Math.round(jevMeta.totalMs * 100) / 100,
          }
        : null,
      jevValue,
      judgedByCode,
    });
  }

  // ---- Search Replay & Review Log (never blocks/never fails the search) ----
  if (options.log && usingV3) {
    try {
      const zeroReasonOf = (company: (typeof companies)[number]): string | null => {
        const text = `${company.industry} ${company.businessDescription}`;
        if (constraints.province && company.region.province && company.region.province !== constraints.province) return "province";
        if (constraints.dropIndustries.some((drop) => industryHitsDrop(company.industry, text, drop))) return "drop_industry";
        if (exclusionPatterns.some(({ re }) => re.test(company.judgeText))) return "exclusion_pattern";
        return null;
      };
      const candidates: SearchRunRow[] = v3.candidates.map((companyIndex, rank) => {
        const company = companies[companyIndex];
        const info = v3.channelInfo.get(companyIndex);
        const judgeScore = scores[rank] ?? 0;
        return {
          rank: rank + 1,
          code: company.code,
          name: company.name,
          retrieval: {
            bm25Rank: info?.bm25Rank ?? null,
            bm25Score: info?.bm25Score ?? null,
            vectorRank: info?.vectorRank ?? null,
            vectorScore: info?.vectorScore ?? null,
            rrfScore: info?.rrfScore ?? 0,
          },
          reranker: { grade: null, score: Math.round(judgeScore * 1000) / 1000 },
          queryMatch: {
            matchedMust: spec.must.filter((term) => (company.searchProfileText || company.judgeText).includes(term)),
            matchedExclusion: [...new Set(exclusionPatterns.filter(({ re }) => re.test(company.judgeText)).map(({ type }) => type))],
            zeroReason: zeroReasonOf(company),
          },
          profile: {
            profileEdition: edition,
            searchTextHash: null,
          },
        };
      });
      const run: SearchRun = {
        logSchemaVersion: 3,
        searchId,
        timestamp: new Date().toISOString(),
        query: {
          raw,
          normalized: query,
          querySpec: {
            concepts: spec.concepts,
            must: spec.must,
            expansionTerms: spec.expansionTerms,
            exclusions: spec.exclusions,
            attrs: spec.attrs,
          },
        },
        versions: {
          gitHead: gitHead(),
          companyDatasetSha16: datasetSha16(),
          profileEdition: edition,
          searchProfileVersion: corpus
            ? null
            : manifest
              ? edition === "v1"
                ? "v1/2026-09-23-v1"
                : `${manifest.schemaVersion}/${manifest.ontologyVersion}`
              : "v1/2026-09-23-v1",
          corpusSchemaVersion: corpus?.schemaVersion ?? null,
          corpusContentDigest16: corpus?.contentDigest16 ?? null,
          ontologyVersion: ONTOLOGY_VERSION,
          derivationVersion: manifest?.derivationVersion ?? "v1-wordhit",
          semiconductorEnrichmentVersion: corpus?.knowledgeEnrichmentVersion ?? manifest?.semiconductorEnrichmentVersion ?? null,
          materialAttributionVersion: manifest?.materialAttributionVersion ?? null,
          sourceSnapshotId: manifest?.sourcesSnapshotId ?? manifest?.sourceSnapshotId ?? null,
          embeddingModel: corpus?.embeddingModel ?? manifest?.embeddingModel ?? "Xenova/bge-small-zh-v1.5",
          retrievalVersion,
          rerankerModel: judgeIdentityOf(judgeReport),
          rerankerSha: null,
          judgeProvider: judgeReport.provider,
          judgeOutcome: judgeReport.outcome,
          degraded,
        },
        timing: {
          queryParseMs: Math.round(queryParseMs * 100) / 100,
          retrievalMs: Math.round(lastRetrievalMs() * 100) / 100,
          rerankMs: Math.round(rerankMs * 100) / 100,
          totalMs: Math.round((performance.now() - searchStarted) * 100) / 100,
        },
        retrieval: {
          poolSize: v3.candidates.length,
          bm25Top: v3.wordChannel.slice(0, 50).map((i) => companies[i].code),
          vectorTop: v3.embedChannel.slice(0, 50).map((i) => companies[i].code),
          fusedTop200: v3.candidates.map((i) => companies[i].code),
          excludedByHardFilter: v3.excludedByHardFilter.slice(0, 200).map((i) => companies[i].code),
        },
        candidates,
        result: {
          matches,
          top20: ranked.slice(0, Math.max(matches, 0)).slice(0, 20).map((row, rank) => ({
            rank: rank + 1,
            code: companies[row.index].code,
            name: companies[row.index].name,
            score: Math.round(row.probability * 1000) / 1000,
          })),
        },
        jev: jevMeta
          ? {
              capability: jevMeta.capability,
              runtimeModel: jevMeta.runtimeModel,
              tokens,
              costUsd: judgeCostUsd,
              judgeMs: Math.round(jevMeta.judgeMs * 100) / 100,
              value: jevValue
                ? {
                    top1Changed: jevValue.top1Changed,
                    top10Changed: jevValue.top10Changed,
                    rankingChanged: jevValue.rankingChanged,
                    promotedIntoTop10: jevValue.promotedIntoTop10,
                    droppedFromTop10: jevValue.droppedFromTop10,
                    jevRemovedCount: jevValue.jevRemovedCount,
                    preTop: jevValue.preTop,
                    postTop: jevValue.postTop,
                  }
                : null,
            }
          : { capability: null, runtimeModel: null, tokens: 0, costUsd: null, judgeMs: null, value: null },
        cached: options.cached,
      };
      appendSearchRun(run);
    } catch (error) {
      console.warn("[search-log] record build failed (search unaffected):", error instanceof Error ? error.message : error);
    }
  }

  let trace: SearchTrace | undefined;
  if (options.trace) {
    const recallRank = new Map(indexes.map((index, rank) => [index, rank]));
    trace = {
      decidedBy,
      channels: nomination
        ? {
            meaning: nomination.meaning.map((index) => ({ code: companies[index].code, name: companies[index].name, score: round(meaning[index]) })),
            words: nomination.words.map((index) => ({ code: companies[index].code, name: companies[index].name, score: round(words[index]) })),
            industry: nomination.industry.map((index) => ({ code: companies[index].code, name: companies[index].name, score: round(meaning[index]) })),
            concept: nomination.concept.map((index) => ({ code: companies[index].code, name: companies[index].name, score: round(meaning[index]) })),
          }
        : {
            // The channels V3 actually fused, at the depth the legacy trace showed.
            meaning: v3.embedChannel.slice(0, 60).map((index) => ({ code: companies[index].code, name: companies[index].name, score: round(meaning[index]) })),
            words: v3.wordChannel.slice(0, 40).map((index) => ({ code: companies[index].code, name: companies[index].name, score: round(words[index]) })),
            industry: [],
            concept: [],
          },
      constraints,
      finalists: indexes.map((index) => companies[index].code),
      judged: ranked.map((row) => ({
        code: companies[row.index].code,
        name: companies[row.index].name,
        jev: round(row.jev),
        recallRank: recallRank.get(row.index) ?? -1,
        delta: (recallRank.get(row.index) ?? 0) - ranked.indexOf(row),
      })),
      final: ranked.slice(0, matches).map((row) => ({
        code: companies[row.index].code,
        name: companies[row.index].name,
        probability: round(row.probability),
        jev: round(row.jev),
      })),
    };
  }

  return (() => {
    // Only the hits this answer actually returns carry judgements — the map
    // covers every judged finalist, most of which never surface.
    const returned = hits.slice(0, 120);
    const surfaced: Record<string, ResultJudgement> = {};
    if (judgements) {
      for (const hit of returned) {
        const judgement = judgements[hit.code];
        if (judgement) surfaced[hit.code] = judgement;
      }
    }
    return {
      searchId,
      query,
      hits: returned,
      matches: Math.min(matches, hits.length),
      degraded,
      judge: judgeReport,
      tokens,
      costUsd: judgeReport.provider === "jev" ? judgeCostUsd : null,
      decidedBy,
      intelligence,
      judgements: judgements ? surfaced : undefined,
      trace,
    };
  })();
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Record a cache replay without re-running retrieval and without asking Jev again.
 *
 * The pre-Phase-4 route replayed a cache hit through `runSearch`, which meant a
 * user pressing Enter twice paid for a second cloud judgement — the exact
 * duplicate-request pattern §15 tells us to stop. The row is still written, so
 * query-frequency signals survive, but it is marked as a replay and carries the
 * id of the run that actually computed the answer.
 */
export function logCacheHit(raw: string, result: SearchResult, options: { origin?: RequestOrigin; sessionId?: string | null } = {}): void {
  if (!result.searchId) return;
  const { version, edition, manifest } = loadDataset();
  const spec = parseQuerySpec(result.query);
  const origin: RequestOrigin = options.origin ?? "organic_ui";
  try {
    const run: SearchRun = {
      logSchemaVersion: 3,
      searchId: newSearchId(),
      timestamp: new Date().toISOString(),
      query: {
        raw,
        normalized: result.query,
        querySpec: { concepts: spec.concepts, must: spec.must, expansionTerms: spec.expansionTerms, exclusions: spec.exclusions, attrs: spec.attrs },
      },
      versions: {
        gitHead: gitHead(),
        companyDatasetSha16: datasetSha16(),
        profileEdition: edition,
        searchProfileVersion: null,
        corpusSchemaVersion: loadDataset().corpus?.schemaVersion ?? null,
        corpusContentDigest16: loadDataset().corpus?.contentDigest16 ?? null,
        ontologyVersion: ONTOLOGY_VERSION,
        derivationVersion: manifest?.derivationVersion ?? "v1-wordhit",
        semiconductorEnrichmentVersion: loadDataset().corpus?.knowledgeEnrichmentVersion ?? manifest?.semiconductorEnrichmentVersion ?? null,
        materialAttributionVersion: manifest?.materialAttributionVersion ?? null,
        sourceSnapshotId: manifest?.sourcesSnapshotId ?? manifest?.sourceSnapshotId ?? null,
        embeddingModel: loadDataset().corpus?.embeddingModel ?? manifest?.embeddingModel ?? "Xenova/bge-small-zh-v1.5",
        retrievalVersion: loadDataset().corpus ? "v3-rrf60-corpus" : `v3-rrf60-profile-${edition}`,
        rerankerModel: judgeIdentityOf(result.judge),
        rerankerSha: null,
        judgeProvider: result.judge.provider,
        judgeOutcome: result.judge.outcome,
        degraded: result.degraded,
      },
      timing: { queryParseMs: 0, retrievalMs: 0, rerankMs: 0, totalMs: 0 },
      retrieval: { poolSize: 0, bm25Top: [], vectorTop: [], fusedTop200: [], excludedByHardFilter: [] },
      candidates: [],
      result: {
        matches: result.matches,
        top20: result.hits.slice(0, 20).map((hit, rank) => ({ rank: rank + 1, code: hit.code, name: hit.name, score: hit.probability })),
      },
      cached: true,
      cacheReplay: true,
      replayOfSearchId: result.searchId,
    };
    appendSearchRun(run);
    if (result.searchId) {
      void beginSearch({
        searchId: run.searchId,
        rawQuery: raw.slice(0, 200),
        normalizedQuery: result.query,
        origin,
        sessionId: options.sessionId ?? null,
        cached: true,
        corrupt: false,
      });
    }
  } catch (error) {
    console.warn("[search-log] cache replay record failed (search unaffected):", error instanceof Error ? error.message : error);
  }
}
