import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stage 3.2 Attribution Benchmark(规格第二十三/二十四节)—— 数据级 ground truth。
 *
 * 冻结规则:
 *   - 行 = (company, capabilityClaim),claim 取自 Stage 3.1(v2)记录的真实挂载;
 *   - label 由人工按 SOURCE 证据核定(证据文本在 derive diff / audit 报告可回放),
 *     六类:TRUE_CAPABILITY / TRUE_EXPOSURE / TRUE_COMPONENT / TRUE_MATERIAL /
 *          FALSE_ATTRIBUTION / AMBIGUOUS;
 *   - 抽样覆盖:已知过提取(中科飞测/强一/菲沃泰)、真设备商(中微/北方华创/
 *     拓荆/盛美/微导/至纯/华峰/晶盛/捷佳)、材料商(江丰/雅克/安集/晶瑞/飞凯)、
 *     零部件商(珂玛/先锋精科)、检测企业、制程用户(三安/聚灿 —— 用设备造芯片,
 *     不是设备商);
 *   - 派生器只按通用规则运行,benchmark 不进入任何规则 —— 它是考卷不是教材。
 *
 * 评分(§24,CapabilityPrecision 第一主指标):
 *   CapabilityPrecision   = TRUE_CAPABILITY 且派生为设备能力 / 派生为设备能力的行
 *   CapabilityRecall      = TRUE_CAPABILITY 且派生保留 / 全部 TRUE_CAPABILITY 行
 *   FalseAttributionRate  = FALSE_ATTRIBUTION 且派生为设备能力 / 派生为设备能力的行
 *   ExposureVsCapabilityConfusion = (TRUE_EXPOSURE|TRUE_COMPONENT|TRUE_MATERIAL)
 *                                   被派生成 equipmentType 的行数
 * 对 v2(snapshot)与 v3(live)各评一次。
 *
 * Usage: npx tsx scripts/stage3_2_attribution_benchmark.ts
 *   → data/eval/stage3_2_attribution_benchmark.json
 */

const root = process.cwd();
const V2 = path.join(root, "data", "eval", "snapshot_stage3_1", "enrichment", "enrichment.json");
const V3 = path.join(root, "data", "enrichment", "semiconductor", "enrichment.json");
const OUT = path.join(root, "data", "eval", "stage3_2_attribution_benchmark.json");

/** 人工核定的 ground truth 表:key = `${code}|${claim}`(claim 为 process/specific/
 *  equipment/material/component 连写,与 enrichment 记录展示一致)。
 *  rationale 记录 SOURCE 依据(证据句式),可回放。 */
