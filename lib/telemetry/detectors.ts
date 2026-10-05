import type { SuspectKind } from "./types";

/**
 * Automatic search-quality signals (规格 §29-§30). Every finding is a SUSPECT:
 * recorded as evidence for later human review, never an online re-rank, never
 * an automatic root-cause verdict.
 */

export type SnapshotRow = {
  rank: number;
  code: string;
  name: string;
  grade: number | null; // 0..3 when the graded reranker decided
  rerankerScore: number;
  roles: string[];
  /** Exclusion types whose company patterns this row actually matches (pipeline-evaluated). */
  matchedExclusionTypes: string[];
};

export type SearchSignalInput = {
  normalizedQuery: string;
  exclusionTypes: string[];
  candidateCount: number;
  fusedBeforeCap: number;
  droppedByHardFilter: number;
  bm25TopN: number;
  vectorTopN: number;
  vectorsFilePresent: boolean;
  retrievalMs: number;
  rerankMs: number;
  rerankTimeouts: number;
  rerankErrors: number;
  rerankRetries: number;
  graded: boolean;
  degraded: boolean;
  top: SnapshotRow[];
  /** Recent searches this process remembers, for repeat-offender detection. */
  recentTopCompanies?: { queryKey: string; codes: string[] }[];
};

export type Suspect = { kind: SuspectKind; evidence: Record<string, unknown> };

const RETRIEVAL_LATENCY_SPIKE_MS = 5_000;
const RERANK_LATENCY_SPIKE_MS = 15_000;
const UNDERFILLED_POOL = 25;
const FILTER_OVERDROP_RATIO = 0.9;
const FILTER_OVERDROP_MIN = 50;
const SCORE_COLLAPSE_SPREAD = 0.34;
const REPEAT_OFFENDER_QUERIES = 5;

/** Family-noun queries (§30): 芯片厂设备供应商-style prompts. */
const FAMILY_NOUN_SUPPLIER_RE = /(芯片|半导体|晶圆|面板|光伏)厂?\s*(设备|材料|气体|化学品)?供应商|设备供应商|材料供应商/;
const CMP_QUERY_RE = /CMP|化学机械抛光|化学机械研磨|抛光机|抛光设备/i;
const ROLE_MATERIAL_SUPPLIER_RE = /材料|耗材|供应商|药剂|气体|试剂/;
const ROLE_DESIGN_RE = /设计/;

