import type { Company } from "../types";
import { exclusionCompanyPatterns } from "./querySpec";
import { industryHitsDrop, type Constraints } from "./constraints";

const SHOWN = 0.3;
const MOST = 120;
const FEWEST = 9;

export type Scored = {
  index: number;
  probability: number;
  jev: number;
};

/** The number on the plate is the number that sorts. */
export function fuse(
  companies: Company[],
  finalists: number[],
  jev: number[],
  constraints: Constraints,
): Scored[] {
  const scored = finalists.map((index, at) => {
    const company = companies[index];
    let probability = jev[at] ?? 0;
    if (constraints.province && company.region.province && company.region.province !== constraints.province) probability = 0;
    if (constraints.province && !company.region.province) probability *= 0.35;
    const text = `${company.industry} ${company.businessDescription}`;
    if (constraints.dropIndustries.some((drop) => industryHitsDrop(company.industry, text, drop))) probability = 0;
    // ontology exclusions (不要铜加工 / 不要整机厂 / …): pattern hits on the judge view
    if (constraints.exclusions.some((type) => exclusionCompanyPatterns(type).some((p) => new RegExp(p).test(company.searchProfileText || company.judgeText)))) probability = 0;
    return { index, probability, jev: jev[at] ?? 0 };
  });
  scored.sort((a, b) => {
    const pa = Math.round(a.probability * 100);
    const pb = Math.round(b.probability * 100);
    if (pb !== pa) return pb - pa;
    const capA = companies[a.index].marketCap ?? 0;
    const capB = companies[b.index].marketCap ?? 0;
    return capB - capA;
  });
  return scored;
}

export function matchCount(scored: Scored[]): number {
  const fitting = scored.filter((row) => row.probability >= SHOWN).length;
  return Math.min(MOST, Math.max(Math.min(FEWEST, scored.length), fitting));
}

export { SHOWN, MOST, FEWEST };