const GROUND_TRUTH: Record<string, { label: string; rationale: string }> = {
  // —— 已知过提取:中科飞测(良率检测/量测设备商) ——
  "688361|metrology_inspection/metrology_equipment": { label: "TRUE_CAPABILITY", rationale: "「暗场纳米图形晶圆缺陷检测设备等新系列产品…收入贡献增长」—— 自有产品+p10/p15/p16" },
  "688361|etching/etcher": { label: "FALSE_ATTRIBUTION", rationale: "p20「晶圆厂…购买…如…刻蚀设备…」客户购买叙事;「刻蚀深度」量测参数" },
  "688361|deposition/deposition_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上 p20 行业叙述 + 「薄膜厚度」受测参数" },
  "688361|cleaning/cleaning_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上 p20 行业叙述" },
  "688361|cmp/CMP_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上 p20 行业叙述" },
  "688361|ion_implantation/ion_implanter": { label: "FALSE_ATTRIBUTION", rationale: "p20 行业叙述 + 「这些半导体设备应用在…」枚举回指" },
  "688361|lithography/lithography_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上;「套刻精度」是量测参数" },
  // —— 强一股份(探针卡) ——
  "688809|wafer_probing/prober": { label: "FALSE_ATTRIBUTION", rationale: "探针卡是装在探针台上的测试接口部件,不是探针台整机(v2 词法错位)" },
  "688809|etching/etcher": { label: "FALSE_ATTRIBUTION", rationale: "p18「光刻机、刻蚀机等昂贵设备的巨额前期投入」行业壁垒 + MEMS 制造工艺" },
  "688809|lithography/lithography_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上 p18 行业壁垒叙事" },
  "688809|wafer_probing/probe_card": { label: "TRUE_COMPONENT", rationale: "「探针卡产品…收入…客户」—— 探针卡=测试接口部件(正确归类)" },
  "688809|ceramic_component": { label: "TRUE_COMPONENT", rationale: "公司陶瓷部件产品证据" },
  // —— 菲沃泰(纳米镀膜:CVD/PVD 类工艺做涂层) ——
  "688371|deposition/PECVD/PECVD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "「公司利用自主研发的…PECVD设备…获得DLC纳米涂层」= 自用制造方法(§12 B)" },
  "688371|deposition/CVD/CVD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上" },
  "688371|deposition/ALD/ALD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "「用ALD结合PECVD技术,研发出的设备适用于制备水汽阻隔薄膜」镀膜机,非晶圆设备" },
  "688371|deposition/PVD/PVD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "「PVD设备FTPX1400B 超硬DLC涂层…汽车零件」纳米镀膜机(消费电子域)" },
  "688371|etching/CCP/etcher": { label: "FALSE_ATTRIBUTION", rationale: "「本项目旨在研发多功能镀膜刻蚀实验平台」研发平台" },
  // —— 真设备商(保护组) ——
  "688012|etching/etcher": { label: "TRUE_CAPABILITY", rationale: "「◎开发的CCP和ICP…二十几种细分刻蚀设备」p29 自主产品枚举" },
  "688012|deposition/deposition_equipment": { label: "TRUE_CAPABILITY", rationale: "「公司主要为…制造企业提供刻蚀设备、薄膜沉积设备」p29" },
  "688012|deposition/LPCVD/LPCVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「新开发的LPCVD薄膜设备…累计出货量已突破300个反应台」p32" },
  "688012|deposition/ALD/ALD_equipment": { label: "TRUE_CAPABILITY", rationale: "同上 p32 自主枚举" },
  "688012|deposition/CVD/CVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「着重开发多种导体和半导体化学薄膜设备」p29" },
  "688012|deposition/MOCVD/MOCVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「开发的用于LED和功率器件外延片生产的MOCVD设备早已投入量产」p29" },
  "688012|epitaxy/epitaxy_equipment": { label: "TRUE_CAPABILITY", rationale: "「EPI设备」自主枚举 p29" },
  "688012|metrology_inspection/metrology_equipment": { label: "TRUE_CAPABILITY", rationale: "「已全面布局光学和电子束量检测设备」p29" },
  "002371|etching/etcher": { label: "TRUE_CAPABILITY", rationale: "北方华创刻蚀设备为在售主营产品(年报产品枚举)" },
  "002371|deposition/CVD/CVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「低压化学气相沉积设备」产品清单" },
  "002371|deposition/PVD/PVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「磁控溅射镀膜设备」产品清单" },
  "002371|cleaning/cleaning_equipment": { label: "TRUE_CAPABILITY", rationale: "清洗设备为北方华创在售产品" },
  "002371|ion_implantation/ion_implanter": { label: "TRUE_CAPABILITY", rationale: "离子注入机为在售产品" },
  "002371|thermal_processing/furnace": { label: "TRUE_CAPABILITY", rationale: "「扩散氧化退火设备/立式炉」产品清单" },
  "002371|crystal_growth/growth_furnace": { label: "TRUE_CAPABILITY", rationale: "「晶体生长设备」产品清单(精密元器件业务)" },
  "688072|deposition/PECVD/PECVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「PECVD系列产品」主营构成 registry 行+产品矩阵" },
  "688072|deposition/SACVD/SACVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「SACVD系列产品」主营构成" },
  "688072|deposition/ALD/ALD_equipment": { label: "TRUE_CAPABILITY", rationale: "「ALD系列产品」主营构成" },
  "688072|deposition/CVD/CVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「HDPCVD系列产品/FlowableCVD系列产品」主营构成" },
  "688072|deposition/deposition_equipment": { label: "TRUE_CAPABILITY", rationale: "「薄膜沉积设备、三维集成设备的产品矩阵」" },
  "688072|metrology_inspection/metrology_equipment": { label: "TRUE_CAPABILITY", rationale: "「键合套准精度量测产品…重要的键合精度量测设备」" },
  "688072|testing/test_equipment": { label: "AMBIGUOUS", rationale: "证据窗口未直接见测试机产品句式,证据不足两可" },
  "688082|cleaning/cleaning_equipment": { label: "TRUE_CAPABILITY", rationale: "「先后开发了前道半导体工艺设备,包括清洗设备…」+SAPS/TEBO 兆声波清洗" },
  "688082|etching/etcher": { label: "TRUE_CAPABILITY", rationale: "「边缘湿法刻蚀设备该设备支持多种器件和工艺」产品目录回指" },
  "688082|photoresist_track/track_equipment": { label: "TRUE_CAPABILITY", rationale: "「涂胶显影Track设备」自主枚举" },
  "688082|thermal_processing/furnace": { label: "TRUE_CAPABILITY", rationale: "「立式炉管系列设备」自主枚举" },
  "688082|deposition/PECVD/PECVD_equipment": { label: "TRUE_CAPABILITY", rationale: "「等离子体增强化学气相沉积PECVD设备」自主枚举" },
  "688082|packaging_assembly/packaging_equipment": { label: "TRUE_CAPABILITY", rationale: "先进封装电镀(ECP)设备为在售产品" },
  "688147|deposition/ALD/ALD_equipment": { label: "TRUE_CAPABILITY", rationale: "微导纳米为 ALD 设备商(主营)" },
  "688147|deposition/PECVD/PECVD_equipment": { label: "TRUE_CAPABILITY", rationale: "PECVD 设备在售" },
  "603690|cleaning/cleaning_equipment": { label: "TRUE_CAPABILITY", rationale: "至纯科技湿法清洗设备为在售主营" },
  "688200|testing/test_equipment": { label: "TRUE_CAPABILITY", rationale: "华峰测控为 ATE 测试机厂商" },
  "688200|testing/handler": { label: "FALSE_ATTRIBUTION", rationale: "华峰不产分选机(分选机为搭档设备语境)" },
  "300316|crystal_growth/growth_furnace": { label: "TRUE_CAPABILITY", rationale: "晶盛机电长晶炉为核心在售产品" },
  "300316|thinning/grinding_equipment": { label: "TRUE_CAPABILITY", rationale: "减薄/研磨设备在售" },
  "300316|silicon_wafer": { label: "TRUE_MATERIAL", rationale: "晶盛硅片业务(8英寸片)" },
  "300316|sic_substrate": { label: "TRUE_MATERIAL", rationale: "晶盛碳化硅衬底业务" },
  "300724|cleaning/cleaning_equipment": { label: "TRUE_CAPABILITY", rationale: "捷佳伟创清洗设备为光伏电池设备主营" },
  "300724|deposition/PVD/PVD_equipment": { label: "TRUE_CAPABILITY", rationale: "镀膜设备在售(PVD 类)" },
  "300724|crystal_growth/growth_furnace": { label: "FALSE_ATTRIBUTION", rationale: "「硅棒/硅锭制造设备(如单晶炉…)」是光伏产业链分类枚举,非公司产品" },
  // —— 材料商 ——
  "300666|target_material": { label: "TRUE_MATERIAL", rationale: "江丰电子超高纯溅射靶材主营" },
  "300666|precision_component": { label: "TRUE_COMPONENT", rationale: "江丰半导体精密零部件业务" },
  "002409|photoresist": { label: "TRUE_MATERIAL", rationale: "雅克科技光刻胶业务(LG 化学收购)" },
  "002409|precursor": { label: "TRUE_MATERIAL", rationale: "雅克前驱体(UP Chemical)业务" },
  "002409|electronic_special_gas": { label: "TRUE_MATERIAL", rationale: "雅克电子特气业务" },
  "688019|CMP_slurry": { label: "TRUE_MATERIAL", rationale: "安集科技抛光液主营" },
  "688019|wet_chemicals": { label: "TRUE_MATERIAL", rationale: "安集功能性湿电子化学品" },
  "300655|photoresist": { label: "TRUE_MATERIAL", rationale: "晶瑞电材光刻胶主营" },
  "300655|lithography/lithography_equipment": { label: "FALSE_ATTRIBUTION", rationale: "材料商的光刻设备词来自行业/应用语境,非设备产品" },
  "300398|metrology_inspection/metrology_equipment": { label: "FALSE_ATTRIBUTION", rationale: "飞凯材料为材料商,量测设备词非公司产品" },
  // —— 零部件商 ——
  "301611|ceramic_component": { label: "TRUE_COMPONENT", rationale: "珂玛科技先进陶瓷材料零部件主营" },
  "688605|precision_component": { label: "TRUE_COMPONENT", rationale: "先锋精科半导体设备精密零部件(刻蚀/沉积腔体件)主营" },
  "688605|deposition/ALD/ALD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "「用于ALD/CVD设备的…零部件」—— 零部件应用语境,非整机(v2 过提取)" },
  "688605|deposition/CVD/CVD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上" },
  // —— 制程用户(晶圆/芯片厂,用设备不卖设备) ——
  "600703|epitaxy/epitaxy_equipment": { label: "FALSE_ATTRIBUTION", rationale: "三安光电为化合物半导体芯片厂,MOCVD/EPI 是其生产资料" },
  "600703|deposition/MOCVD/MOCVD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上" },
  "600703|deposition/CVD/CVD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上" },
  "600703|semiconductor_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上" },
  "300708|deposition/MOCVD/MOCVD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "聚灿光电为 LED 芯片厂,MOCVD 是生产资料" },
  "300708|deposition/CVD/CVD_equipment": { label: "FALSE_ATTRIBUTION", rationale: "同上" },
  // —— 检测企业(对照) ——
  "688361|metrology_inspection.processExposure=etching": { label: "TRUE_EXPOSURE", rationale: "「对…刻蚀…等工艺中的关键尺寸进行…测量」—— 刻蚀是受测工艺,检测能力 × 工艺曝光(§10)" },
};

