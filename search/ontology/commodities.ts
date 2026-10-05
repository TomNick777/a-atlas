import type { Dimension } from "./common";

/**
 * P0-6 资源 vs 加工。commodity exposure 用「商品:环节」的梯子表达,
 * copper:mine 与 copper:foil 是同一商品的两端。这是「铜涨价」问题的核心:
 * 涨价受益查询应命中最上游的 rung,而不是任何带「铜」字的公司。
 */

type Rung = { rung: string; label: string; patterns: string[]; confidence?: number };

function ladder(commodity: string, label: string, rungs: Rung[]) {
  return rungs.map((r) => ({
    value: `${commodity}:${r.rung}`,
    label: `${label}·${r.label}`,
    patterns: r.patterns,
    rule: `cmd.${commodity}.${r.rung}.v2`,
    confidence: r.confidence ?? 0.85,
  }));
}

/**
 * kp1 商品梯子修复(Residual Remediation Phase 2,报告 KNOWLEDGE_PASS_COPPER.md):
 *   1. mine 只收铜特异词:铜矿/铜采选/铜金矿/铜钴矿;通用采矿动词(采选/选矿/
 *      矿产资源/多金属采选)与子串 铜钴 全部退出 —— 它们不能独立推出
 *      commodity=copper(triage Case C:罗平锌电 铅锌矿挂全套铜 tag)。
 *      「铜」与采矿动词同段共现按 0.75 授 mine(江西铜业/紫金矿业/白银有色类
 *      主营叙述「铜和黄金的采选」「矿产资源勘查」)。
 *   2. 铜精矿 = 副产证据,降为 copper:byproduct(0.5);有更强 rung 时隐藏
 *      (subordinate)—— 副产铜精矿(罗平锌电)不再自称铜矿商。
 *   3. 电解铜(?!箔):「电解铜箔⊂电解铜」子串泄漏关闭(中一/德福/诺德/嘉元/
 *      亨通的电解铜箔业务误开 smelting);电积铜 补入(寒锐钴业真实铜产品)。
 *   4. 商品词后跟设备头名词(装备/设备/生产线)不算商品敞口 —— 洪田股份
 *      「电解铜箔高端生产装备」是设备商,不是铜商(derive 侧通用守卫)。
 *   5. copper:products(0.6):铜产品/铜钴 产品面证据,环节未定不上资源;
 *      有更强 rung 时隐藏(洛阳钼业 铜钴相关产品 保持铜敞口,寒锐钴业被
 *      电积铜 smelting 覆盖)。
 *   6. role 与 commodity 分离:箔/覆铜板/加工材 rung 语义即 processor/
 *      material_supplier,不构成 copper_resource(规格§十)。
 */
export const COMMODITY_ONTOLOGY_VERSION = "commodity-ontology-kp1";

