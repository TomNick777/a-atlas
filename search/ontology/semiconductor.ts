import type { Dimension } from "./common";

/**
 * P0-3 半导体细分(Stage 3 工艺级扩展,v2.2)。
 *
 * 维度定位:词面派生标签(数据源=主营/产品文本)。工艺级、设备级、材料级的
 * **结构化知识**在 enrichment 层(data/enrichment/semiconductor/*,证据回指
 * 年报/官方来源);本维度只保证主流工艺词在词面上可命中。
 *
 * 设备 ≠ 材料:装备词(刻蚀设备/…设备)与材料词(抛光液/抛光垫)拆成不同 value,
 * 由 cmp/cmp_material、cleaning 等规则体现;映射粒度(specificProcess 等)
 * 由 enrichment 的 derive 规则给证据分级,这里不做。
 * 裸词谨慎(「清洗」「抛光」「退火」太泛),一律带上下文。
 */
export const semiconductorSegment: Dimension = {
  id: "semiconductorSegment",
  label: "半导体细分",
  description: "半导体产业链工艺段/材料段,词面命中带上下文约束",
  rules: [
    {
      value: "semi:etch",
      label: "刻蚀",
      patterns: ["刻蚀", "蚀刻"],
      rule: "semi.etch.v2",
      confidence: 0.85,
    },
    {
      value: "semi:deposition",
      label: "薄膜沉积",
      patterns: ["薄膜沉积", "薄膜设备", "镀膜设备", "化学气相沉积", "物理气相沉积"],
      rule: "semi.deposition.v2",
    },
    {
      value: "semi:epitaxy",
      label: "外延",
      patterns: ["外延", "MOCVD"],
      rule: "semi.epitaxy.v3",
    },
    {
      value: "semi:cvd",
      label: "CVD",
      patterns: ["CVD", "PECVD", "LPCVD", "SACVD", "ALCVD"],
      rule: "semi.cvd.v2",
      confidence: 0.9,
    },
    {
      value: "semi:pvd",
      label: "PVD",
      patterns: ["PVD", "磁控溅射", "溅射设备"],
      rule: "semi.pvd.v2",
      confidence: 0.9,
    },
    {
      value: "semi:ald",
      label: "ALD",
      patterns: ["ALD", "原子层沉积", "原子层镀膜"],
      rule: "semi.ald.v2",
      confidence: 0.9,
    },
    {
      value: "semi:cleaning",
      label: "清洗",
      patterns: ["清洗设备", "单片清洗", "槽式清洗", "湿法设备", "湿法工艺", "半导体清洗", "湿法清洗"],
      rule: "semi.cleaning.v2",
      confidence: 0.85,
    },
    {
      value: "semi:cmp",
      label: "CMP/抛光",
      patterns: ["CMP", "化学机械抛光", "化学机械平坦", "硅抛光", "抛光机"],
      rule: "semi.cmp.v2",
    },
    {
      value: "semi:cmp_material",
      label: "抛光液/抛光垫",
      patterns: ["抛光液", "抛光垫", "Slurry", "抛光材料"],
      rule: "semi.cmp_material.v3",
    },
    {
      value: "semi:track",
      label: "涂胶显影",
      patterns: ["涂胶显影", "Track设备", "Track机"],
      rule: "semi.track.v2",
      confidence: 0.9,
    },
    {
      value: "semi:ion_implant",
      label: "离子注入",
      patterns: ["离子注入", "注入机"],
      rule: "semi.ion_implant.v2",
      confidence: 0.85,
    },
    {
      value: "semi:lithography",
      label: "光刻",
      patterns: ["光刻机", "光刻设备", "光刻工艺", "直写光刻", "纳米压印"],
      rule: "semi.lithography.v2",
      confidence: 0.85,
    },
    {
      value: "semi:thermal_process",
      label: "热处理/炉管",
      patterns: ["立式炉", "炉管", "氧化炉", "扩散炉", "快速热处理", "RTP", "晶圆退火", "晶体生长炉", "长晶炉", "单晶炉"],
      rule: "semi.thermal_process.v3",
    },
    {
      value: "semi:metrology",
      label: "量测/检测",
      patterns: ["量测", "缺陷检测", "缺陷检查", "晶圆检测", "膜厚测量", "关键尺寸量测"],
      rule: "semi.metrology.v3",
    },
    {
      value: "semi:dicing_grinding",
      label: "减薄/划片",
      patterns: ["减薄", "划片", "晶圆切割"],
      rule: "semi.dicing_grinding.v3",
    },
    {
      value: "semi:test",
      label: "测试",
      patterns: ["测试机", "分选机", "探针台", "测试系统", "ATE", "老化测试", "测试座"],
      rule: "semi.test.v2",
    },
    {
      value: "semi:packaging",
      label: "封装/封测",
      patterns: ["封装设备", "封测", "先进封装", "Chiplet", "引线框架", "封装基板", "载板", "晶圆级封装", "扇出封装", "凸块", "固晶机", "键合机"],
      rule: "semi.packaging.v2",
    },
    {
      value: "semi:components",
      label: "零部件/模块",
      patterns: ["半导体零部件", "精密零部件", "硅零部件", "硅电极", "硅环", "真空腔体", "气体管路", "模组部件"],
      rule: "semi.components.v3",
    },
    {
      value: "semi:wafer_fab",
      label: "晶圆制造",
      patterns: ["晶圆代工", "晶圆制造", "集成电路制造", "芯片制造", "晶圆厂"],
      rule: "semi.wafer_fab.v2",
      confidence: 0.85,
    },
    {
      value: "semi:silicon_wafer",
      label: "硅片",
      patterns: ["硅片", "抛光片", "外延片", "衬底片", "SOI"],
      rule: "semi.silicon_wafer.v2",
    },
    {
      value: "semi:compound",
      label: "化合物半导体",
      patterns: ["化合物半导体", "碳化硅", "氮化镓", "砷化镓"],
      rule: "semi.compound.v3",
    },
    {
      value: "semi:photomask",
      label: "掩膜版",
      patterns: ["掩膜版", "掩模版", "光罩", "掩膜板"],
      rule: "semi.photomask.v2",
      confidence: 0.9,
    },
    {
      value: "semi:target",
      label: "靶材",
      patterns: ["靶材", "溅射靶材"],
      rule: "semi.target.v2",
      confidence: 0.9,
    },
    {
      value: "semi:photoresist",
      label: "光刻胶",
      patterns: ["光刻胶", "感光材料", "PCB光刻胶", "面板光刻胶"],
      rule: "semi.photoresist.v2",
      confidence: 0.9,
    },
    {
      value: "semi:specialty_gas",
      label: "电子特气",
      patterns: ["电子特气", "特种气体", "高纯气体"],
      rule: "semi.specialty_gas.v2",
    },
    {
      value: "semi:wet_chemical",
      label: "湿电子化学品",
      patterns: ["湿电子化学品", "超纯试剂", "电子级双氧水", "电子级硫酸", "蚀刻液", "电子级氢氟酸"],
      rule: "semi.wet_chemical.v2",
    },
    {
      value: "semi:precursor",
      label: "前驱体/MO源",
      patterns: ["前驱体", "MO源", "三甲基镓", "三乙基镓"],
      rule: "semi.precursor.v3",
    },
    {
      value: "semi:quartz",
      label: "石英件",
      patterns: ["石英件", "石英舟", "石英环", "石英扩散管", "石英坩埚", "石英玻璃"],
      rule: "semi.quartz.v3",
    },
    {
      value: "semi:ceramic",
      label: "陶瓷件",
      patterns: ["陶瓷外壳", "陶瓷基板", "电子陶瓷", "陶瓷封装"],
      rule: "semi.ceramic.v3",
    },
    {
      value: "semi:bonding_wire",
      label: "键合线",
      patterns: ["键合线", "键合丝", "键合铜线", "铜丝球焊"],
      rule: "semi.bonding_wire.v3",
    },
  ],
};
