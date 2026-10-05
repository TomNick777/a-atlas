import type { Company } from "../types";
import { jevProvider, type SystemOneResponse } from "./cloud";
import type { JevOutcome } from "./provider";

const SURE = 0.12;
/** Choice options ride in the prompt: keep the vocabulary bounded. */
const VOCAB = 250;

export type Classification = {
  industries: string[];
  concepts: string[];
  tokens: number;
  live: boolean;
  outcome: JevOutcome;
  model: string | null;
};

type ChoiceAnswer = { probabilities?: Record<string, number> };

/**
 * One call, several questions, all judged against the query.
 * Vocabularies come from the company pool, not from a hardcoded taxonomy.
 * With the full A-share pool the freq cap keeps the prompt stable: 申万一级
 * names always fit, and the long tail of filing industries rides along by rank.
 *
 * Only the pre-V3 nomination path needs this; V3 retrieval is deterministic and
 * QuerySpec-driven, so the pipeline skips the call rather than paying for an
 * answer it will not read.
 */
export async function classify(
  query: string,
  companies: Company[],
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<Classification> {
  const counts = new Map<string, number>();
  for (const company of companies) {
    if (company.swLevel1Industry && company.swLevel1Industry !== "unknown") {
      counts.set(company.swLevel1Industry, (counts.get(company.swLevel1Industry) ?? 0) + 1);
    }
    const industry = company.industry.trim();
    if (industry) counts.set(industry, (counts.get(industry) ?? 0) + 1);
  }
  const industries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, VOCAB).map(([name]) => name);
  const concepts = unique(companies.flatMap((company) => company.concepts)).slice(0, VOCAB);
  if (!industries.length && !concepts.length) return { industries: [], concepts: [], tokens: 0, live: false, outcome: "bad_response", model: null };

  const call = await jevProvider().ask<SystemOneResponse<Record<string, ChoiceAnswer>>>(
    {
      state: query.slice(0, 300),
      questions: {
        ...(industries.length
          ? {
              industry: {
                type: "choice",
                instructions: "这句话在找哪一类行业的公司？按公司实际做什么判断，而不是按它碰巧出现的词。",
                criteria: Object.fromEntries(industries.map((name) => [name, null])),
              },
            }
          : {}),
        ...(concepts.length
          ? {
              concept: {
                type: "choice",
                instructions: "这句话最接近哪一个概念？对方往往不知道标准叫法，按事情本身判断。",
                criteria: Object.fromEntries(concepts.map((name) => [name, null])),
              },
            }
          : {}),
      },
    },
    "classify",
    { signal: options.signal, deadlineAt: options.deadlineAt },
  );

  if (!call.ok) return { industries: [], concepts: [], tokens: 0, live: false, outcome: call.outcome, model: null };
  return {
    industries: picked(call.data.answers?.industry?.probabilities, 3),
    concepts: picked(call.data.answers?.concept?.probabilities, 4),
    tokens: call.usage.inputTokens + call.usage.outputTokens,
    live: true,
    outcome: "ok",
    model: call.model,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function picked(probabilities: Record<string, number> | undefined, limit: number): string[] {
  return Object.entries(probabilities ?? {})
    .filter(([, probability]) => probability >= SURE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}
