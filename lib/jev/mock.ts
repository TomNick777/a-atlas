import type { Company } from "../types";

/** Name overlap only. Used when Jev never sees the query, so a bucket is not invented. */
export function mockClassify(query: string, companies: Company[]): { industries: string[]; concepts: string[] } {
  const industries = [...new Set(companies.map((company) => company.industry))].filter((name) => name.length >= 2 && query.includes(name)).slice(0, 3);
  const concepts = [...new Set(companies.flatMap((company) => company.concepts))].filter((name) => name.length >= 2 && query.includes(name)).slice(0, 4);
  return { industries, concepts };
}

/**
 * Same blend as the retrieval baseline. Used when there is no TypeSafe key, or Jev does not answer.
 * It is not a judgment. Searches that need it are marked degraded.
 */
export function mockScores(meaning: number[], words: number[]): number[] {
  if (!meaning.length) return [];
  const raw = meaning.map((score, index) => score * 0.65 + (words[index] ?? 0));
  const best = Math.max(...raw, 1e-6);
  return raw.map((score) => Math.round((score / best) * 92) / 100);
}
