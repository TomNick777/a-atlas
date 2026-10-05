/**
 * Mechanical metrics for the discovery quality benchmark (Phase 3.5 §16–§19,
 * §25). Everything here is computable without a semantic judge: counts,
 * resolutions, anchor presence, term probes, drift. Semantic quality labels
 * (DIRECT/VALID/…) only enter through a human-reviewed labels file, and are
 * reported separately — never folded into a single score (§23).
 *
 * Stability is not correctness (§22): ranking-stability metrics are computed
 * across runs and reported next to quality, never merged with it.
 */
import type { BenchmarkCase, BenchmarkDoc, FamilyId } from "./benchmark";

// ---- record shapes (written by run.ts, read everywhere) --------------------

export type CaseStatus = "ok" | "degraded" | "unsupported" | "ambiguous_refusal" | "empty" | "error" | "skipped";

export type ResultRecord = {
  rank: number;
  code: string;
  name: string;
  capability: string | null;
  score: number | null;
  matched: boolean | null;
  relationLabel: string | null;
  judged: boolean;
  evidenceRefs: { companyId: string; ref: string }[];
  evidenceResolved: boolean;
  /** Resolved verbatim evidence text, trimmed for storage. */
  evidenceExcerpt: string | null;
  /** requiredEvidence OR-terms found in the resolved verbatim evidence text. */
  evidenceTermHits: string[];
  marketCapYi: number | null;
  heroKey: string | null;
};

export type CapabilityRecord = {
  capability: string;
  contractVersion: string;
  status: string;
  failure: string | null;
  live: boolean;
  runtimeModel: string | null;
  judgeMs: number;
  tokens: number;
  costUsd: number | null;
};

export type ComparisonDecisionRecord = {
  code: string;
  name: string;
  grade: number | null;
  score: number | null;
  evidenceTermHits: string[];
};

export type ExplanationRecord = {
  subjectCode: string;
  status: string;
  insufficientEvidence: boolean;
  lines: number;
  groundedRefs: boolean;
  groundedVerbatim: boolean;
};

export type CaseRecord = {
  id: string;
  family: FamilyId;
  query: string;
  kind: "discover" | "comparison";
  mode: "live" | "offline-debug";
  status: CaseStatus;
  error: string | null;
  planUnsupported: { intent: string; detail: string } | null;
  executionOrder: string | null;
  decidedBy: string | null;
  degraded: boolean;
  degradedReason: string | null;
  parserVersion: string | null;
  parseMs: number | null;
  timings: { totalMs: number | null; semanticMs: number | null; marketMs: number | null };
  capability: CapabilityRecord | null;
  wireCalls: number;
  results: ResultRecord[];
  comparison: { subjects: ComparisonDecisionRecord[]; strictGradientOk: boolean | null } | null;
  explanation: ExplanationRecord | null;
};

// ---- failure taxonomy (§25) ------------------------------------------------

export const FAILURE_TAXONOMY = [
  "JEV_SEMANTIC_MISS",
  "JEV_RANKING_MISS",
  "CORPUS_MISSING_FACT",
  "CORPUS_WEAK_FACT",
  "RELATION_EVIDENCE_MISSING",
  "PARSER_UNSUPPORTED",
  "PARSER_AMBIGUOUS",
  "CAPABILITY_UNSUPPORTED",
  "EVIDENCE_PIPELINE_ERROR",
  "RUNTIME_ERROR",
  "EXPECTED_REJECTION",
  "NEGATIVE_INTRUSION",
  "NONE",
] as const;

export type FailureTaxonomy = (typeof FAILURE_TAXONOMY)[number];

export const QUALITY_LABELS = ["DIRECT", "VALID", "WEAK", "UNSUPPORTED", "CONTRADICTORY", "UNCERTAIN"] as const;
export type QualityLabel = (typeof QUALITY_LABELS)[number];

