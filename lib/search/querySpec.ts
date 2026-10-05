import {
  CONCEPT_GROUPS,
  EXCLUSIONS,
  QUERY_EXPANSIONS,
  ATTRIBUTES,
  ONTOLOGY_VERSION,
} from "../../search/ontology/index";

export type QuerySpec = {
  raw: string;
  /** Domain concept groups the query touches (drive retrieval expansion). */
  concepts: string[];
  /** Terms the matching company text must relate to (from the query itself). */
  must: string[];
  /** Extra retrieval terms implied by the domain (concept-group vocab). */
  expansionTerms: string[];
  /** Matched exclusion types, e.g. 整车厂 / 纯软件 (enforced by hard filters). */
  exclusions: string[];
  /** Attribute constraints parsed from the query. */
  attrs: {
    province: string | null;
    overseasMinShare: number | null;
  };
};

/** Ontology now lives in search/ontology/ (TS source of truth); the JSON file is a generated artifact. */
const ONTOLOGY = {
  concept_groups: CONCEPT_GROUPS,
  query_expansions: QUERY_EXPANSIONS,
  exclusions: EXCLUSIONS,
  attributes: ATTRIBUTES,
};

/** Bumped when parse rules change; recorded in QUERY_PARSED telemetry. */
export const QUERY_SPEC_PARSER_VERSION = "queryspec-v1";

export const ONTOLOGY_VERSION_REF = ONTOLOGY_VERSION;

export const EXCLUSION_TYPES = Object.keys(ONTOLOGY.exclusions);
/** Company-text patterns per exclusion type — the hard filters read these. */
export const exclusionCompanyPatterns = (type: string): string[] =>
  ONTOLOGY.exclusions[type]?.company_patterns ?? [];

const PROVINCES = [
  "内蒙古", "黑龙江", "新疆", "西藏", "广西", "宁夏", "北京", "天津", "上海", "重庆",
  "河北", "山西", "辽宁", "吉林", "江苏", "浙江", "安徽", "福建", "江西", "山东",
  "河南", "湖北", "湖南", "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海",
];

function matchedConcepts(query: string): string[] {
  const out = new Set<string>();
  for (const rule of ONTOLOGY.query_expansions) {
    if (new RegExp(rule.match).test(query)) for (const c of rule.concepts) out.add(c);
  }
  // direct ontology-term hits also open their group (e.g. query says 减速器)
  for (const [group, terms] of Object.entries(ONTOLOGY.concept_groups)) {
    if (terms.some((t) => query.includes(t))) out.add(group);
  }
  return [...out];
}

function matchedMust(query: string): string[] {
  const out = new Set<string>();
  for (const terms of Object.values(ONTOLOGY.concept_groups)) {
    for (const t of terms) if (query.includes(t)) out.add(t);
  }
  return [...out];
}

function matchedExclusions(query: string): string[] {
  const out: string[] = [];
  for (const [type, spec] of Object.entries(ONTOLOGY.exclusions)) {
    if (spec.query_patterns.some((p) => new RegExp(p).test(query))) out.push(type);
  }
  return out;
}

function overseasMinShare(query: string): number | null {
  let min: number | null = null;
  for (const rule of ONTOLOGY.attributes.overseas.query_patterns) {
    if (new RegExp(rule.match).test(query)) min = min == null ? rule.minShare : Math.max(min, rule.minShare);
  }
  return min;
}

export function parseQuerySpec(raw: string): QuerySpec {
  const query = raw.trim();
  const concepts = matchedConcepts(query);
  const expansionTerms = new Set<string>();
  for (const c of concepts) for (const t of ONTOLOGY.concept_groups[c] ?? []) expansionTerms.add(t);
  return {
    raw: query,
    concepts,
    must: matchedMust(query),
    expansionTerms: [...expansionTerms],
    exclusions: matchedExclusions(query),
    attrs: {
      province: PROVINCES.find((p) => query.includes(p)) ?? null,
      overseasMinShare: overseasMinShare(query),
    },
  };
}
