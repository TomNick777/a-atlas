import type { Dimension, NegativeRule } from "./common";
import { industryChainRole } from "./industryChain";
import { applicationScenario } from "./applications";
import { semiconductorSegment } from "./semiconductor";
import { thermalSegment, thermalProduct, thermalCoolingMode, thermalNegatives } from "./thermal";
import { roboticsSegment, roboticsNegatives } from "./robotics";
import { commodityExposure, commodityNegatives } from "./commodities";
import { CONCEPT_GROUPS } from "./concepts";

/**
 * Ontology source of truth. data/search_ontology.json becomes a generated
 * artifact (querySpec v1 back-compat + python reference); the TS modules own
 * the vocabulary. Bump ONTOLOGY_VERSION whenever any rule text changes — it is
 * part of every profile's provenance and of the incremental-build hash.
 *
 * kp1 (2026-09-26, Residual Remediation Phase 2):铜商品梯子 typed 化 + thermal
 * 三维拆分(thermalProduct/thermalCoolingMode 新维度)+ 铜资源概念词表收紧。
 */
export const ONTOLOGY_VERSION = "2026-09-26-kp1";

export const DIMENSIONS: Dimension[] = [
  industryChainRole,
  applicationScenario,
  semiconductorSegment,
  thermalSegment,
  thermalProduct,
  thermalCoolingMode,
  roboticsSegment,
  commodityExposure,
];

export const NEGATIVE_RULES: NegativeRule[] = [...thermalNegatives, ...roboticsNegatives, ...commodityNegatives];

export { CONCEPT_GROUPS };

export const P0_DIMENSION_IDS = DIMENSIONS.map((d) => d.id);

/** Query-side expansion rules, verbatim from v1 JSON (deterministic QuerySpec). */
export const QUERY_EXPANSIONS: { match: string; concepts: string[]; note?: string }[] = [
  { match: "人形机器人|机器人零部件|机器人核心部件|灵巧手|机器人时代", concepts: ["机器人零部件", "电机传动"] },
  { match: "工业机器人", concepts: ["工业自动化", "机器人零部件"] },
  { match: "液冷|散热|温控", concepts: ["液冷温控"] },
  { match: "数据中心|IDC|算力|AI|人工智能", concepts: ["数据中心", "AI硬件", "液冷温控", "电源供配电"] },
  { match: "UPS|供配电|电源保障|电源", concepts: ["电源供配电"] },
  { match: "半导体设备|刻蚀|清洗|薄膜沉积|晶圆", concepts: ["半导体设备"] },
  { match: "半导体材料|光刻胶|靶材", concepts: ["半导体材料"] },
  { match: "铜价|铜资源|铜矿|铜涨价", concepts: ["铜资源"] },
  { match: "电池材料|新能源材料|正极|负极|电解液|隔膜", concepts: ["电池材料"] },
  { match: "工业自动化|伺服|运动控制|类似汇川", concepts: ["工业自动化", "电机传动"] },
  { match: "汽车零部件|汽零", concepts: ["汽车零部件", "汽车热管理"] },
  { match: "消费电子|苹果|耳机|手机产业链", concepts: ["消费电子"] },
];

/** Query-side exclusion types, verbatim from v1 JSON. */
export const EXCLUSIONS: Record<string, { query_patterns: string[]; company_patterns: string[] }> = {
  整车厂: {
    query_patterns: ["不要.{0,6}整车", "排除.{0,4}整车", "不是.{0,4}整车", "不要.{0,6}造车"],
    company_patterns: ["整车", "乘用车", "商用车", "轿车", "SUV", "客车", "汽车制造", "汽车生产", "造车", "新能源商用车整车"],
  },
  机器人整机: {
    query_patterns: ["不要.{0,6}整机", "排除.{0,4}整机", "不要.{0,10}本体厂", "不要.{0,8}整机厂", "排除.{0,10}本体厂", "排除.{0,8}整机厂"],
    company_patterns: ["工业机器人及智能制造系统", "机器人产品及系统", "机器人系统集成", "智能机器人及", "机器人本体", "人形机器人、四足机器人", "通用人形机器人", "具身智能模型的研发"],
  },
  纯软件: {
    query_patterns: ["不要.{0,4}软件", "排除.{0,4}软件", "不是.{0,4}软件", "不要.{0,6}纯软件", "不要.{0,8}大模型", "排除.{0,6}算法"],
    company_patterns: ["软件开发", "软件服务", "软件销售", "信息技术服务", "大模型", "算法", "互联网信息服务"],
  },
  芯片设计: {
    query_patterns: ["不要.{0,4}芯片设计", "排除.{0,6}芯片设计", "不要.{0,8}设计公司"],
    company_patterns: ["芯片设计", "集成电路设计", "IP核", "EDA"],
  },
  铜加工: {
    query_patterns: ["不要.{0,4}铜加工", "排除.{0,6}铜加工", "不要.{0,6}铜材", "排除.{0,6}铜材", "不要.{0,4}铜.{0,2}加工", "排除.{0,6}铜.{0,2}加工"],
    company_patterns: ["铜管", "铜棒", "铜箔", "铜杆", "铜线", "铜板带", "铜材", "铜合金", "覆铜板", "铜基材料", "铜加工"],
  },
  医美机构: {
    query_patterns: ["不要.{0,6}医美机构", "排除.{0,8}诊所医院"],
    company_patterns: ["医疗美容医院", "医美机构", "门诊部"],
  },
  游戏研发: {
    query_patterns: ["不要.{0,8}游戏研发", "排除.{0,8}游戏内容"],
    company_patterns: ["游戏研发", "游戏开发", "游戏发行", "网络游戏运营"],
  },
};

/** Query-side attribute constraints, verbatim from v1 JSON. */
export const ATTRIBUTES = {
  overseas: {
    query_patterns: [
      { match: "海外业务比较的多?|海外业务较多|大量海外|海外收入占比高", minShare: 0.2 },
      { match: "主要靠海外|海外市场赚钱|海外为主|大量出口|出口企业", minShare: 0.35 },
      { match: "海外|出口|出海|境外", minShare: 0.1 },
    ],
  },
};

/** Regenerate data/search_ontology.json (v1 shape) so python/tooling stays in sync. */
export function buildOntologyJson() {
  return {
    version: ONTOLOGY_VERSION,
    note: "由 search/ontology/ 生成,勿手改。领域同义/概念关系表,query 扩展(lib/search/querySpec.ts)与公司 DERIVED 标签(scripts/build_search_profiles_v2.ts)共用。只允许领域词汇,禁止出现任何公司代码/简称。",
    concept_groups: CONCEPT_GROUPS,
    query_expansions: QUERY_EXPANSIONS,
    exclusions: EXCLUSIONS,
    attributes: ATTRIBUTES,
    dimensions_v2: DIMENSIONS.map((d) => ({
      id: d.id,
      label: d.label,
      values: d.rules.map((r) => ({ value: r.value, label: r.label, rules: r.patterns.length })),
    })),
    negatives_v2: NEGATIVE_RULES.map((n) => ({ concept: n.concept, label: n.label, rule: n.rule })),
  };
}