export type CaseLabels = {
  reviewed: boolean;
  /** Per-result labels for the reviewed slice (usually Top3 + anchors + suspicious highs). */
  results?: Record<string, QualityLabel>;
  /** Final failure attribution; overrides the mechanical hint. */
  attribution?: FailureTaxonomy;
  notes?: string;
};

export type LabelsDoc = {
  runLabel: string;
  reviewedBy: string;
  reviewedAt: string;
  method: string;
  cases: Record<string, CaseLabels>;
};

// ---- mechanical per-case evaluation ----------------------------------------

export type CaseSummary = {
  id: string;
  family: FamilyId;
  status: CaseStatus;
  executionOrder: string | null;
  decidedBy: string | null;
  degraded: boolean;
  unsupportedIntent: string | null;
  resultCount: number;
  judgedCount: number;
  evidenceResolvedCount: number;
  mustHit: { top5: boolean; top10: boolean; top20: boolean };
  shouldHit: { top5: number; top10: number; top20: number; total: number };
  negativeIntrusion: { top5: boolean; top10: boolean; top20: boolean };
  top1TermHit: boolean;
  top10DirectTermHit: boolean;
  wireCalls: number;
  totalMs: number | null;
  judgeMs: number | null;
  strictGradientOk: boolean | null;
  explanationGrounded: boolean | null;
  mechanicalHint: FailureTaxonomy;
  finalAttribution: FailureTaxonomy;
};

function inTopK(record: CaseRecord, code: string, k: number): boolean {
  return record.results.some((row) => row.rank <= k && row.code === code);
}

function intrusionInTopK(record: CaseRecord, codes: string[], k: number): boolean {
  return record.results.some(
    (row) => row.rank <= k && codes.includes(row.code) && ((row.matched ?? false) || (row.score ?? 0) >= 0.6),
  );
}

/** §25 — mechanical attribution hints. Human labels (labels.json) override. */
export function mechanicalHint(record: CaseRecord, benchCase: BenchmarkCase): FailureTaxonomy {
  if (record.status === "error") return "RUNTIME_ERROR";
  if (record.status === "skipped") return "NONE";
  if (record.planUnsupported) {
    if (benchCase.expectedHonestRejection) return "EXPECTED_REJECTION";
    return record.planUnsupported.intent === "ambiguous_query" ? "PARSER_AMBIGUOUS" : "PARSER_UNSUPPORTED";
  }
  if (record.status === "degraded") return "RUNTIME_ERROR";
  if (record.capability && record.capability.status !== "ok") {
    if (record.capability.failure === "capability_unsupported") return "CAPABILITY_UNSUPPORTED";
    if (record.capability.failure === "insufficient_evidence") {
      return record.family === "relation" ? "RELATION_EVIDENCE_MISSING" : "CORPUS_WEAK_FACT";
    }
    return "RUNTIME_ERROR";
  }
  if (record.explanation && !record.explanation.groundedRefs) return "EVIDENCE_PIPELINE_ERROR";
  const must = benchCase.anchors?.mustInclude?.map((anchor) => anchor.code) ?? [];
  const negative = benchCase.anchors?.negative?.map((anchor) => anchor.code) ?? [];
  if (negative.some((code) => intrusionInTopK(record, negative, 10))) return "NEGATIVE_INTRUSION";
  if (must.length > 0 && !must.some((code) => inTopK(record, code, 20)) && record.status === "ok") {
    return "JEV_SEMANTIC_MISS";
  }
  return "NONE";
}

