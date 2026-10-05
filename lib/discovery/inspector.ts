import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { loadDataset } from "../companies";
import { parseQuerySpec, exclusionCompanyPatterns, type QuerySpec } from "../search/querySpec";
import { constraintsFromQuery, industryHitsDrop } from "../search/constraints";
import { retrieveV3 } from "../search/v3";
import { expectedCloudModel, runSemanticMatch, subjectsOf } from "../jev/capabilities";
import { fuse, matchCount, SHOWN } from "../search/score";
import { embedQuery, DIM, dot } from "../text/embed";
import { tokensOf } from "../text/tokenize";
import { ONTOLOGY_VERSION } from "../../search/ontology/index";
import { traceVerdict, type TraceHint, type TraceObservation } from "./failureTaxonomy";

/**
 * Discovery Inspector (Phase 3B, DEV-only).
 *
 * Runs the production discovery path stage by stage — the SAME primitives in the
 * SAME order as lib/search/pipeline.ts runSearch (parseQuerySpec → retrieveV3 →
 * judge → fuse → matchCount) — without modifying any production code, and exposes
 * every intermediate so any query can answer: 正确公司在哪一步消失了？
 *
 * In jev mode (default) this executes one real cloud judgement, exactly like a
 * production search. In retrieval mode no judge is called and the ranking shown
 * is the deterministic RRF order, clearly labelled — it is a diagnostic view,
 * not a second judge (A-Atlas has exactly one: Jev Cloud).
 */

export type InspectMode = "jev" | "retrieval";

export type InspectorCandidate = {
  rank: number;
  code: string;
  name: string;
  bm25Rank: number | null;
  bm25Score: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  rrfScore: number;
  channels: string[];
  judgeScore: number | null;
};

export type InspectorEvidence = {
  code: string;
  name: string;
  fields: string[];
  matchedTerms: string[];
  snippets: string[];
};

export type InspectorExclusion = {
  code: string;
  name: string;
  reason: string;
  stage: "hard_filter" | "fusion";
};

export type InspectorTrace = {
  code: string;
  name: string | null;
  inDataset: boolean;
  textTermHits: string[];
  structuredTermHits: string[];
  evidenceSnippets: string[];
  inCandidatePool: boolean;
  poolRank: number | null;
  bm25Rank: number | null;
  vectorRank: number | null;
  standaloneVectorScore: number | null;
  judgeScore: number | null;
  zeroReason: string | null;
  finalRank: number | null;
  inMatches: boolean;
  /** Mechanical answer to "which layer lost it" — a hint, not a verdict. */
  verdict: TraceHint;
};

export type InspectionReport = {
  mode: InspectMode;
  identity: {    timestamp: string;
    gitHead: string | null;
    corpusActive: boolean;
    corpusSchemaVersion: string | null;
    corpusContentDigest16: string | null;
    retrievalVersion: string;
    datasetVersion: string;
    companyCount: number;
    ontologyVersion: string;
    embeddingModel: string | null;
    judgeModelExpected: string | null;
    judgeModelActual: string | null;
  };
  query: {
    raw: string;
    normalized: string;
    spec: QuerySpec;
  };
  retrieval: {
    poolSize: number;
    bm25TopN: number;
    vectorTopN: number;
    fusedBeforeCap: number;
    droppedByHardFilter: number;
    timings: { retrievalMs: number };
    candidates: InspectorCandidate[];
    hardFilterExcluded: InspectorExclusion[];
    bm25ChannelTop: string[];
    vectorChannelTop: string[];
  };
  evidence: InspectorEvidence[];
  judge: {
    decidedBy: "jev" | "retrieval";
    degraded: boolean;
    outcome: string | null;
    tokens: number;
    chunks: number;
    answeredChunks: number;
    scoredCandidates: number;
    ms: number | null;
  };
  fusion: {
    zeroed: InspectorExclusion[];
    matches: number;
    shownThreshold: number;
  };
  final: {
    /** "fuse" = production fusion with judge scores; "rrf_order" = no judge ran. */
    rankingSource: "fuse" | "rrf_order";
    ranking: Array<{ rank: number; code: string; name: string; jevScore: number | null; probability: number; inMatches: boolean }>;
  };
  traces: InspectorTrace[];
  timings: { totalMs: number };
};

type CorpusDoc = {
  symbol: string;
  name: string;
  business?: string[];
  products?: Array<{ name: string }>;
  revenueMix?: Array<{ name: string }>;
  concepts?: string[];
  themes?: Array<{ label: string }>;
  aliases?: string[];
  profile?: string;
  searchableText: string;
};

const docStore = globalThis as unknown as { __inspectorDocs?: { digest: string | null; docs: Map<string, CorpusDoc> } | null };

