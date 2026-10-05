import type { Company } from "../../lib/types";
import {
  DIMENSIONS,
  NEGATIVE_RULES,
  CONCEPT_GROUPS,
  ONTOLOGY_VERSION,
} from "../ontology/index";
import { compileRules, DEFAULT_CONFIDENCE, type MatchRule } from "../ontology/common";
import type { CompanySearchProfile, DerivedEntry, NegativeTag, SemanticTag } from "./schema";
import { DERIVATION_VERSION } from "./schema";
import { buildSearchTextV2 } from "./searchText";

/**
 * Stage-1 deterministic derivation. Source text = 主营 + 产品名 (the same
 * field scope V1 used; 机构简介 is registration boilerplate and stays out).
 * Every emitted entry is reproducible from the source text plus the ontology
 * — no model, no external knowledge, no guessing.
 */

export type DerivedBundle = Pick<
  CompanySearchProfile,
  "derived" | "semantic" | "coverage" | "unknownDimensions"
>;

const compiled = DIMENSIONS.map((dim) => ({ dim, rules: compileRules(dim.rules) }));
const conceptCompiled = Object.entries(CONCEPT_GROUPS).map(([group, terms]) => ({
  group,
  regexes: terms.map((t) => new RegExp(t)),
}));

export function businessFields(company: Company): { field: string; text: string }[] {
  const products = company.mainProducts.map((p) => p.name).join("、");
  return [
    { field: "businessDescription", text: company.businessDescription || "" },
    { field: "mainProducts", text: products },
  ];
}

function scan(text: string, regexes: RegExp[]): RegExpExecArray | null {
  for (const re of regexes) {
    const m = re.exec(text);
    if (m) return m;
  }
  return null;
}

/**
 * kp1 商品×设备复合词守卫:商品词命中后紧跟设备头名词(装备/设备/机器/机械/
 * 生产线,允许 高端/生产 前缀,中间无句读)= 公司卖的是那台设备,不是商品
 * 本体 —— 洪田股份「电解铜箔高端生产装备/电解铜箔设备」不构成铜商品敞口。
 */
const COMMODITY_EQUIP_HEAD = /^(?:高端)?(?:生产)?(?:装备|设备|机器|机械)/;

/** kp1:设备复合词守卫适用的概念标签组(铜商品组;词表同样被 QuerySpec 扩展消费,
 *  守卫只作用于公司侧标签派生,不动查询侧词表)。 */
const EQUIP_GUARDED_TAG_GROUPS = new Set(["铜资源", "铜加工"]);

/** kp1 维度级派生:cooc 共现与商品设备头守卫后的条目收集。 */
export function deriveProfile(company: Company): DerivedBundle {
  const fields = businessFields(company);
  const joined = fields.map((f) => f.text).join("。");

  const derived: DerivedEntry[] = [];
  for (const { dim, rules } of compiled) {
    for (const { rule, regexes } of rules) {
      const evidence: string[] = [];
      const from = new Set<string>();
      for (const f of fields) {
        const hit = scan(f.text, regexes);
        if (hit) {
          // 商品敞口专用:命中词是设备复合词的修饰语时不算商品环节
          if (dim.id === "commodityExposure" && COMMODITY_EQUIP_HEAD.test(f.text.slice(hit.index + hit[0].length, hit.index + hit[0].length + 8))) continue;
          evidence.push(hit[0]);
          from.add(f.field);
        }
        if (evidence.length >= 2) break;
      }
      if (evidence.length) {
        // kp1 共现闸门:产品词需要场景词在场才成立(液冷系统×数据中心/算力)
        if (rule.cooc && !rule.cooc.every((p) => new RegExp(p).test(joined))) continue;
        derived.push({
          dimension: dim.id,
          dimLabel: dim.label,
          value: rule.value,
          label: rule.label,
          evidence: evidence.map((e) => e.slice(0, 24)),
          derivedFrom: [...from],
          derivationRule: rule.rule,
          derivationVersion: DERIVATION_VERSION,
          confidence: rule.confidence ?? DEFAULT_CONFIDENCE,
        });
      }
    }
    // kp1 从属裁决:同维更强证据在场时,弱 rung 条目不输出(SOURCE 不动,解释收敛)
    if (dim.subordinate?.length) {
      const present = new Set(derived.filter((e) => e.dimension === dim.id).map((e) => e.value));
      for (const sub of dim.subordinate) {
        if (!present.has(sub.value)) continue;
        if (!sub.hiddenBy.some((v) => present.has(v))) continue;
        for (let i = derived.length - 1; i >= 0; i -= 1) {
          if (derived[i].dimension === dim.id && derived[i].value === sub.value) derived.splice(i, 1);
        }
      }
    }
  }

  // V1-compat concept tags: same word-hit semantics as build_search_profiles.py.
  // kp1:铜资源/铜加工 组标签套用商品×设备复合词守卫 —— 「电解铜箔设备/电解铜箔
  // 高端生产装备」里的 铜箔 是设备修饰语,不构成铜概念标签(洪田股份案)。
  const semanticTags: SemanticTag[] = [];
  for (const { group, regexes } of conceptCompiled) {
    let hit: RegExpExecArray | null = null;
    for (const re of regexes) {
      const gre = new RegExp(re.source, "g");
      for (let m = gre.exec(joined); m; m = gre.exec(joined)) {
        if (EQUIP_GUARDED_TAG_GROUPS.has(group) && COMMODITY_EQUIP_HEAD.test(joined.slice(m.index + m[0].length, m.index + m[0].length + 8))) continue;
        hit = m;
        break;
      }
      if (hit) break;
    }
    if (hit) semanticTags.push({ tag: group, evidence: hit[0].slice(0, 40), provenance: "DERIVED:业务文本词面命中" });
  }

  const presentValues = new Set(derived.map((e) => e.value));
  const negativeConcepts: NegativeTag[] = [];
  for (const neg of NEGATIVE_RULES) {
    if (!neg.hasAny.some((v) => presentValues.has(v))) continue;
    if (neg.hasNoneOf.some((v) => presentValues.has(v))) continue;
    if (neg.guardTextPatterns.some((p) => new RegExp(p).test(joined))) continue;
    negativeConcepts.push({
      concept: neg.concept,
      label: neg.label,
      because: neg.because,
      rule: neg.rule,
      derivationVersion: DERIVATION_VERSION,
    });
  }

  const coverage = [...new Set(derived.map((e) => e.dimension))];
  const known = new Set([...coverage]);
  const unknownDimensions = DIMENSIONS.map((d) => d.id).filter((id) => !known.has(id));

  return { derived, semantic: { semanticTags, negativeConcepts }, coverage, unknownDimensions };
}

export function ontologyStamp(): { ontologyVersion: string; ruleCount: number } {
  const ruleCount = DIMENSIONS.reduce((sum, d) => sum + d.rules.length, 0);
  return { ontologyVersion: ONTOLOGY_VERSION, ruleCount };
}

export type { MatchRule };