export function summarizeCase(record: CaseRecord, benchCase: BenchmarkCase, labels?: CaseLabels): CaseSummary {
  const must = benchCase.anchors?.mustInclude?.map((anchor) => anchor.code) ?? [];
  const should = benchCase.anchors?.shouldInclude?.map((anchor) => anchor.code) ?? [];
  const negative = benchCase.anchors?.negative?.map((anchor) => anchor.code) ?? [];
  const judged = record.results.filter((row) => row.judged);
  const hint = mechanicalHint(record, benchCase);
  const top1 = record.results.find((row) => row.rank === 1);
  const summary: CaseSummary = {
    id: record.id,
    family: record.family,
    status: record.status,
    executionOrder: record.executionOrder,
    decidedBy: record.decidedBy,
    degraded: record.degraded,
    unsupportedIntent: record.planUnsupported?.intent ?? null,
    resultCount: record.results.length,
    judgedCount: judged.length,
    evidenceResolvedCount: record.results.filter((row) => row.evidenceResolved).length,
    mustHit: {
      top5: must.some((code) => inTopK(record, code, 5)),
      top10: must.some((code) => inTopK(record, code, 10)),
      top20: must.some((code) => inTopK(record, code, 20)),
    },
    shouldHit: {
      top5: should.filter((code) => inTopK(record, code, 5)).length,
      top10: should.filter((code) => inTopK(record, code, 10)).length,
      top20: should.filter((code) => inTopK(record, code, 20)).length,
      total: should.length,
    },
    negativeIntrusion: {
      top5: intrusionInTopK(record, negative, 5),
      top10: intrusionInTopK(record, negative, 10),
      top20: intrusionInTopK(record, negative, 20),
    },
    top1TermHit: top1 !== undefined && top1.evidenceTermHits.length > 0,
    top10DirectTermHit: record.results.some((row) => row.rank <= 10 && row.evidenceTermHits.length > 0),
    wireCalls: record.wireCalls,
    totalMs: record.timings.totalMs,
    judgeMs: record.capability?.judgeMs ?? record.timings.semanticMs ?? null,
    strictGradientOk: record.comparison?.strictGradientOk ?? null,
    explanationGrounded: record.explanation ? record.explanation.groundedRefs && record.explanation.groundedVerbatim : null,
    mechanicalHint: hint,
    finalAttribution: labels?.attribution ?? hint,
  };
  return summary;
}

// ---- run-level metrics ------------------------------------------------------

export type RunMetrics = {
  label: string;
  mode: string;
  generatedAt: string;
  queryCount: number;
  global: {
    querySuccessRate: number;
    judgedResultRate: number;
    evidenceCoverageRate: number;
    orphanJudgementRate: number;
    mustIncludeRecall: { top5: number; top10: number; top20: number; cases: number };
    negativeIntrusion: { top5: number; top10: number; top20: number };
    insufficientEvidenceRate: number;
    capabilityFailureRate: number;
    unexpectedErrorRate: number;
    latencyMs: { totalP50: number | null; totalP95: number | null; judgeP50: number | null; judgeP95: number | null };
    wireCalls: number;
    tokens: number;
    costUsd: number | null;
  };
  evidence: {
    evidenceRefResolutionRate: number;
    verbatimGroundingRate: number | null;
    directEvidenceRateTop1: number;
    weakEvidenceRateTop10: number;
    explanationGroundingRate: number | null;
  };
  byFamily: Record<string, { queries: number; success: number; mustRecallTop10: number | null; negativeIntrusionTop10: number; hintCounts: Record<string, number> }>;
  byCase: CaseSummary[];
  failureAttribution: Record<string, number>;
  humanReview: {
    reviewedCases: number;
    labeledResults: number;
    labelCounts: Record<string, number>;
    evidenceWeightedPrecisionTop10: number | null;
    reviewedAt: string | null;
    reviewedBy: string | null;
  } | null;
};