type BenchRow = {
  company: string;
  code: string;
  claim: string;
  label: string;
  rationale: string;
  v2: { asEquipment: boolean; asMaterialComponent: boolean; asExposure: boolean };
  v3: { asEquipment: boolean; asMaterialComponent: boolean; asExposure: boolean };
};

function claimFromCap(cap: { process?: string; specificProcess?: string; equipmentType?: string; materialType?: string; componentType?: string }): string {
  return [cap.process, cap.specificProcess, cap.equipmentType, cap.materialType, cap.componentType].filter(Boolean).join("/");
}

function equipmentClaims(records: any[], code: string): Set<string> {
  const rec = records.find((r) => r.code === code);
  if (!rec) return new Set();
  const set = new Set<string>();
  for (const cap of rec.processCapabilities) {
    if (cap.equipmentType && cap.role === "equipment_supplier") {
      set.add(claimFromCap(cap));
      // 设备能力的无细分行(如 etching/etcher 覆盖 etching/CCP/etcher)
      if (cap.specificProcess) set.add([cap.process, undefined, cap.equipmentType].filter(Boolean).join("/"));
    }
  }
  return set;
}

function materialComponentClaims(records: any[], code: string): Set<string> {
  const rec = records.find((r) => r.code === code);
  if (!rec) return new Set();
  const set = new Set<string>();
  for (const cap of rec.processCapabilities) {
    if (cap.materialType) set.add(cap.materialType);
    if (cap.componentType) set.add(cap.componentType);
  }
  return set;
}

