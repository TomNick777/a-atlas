/**
 * Ontology rule primitives. Everything in search/ontology is domain vocabulary
 * and deterministic matching rules — no company codes or names may appear here
 * (anti-gaming discipline carried over from data/search_ontology.json v1).
 *
 * A rule hits when any of its patterns matches the company's business text.
 * Hits become DERIVED entries carrying the matched span as evidence.
 */

export type MatchRule = {
  /** Ontology value id, stable across versions (e.g. "copper:mine"). */
  value: string;
  /** Chinese display label used in searchText and reports. */
  label: string;
  /** Regex source strings; any hit = evidence. Kept word-level: this is Stage 1. */
  patterns: string[];
  /** Rule id recorded on every derived entry (provenance). */
  rule: string;
  /** Prior confidence for a deterministic word hit. Default 0.8. */
  confidence?: number;
  /**
   * kp1 共现闸门:patterns 命中之外,每一条还必须命中同一公司拼接全文
   * (主营。产品)的语境词 —— 「液冷系统」只在同时存在 数据中心/服务器/算力
   * 类场景词时才算数据中心液冷;产品词单独不构成应用域证据。
   */
  cooc?: string[];
};

export type Dimension = {
  /** Dimension id, e.g. "industryChainRole". */
  id: string;
  label: string;
  description: string;
  rules: MatchRule[];
  /**
   * kp1 从属裁决:本 dimension 内,当 hiddenBy 任一值已存在时,value 的条目
   * 不再单独输出(弱证据被同维更强证据覆盖 —— 如 copper:byproduct 伴生铜精矿
   * 被 copper:mine/smelting 覆盖)。SOURCE 原文不动,只收敛派生解释。
   */
  subordinate?: { value: string; hiddenBy: string[] }[];
};

/**
 * A negative search concept, emitted only by an explicit domain rule:
 * required values present + forbidden values absent + optional raw-text guard.
 * Absence evidence alone is never enough — the guard patterns double-check the
 * raw text so a rule cannot deny a company something its own text claims.
 */
export type NegativeRule = {
  /** Concept id the company should NOT be matched to (e.g. "vehicle_thermal"). */
  concept: string;
  label: string;
  /** At least one of these dimension values must be present on the company. */
  hasAny: string[];
  /** None of these dimension values may be present. */
  hasNoneOf: string[];
  /** If any of these raw-text patterns hits, the negative is suppressed. */
  guardTextPatterns: string[];
  because: string;
  rule: string;
};

export const DEFAULT_CONFIDENCE = 0.8;

export function compileRules(rules: MatchRule[]): Array<{ rule: MatchRule; regexes: RegExp[] }> {
  return rules.map((rule) => ({
    rule,
    regexes: rule.patterns.map((p) => {
      try {
        return new RegExp(p);
      } catch (error) {
        throw new Error(`ontology rule ${rule.rule}: bad pattern ${p}: ${error}`);
      }
    }),
  }));
}
