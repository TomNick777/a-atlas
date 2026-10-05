import type { Company } from "../../lib/types";
import type { CompanySearchProfile } from "./schema";

/**
 * V2 searchText: judgeText(已验证的紧凑底文)+ 结构化派生行。
 * 检索(BM25)与 rerank(graded 头)继续共读这一份 — 与 V3 的三读一致原则相同。
 * 结构化行让「产业链角色/应用/细分/商品/排除」成为可命中词面。
 * 总长受控(~500 字符内),避免 bge 512 token 截断吃掉尾部行。
 */

const MAX_LEN = 640;

/**
 * genericLabels: dimension labels whose document frequency is too high to be
 * discriminative (computed by the build). They stay in the audit layer
 * (`derived`) but are kept out of the retrieval text.
 *
 * knowledgeLabels: Stage 3 domain-enrichment retrieval labels (工艺/材料/设备
 * 词,证据回指年报)。同一个 DF 闸门适用(规格第十八节:高 DF 泛化标签不进
 * lexical searchText;结构化知识存在 ≠ BM25 文本消费)。
 */
export function buildSearchTextV2(
  company: Company,
  bundle: Pick<CompanySearchProfile, "derived" | "semantic">,
  genericLabels?: Set<string>,
  knowledgeLabels?: string[],
): string {
  const parts: string[] = [company.judgeText];

  const line = (label: string, values: string[], cap = 8) => {
    const usable = genericLabels ? values.filter((v) => !genericLabels.has(v)) : values;
    if (!usable.length) return;
    parts.push(`${label}:${dedup(usable).slice(0, cap).join("、")}`);
  };

  line("角色", bundle.derived.filter((e) => e.dimension === "industryChainRole").map((e) => e.label));
  line("应用", bundle.derived.filter((e) => e.dimension === "applicationScenario").map((e) => e.label));
  line(
    "细分",
    bundle.derived
      .filter((e) => ["semiconductorSegment", "thermalSegment", "roboticsSegment"].includes(e.dimension))
      .map((e) => e.label),
  );
  // kp1 热管理三维:应用域走「细分」,产品能力/冷却方式走「热管理」行
  // (导热界面材料/均热板/液冷系统等词面与查询词对齐,但不再是应用域声明)。
  line(
    "热管理",
    bundle.derived
      .filter((e) => ["thermalProduct", "thermalCoolingMode"].includes(e.dimension))
      .map((e) => e.label),
  );
  line("商品", bundle.derived.filter((e) => e.dimension === "commodityExposure").map((e) => e.label), 5);
  line("工艺", knowledgeLabels ?? [], 12);
  line("标签", bundle.semantic.semanticTags.map((t) => t.tag));
  line("排除", bundle.semantic.negativeConcepts.map((n) => n.label), 4);

  return parts.filter(Boolean).join(" | ").slice(0, MAX_LEN);
}

function dedup(values: string[]): string[] {
  return [...new Set(values)];
}
