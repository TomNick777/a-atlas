import type { Dimension, NegativeRule, MatchRule } from "./common";

/**
 * P0-4 热管理。kp1 三维拆分(Residual Remediation Phase 2,规格§十五;
 * 报告 KNOWLEDGE_PASS_THERMAL.md):
 *
 *   thermalSegment      = 应用域(服务器/数据中心/消费电子/汽车/储能/工业/轨交),
 *                         只认 SOURCE 里的场景词 —— 「产品词直推应用域」全部停用:
 *                         导热材料/均热板/热管 不再等于 服务器散热(triage Case B:
 *                         中石科技「细分:服务器散热」系产品词命中,SOURCE 无服务器
 *                         字样;§九 禁止硬训练)。
 *   thermalProduct      = 产品能力(导热界面材料/石墨/热管/VC/散热器/风扇/冷板/
 *                         液冷系统/精密空调/热管理系统)。
 *   thermalCoolingMode  = 冷却方式(液冷/风冷/两相/均热扩散/导热)。
 *
 * 裸「液冷(系统|板)」不构成数据中心证据(车用/储能/动力电池也用液冷):
 * dc_liquid 直配 pattern 要求场景词同段;跨字段(主营说 算力/机房,产品行说
 * 液冷系统)按 cooc 共现 0.7 授 —— 川润(无任何场景词)保持 unknown。
 */

export const THERMAL_ENRICHMENT_VERSION = "thermal-source-kp1";

const DC_CONTEXT = "数据中心|机房|服务器|算力|智算|IT设备|机柜|CDU";

export const thermalProduct: Dimension = {
  id: "thermalProduct",
  label: "热管理产品",
  description: "热管理产品能力维度,证据=SOURCE 产品词面(不推断应用域)",
  rules: [
    { value: "thermal:tim", label: "导热界面材料", patterns: ["导热(界面)?材料", "热界面材料", "TIM", "导热硅脂", "导热垫片", "导热凝胶", "导热硅胶"], rule: "thermalp.tim.v2", confidence: 0.85 },
    { value: "thermal:graphite_sheet", label: "石墨散热材料", patterns: ["石墨散热", "石墨膜", "石墨片", "人工石墨", "石墨烯散热"], rule: "thermalp.graphite.v2", confidence: 0.85 },
    { value: "thermal:heat_pipe", label: "热管", patterns: ["热管(?!理|路)"], rule: "thermalp.heat_pipe.v2", confidence: 0.85 },
    { value: "thermal:vapor_chamber", label: "均热板(VC)", patterns: ["均热板", "VC均热", "VC（均热板）", "真空腔均热"], rule: "thermalp.vc.v2", confidence: 0.85 },
    { value: "thermal:heat_sink", label: "散热器/模组", patterns: ["散热模组", "散热器", "散热片"], rule: "thermalp.heat_sink.v2", confidence: 0.8 },
    { value: "thermal:fan", label: "风扇", patterns: ["电子风扇", "散热风扇", "轴流风扇", "离心风扇", "冷却风扇"], rule: "thermalp.fan.v2", confidence: 0.8 },
    { value: "thermal:cold_plate", label: "液冷板", patterns: ["液冷板", "电池冷却板", "冷板(?!式)"], rule: "thermalp.cold_plate.v2", confidence: 0.85 },
    { value: "thermal:liquid_cooling_system", label: "液冷系统", patterns: ["液冷系统", "液冷机组", "液冷散热", "浸没式液冷", "冷板式", "冷量分配单元", "液冷产品"], rule: "thermalp.lcs.v2", confidence: 0.85 },
    { value: "thermal:precision_ac", label: "精密空调", patterns: ["机房空调", "精密空调", "行级空调", "列间空调", "恒温恒湿"], rule: "thermalp.pac.v2", confidence: 0.85 },
    { value: "thermal:tms", label: "热管理系统", patterns: ["热管理系统", "温控系统", "温控设备", "温控节能", "热管理解决方案"], rule: "thermalp.tms.v2", confidence: 0.8 },
  ],
};

export const thermalCoolingMode: Dimension = {
  id: "thermalCoolingMode",
  label: "冷却方式",
  description: "冷却方式维度,由产品/工艺词面派生(VC=两相,石墨=均热扩散)",
  rules: [
    { value: "cooling:liquid", label: "液冷", patterns: ["液冷", "冷板式", "浸没式"], rule: "coolm.liquid.v2", confidence: 0.85 },
    { value: "cooling:air", label: "风冷", patterns: ["风冷", "散热器", "散热风扇", "空调"], rule: "coolm.air.v2", confidence: 0.75 },
    { value: "cooling:two_phase", label: "两相冷却", patterns: ["均热板", "热管(?!理|路)", "相变"], rule: "coolm.two_phase.v2", confidence: 0.8 },
    { value: "cooling:spreading", label: "均热扩散", patterns: ["石墨散热", "石墨膜", "石墨片"], rule: "coolm.spreading.v2", confidence: 0.8 },
    { value: "cooling:conduction", label: "导热", patterns: ["导热(界面|材料|硅脂|垫片|凝胶|膜)"], rule: "coolm.conduction.v2", confidence: 0.8 },
  ],
};