export function detectSuspects(input: SearchSignalInput): Suspect[] {
  const suspects: Suspect[] = [];
  const top = input.top;
  const top10 = top.slice(0, 10);

  // ---- Retrieval health (§16) ----
  if (input.candidateCount === 0) suspects.push({ kind: "RETRIEVAL_EMPTY", evidence: { candidateCount: 0 } });
  else {
    if (input.candidateCount < UNDERFILLED_POOL) suspects.push({ kind: "RETRIEVAL_UNDERFILLED", evidence: { candidateCount: input.candidateCount, threshold: UNDERFILLED_POOL } });
    if (input.bm25TopN === 0) suspects.push({ kind: "BM25_EMPTY", evidence: {} });
    if (input.vectorsFilePresent && input.vectorTopN === 0) suspects.push({ kind: "VECTOR_EMPTY", evidence: {} });
    if (!input.vectorsFilePresent) suspects.push({ kind: "VECTOR_UNAVAILABLE", evidence: {} });
    const denom = input.droppedByHardFilter + input.fusedBeforeCap;
    if (denom > 0 && input.droppedByHardFilter > FILTER_OVERDROP_MIN && input.droppedByHardFilter / denom > FILTER_OVERDROP_RATIO) {
      suspects.push({ kind: "FILTER_OVERDROP", evidence: { droppedByHardFilter: input.droppedByHardFilter, fusedBeforeCap: input.fusedBeforeCap } });
    }
  }
  if (input.retrievalMs > RETRIEVAL_LATENCY_SPIKE_MS) {
    suspects.push({ kind: "RETRIEVAL_LATENCY_SPIKE", evidence: { retrievalMs: Math.round(input.retrievalMs) } });
  }

  // ---- Reranker health (§19) ----
  if (input.rerankTimeouts > 0) suspects.push({ kind: "RERANK_TIMEOUT", evidence: { timeouts: input.rerankTimeouts } });
  if (input.rerankRetries > 0) suspects.push({ kind: "RERANK_RETRY", evidence: { retries: input.rerankRetries } });
  if (input.rerankErrors > 0 && input.degraded) suspects.push({ kind: "RERANK_DEGRADED", evidence: { errors: input.rerankErrors } });
  if (input.rerankMs > RERANK_LATENCY_SPIKE_MS) suspects.push({ kind: "RERANK_LATENCY_SPIKE", evidence: { rerankMs: Math.round(input.rerankMs) } });

  // ---- Result-quality suspects (§29) ----
  if (input.graded && top10.length >= 5) {
    const grades = top10.map((row) => row.grade ?? 0);
    const spread = Math.max(...grades) - Math.min(...grades);
    // Homogeneous AND not strongly relevant = collapse. All-grade-3 on a broad
    // query is homogeneous success, not a suspect.
    if (spread < SCORE_COLLAPSE_SPREAD && Math.max(...grades) < 3) {
      suspects.push({ kind: "SCORE_COLLAPSE", evidence: { spread: Math.round(spread * 1000) / 1000, maxGrade: Math.max(...grades) } });
    }
    const best = top.reduce((acc, row) => (row.grade != null && (acc == null || row.grade > acc) ? row.grade : acc), null as number | null);
    const top1 = top10[0];
    const buried3 = top.findIndex((row) => row.grade === 3);
    if (top1?.grade != null && top1.grade <= 1 && buried3 >= 5) {
      suspects.push({ kind: "RANKING_FAILURE_SUSPECT", evidence: { top1Grade: top1.grade, firstGrade3Rank: buried3 + 1 } });
    }
    void best;
  }

  // Exclusion failure: an excluded type's company pattern still reached the top20.
  if (input.exclusionTypes.length && top.length) {
    const failures = top.flatMap((row) => row.matchedExclusionTypes.map((type) => ({ type, code: row.code, rank: row.rank })));
    if (failures.length) suspects.push({ kind: "EXCLUSION_FAILURE", evidence: { failures: failures.slice(0, 5) } });
  }

  // Profile gap: the query opened ontology concept groups but retrieval found (almost) nothing.
  if (input.candidateCount === 0 && input.normalizedQuery.length >= 2) {
    suspects.push({ kind: "PROFILE_GAP_SUSPECT", evidence: { query: input.normalizedQuery.slice(0, 60) } });
  }

  // ---- Yellow-flag detectors (§30) — observe only, never re-rank ----
  const materialShare = shareOf(top10, (roles) => roles.some((role) => ROLE_MATERIAL_SUPPLIER_RE.test(role)));
  if (CMP_QUERY_RE.test(input.normalizedQuery) && top10.length >= 5 && materialShare >= 0.3) {
    suspects.push({
      kind: "CMP_DEVICE_MATERIAL_INTRUSION_SUSPECT",
      evidence: { materialSupplierShare: Math.round(materialShare * 100) / 100, top10Roles: top10.map((row) => ({ code: row.code, roles: row.roles.slice(0, 2) })) },
    });
  }
  if (FAMILY_NOUN_SUPPLIER_RE.test(input.normalizedQuery) && top10.length >= 5) {
    const designShare = shareOf(top10, (roles) => roles.some((role) => ROLE_DESIGN_RE.test(role)));
    if (designShare >= 0.3) {
      suspects.push({
        kind: "FAMILY_NOUN_ROLE_INTRUSION_SUSPECT",
        evidence: { designRoleShare: Math.round(designShare * 100) / 100, top10Roles: top10.map((row) => ({ code: row.code, roles: row.roles.slice(0, 2) })) },
      });
    }
  }

  // ---- Repeat offender: same company surfacing across many distinct queries ----
  if (input.recentTopCompanies && input.recentTopCompanies.length >= REPEAT_OFFENDER_QUERIES) {
    const counts = new Map<string, number>();
    for (const search of input.recentTopCompanies) {
      for (const code of new Set(search.codes)) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    const offenders = [...counts.entries()].filter(([, count]) => count >= REPEAT_OFFENDER_QUERIES).map(([code, count]) => ({ code, count }));
    if (offenders.length) suspects.push({ kind: "REPEAT_OFFENDER", evidence: { window: input.recentTopCompanies.length, offenders: offenders.slice(0, 5) } });
  }

  void input.exclusionTypes;
  return suspects;
}

function shareOf(rows: SnapshotRow[], match: (roles: string[]) => boolean): number {
  if (!rows.length) return 0;
  return rows.filter((row) => match(row.roles)).length / rows.length;
}
