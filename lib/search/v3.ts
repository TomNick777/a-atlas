import { readFileSync } from "node:fs";
import path from "node:path";
import type { Company } from "../types";
import { DIM, dot } from "../text/embed";
import { tokensOf } from "../text/tokenize";
import { exclusionCompanyPatterns, parseQuerySpec, type QuerySpec } from "./querySpec";
import { profileEdition, vectorsFileFor } from "./edition";
import { loadDataset, CORPUS_VECTORS_FILE } from "../companies";

/** The dataset version string embeds the profile edition as its 4th segment. */
const editionOf = (version: string): ReturnType<typeof profileEdition> => {
  const parts = version.split(":");
  const edition = parts[3];
  return edition === "v1" || edition === "v2" || edition === "v3" ? edition : profileEdition();
};

/**
 * V3 candidate retrieval: QuerySpec expansion -> BM25 over searchProfile text ⊕
 * bge-small over profile vectors, RRF-fused, ontology exclusion/attribute hard
 * filters applied, Top-N (default 200) candidate pool for the reranker.
 * Benchmarked in reports/LAYA_V3_RETRIEVAL_BENCHMARK.md (R@200 0.69 all-query,
 * 0.77 on the ranking families, vs 0.56 for the V2 channels).
 */

export const CANDIDATE_POOL = 200;
const RRF_K = 60;

const store = globalThis as unknown as {
  __v3profiles?: { version: string; texts: string[] } | null;
  __v3bm25?: { version: string; index: Bm25Index } | null;
  __v3vectors?: { version: string; vectors: Float32Array } | null;
};

type Bm25Index = {
  postings: Map<string, Map<number, number>>;
  docLen: number[];
  avgdl: number;
};

export function profileTexts(companies: Company[], version: string): string[] {
  if (store.__v3profiles?.version === version) return store.__v3profiles.texts;
  // companies already carry the edition-correct searchProfileText (lib/companies).
  const texts = companies.map((c) => c.searchProfileText || c.judgeText);
  store.__v3profiles = { version, texts };
  return texts;
}

export function profileVectors(version: string): Float32Array | null {
  if (store.__v3vectors?.version === version) return store.__v3vectors.vectors;
  try {
    // Corpus in effect → its embeddings are the vector channel; the legacy
    // fallback keeps reading the profile vectors of its own edition.
    const { corpus } = loadDataset();
    const file = corpus ? CORPUS_VECTORS_FILE : vectorsFileFor(editionOf(version));
    const buf = readFileSync(path.join(process.cwd(), file));
    const floats = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const { companies } = JSON.parse(readFileSync(path.join(process.cwd(), "data", "companies.json"), "utf8")) as { companies: Company[] };
    if (floats.length !== companies.length * DIM) return null;
    store.__v3vectors = { version, vectors: floats };
    return floats;
  } catch {
    return null;
  }
}