export const thermalSegment: Dimension = {
  id: "thermalSegment",
  label: "热管理细分",
  description: "热管理业务的应用域归属,只认 SOURCE 场景词,上下文约束优先于裸词",
  rules: [
    {
      value: "thermal:dc_liquid_cooling",
      label: "数据中心液冷",
      patterns: [
        `(?:${DC_CONTEXT}).{0,10}液冷`,
        "液冷(服务器|数据中心|机柜|机箱)",
      ],
      rule: "thermal.dc_liquid.v2",
      confidence: 0.9,
    },
    {
      value: "thermal:dc_liquid_cooling",
      label: "数据中心液冷",
      patterns: ["液冷(系统|板|机组|产品)"],
      cooc: [DC_CONTEXT],
      rule: "thermal.dc_liquid.cooc.v3",
      confidence: 0.7,
    },
    {
      value: "thermal:dc_thermal",
      label: "数据中心温控",
      patterns: ["机房温控", "机房空调", "精密温控", "数据中心(温控|散热|制冷|空调)", "恒温恒湿", "行级空调", "列间空调", "机柜温控"],
      rule: "thermal.dc_thermal.v2",
      confidence: 0.85,
    },
    {
      value: "thermal:server_cooling",
      label: "服务器散热",
      patterns: ["服务器散热", "服务器(液冷|散热|温控|热管理|冷却)", "(液冷|散热|温控)服务器"],
      rule: "thermal.server_cooling.v2",
    },
    {
      value: "thermal:consumer_thermal",
      label: "消费电子散热",
      patterns: ["消费电子(散热|热管理)", "(手机|可穿戴|智能穿戴|笔电|平板|TWS耳机)(散热|热管理)", "终端散热"],
      rule: "thermal.consumer.v3",
      confidence: 0.8,
    },
    {
      value: "thermal:vehicle_thermal",
      label: "汽车热管理",
      patterns: ["汽车热管理", "车用空调", "车载空调", "汽车空调", "热泵空调", "热管理模块", "电子水泵", "冷却水泵", "电子风扇", "Chiller", "电池冷却板", "暖风机"],
      rule: "thermal.vehicle.v2",
      confidence: 0.9,
    },
    {
      value: "thermal:ess_thermal",
      label: "储能温控",
      patterns: ["储能温控", "储能液冷", "储能(空调|散热|热管理)", "电池热管理", "PACK液冷", "电池包冷却"],
      rule: "thermal.ess.v2",
      confidence: 0.9,
    },
    {
      value: "thermal:industrial_cooling",
      label: "工业散热",
      patterns: ["电力电子散热", "功率器件散热", "变频器散热", "IGBT散热", "光伏逆变器散热", "水冷板", "油冷", "工业冷水机", "冷水机组"],
      rule: "thermal.industrial.v2",
    },
    {
      value: "thermal:rail_hvac",
      label: "轨交/客车空调",
      patterns: ["轨道交通.{0,6}空调", "列车空调", "地铁空调", "客车空调"],
      rule: "thermal.rail.v2",
      confidence: 0.85,
    },
  ],
};

/**
 * 负向概念:有明确数据中心侧证据、且文本里没有任何车用热管理词的公司,
 * 才允许声明「非汽车热管理主营」。guardTextPatterns 保证公司自己的文本
 * 提到车用空调时不被误标(包括收入占比很小的尾部长尾,如英维克的客车空调)。
 */
export const thermalNegatives: NegativeRule[] = [
  {
    concept: "thermal:vehicle_thermal",
    label: "非汽车热管理主营",
    hasAny: ["thermal:dc_liquid_cooling", "thermal:dc_thermal", "thermal:server_cooling"],
    hasNoneOf: ["thermal:vehicle_thermal"],
    guardTextPatterns: ["汽车热管理", "车用空调", "车载空调", "汽车空调", "热泵空调", "电子水泵", "冷却水泵", "Chiller"],
    because: "业务文本只有数据中心/服务器侧温控证据,无任何车用热管理词",
    rule: "thermal.neg_vehicle.v2",
  },
];

export type { MatchRule };