function corpusDocs(digest: string | null): Map<string, CorpusDoc> {
  if (docStore.__inspectorDocs && docStore.__inspectorDocs.digest === digest) return docStore.__inspectorDocs.docs;
  const docs = new Map<string, CorpusDoc>();
  const file = path.join(process.cwd(), "data", "company-corpus", "companies.jsonl");
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const doc = JSON.parse(line) as CorpusDoc;
      docs.set(doc.symbol, doc);
    }
  } catch {
    // corpus file absent — corpus is not in effect anyway
  }
  docStore.__inspectorDocs = { digest, docs };
  return docs;
}

function gitHead(): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function termHits(terms: string[], text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set(terms.filter((t) => text.includes(t)))];
}

function snippetsAround(terms: string[], text: string | undefined, cap = 3): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const term of terms) {
    const at = text.indexOf(term);
    if (at < 0) continue;
    const start = Math.max(0, at - 16);
    const end = Math.min(text.length, at + term.length + 16);
    out.push((start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : ""));
    if (out.length >= cap) break;
  }
  return out;
}

function queryTermHits(spec: QuerySpec, raw: string): string[] {
  // What the query literally asks about: its own tokens + the ontology terms it
  // touched. These are the terms a matching document should be able to cite.
  return [...new Set([...tokensOf(raw), ...spec.must])].filter((t) => t.length >= 2).slice(0, 24);
}

