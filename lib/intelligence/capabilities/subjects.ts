/**
 * Atlas-side subject mapping (Phase 3.3) — Company records → judgement subjects.
 *
 * Which profile text a company contributes (中文 judge profile, or the English
 * one for the language measurement) is FACT SELECTION, so it lives on the Atlas
 * side of the seam. The capability payload builder only slices to the transport
 * detail budget.
 */
import type { Company } from "../../types";
import type { EvidenceItem, JudgementSubject } from "./contracts";

/** The evidence ref of the judge profile Atlas mapped for a company. */
export function judgeProfileRef(companyId: string): string {
  return `judge-profile:${companyId}`;
}

/** The judge profile text exactly as production has always sent it. */
export function judgeProfileText(company: Company, language: "zh" | "en" = "zh"): string {
  return language === "en" && company.judgeTextEn ? company.judgeTextEn : company.searchProfileText || company.judgeText;
}

/** One company → one subject carrying its judge profile as the evidence item. */
export function subjectOf(company: Company, language: "zh" | "en" = "zh"): JudgementSubject {
  return {
    companyId: company.code,
    name: company.name,
    evidence: [judgeEvidenceOf(company, language)],
  };
}

/** Companies → subjects, input order preserved (score arrays are index-aligned). */
export function subjectsOf(companies: Company[], language: "zh" | "en" = "zh"): JudgementSubject[] {
  return companies.map((company) => subjectOf(company, language));
}

export function judgeEvidenceOf(company: Company, language: "zh" | "en" = "zh"): EvidenceItem {
  return { ref: judgeProfileRef(company.code), text: judgeProfileText(company, language) };
}
