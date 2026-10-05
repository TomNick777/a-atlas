/**
 * Deterministic capability routing (Phase 3.3 §11) — no model, no planner, no
 * intent classifier.
 *
 * Only RELATION SYNTAX routes a query to semantic_relation; everything else —
 * including anything ambiguous — stays on semantic_match, the safe default.
 * This file holds the same discipline as the planner grammar: relation syntax
 * words only (供应链/供应商/产业链/上下游/合作/配套/代工…), never an industry,
 * product, company or concept word. A boundary test pins this file to zero
 * such vocabulary.
 */
export type RoutedCapability = "semantic_match" | "semantic_relation";

export type CapabilityRoute = { capability: RoutedCapability; reason: string };

/** Relation phrases with a frozen reading: 「X供应链」「X供应商」「给X做配套」… */
const RELATION_SYNTAX: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /(供应|产业|协作|配套)链/, reason: "供应链/产业链表述" },
  { re: /供应商|供货|代工|配套厂|配套企业|配套商/, reason: "供应/配套关系表述" },
  { re: /合作伙伴|合作厂商|战略合作/, reason: "合作关系表述" },
  { re: /上游|下游/, reason: "产业链上下游表述" },
];

export function resolveJevCapability(rawQuery: string): CapabilityRoute {
  const query = rawQuery.trim();
  for (const rule of RELATION_SYNTAX) {
    if (rule.re.test(query)) return { capability: "semantic_relation", reason: rule.reason };
  }
  return { capability: "semantic_match", reason: "默认：普通语义发现" };
}
