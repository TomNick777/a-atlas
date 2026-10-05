import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Search Replay & Review Log — append-only JSONL, one SearchRun per line.
 *
 * Failure contract (规格第十七节): logging NEVER breaks a search. Writes are
 * serialized through a promise chain and every error is swallowed with a
 * console.warn; the search result is returned regardless. Only submitted
 * queries are recorded — no keystrokes, no browsing, nothing else.
 */

export type SearchRunRow = {
  rank: number;
  code: string;
  name: string;
  retrieval: {
    bm25Rank: number | null;
    bm25Score: number | null;
    vectorRank: number | null;
    vectorScore: number | null;
    rrfScore: number;
  };
  reranker: { grade: number | null; score: number } | null;
  queryMatch: { matchedMust: string[]; matchedExclusion: string[]; zeroReason: string | null };
  profile: { profileEdition: string; searchTextHash: string | null };
};

export type SearchRun = {
  /** 3 = Product Usage Baseline: adds the optional `jev` block (cost + value).
   * 2 = Phase 4: judgeProvider/judgeOutcome replace jevSource; rerankerSha is always null. */
  logSchemaVersion: 1 | 2 | 3;
  searchId: string;
  timestamp: string;
  query: {
    raw: string;
    normalized: string;
    querySpec: {
      concepts: string[];
      must: string[];
      expansionTerms: string[];
      exclusions: string[];
      attrs: { province: string | null; overseasMinShare: number | null };
    };
  };
  versions: {
    gitHead: string | null;
    companyDatasetSha16: string | null;
    profileEdition: string;
    /** Legacy profile layer version; null when the corpus layer decided. */
    searchProfileVersion: string | null;
    /** Company Knowledge Corpus identity; null on the legacy profile fallback. */
    corpusSchemaVersion?: string | null;
    corpusContentDigest16?: string | null;
    ontologyVersion: string | null;
    derivationVersion: string | null;
    /** Stage 3 domain enrichment version ("none" before Stage 3). */
    semiconductorEnrichmentVersion: string | null;
    /** mp1.1 材料归属闸门版本(manifest 缺该字段时 null)。 */
    materialAttributionVersion?: string | null;
    /** Tier1 source-set snapshot id (Stage 3); null before. */
    sourceSnapshotId: string | null;
    embeddingModel: string | null;
    retrievalVersion: string;
    rerankerModel: string | null;
    /**
     * Null from Phase 4 on: the judge is a cloud model, so there are no local
     * weights to hash. `rerankerModel` carries the identity that answered.
     * Kept so Phase 1-3 rows and readers stay readable.
     */
    rerankerSha: string | null;
    judgeProvider: string;
    judgeOutcome: string;
    degraded: boolean;
  };
  timing: { queryParseMs: number; retrievalMs: number; rerankMs: number; totalMs: number };
  retrieval: {
    poolSize: number;
    bm25Top: string[];
    vectorTop: string[];
    fusedTop200: string[];
    excludedByHardFilter: string[];
  };
  candidates: SearchRunRow[];
  result: {
    matches: number;
    top20: { rank: number; code: string; name: string; score: number }[];
  };
  cached?: boolean;
  /**
   * Phase 4 §15/§16: a cache replay is logged for query frequency, and it is NOT
   * produced by a second judge call. `cacheReplay` marks the row so analysis never
   * mistakes a replay for an independent measurement, and `replayOfSearchId` points
   * at the run that actually computed the answer.
   */
  cacheReplay?: boolean;
  replayOfSearchId?: string | null;
  /**
   * Usage Baseline (§4/§5): what Jev cost this run and whether it changed the
   * ranking. Absent (not zero) when Jev never ran. `value.preTop` is the
   * retrieval order the judge received; `value.postTop` is the final order.
   */
  jev?: {
    capability: string | null;
    runtimeModel: string | null;
    tokens: number;
    costUsd: number | null;
    judgeMs: number | null;
    value: {
      top1Changed: boolean | null;
      top10Changed: boolean | null;
      rankingChanged: boolean | null;
      promotedIntoTop10: number | null;
      droppedFromTop10: number | null;
      jevRemovedCount: number | null;
      preTop: string[];
      postTop: string[];
    } | null;
  };
};

const LOG_DIR = path.join(process.cwd(), "data", "search_log");
const LOG_FILE = path.join(LOG_DIR, "search_log.jsonl");

let chain: Promise<void> = Promise.resolve();

export function searchLogPath(): string {
  return LOG_FILE;
}

export function appendSearchRun(run: SearchRun): void {
  chain = chain
    .then(async () => {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(LOG_FILE, JSON.stringify(run) + "\n", "utf8");
    })
    .catch((error) => console.warn("[search-log] append failed (search unaffected):", error instanceof Error ? error.message : error));
}

export async function listSearchRuns(filter?: { date?: string; queryContains?: string; companyCode?: string }): Promise<SearchRun[]> {
  let text: string;
  try {
    text = await readFile(LOG_FILE, "utf8");
  } catch {
    return [];
  }
  const runs: SearchRun[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as SearchRun;
      if (filter?.date && !run.timestamp.startsWith(filter.date)) continue;
      if (filter?.queryContains && !run.query.raw.includes(filter.queryContains)) continue;
      if (filter?.companyCode && !run.retrieval.fusedTop200.includes(filter.companyCode)) continue;
      runs.push(run);
    } catch {
      // skip corrupt line, the log is append-only and may have torn writes
    }
  }
  return runs;
}

export async function getSearchRun(searchId: string): Promise<SearchRun | null> {
  const runs = await listSearchRuns();
  return runs.find((run) => run.searchId === searchId) ?? null;
}

/** Review export: one self-contained JSON per external audit (规格第二十节). */
export async function exportReviewRuns(limit?: number): Promise<SearchRun[]> {
  const runs = await listSearchRuns();
  return limit && limit > 0 ? runs.slice(-limit) : runs;
}
