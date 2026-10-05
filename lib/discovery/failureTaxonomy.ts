/**
 * Discovery Failure Taxonomy — the enum and the mechanical stage classifier.
 *
 * Definitions live in evaluation/discovery/failure-taxonomy.md. This module only
 * produces SUGGESTIONS from Inspector observations; the human analyst confirms
 * the final category (F0/F3/F10 in particular are not mechanically decidable).
 * Classification walks the layers bottom-up and the first hit is the primary cause.
 */

export const FAILURE_CATEGORIES = [
  "F0", // benchmark / expectation issue
  "F1", // corpus coverage failure
  "F2", // corpus representation failure
  "F3", // query understanding failure
  "F4", // candidate retrieval failure
  "F5", // Jev judgment failure
  "F6", // ranking failure
  "F7", // exclusion / negative constraint failure
  "F8", // entity collision
  "F9", // no-good-answer handling failure
  "F10", // evaluation ambiguity
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** What the Inspector observed for one expected symbol, end to end. */
export type TraceObservation = {
  corpusActive: boolean;
  /** query term hits in the company's searchableText (retrieval/judge text). */
  textTermHits: string[];
  /** query term hits anywhere in the document's structured fields. */
  structuredTermHits: string[];
  inCandidatePool: boolean;
  poolRank: number | null;
  judgeScore: number | null;
  /** fuse zero reason when the candidate was zeroed (province/drop_industry/exclusion_pattern). */
  zeroReason: string | null;
  finalRank: number | null;
  inMatches: boolean;
};

export type TraceHint = {
  /** Where the company disappeared, phrased as a stage name. */
  stage: string;
  /** Suggested taxonomy category (null = surfaced fine, or needs human eyes). */
  category: FailureCategory | null;
  detail: string;
};

/**
 * The §9 core question — "正确公司在哪一步消失了？" — answered mechanically.
 * Ordered bottom-up per failure-taxonomy.md; only hints, never a verdict.
 */
export function traceVerdict(obs: TraceObservation): TraceHint {
  if (!obs.corpusActive) {
    return { stage: "runtime", category: null, detail: "corpus 未生效（运行在 legacy profile 层）；本次归因只对 corpus 生效的运行有意义" };
  }
  if (obs.zeroReason) {
    return { stage: "fusion", category: "F7", detail: `被约束置零：${obs.zeroReason}；若该置零与查询意图矛盾即为排除失败` };
  }
  if (!obs.inCandidatePool) {
    if (obs.textTermHits.length === 0 && obs.structuredTermHits.length === 0) {
      return { stage: "corpus", category: "F1", detail: "文档（searchableText+结构化字段）不含 query 概念词 → 语料覆盖/表征缺口，检索无从谈起" };
    }
    if (obs.textTermHits.length === 0 && obs.structuredTermHits.length > 0) {
      return { stage: "representation", category: "F2", detail: "结构化字段有概念词但 searchableText 没有 → 表征丢失（截断/措辞）" };
    }
    return { stage: "retrieval", category: "F4", detail: `searchableText 有词面证据（${obs.textTermHits.slice(0, 3).join("、")}）但未进 Top-200 候选池` };
  }
  if (obs.judgeScore == null) {
    return { stage: "candidates", category: null, detail: `在候选池第 ${obs.poolRank} 位；本轮无 judge 分数（retrieval 模式或云未应答），只看到检索层` };
  }
  if (obs.judgeScore < 0.3) {
    return { stage: "jev", category: "F5", detail: `已在候选池第 ${obs.poolRank} 位，但 Jev 打分 ${obs.judgeScore.toFixed(3)} < 0.3 阈值，没进 matches` };
  }
  if (obs.finalRank != null && obs.inMatches && obs.finalRank <= 10) {
    return { stage: "surfaced", category: null, detail: `最终排名第 ${obs.finalRank}，已进 Top10` };
  }
  if (obs.inMatches) {
    return { stage: "ranking", category: "F6", detail: `进了 matches 但排名第 ${obs.finalRank}，弱于期望位次` };
  }
  return { stage: "ambiguous", category: "F10", detail: "在候选池内、分数边界情况，需人工核对" };
}
