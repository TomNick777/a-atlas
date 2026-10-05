/**
 * Legacy-compatible judge facade (Phase 3.3).
 *
 * Both heads are now adapters over capability contracts: `judge` rides the
 * semantic_match capability, `judgeGraded` rides semantic_comparison — the
 * payload builders live in lib/jev/capabilities/ and are byte-identical to the
 * pre-capability production code, so committed fixtures and harness replays
 * are unchanged. This file stays because offline harnesses (benchmarks,
 * trawler-era scripts) and the runtime identity probe still speak the
 * JudgeVerdict shape; nothing outside lib/jev may grow a new dependency on it.
 */
import type { Company } from "../types";
import type { JevOutcome } from "./provider";
import { runSemanticMatch } from "./capabilities/semantic-match";
import { runSemanticComparison } from "./capabilities/semantic-comparison";
import { subjectsOf } from "./capabilities/subjects";

export { MATCH_CHUNK as JUDGE_CHUNK } from "./capabilities/semantic-match";

export type JudgeVerdict = {
  scores: number[];
  tokens: number;
  /** Every chunk got an answer. Anything else means the search is degraded (§10). */
  live: boolean;
  outcome: JevOutcome;
  model: string | null;
  chunks: number;
  answeredChunks: number;
};

function verdictOf(scores: number[], result: { live: boolean; outcome: string | null; runtimeModel: string | null; tokens: number; status: string; answeredChunks: number }, chunks: number): JudgeVerdict {
  return {
    scores,
    tokens: result.tokens,
    live: result.live,
    outcome: (result.outcome as JevOutcome) ?? (result.status === "ok" ? "ok" : "client_error"),
    model: result.runtimeModel,
    chunks,
    answeredChunks: result.answeredChunks,
  };
}

/**
 * The query is the state. Each finalist is one yes/no question. Kept as the
 * JudgeVerdict adapter over the semantic_match capability; production callers
 * use the capability seam instead.
 */
export async function judge(
  query: string,
  companies: Company[],
  options: { signal?: AbortSignal; language?: "zh" | "en"; deadlineAt?: number } = {},
): Promise<JudgeVerdict> {
  const result = await runSemanticMatch(
    { query, subjects: subjectsOf(companies, options.language ?? "zh") },
    { signal: options.signal, deadlineAt: options.deadlineAt },
  );
  return verdictOf(
    result.decisions.map((decision) => decision.score),
    result,
    result.chunks,
  );
}

/**
 * Graded relevance (0-3) on the score head, now the semantic_comparison
 * contract with its payload unchanged. Measured on the frozen blind suite
 * (a-share-trawler reports/model_contest/unseen_v1): Jev noul 95.8% vs Jev
 * score 90.0%, so production rerank keeps the noul head. This stays because
 * the head works on the cloud and the offline ranking harnesses compare
 * against it.
 */
export async function judgeGraded(query: string, companies: Company[], options: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<JudgeVerdict> {
  const result = await runSemanticComparison(
    { comparisonQuery: query, subjects: subjectsOf(companies, "zh") },
    { signal: options.signal, deadlineAt: options.deadlineAt },
  );
  return verdictOf(
    result.decisions.map((decision) => decision.score),
    result,
    result.chunks,
  );
}

/**
 * One minimal question against the cloud, used by the startup self-check to learn
 * which model actually answers. Real companies, real head, two candidates: the
 * cheapest call that still exercises the whole wire contract, on a question whose
 * answer we already know — so it can never mislead a search.
 */
export async function identityProbe(): Promise<{ ok: boolean; model: string | null; outcome: JevOutcome }> {
  const result = await runSemanticMatch({
    query: "做商业银行业务的银行",
    subjects: [
      {
        companyId: "000001",
        name: "平安银行",
        evidence: [{ ref: "judge-profile:000001", text: "平安银行（000001，SZ） | 行业：货币金融服务/银行 | 主营：商业银行业务。" }],
      },
      {
        companyId: "601318",
        name: "中国平安",
        evidence: [{ ref: "judge-profile:601318", text: "中国平安（601318，SH） | 行业：保险 | 主营：保险与综合金融。" }],
      },
    ],
  });
  return {
    ok: result.status === "ok" && result.live,
    model: result.runtimeModel,
    outcome: result.outcome ?? (result.status === "ok" ? "ok" : "client_error"),
  };
}