const WEIGHTS: Record<QualityLabel, number> = { DIRECT: 1, VALID: 0.75, WEAK: 0.3, UNSUPPORTED: 0, CONTRADICTORY: 0, UNCERTAIN: 0.5 };

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function computeMetrics(
  doc: BenchmarkDoc,
  label: string,
  mode: string,
  records: CaseRecord[],
  labels?: LabelsDoc | null,
): RunMetrics {
  const byId = new Map(doc.cases.map((row) => [row.id, row]));
  const summaries = records.map((record) => summarizeCase(record, byId.get(record.id) as BenchmarkCase, labels?.cases?.[record.id]));

  const evaluated = records.filter((record) => record.status !== "skipped");
  const successes = evaluated.filter((record) => record.status === "ok" && !record.degraded);
  const refused = evaluated.filter((record) => record.status === "unsupported" || record.status === "ambiguous_refusal");
  const judgedRows = records.flatMap((record) => record.results).filter((row) => row.judged);
  const resolvedRows = judgedRows.filter((row) => row.evidenceResolved);
  const mustCases = summaries.filter((summary, index) => {
    const benchCase = byId.get(summary.id) as BenchmarkCase;
    return (benchCase.anchors?.mustInclude?.length ?? 0) > 0 && summaries[index].status === "ok";
  });
  const explanationRecords = records.filter((record) => record.explanation);
  const capabilityRecords = records.filter((record) => record.capability);
  const termProbeCases = summaries.filter((summary, index) => {
    const benchCase = byId.get(summary.id) as BenchmarkCase;
    return (benchCase.requiredEvidence?.length ?? 0) > 0 && summaries[index].status === "ok" && summaries[index].resultCount > 0;
  });

  const top10Rows = records.flatMap((record) => record.results.filter((row) => row.rank <= 10));
  const weakRows = top10Rows.filter((row) => row.judged && row.evidenceTermHits.length === 0);

  // Evidence-weighted precision from human labels over labeled Top10 results.
  let ewpSum = 0;
  let ewpCount = 0;
  let labeledResults = 0;
  const labelCounts: Record<string, number> = {};
  if (labels) {
    for (const record of records) {
      const caseLabels = labels.cases?.[record.id];
      if (!caseLabels?.results) continue;
      for (const [code, labelName] of Object.entries(caseLabels.results)) {
        labeledResults += 1;
        labelCounts[labelName] = (labelCounts[labelName] ?? 0) + 1;
        const row = record.results.find((candidate) => candidate.code === code && candidate.rank <= 10);
        if (row) {
          ewpSum += WEIGHTS[labelName as QualityLabel] ?? 0;
          ewpCount += 1;
        }
      }
    }
  }

  const attributionCounts: Record<string, number> = {};
  for (const summary of summaries) {
    attributionCounts[summary.finalAttribution] = (attributionCounts[summary.finalAttribution] ?? 0) + 1;
  }

  const byFamily: RunMetrics["byFamily"] = {};
  for (const family of new Set(records.map((record) => record.family))) {
    const familySummaries = summaries.filter((summary) => summary.family === family);
    const familyCases = familySummaries.map((summary) => byId.get(summary.id) as BenchmarkCase);
    const withMust = familySummaries.filter((summary, index) => (familyCases[index].anchors?.mustInclude?.length ?? 0) > 0 && summary.status === "ok");
    byFamily[family] = {
      queries: familySummaries.length,
      success: familySummaries.filter((summary) => summary.status === "ok" && !summary.degraded).length,
      mustRecallTop10: withMust.length ? withMust.filter((summary) => summary.mustHit.top10).length / withMust.length : null,
      negativeIntrusionTop10: familySummaries.filter((summary) => summary.negativeIntrusion.top10).length,
      hintCounts: familySummaries.reduce<Record<string, number>>((acc, summary) => {
        acc[summary.finalAttribution] = (acc[summary.finalAttribution] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }

  return {
    label,
    mode,
    generatedAt: new Date().toISOString(),
    queryCount: records.length,
    global: {
      // Honest handling counts as success: an expected honest refusal is the
      // contract working, not a failure (§10).
      querySuccessRate: evaluated.length ? (successes.length + refused.filter((record) => (byId.get(record.id) as BenchmarkCase).expectedHonestRejection).length) / evaluated.length : 0,
      judgedResultRate: judgedRows.length / Math.max(1, records.flatMap((record) => record.results).length),
      evidenceCoverageRate: judgedRows.length ? resolvedRows.length / judgedRows.length : 0,
      orphanJudgementRate: judgedRows.length ? judgedRows.filter((row) => !row.evidenceResolved).length / judgedRows.length : 0,
      mustIncludeRecall: {
        top5: mustCases.length ? mustCases.filter((summary) => summary.mustHit.top5).length / mustCases.length : 0,
        top10: mustCases.length ? mustCases.filter((summary) => summary.mustHit.top10).length / mustCases.length : 0,
        top20: mustCases.length ? mustCases.filter((summary) => summary.mustHit.top20).length / mustCases.length : 0,
        cases: mustCases.length,
      },
      negativeIntrusion: {
        top5: summaries.filter((summary) => summary.negativeIntrusion.top5).length,
        top10: summaries.filter((summary) => summary.negativeIntrusion.top10).length,
        top20: summaries.filter((summary) => summary.negativeIntrusion.top20).length,
      },
      insufficientEvidenceRate: capabilityRecords.length
        ? capabilityRecords.filter((record) => record.capability?.failure === "insufficient_evidence").length / capabilityRecords.length
        : 0,
      capabilityFailureRate: capabilityRecords.length ? capabilityRecords.filter((record) => record.capability?.status !== "ok").length / capabilityRecords.length : 0,
      unexpectedErrorRate: evaluated.length ? evaluated.filter((record) => record.status === "error").length / evaluated.length : 0,
      latencyMs: {
        totalP50: percentile(evaluated.map((record) => record.timings.totalMs ?? 0).filter((value) => value > 0), 50),
        totalP95: percentile(evaluated.map((record) => record.timings.totalMs ?? 0).filter((value) => value > 0), 95),
        judgeP50: percentile(records.map((record) => record.capability?.judgeMs ?? 0).filter((value) => value > 0), 50),
        judgeP95: percentile(records.map((record) => record.capability?.judgeMs ?? 0).filter((value) => value > 0), 95),
      },
      wireCalls: records.reduce((sum, record) => sum + record.wireCalls, 0),
      tokens: capabilityRecords.reduce((sum, record) => sum + (record.capability?.tokens ?? 0), 0),
      costUsd: capabilityRecords.reduce((sum, record) => sum + (record.capability?.costUsd ?? 0), 0) || null,
    },
    evidence: {
      evidenceRefResolutionRate: judgedRows.length ? resolvedRows.length / judgedRows.length : 0,
      verbatimGroundingRate: explanationRecords.length
        ? explanationRecords.filter((record) => record.explanation?.groundedRefs && record.explanation?.groundedVerbatim).length / explanationRecords.length
        : null,
      directEvidenceRateTop1: termProbeCases.length ? termProbeCases.filter((summary) => summary.top1TermHit).length / termProbeCases.length : 0,
      weakEvidenceRateTop10: top10Rows.filter((row) => row.judged).length ? weakRows.length / top10Rows.filter((row) => row.judged).length : 0,
      explanationGroundingRate: explanationRecords.length
        ? explanationRecords.filter((record) => record.explanation?.groundedRefs && record.explanation?.groundedVerbatim).length / explanationRecords.length
        : null,
    },
    byFamily,
    byCase: summaries,
    failureAttribution: attributionCounts,
    humanReview: labels
      ? {
          reviewedCases: Object.values(labels.cases).filter((caseLabels) => caseLabels.reviewed).length,
          labeledResults,
          labelCounts,
          evidenceWeightedPrecisionTop10: ewpCount ? ewpSum / ewpCount : null,
          reviewedAt: labels.reviewedAt,
          reviewedBy: labels.reviewedBy,
        }
      : null,
  };
}

// ---- stability across runs (§21/§22) ----------------------------------------

export type StabilityPair = {
  base: string;
  target: string;
  overlapTop5: number;
  overlapTop10: number;
  overlapTop20: number;
  meanAbsRankDelta: number | null;
  meanAbsScoreDelta: number | null;
  mustAnchorPresenceAgreement: number;
  negativeIntrusionAgreement: number;
  attributionFlips: number;
};

export type StabilityReport = {
  runs: string[];
  pairs: StabilityPair[];
  note: string;
};

export function computeStability(doc: BenchmarkDoc, runs: { label: string; records: CaseRecord[] }[]): StabilityReport {
  const pairs: StabilityPair[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const base = new Map(runs[i].records.map((record) => [record.id, record]));
      const target = new Map(runs[j].records.map((record) => [record.id, record]));
      const benchById = new Map(doc.cases.map((row) => [row.id, row]));
      let overlap5 = 0;
      let overlap10 = 0;
      let overlap20 = 0;
      let cases = 0;
      let rankDeltas: number[] = [];
      let scoreDeltas: number[] = [];
      let mustAgree = 0;
      let mustCases = 0;
      let negAgree = 0;
      let negCases = 0;
      let attrFlips = 0;
      for (const [id, baseRecord] of base) {
        const targetRecord = target.get(id);
        if (!targetRecord || targetRecord.status === "skipped" || baseRecord.status === "skipped") continue;
        cases += 1;
        const codes = (k: number, record: CaseRecord) => new Set(record.results.filter((row) => row.rank <= k).map((row) => row.code));
        const base5 = codes(5, baseRecord);
        const target5 = codes(5, targetRecord);
        overlap5 += [...base5].filter((code) => target5.has(code)).length / Math.max(1, Math.min(base5.size, 5));
        const base10 = codes(10, baseRecord);
        const target10 = codes(10, targetRecord);
        overlap10 += [...base10].filter((code) => target10.has(code)).length / Math.max(1, Math.min(base10.size, 10));
        const base20 = codes(20, baseRecord);
        const target20 = codes(20, targetRecord);
        overlap20 += [...base20].filter((code) => target20.has(code)).length / Math.max(1, Math.min(base20.size, 20));
        for (const row of baseRecord.results) {
          const twin = targetRecord.results.find((candidate) => candidate.code === row.code);
          if (twin) {
            rankDeltas.push(Math.abs(row.rank - twin.rank));
            if (row.score !== null && twin.score !== null) scoreDeltas.push(Math.abs(row.score - twin.score));
          }
        }
        const benchCase = benchById.get(id) as BenchmarkCase;
        const must = benchCase.anchors?.mustInclude?.map((anchor) => anchor.code) ?? [];
        if (must.length) {
          mustCases += 1;
          const baseHit = must.some((code) => inTopK(baseRecord, code, 20));
          const targetHit = must.some((code) => inTopK(targetRecord, code, 20));
          if (baseHit === targetHit) mustAgree += 1;
        }
        const negative = benchCase.anchors?.negative?.map((anchor) => anchor.code) ?? [];
        if (negative.length) {
          negCases += 1;
          const baseIntrusion = negative.some((code) => intrusionInTopK(baseRecord, negative, 10));
          const targetIntrusion = negative.some((code) => intrusionInTopK(targetRecord, negative, 10));
          if (baseIntrusion === targetIntrusion) negAgree += 1;
        }
        if (baseRecord.status !== targetRecord.status) attrFlips += 1;
      }
      pairs.push({
        base: runs[i].label,
        target: runs[j].label,
        overlapTop5: cases ? overlap5 / cases : 0,
        overlapTop10: cases ? overlap10 / cases : 0,
        overlapTop20: cases ? overlap20 / cases : 0,
        meanAbsRankDelta: rankDeltas.length ? rankDeltas.reduce((sum, value) => sum + value, 0) / rankDeltas.length : null,
        meanAbsScoreDelta: scoreDeltas.length ? scoreDeltas.reduce((sum, value) => sum + value, 0) / scoreDeltas.length : null,
        mustAnchorPresenceAgreement: mustCases ? mustAgree / mustCases : 1,
        negativeIntrusionAgreement: negCases ? negAgree / negCases : 1,
        attributionFlips: attrFlips,
      });
    }
  }
  return {
    runs: runs.map((run) => run.label),
    pairs,
    note: "Stability is not correctness (§22): reported next to quality, never merged with it. Overlap@K = mean Jaccard-style overlap of TopK code sets across the run pair.",
  };
}
