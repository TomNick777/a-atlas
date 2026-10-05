/**
 * Evidence UX contract (Phase 3.4) — the ONLY evidence shape the UI consumes.
 *
 *   Jev decision (evidenceRefs) → resolve against Atlas facts → EvidenceView → UI
 *
 * The frontend never sees capability wire shapes, corpus rows or profile files;
 * it renders EvidenceView. Every displayed evidence line must resolve through
 * this module — an unresolvable ref is never rendered, and a judgement whose
 * refs fail resolution surfaces as "证据暂不可用", never as invented text.
 *
 * The judge profile text resolved here is byte-identical to what the capability
 * layer sent Jev (same subjects mapping), so "this is what the judgement was
 * grounded in" is literally true, not a paraphrase.
 */
import { loadDataset } from "@/lib/companies";
import { findCompany } from "@/lib/atlas/company";
import { LruCache } from "@/lib/cache";
import { parseQuerySpec } from "@/lib/search/querySpec";
import { judgeEvidenceOf, judgeProfileRef, judgeProfileText, type EvidenceItem, type EvidenceRef } from "@/lib/jev/capabilities";
import type { Company, ResultJudgement, SearchHit, SearchResult } from "@/lib/types";
import type { HybridDiscoverResult, HybridResultRow } from "@/lib/hybrid/contracts";

/** Version of the UI evidence contract itself (independent of capability
 * contract versions; surfaced in the inspector's technical details). */
export const EVIDENCE_VIEW_VERSION = "evidence-view-1";

/** The single evidence kind Atlas resolves today: the judge profile text. */
export type EvidenceKind = "judge_profile";

/**
 * One resolvable, displayed evidence item. `text` is verbatim Atlas fact —
 * excerpting/truncation for display happens in the UI, never rewording.
 */
export type EvidenceView = {
  ref: string;
  kind: EvidenceKind;
  /** Stable zh UI label for the source (closed mapping — no invented sources). */
  label: string;
  text: string;
  provenance: {
    /** Corpus / profile layer the fact came from, with its digest. */
    source: string;
    recordedAt: string | null;
  };
};

const JUDGE_PROFILE_PREFIX = "judge-profile:";
const LABELS: Record<EvidenceKind, string> = { judge_profile: "公司档案" };

/** Resolve one evidence ref to its verbatim Atlas text. Null for any ref this
 * module cannot resolve — callers must never render an unresolved ref. */
export function resolveEvidenceRef(ref: string): EvidenceView | null {
  if (!ref.startsWith(JUDGE_PROFILE_PREFIX)) return null;
  const company = findCompany(ref.slice(JUDGE_PROFILE_PREFIX.length));
  if (!company) return null;
  const { corpus, edition, manifest } = loadDataset();
  return {
    ref,
    kind: "judge_profile",
    label: LABELS.judge_profile,
    text: judgeProfileText(company, "zh"),
    provenance: {
      source: corpus ? `company-corpus ${corpus.contentDigest16}` : `search-profiles/${edition}`,
      recordedAt: corpus?.generatedAt?.slice(0, 10) ?? (typeof manifest?.builtAt === "string" ? manifest.builtAt.slice(0, 10) : null),
    },
  };
}

/** Resolve every ref behind a judgement. Null when ANY ref fails — a partially
 * grounded evidence list is worse than an honest "unavailable". */
export function evidenceViewsFor(refs: EvidenceRef[]): EvidenceView[] | null {
  const views: EvidenceView[] = [];
  for (const ref of refs) {
    const view = resolveEvidenceRef(ref.ref);
    if (!view) return null;
    views.push(view);
  }
  return views;
}

/** The judge-profile EvidenceView for a company (company-page inspector).
 * Pages consume this, never the seam's ref helpers — the frontend speaks
 * EvidenceView only. */
export function judgeProfileEvidenceView(code: string): EvidenceView | null {
  return resolveEvidenceRef(judgeProfileRef(code));
}

/** Atlas fact selection for an explanation call: the same evidence text the
 * judge read for this company (identical subjects mapping, zh). */
export function judgeEvidenceFor(code: string): EvidenceItem[] {
  const company = findCompany(code);
  return company ? [judgeEvidenceOf(company, "zh")] : [];
}

/** Deterministic term hits: query terms found verbatim in the company's judge
 * profile text. These are Atlas facts (Level-1 hint source) — never Jev output,
 * never a summary. Single authority for the executor and the company page. */
const profileQueryTerms = new LruCache<readonly string[]>(48);

export function profileTermHits(query: string, company: Company): string[] {
  const text = company.searchProfileText || company.judgeText;
  let terms = profileQueryTerms.get(query);
  if (!terms) {
    const unique = new Set<string>(parseQuerySpec(query).must);
    for (const token of query.split(/[\s，。、·]+/)) if (token.length >= 2) unique.add(token);
    terms = [...unique];
    profileQueryTerms.set(query, terms);
  }
  // Cache only query parsing. Matches always use the current company's text,
  // and filter returns a fresh array that callers can safely own.
  return terms.filter((term) => text.includes(term));
}

// ---- presented result shapes (API boundary) --------------------------------

/** A search hit plus its judgement and resolved evidence (additive; /api/search). */
export type SearchHitPresented = SearchHit & {
  judgement: ResultJudgement | null;
  /** null = the judgement's refs did not all resolve — never render partial evidence. */
  evidence: EvidenceView[] | null;
};

export type SearchResultPresented = Omit<SearchResult, "hits" | "judgements"> & {
  hits: SearchHitPresented[];
};

/** Per-hit presentation replaces the internal judgements map: the UI reads
 * `hit.judgement` / `hit.evidence`, never a code-keyed lookup table. */
export function presentSearchResult(result: SearchResult): SearchResultPresented {
  const { judgements, ...rest } = result;
  return {
    ...rest,
    hits: result.hits.map((hit) => presentJudgement(hit, judgements?.[hit.code] ?? null)),
  };
}

function presentJudgement<T extends { code: string }>(row: T, judgement: ResultJudgement | null): T & { judgement: ResultJudgement | null; evidence: EvidenceView[] | null } {
  if (!judgement) return { ...row, judgement: null, evidence: null };
  return { ...row, judgement, evidence: evidenceViewsFor(judgement.evidenceRefs) };
}

/** A discover row plus its judgement and resolved evidence (/api/discover). */
export type HybridResultRowPresented = HybridResultRow & {
  judgement: ResultJudgement | null;
  evidence: EvidenceView[] | null;
};

export type HybridDiscoverPresented = Omit<HybridDiscoverResult, "results"> & {
  results: HybridResultRowPresented[];
};

export function presentDiscoverResult(result: HybridDiscoverResult): HybridDiscoverPresented {
  return {
    ...result,
    results: result.results.map((row) => presentJudgement(row, row.judgement)),
  };
}
