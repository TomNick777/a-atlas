import type { Company } from "../types";
import type { LexicalIndex } from "../text/tokenize";
import { lexicalScore } from "../text/tokenize";
import { DIM, dot } from "../text/embed";

export const BY_MEANING = 60;
export const BY_WORDS = 40;
export const BY_INDUSTRY = 80;
export const BY_CONCEPT = 80;
export const MOST_FINALISTS = 240;

export type Nomination = {
  meaning: number[];
  words: number[];
  industry: number[];
  concept: number[];
};

const top = (scores: number[], n: number, min = 0) =>
  scores
    .map((score, index) => ({ score, index }))
    .filter((item) => item.score > min)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((item) => item.index);

export function meaningScores(query: Float32Array, vectors: Float32Array | null, count: number): number[] {
  if (!vectors) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, i) => dot(query, vectors, i * DIM));
}

export function wordScores(index: LexicalIndex, query: string, count: number): number[] {
  return Array.from({ length: count }, (_, i) => lexicalScore(index, query, i));
}

function bucket(companies: Company[], names: string[], field: (company: Company) => string[], scores: number[], cap: number): number[] {
  if (!names.length) return [];
  const want = new Set(names);
  return companies
    .map((company, index) => ({ index, score: field(company).some((name) => want.has(name)) ? scores[index] + 1e-9 : 0 }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((item) => item.index);
}

/**
 * When the classifier is sure, read the whole bucket. Being skipped before anyone
 * reads the profile is not the same as being judged and rejected.
 */
export function nominate(
  companies: Company[],
  meaning: number[],
  words: number[],
  industries: string[],
  concepts: string[],
): Nomination {
  const blended = meaning.map((score, index) => score + 0.35 * words[index]);
  return {
    meaning: top(meaning, BY_MEANING, 0.15),
    words: top(words, BY_WORDS, 0.08),
    industry: bucket(companies, industries, (company) => (company.industry ? [company.industry] : []), blended, BY_INDUSTRY),
    concept: bucket(companies, concepts, (company) => company.concepts, blended, BY_CONCEPT),
  };
}

export function finalistIndexes(nomination: Nomination): number[] {
  const ordered = [...nomination.words, ...nomination.meaning, ...nomination.industry, ...nomination.concept];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const index of ordered) {
    if (seen.has(index)) continue;
    seen.add(index);
    out.push(index);
    if (out.length >= MOST_FINALISTS) break;
  }
  return out;
}