function bm25(texts: string[], version: string): Bm25Index {
  if (store.__v3bm25?.version === version) return store.__v3bm25.index;
  const postings = new Map<string, Map<number, number>>();
  const docLen: number[] = [];
  texts.forEach((text, di) => {
    const tf = new Map<string, number>();
    for (const t of tokensOf(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let len = 0;
    for (const [term, count] of tf) {
      len += count;
      let list = postings.get(term);
      if (!list) postings.set(term, (list = new Map()));
      list.set(di, count);
    }
    docLen.push(len);
  });
  const avgdl = docLen.reduce((a, b) => a + b, 0) / Math.max(1, docLen.length);
  const index = { postings, docLen, avgdl };
  store.__v3bm25 = { version, index };
  return index;
}

export function bm25Scores(index: Bm25Index, query: string, count: number): number[] {
  const scores = new Array<number>(count).fill(0);
  const seen = new Set<string>();
  for (const term of tokensOf(query)) {
    if (seen.has(term)) continue;
    seen.add(term);
    const list = index.postings.get(term);
    if (!list) continue;
    const df = list.size;
    const w = Math.log(1 + (count - df + 0.5) / (df + 0.5));
    for (const [di, tf] of list) {
      const denom = tf + 1.2 * (1 - 0.75 + 0.75 * (index.docLen[di] / index.avgdl));
      scores[di] += w * ((tf * 2.2) / denom);
    }
  }
  return scores;
}

/** Exclusion hard filter: ontology company-patterns + structured attribute bounds. */
export function exclusionFilter(companies: Company[], spec: QuerySpec): (index: number) => boolean {
  const drop = spec.exclusions.flatMap((type) => exclusionCompanyPatterns(type).map((p) => new RegExp(p)));
  return (index: number) => {
    const company = companies[index];
    if (drop.some((re) => re.test(company.judgeText))) return false;
    if (spec.attrs.overseasMinShare != null) {
      const share = company.overseasRevenueShare;
      if (share == null || share < spec.attrs.overseasMinShare) return false;
    }
    return true;
  };
}

const top = (scores: number[], keep: (i: number) => boolean, n: number): number[] =>
  scores
    .map((score, index) => ({ score, index }))
    .filter((row) => row.score > 0 && keep(row.index))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((row) => row.index);

export type V3Retrieval = {
  spec: QuerySpec;
  candidates: number[];
  embedChannel: number[];
  wordChannel: number[];
  /** Per-candidate audit trail: rank+score in each channel and the RRF value. */
  channelInfo: Map<number, { bm25Rank: number | null; bm25Score: number | null; vectorRank: number | null; vectorScore: number | null; rrfScore: number }>;
  /** Indexes the channels proposed but the ontology hard filter dropped (audit only). */
  excludedByHardFilter: number[];
  /** Channel sizes before the hard filter, for retrieval telemetry (telemetry-only, no behavior). */
  counts: { bm25TopN: number; vectorTopN: number; fusedBeforeCap: number; droppedByHardFilter: number };
  /** Stage timings for retrieval telemetry; filterMs not separable from the channels (stays null). */
  timings: { bm25Ms: number; embeddingMs: number; rrfMs: number; filterMs: number | null; totalRetrievalMs: number };
};

/**
 * The pipeline path: RRF over the expanded embedding and expanded BM25,
 * hard-filtered, capped to the candidate pool.
 */
export async function retrieveV3(
  companies: Company[],
  raw: string,
  version: string,
  embedExpanded: (text: string) => Promise<Float32Array | null>,
): Promise<V3Retrieval> {
  const started = performance.now();
  const spec = parseQuerySpec(raw);
  const texts = profileTexts(companies, version);
  const vectors = profileVectors(version);
  const keep = exclusionFilter(companies, spec);
  const expanded = spec.expansionTerms.length ? `${raw} ${spec.expansionTerms.join(" ")}` : raw;

  // Index construction included: its (cached, first-search) cost is part of
  // what THIS request paid for retrieval.
  const bm25Started = performance.now();
  const index = bm25(texts, version);
  const words = bm25Scores(index, expanded, companies.length);
  const wordChannel = top(words, keep, CANDIDATE_POOL);
  const bm25Ms = performance.now() - bm25Started;

  let embedChannel: number[] = [];
  let embedScores: number[] | null = null;
  const embedStarted = performance.now();
  if (vectors) {
    const qv = await embedExpanded(expanded);
    if (qv) {
      embedScores = Array.from({ length: companies.length }, (_, i) => dot(qv, vectors, i * DIM));
      embedChannel = top(embedScores, keep, CANDIDATE_POOL);
    }
  }
  const embeddingMs = performance.now() - embedStarted;

  const rrfStarted = performance.now();
  const fused = new Map<number, number>();
  embedChannel.forEach((index2, at) => fused.set(index2, (fused.get(index2) ?? 0) + 1 / (RRF_K + at + 1)));
  wordChannel.forEach((index2, at) => fused.set(index2, (fused.get(index2) ?? 0) + 1 / (RRF_K + at + 1)));
  const candidates = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CANDIDATE_POOL)
    .map(([index2]) => index2);
  const rrfMs = performance.now() - rrfStarted;

  const bm25Rank = new Map(wordChannel.map((index2, at) => [index2, at + 1] as const));
  const vectorRank = new Map(embedChannel.map((index2, at) => [index2, at + 1] as const));
  const channelInfo = new Map<number, { bm25Rank: number | null; bm25Score: number | null; vectorRank: number | null; vectorScore: number | null; rrfScore: number }>();
  for (const [index2, rrf] of fused) {
    channelInfo.set(index2, {
      bm25Rank: bm25Rank.get(index2) ?? null,
      bm25Score: bm25Rank.has(index2) ? round3(words[index2]) : null,
      vectorRank: vectorRank.get(index2) ?? null,
      vectorScore: embedScores && vectorRank.has(index2) ? round3(embedScores[index2]) : null,
      rrfScore: round3(rrf),
    });
  }

  // Audit: what the channels proposed but the hard filter refused (Top-200 slice).
  const droppedRaw = top(words, () => true, CANDIDATE_POOL).filter((index2) => !keep(index2));
  const excludedByHardFilter = [...new Set(droppedRaw)].slice(0, CANDIDATE_POOL);

  retrievalMsLast = performance.now() - started;
  return {
    spec,
    candidates,
    embedChannel,
    wordChannel,
    channelInfo,
    excludedByHardFilter,
    counts: { bm25TopN: wordChannel.length, vectorTopN: embedChannel.length, fusedBeforeCap: fused.size, droppedByHardFilter: excludedByHardFilter.length },
    timings: { bm25Ms: round1(bm25Ms), embeddingMs: round1(embeddingMs), rrfMs: round1(rrfMs), filterMs: null, totalRetrievalMs: round1(retrievalMsLast) },
  };
}

let retrievalMsLast = 0;
export const lastRetrievalMs = () => retrievalMsLast;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;