export const commodityExposure: Dimension = {
  id: "commodityExposure",
  label: "商品敞口",
  description: "商品×环节梯子(mine→smelting→processing→深加工),资源与加工分列",
  subordinate: [
    { value: "copper:byproduct", hiddenBy: ["copper:mine", "copper:smelting", "copper:processing", "copper:foil", "copper:clad"] },
    { value: "copper:products", hiddenBy: ["copper:mine", "copper:smelting", "copper:processing", "copper:foil", "copper:clad", "copper:byproduct"] },
  ],
  rules: [
    { value: "copper:mine", label: "铜·矿山采选", patterns: ["铜矿", "铜采选", "铜金矿", "铜钴矿"], rule: "cmd.copper.mine.v2", confidence: 0.85 },
    { value: "copper:mine", label: "铜·矿山采选", patterns: ["铜[一-龥、,和与及]{0,20}(采选|开采|矿山|采掘|勘探|勘查|资源储量)"], rule: "cmd.copper.mine.cooc.v3", confidence: 0.75 },
    { value: "copper:smelting", label: "铜·冶炼", patterns: ["铜冶炼", "阴极铜", "电解铜(?!箔)", "电积铜", "粗铜", "冰铜", "冶炼产铜"], rule: "cmd.copper.smelting.v2", confidence: 0.85 },
    { value: "copper:processing", label: "铜·加工材", patterns: ["铜加工", "铜管", "铜棒", "铜杆", "铜线", "铜板带", "铜排", "铜材", "铜合金"], rule: "cmd.copper.processing.v2", confidence: 0.9 },
    { value: "copper:foil", label: "铜·铜箔", patterns: ["铜箔", "电解铜箔", "压延铜箔"], rule: "cmd.copper.foil.v2", confidence: 0.9 },
    { value: "copper:clad", label: "铜·覆铜板", patterns: ["覆铜板", "CCL"], rule: "cmd.copper.clad.v2", confidence: 0.9 },
    { value: "copper:heatsink", label: "铜·散热件", patterns: ["铜散热", "铜热管", "铜基板散热"], rule: "cmd.copper.heatsink.v2", confidence: 0.85 },
    { value: "copper:byproduct", label: "铜·副产(伴生铜精矿)", patterns: ["铜精矿"], rule: "cmd.copper.byproduct.v3", confidence: 0.5 },
    { value: "copper:products", label: "铜·产品敞口(环节未定)", patterns: ["铜产品", "铜钴"], rule: "cmd.copper.products.v3", confidence: 0.6 },
    ...ladder("gold", "黄金", [
      { rung: "mine", label: "金矿采选", patterns: ["金矿", "黄金开采", "金精矿", "采金"] },
      { rung: "smelting", label: "冶炼", patterns: ["黄金冶炼", "金锭", "合质金"] },
    ]),
    ...ladder("lithium", "锂", [
      { rung: "mine", label: "锂矿/盐湖", patterns: ["锂矿", "锂辉石", "锂云母", "盐湖提锂", "盐湖卤水"] },
      { rung: "salt", label: "锂盐", patterns: ["碳酸锂", "氢氧化锂", "氯化锂", "锂盐"], confidence: 0.8 },
      { rung: "cathode", label: "正极材料", patterns: ["正极材料", "三元材料", "磷酸铁锂", "钴酸锂", "锰酸锂"] },
    ]),
    ...ladder("aluminum", "铝", [
      { rung: "mine", label: "铝土矿", patterns: ["铝土矿", "氧化铝"] },
      { rung: "smelting", label: "电解铝", patterns: ["电解铝", "原铝", "铝锭"] },
      { rung: "processing", label: "铝加工材", patterns: ["铝型材", "铝板带箔", "铝箔", "铝材", "铝合金材料", "精密铝合金"], confidence: 0.8 },
    ]),
    ...ladder("rare_earth", "稀土", [
      { rung: "mine", label: "稀土矿", patterns: ["稀土矿", "稀土开采", "稀土原矿"] },
      { rung: "separation", label: "冶炼分离", patterns: ["稀土冶炼", "稀土分离", "稀土氧化物", "稀土产品"] },
      { rung: "magnet", label: "永磁材料", patterns: ["钕铁硼", "永磁材料", "磁材", "永磁铁氧体", "稀土永磁"], confidence: 0.9 },
    ]),
    ...ladder("nickel", "镍", [
      { rung: "mine", label: "镍矿", patterns: ["镍矿", "红土镍矿", "镍精矿"] },
      { rung: "smelting", label: "镍冶炼", patterns: ["镍冶炼", "电解镍", "硫酸镍", "高冰镍"] },
    ]),
    ...ladder("cobalt", "钴", [
      { rung: "mine", label: "钴矿", patterns: ["钴矿", "钴精矿", "铜钴矿"] },
      { rung: "smelting", label: "钴冶炼", patterns: ["钴冶炼", "氯化钴", "硫酸钴", "四氧化三钴", "钴酸锂"] },
    ]),
    ...ladder("tin", "锡", [
      { rung: "mine", label: "锡矿", patterns: ["锡矿", "锡精矿"] },
      { rung: "smelting", label: "锡冶炼", patterns: ["锡冶炼", "锡锭", "焊锡"] },
    ]),
    ...ladder("silicon", "工业硅", [
      { rung: "smelting", label: "工业硅/金属硅", patterns: ["工业硅", "金属硅", "多晶硅", "有机硅"] },
    ]),
  ],
};

/**
 * 商品负向:有矿山/冶炼证据、无任何加工词的铜公司,才允许声明「非铜加工」。
 * 冶炼企业常兼加工,guardTextPatterns 兜底(文本出现加工词即抑制负向)。
 */
export const commodityNegatives: import("./common").NegativeRule[] = [
  {
    concept: "copper:processing",
    label: "非铜加工",
    hasAny: ["copper:mine", "copper:smelting"],
    hasNoneOf: ["copper:processing", "copper:foil", "copper:clad", "copper:heatsink"],
    guardTextPatterns: ["铜管", "铜棒", "铜杆", "铜线", "铜板带", "铜排", "铜材", "铜合金", "铜加工", "铜箔", "覆铜板"],
    because: "只有铜矿/冶炼证据,无任何铜加工材词",
    rule: "cmd.copper.neg_processing.v2",
  },
];