export async function inspectQuery(
  rawQuery: string,
  options: { mode?: InspectMode; expect?: string[]; signal?: AbortSignal } = {},
): Promise<InspectionReport> {
  const started = performance.now();
  const mode: InspectMode = options.mode ?? "jev";
  const query = rawQuery.trim().slice(0, 120);
  const { companies, vectors, version, corpus, manifest } = loadDataset();
  const activeRetrievalVersion = corpus ? "v3-rrf60-corpus" : "v3-rrf60-profile-fallback";

  const spec = parseQuerySpec(query);
  const constraints = constraintsFromQuery(query);
  const terms = queryTermHits(spec, query);

  const retrievalStarted = performance.now();
  const v3 = await retrieveV3(companies, query, version, embedQuery);
  const retrievalMs = Math.round(performance.now() - retrievalStarted);

  // ---- Jev judgement (same chunking, same budget, same input as production) ----
  const finalists = v3.candidates.map((index) => companies[index]);
  let scores: number[] | null = null;
  let judgeModelActual: string | null = null;
  let judgeOutcome: string | null = null;
  let judgeTokens = 0;
  let judgeChunks = 0;
  let judgeAnswered = 0;
  let judgeMs: number | null = null;
  let decidedBy: "jev" | "retrieval" = "retrieval";
  if (mode === "jev" && finalists.length) {
    const judgeStarted = performance.now();
    const match = await runSemanticMatch({ query, subjects: subjectsOf(finalists, "zh") }, { signal: options.signal });
    judgeMs = Math.round(performance.now() - judgeStarted);
    judgeTokens = match.tokens;
    judgeChunks = match.chunks;
    judgeAnswered = match.answeredChunks;
    judgeModelActual = match.runtimeModel;
    judgeOutcome = match.outcome ?? (match.status === "ok" ? "ok" : match.failure);
    if (match.live) {
      scores = match.decisions.map((decision) => decision.score);
      decidedBy = "jev";
    } else {
      scores = null; // honest: cloud did not deliver; inspection shows retrieval order only
    }
  }

  // ---- Ranking. With judge scores: production fuse exactly. Without (retrieval
  // mode / cloud failure): the deterministic RRF order, honestly labelled — never
  // a second judge. ----
  const rankingSource: "fuse" | "rrf_order" = scores ? "fuse" : "rrf_order";
  const ranked = scores
    ? fuse(companies, v3.candidates, scores, constraints)
    : v3.candidates.map((index) => ({ index, probability: 0, jev: 0 }));
  const matches = scores ? matchCount(ranked) : 0;

  const docs = corpusDocs(corpus?.contentDigest16 ?? null);
  const codeOf = new Map(companies.map((c, i) => [c.code, i] as const));
  const companyAt = (index: number) => companies[index];

  const exclusionPatterns = spec.exclusions.flatMap((type) =>
    exclusionCompanyPatterns(type).map((p) => ({ type, re: new RegExp(p) })),
  );
  const zeroReasonOf = (index: number): string | null => {
    const company = companyAt(index);
    const text = `${company.industry} ${company.businessDescription}`;
    if (constraints.province && company.region.province && company.region.province !== constraints.province) return "province";
    if (constraints.province && !company.region.province) return null; // dampened, not zeroed
    if (constraints.dropIndustries.some((drop) => industryHitsDrop(company.industry, text, drop))) return "drop_industry";
    if (exclusionPatterns.some(({ re }) => re.test(company.searchProfileText || company.judgeText))) return "exclusion_pattern";
    return null;
  };

  // ---- Candidate view (Top-50) ----
  const candidates: InspectorCandidate[] = v3.candidates.slice(0, 50).map((index, at) => {
    const company = companyAt(index);
    const info = v3.channelInfo.get(index);
    const channels: string[] = [];
    if (info?.bm25Rank != null) channels.push("bm25");
    if (info?.vectorRank != null) channels.push("vector");
    return {
      rank: at + 1,
      code: company.code,
      name: company.name,
      bm25Rank: info?.bm25Rank ?? null,
      bm25Score: info?.bm25Score ?? null,
      vectorRank: info?.vectorRank ?? null,
      vectorScore: info?.vectorScore ?? null,
      rrfScore: info?.rrfScore ?? 0,
      channels,
      judgeScore: scores ? Math.round((scores[at] ?? 0) * 1000) / 1000 : null,
    };
  });

  // ---- Corpus evidence view (same Top-50, real fields only) ----
  const evidence: InspectorEvidence[] = candidates.map((candidate) => {
    const doc = docs.get(candidate.code);
    const searchable = doc?.searchableText ?? companyAt(codeOf.get(candidate.code)!).searchProfileText ?? "";
    const fields: string[] = [];
    if (doc?.business?.length) fields.push("business");
    if (doc?.products?.length) fields.push("products");
    if (doc?.revenueMix?.length) fields.push("revenueMix");
    if (doc?.themes?.length) fields.push("themes");
    if (doc?.concepts?.length) fields.push("concepts");
    if (doc?.aliases?.length) fields.push("aliases");
    if (doc?.profile) fields.push("profile");
    const matched = termHits(terms, searchable);
    return { code: candidate.code, name: candidate.name, fields, matchedTerms: matched, snippets: snippetsAround(matched, searchable) };
  });

  // ---- Exclusion accounting ----
  const hardFilterExcluded: InspectorExclusion[] = v3.excludedByHardFilter.slice(0, 50).map((index) => {
    const company = companyAt(index);
    const patternHit = spec.exclusions.flatMap((type) =>
      exclusionCompanyPatterns(type).map((p) => ({ type, re: new RegExp(p) })).filter(({ re }) => re.test(company.judgeText)),
    );
    const overseasFail = spec.attrs.overseasMinShare != null && (company.overseasRevenueShare == null || company.overseasRevenueShare < spec.attrs.overseasMinShare);
    const reason = patternHit.length
      ? `exclusion:${patternHit.map(({ type }) => type).join(",")}`
      : overseasFail
        ? `attr:overseasMinShare(${spec.attrs.overseasMinShare}) company=${company.overseasRevenueShare ?? "null"}`
        : "unknown";
    return { code: company.code, name: company.name, reason, stage: "hard_filter" as const };
  });
  const finalRankByCode = new Map<string, { rank: number; inMatches: boolean; probability: number }>();
  ranked.forEach((row, at) => {
    finalRankByCode.set(companyAt(row.index).code, { rank: at + 1, inMatches: at < matches, probability: Math.round(row.probability * 1000) / 1000 });
  });
  const zeroed: InspectorExclusion[] = v3.candidates
    .map((index, at) => ({ index, at }))
    .filter(({ index }) => zeroReasonOf(index) != null)
    .slice(0, 50)
    .map(({ index }) => {
      const company = companyAt(index);
      return { code: company.code, name: company.name, reason: zeroReasonOf(index) as string, stage: "fusion" as const };
    });

  // ---- Traces: where did each expected symbol disappear? ----
  let traceQueryVector: Float32Array | null = null;
  if (vectors) {
    traceQueryVector = await embedQuery(`${query} ${spec.expansionTerms.join(" ")}`.trim());
  }
  const traces: InspectorTrace[] = [];
  for (const code of options.expect ?? []) {
    const index = codeOf.get(code);
    const company = index != null ? companyAt(index) : null;
    const doc = docs.get(code);
    if (!company || index == null) {
      traces.push({
        code,
        name: null,
        inDataset: false,
        textTermHits: [],
        structuredTermHits: [],
        evidenceSnippets: [],
        inCandidatePool: false,
        poolRank: null,
        bm25Rank: null,
        vectorRank: null,
        standaloneVectorScore: null,
        judgeScore: null,
        zeroReason: null,
        finalRank: null,
        inMatches: false,
        verdict: { stage: "benchmark", category: "F0", detail: "符号不在数据集中——期望值本身有问题" },
      });
      continue;
    }
    const searchable = company.searchProfileText || company.judgeText;
    const textHits = termHits(terms, searchable);
    const structuredText = [
      ...(doc?.business ?? []),
      ...(doc?.products ?? []).map((p) => p.name),
      ...(doc?.revenueMix ?? []).map((p) => p.name),
      ...(doc?.themes ?? []).map((t) => t.label),
      ...(doc?.concepts ?? []),
      ...(doc?.aliases ?? []),
      doc?.profile ?? "",
    ].join("\n");
    const structuredHits = termHits(terms, structuredText);
    const poolAt = v3.candidates.indexOf(index);
    const info = v3.channelInfo.get(index);
    const zeroReason = zeroReasonOf(index);
    const finalRow = finalRankByCode.get(code) ?? null;
    let standaloneVectorScore: number | null = null;
    if (vectors && traceQueryVector) standaloneVectorScore = Math.round(dot(traceQueryVector, vectors, index * DIM) * 1000) / 1000;
    const judgeScore = scores && poolAt >= 0 ? Math.round((scores[poolAt] ?? 0) * 1000) / 1000 : null;
    const obs: TraceObservation = {
      corpusActive: Boolean(corpus),
      textTermHits: textHits,
      structuredTermHits: structuredHits,
      inCandidatePool: poolAt >= 0,
      poolRank: poolAt >= 0 ? poolAt + 1 : null,
      judgeScore,
      zeroReason,
      finalRank: finalRow?.rank ?? null,
      inMatches: finalRow?.inMatches ?? false,
    };
    traces.push({
      code,
      name: company.name,
      inDataset: true,
      textTermHits: textHits,
      structuredTermHits: structuredHits,
      evidenceSnippets: snippetsAround([...textHits, ...structuredHits], searchable, 3),
      inCandidatePool: obs.inCandidatePool,
      poolRank: obs.poolRank,
      bm25Rank: info?.bm25Rank ?? null,
      vectorRank: info?.vectorRank ?? null,
      standaloneVectorScore,
      judgeScore,
      zeroReason,
      finalRank: obs.finalRank,
      inMatches: obs.inMatches,
      verdict: traceVerdict(obs),
    });
  }

  return {
    mode,
    identity: {
      timestamp: new Date().toISOString(),
      gitHead: gitHead(),
      corpusActive: Boolean(corpus),
      corpusSchemaVersion: corpus?.schemaVersion ?? null,
      corpusContentDigest16: corpus?.contentDigest16 ?? null,
      retrievalVersion: activeRetrievalVersion,
      datasetVersion: version,
      companyCount: companies.length,
      ontologyVersion: ONTOLOGY_VERSION,
      embeddingModel: corpus?.embeddingModel ?? manifest?.embeddingModel ?? null,
      judgeModelExpected: mode === "jev" ? expectedCloudModel() : null,
      judgeModelActual,
    },
    query: { raw: rawQuery, normalized: query, spec },
    retrieval: {
      poolSize: v3.candidates.length,
      bm25TopN: v3.counts.bm25TopN,
      vectorTopN: v3.counts.vectorTopN,
      fusedBeforeCap: v3.counts.fusedBeforeCap,
      droppedByHardFilter: v3.counts.droppedByHardFilter,
      timings: { retrievalMs },
      candidates,
      hardFilterExcluded,
      bm25ChannelTop: v3.wordChannel.slice(0, 20).map((i) => companyAt(i).code),
      vectorChannelTop: v3.embedChannel.slice(0, 20).map((i) => companyAt(i).code),
    },
    evidence,
    judge: {
      decidedBy,
      degraded: mode === "jev" && decidedBy !== "jev",
      outcome: judgeOutcome,
      tokens: judgeTokens,
      chunks: judgeChunks,
      answeredChunks: judgeAnswered,
      scoredCandidates: scores ? scores.length : 0,
      ms: judgeMs,
    },
  fusion: {
    zeroed,
    matches,
    shownThreshold: SHOWN,
  },
  final: {
    rankingSource,
    ranking: ranked.slice(0, scores ? Math.max(matches, 20) : 20).map((row, at) => {
      const company = companyAt(row.index);
      return {
        rank: at + 1,
        code: company.code,
        name: company.name,
        jevScore: scores ? Math.round((scores[v3.candidates.indexOf(row.index)] ?? 0) * 1000) / 1000 : null,
        probability: Math.round(row.probability * 1000) / 1000,
        inMatches: scores ? at < matches : false,
      };
    }),
  },
    traces,
    timings: { totalMs: Math.round(performance.now() - started) },
  };
}

/** digest16 of the corpus JSONL on disk (null when absent) — for report headers. */
export function corpusDigest16OnDisk(): string | null {
  try {
    return createHash("sha256")
      .update(readFileSync(path.join(process.cwd(), "data", "company-corpus", "companies.jsonl")))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return null;
  }
}
