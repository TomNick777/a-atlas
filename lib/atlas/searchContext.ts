import type { AnswerRecord } from "./discoverCache";
import type { EvidenceView } from "./evidence";
import type { HybridDiscoverResult, HeroMetric } from "../hybrid/contracts";
import type { ResultJudgement } from "../types";

/** Presentation of one recorded answer only. No current corpus, market or judge reads. */
export type SearchContext =
  | { status: "none" }
  | { status: "unavailable"; query: string }
  | {
      status: "available";
      query: string;
      searchId: string;
      rank: number | null;
      caption: string;
      basis: "market" | "judgement" | "retrieval" | "unknown";
      degraded: boolean;
      selection: HybridDiscoverResult["execution"]["selection"];
      metric: HeroMetric | null;
      marketDate: string | null;
      marketSnapshot: HybridDiscoverResult["marketSnapshot"];
      judgement: ResultJudgement | null;
      provider: AnswerRecord["provider"] | null;
      runtimeModel: string | null;
      evidence: EvidenceView[];
    };

export function recordedSearchContext(input: {
  query: string;
  searchId?: string;
  code: string;
  record?: AnswerRecord;
}): SearchContext {
  const { query, searchId, code, record } = input;
  if (!query && !searchId) return { status: "none" };
  const unavailable = { status: "unavailable", query } as const;
  if (!searchId || !query || !record || record.answer.query !== query) return unavailable;
  const answer = record.answer;
  const index = answer.results.findIndex(row => row.code === code);
  if (index < 0) return unavailable;
  const row = answer.results[index];
  const judgement = row.judgement ?? null;
  const views = record.evidence[code] ?? [];
  // Fail closed for incomplete saved evidence; never resolve against today's corpus.
  const evidence = judgement?.evidenceRefs.length && judgement.evidenceRefs.every(ref =>
    ref.companyId === code && views.some(view => view.ref === ref.ref),
  ) ? views.filter(view => judgement.evidenceRefs.some(ref => ref.ref === view.ref)) : [];
  return structuredClone({
    status: "available",
    query,
    searchId,
    rank: Number.isInteger(row.rank) && row.rank! > 0 ? row.rank! : row.market ? null : index + 1,
    caption: answer.planCaption,
    basis: row.market ? "market" : judgement ? "judgement" : answer.execution.decidedBy === "retrieval" ? "retrieval" : "unknown",
    degraded: answer.execution.degraded,
    selection: answer.execution.selection,
    metric: row.hero,
    marketDate: row.market?.tradeDate ?? null,
    marketSnapshot: row.market ? answer.marketSnapshot : null,
    judgement,
    provider: judgement ? record.provider : null,
    runtimeModel: judgement ? record.runtimeModel : null,
    evidence,
  });
}

/** Explicit timezone for offset-bearing timestamps; preserve source wall-clock strings. */
export function sourceTimeLabel(value: string | null | undefined): string {
  if (!value) return "未提供";
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未提供";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date);
}