function exposureClaims(records: any[], code: string): Set<string> {
  const rec = records.find((r) => r.code === code);
  if (!rec) return new Set();
  const set = new Set<string>();
  for (const cap of rec.processCapabilities) {
    for (const p of cap.processExposure ?? []) set.add(`${cap.process}.processExposure=${p}`);
  }
  return set;
}

function main() {
  const v2 = JSON.parse(readFileSync(V2, "utf8")).records;
  const v3 = JSON.parse(readFileSync(V3, "utf8")).records;
  const rows: BenchRow[] = [];
  for (const [key, gt] of Object.entries(GROUND_TRUTH)) {
    const [code, claim] = key.split("|");
    const name = v3.find((r: any) => r.code === code)?.name ?? code;
    const exposureKey = claim.startsWith("metrology_inspection.processExposure=") ? claim : null;
    const row: BenchRow = {
      company: name,
      code,
      claim,
      label: gt.label,
      rationale: gt.rationale,
      v2: {
        asEquipment: exposureKey ? false : equipmentClaims(v2, code).has(claim),
        asMaterialComponent: exposureKey ? false : materialComponentClaims(v2, code).has(claim),
        asExposure: exposureKey ? exposureClaims(v2, code).has(claim) : false,
      },
      v3: {
        asEquipment: exposureKey ? false : equipmentClaims(v3, code).has(claim),
        asMaterialComponent: exposureKey ? false : materialComponentClaims(v3, code).has(claim),
        asExposure: exposureKey ? exposureClaims(v3, code).has(claim) : false,
      },
    };
    rows.push(row);
  }

  // —— 评分(§24) ——
  function grade(records: "v2" | "v3") {
    const eq = rows.filter((r) => r.label !== "AMBIGUOUS" && !r.claim.includes("processExposure"));
    const claimed = eq.filter((r) => r[records].asEquipment || (r[records].asMaterialComponent && (r.label === "TRUE_MATERIAL" || r.label === "TRUE_COMPONENT")));
    const asEquipmentRows = eq.filter((r) => r[records].asEquipment);
    const trueCap = asEquipmentRows.filter((r) => r.label === "TRUE_CAPABILITY");
    const falseRows = asEquipmentRows.filter((r) => r.label !== "TRUE_CAPABILITY");
    const allTrueCap = eq.filter((r) => r.label === "TRUE_CAPABILITY");
    const trueCapRecalled = allTrueCap.filter((r) => r[records].asEquipment);
    const confusion = eq.filter((r) => (r.label === "TRUE_EXPOSURE" || r.label === "TRUE_COMPONENT" || r.label === "TRUE_MATERIAL") && r[records].asEquipment);
    const trueCapEquipClaims = asEquipmentRows.length;
    return {
      capabilityPrecision: trueCapEquipClaims ? trueCap.length / trueCapEquipClaims : null,
      capabilityRecall: allTrueCap.length ? trueCapRecalled.length / allTrueCap.length : null,
      falseAttributionRate: trueCapEquipClaims ? falseRows.length / trueCapEquipClaims : null,
      exposureVsCapabilityConfusion: confusion.length,
      equipmentClaimRows: trueCapEquipClaims,
      trueCapRows: allTrueCap.length,
      trueCapRecalled: trueCapRecalled.length,
    };
  }

  // 保护组 recall(§25:中微/北方华创/拓荆/盛美)
  const GUARD = ["688012", "002371", "688072", "688082"];
  function guardRecall(records: "v2" | "v3") {
    const rowsGuard = rows.filter((r) => GUARD.includes(r.code) && r.label === "TRUE_CAPABILITY");
    const recalled = rowsGuard.filter((r) => r[records].asEquipment);
    return { total: rowsGuard.length, recalled: recalled.length, ratio: rowsGuard.length ? recalled.length / rowsGuard.length : null };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    frozen: "stage3_2_attribution_benchmark",
    rule: "行=capability claim,label=人工按 SOURCE 核定;派生器零白名单,benchmark 不进规则",
    labelCounts: rows.reduce<Record<string, number>>((a, r) => ((a[r.label] = (a[r.label] ?? 0) + 1), a), {}),
    metrics: { "s3-derive-v2": grade("v2"), "s3-derive-v3": grade("v3") },
    guardRecall: { "s3-derive-v2": guardRecall("v2"), "s3-derive-v3": guardRecall("v3") },
    rows,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(out.metrics, null, 1));
  console.log("guardRecall:", JSON.stringify(out.guardRecall));
  console.log("labels:", JSON.stringify(out.labelCounts));
  // 残留 FALSE 明细
  for (const r of rows) {
    if (r.label === "FALSE_ATTRIBUTION" && r.v3.asEquipment) console.log(`  v3 STILL FALSE: ${r.company} ${r.claim}`);
    if (r.label === "TRUE_CAPABILITY" && !r.v3.asEquipment && r.v2.asEquipment) console.log(`  v3 LOST TRUE: ${r.company} ${r.claim}`);
  }
}

main();
