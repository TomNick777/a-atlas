import { describe, expect, it } from "vitest";
import {
  deriveCompanyCaps,
  deriveFromEvidence,
  deriveWithTrace,
  mergeCapabilities,
  type SemiCapability,
  type SemiEvidence,
} from "../search/knowledge/semiconductor";

const ev = (evidenceText: string, overrides: Partial<SemiEvidence> = {}): SemiEvidence => ({
  evidenceId: "ev_test_0001",
  companyCode: "TEST01",
  sourceType: "annual_report",
  sourceTitle: "测试公司2025年年度报告",
  sourceDate: "2026-03-30",
  reportPeriod: "2025-12-31",
  locator: { page: 25, section: "第二节" },
  evidenceText,
  matchedKeywords: [],
  retrievedAt: "2026-09-24T00:00:00Z",
  authorityTier: 1,
  status: "CURRENT",
  asOfDate: "2025-12-31",
  ...overrides,
});

const one = (caps: ReturnType<typeof deriveFromEvidence>, pick: (c: SemiCapability) => boolean) =>
  caps.find(pick);

describe("stage3 derive rules — 词面只能证明到词面", () => {
  it("刻蚀设备销售 → etching + etcher 设备证据", () => {
    const caps = deriveFromEvidence(ev("2025年刻蚀设备销售约98.32亿元,同比增长约35.12%,主要用于集成电路制造"));
    const etch = one(caps, (c) => c.process === "etching" && c.equipmentType === "etcher");
    expect(etch).toBeDefined();
    expect(etch!.role).toBe("equipment_supplier");
    expect(etch!.manufacturingStage).toBe("front_end");
  });

  it("CCP/ICP 窗口 → specificProcess 且设备类型 etcher", () => {
    const caps = deriveFromEvidence(ev("公司开发的CCP高能等离子体和ICP低能等离子体刻蚀两大类细分刻蚀设备已覆盖大多数应用"));
    const ccp = one(caps, (c) => c.specificProcess === "CCP");
    const icp = one(caps, (c) => c.specificProcess === "ICP");
    expect(ccp?.equipmentType).toBe("etcher");
    expect(icp?.equipmentType).toBe("etcher");
  });

  it("证据只写「薄膜设备」→ 不得升级成 CVD/ALD", () => {
    const caps = deriveFromEvidence(ev("公司主营半导体薄膜设备的研发、生产和销售,产品广泛应用于晶圆制造"));
    const dep = one(caps, (c) => c.process === "deposition");
    expect(dep).toBeDefined();
    expect(dep!.specificProcess).toBeUndefined();
    expect(dep!.equipmentType).toBe("deposition_equipment");
    expect(caps.some((c) => c.specificProcess === "ALD")).toBe(false);
    expect(caps.some((c) => c.specificProcess === "CVD")).toBe(false);
  });

  it("PECVD + 设备语境 → PECVD specificProcess + PECVD_equipment", () => {
    const caps = deriveFromEvidence(ev("公司的PECVD设备已应用于国内多家晶圆厂的生产线"));
    const pecvd = one(caps, (c) => c.specificProcess === "PECVD");
    expect(pecvd?.equipmentType).toBe("PECVD_equipment");
    expect(pecvd?.role).toBe("equipment_supplier");
  });

  it("裸工艺词(刻蚀工艺)无设备名词 → 不自称设备商(v3:进改释台账,不进能力)", () => {
    const trace = deriveWithTrace(ev("公司在多种关键刻蚀工艺上实现大规模量产,覆盖先进逻辑与存储器件"));
    expect(trace.caps.some((c) => c.equipmentType)).toBe(false);
    expect(trace.caps.some((c) => c.role === "equipment_supplier")).toBe(false);
    const bare = trace.bareLedger.find((b) => b.process === "etching");
    expect(bare).toBeDefined();
  });

  it("merge:同工艺出现设备证据后,unknown 升级且冗余项被吸收", () => {
    const bare = deriveFromEvidence(ev("公司在刻蚀工艺实现大规模量产,产品覆盖逻辑与存储"));
    const equip = deriveFromEvidence(ev("公司刻蚀设备销售收入大幅增长,客户端为集成电路制造企业"));
    const merged = mergeCapabilities([...bare, ...equip]);
    const etchCaps = merged.filter((c) => c.process === "etching");
    for (const cap of etchCaps) expect(cap.role).toBe("equipment_supplier");
    const unknownEti = etchCaps.filter((c) => c.equipmentType === undefined);
    // 裸工艺项已被 equipment 版覆盖吸收
    expect(unknownEti).toHaveLength(0);
  });

  it("术语定义窗口(「X指…」)不产生能力", () => {
    const caps = deriveFromEvidence(ev("ETCH、刻蚀指用化学或物理方法有选择地在硅片表面去除不需要的材料的过程"));
    expect(caps).toHaveLength(0);
  });

  it("CMP 设备与 CMP 材料可区分", () => {
    const equip = deriveFromEvidence(ev("公司的CMP设备市场占有率持续提升,客户端为国内主要晶圆厂"));
    const mat = deriveFromEvidence(ev("公司CMP抛光液销售收入增长,产品应用于集成电路制造和存储芯片"));
    expect(one(equip, (c) => c.equipmentType === "CMP_equipment")).toBeDefined();
    expect(one(mat, (c) => c.materialType === "CMP_slurry")).toBeDefined();
    expect(mat.some((c) => c.equipmentType === "CMP_equipment")).toBe(false);
  });

  it("应用语境标注:LED/功率器件/先进逻辑", () => {
    const caps = deriveFromEvidence(ev("开发的用于LED和功率器件外延片生产的MOCVD设备已投入量产,并服务先进逻辑客户"));
    const mocvd = one(caps, (c) => c.specificProcess === "MOCVD");
    expect(mocvd?.equipmentType).toBe("MOCVD_equipment");
    expect(mocvd!.applications).toContain("led_display");
    expect(mocvd!.applications).toContain("power");
    expect(mocvd!.applications).toContain("logic");
  });

  it("HISTORICAL 证据不冒充 CURRENT(asOfDate 保留)", () => {
    const caps = deriveFromEvidence(ev("2020年公司刻蚀设备业务实现收入约2亿元", { status: "HISTORICAL", asOfDate: "2020-12-31" }));
    const etch = one(caps, (c) => c.process === "etching");
    expect(etch!.status).toBe("HISTORICAL");
    expect(etch!.asOfDate).toBe("2020-12-31");
  });
});

describe("s3-derive-v2 设备主体守卫 — 部件/材料厂不得因下游设备词冒充设备商", () => {
  it("设备解剖句(「…半导体设备由精密零部件结合构成」)不授设备", () => {
    const caps = deriveFromEvidence(ev("2、半导体精密零部件超大规模集成电路芯片PVD、CVD、刻蚀机等半导体设备由各种精密零部件结合构成，这些部件主要包括传输腔体、反应腔体"));
    expect(caps.some((c) => c.role === "equipment_supplier")).toBe(false);
    expect(caps.some((c) => c.equipmentType)).toBe(false);
  });

  it("应用域列举(「覆盖了包括PVD、CVD、刻蚀…等应用领域」)不授设备", () => {
    const caps = deriveFromEvidence(ev("公司半导体精密零部件销售收入稳定,覆盖了包括PVD、CVD、刻蚀、离子注入以及产业机器人等应用领域，产品主要出售给晶圆制造商作为设备使用耗材"));
    expect(caps.some((c) => c.equipmentType)).toBe(false);
    expect(caps.some((c) => c.componentType === "precision_component")).toBe(true);
  });

  it("「半导体设备零部件」→ precision_component,不是设备商(规格第二节)", () => {
    const caps = deriveFromEvidence(ev("半导体设备零部件是公司报告期内先进陶瓷产品的最主要应用,公司持续加大研发投入"));
    const comp = one(caps, (c) => c.componentType === "precision_component");
    expect(comp).toBeDefined();
    expect(comp!.role).toBe("component_supplier");
    expect(caps.some((c) => c.equipmentType)).toBe(false);
  });

  it("「生产半导体设备核心零部件」→ component_supplier(规格第四节)", () => {
    const caps = deriveFromEvidence(ev("公司生产半导体设备核心零部件,产品销量稳步增长"));
    const comp = one(caps, (c) => c.componentType === "precision_component");
    expect(comp?.role).toBe("component_supplier");
    expect(caps.some((c) => c.equipmentType)).toBe(false);
  });

  it("「泛半导体设备表面处理服务」不授设备(服务语境)", () => {
    const caps = deriveFromEvidence(ev("公司主营业务为先进陶瓷材料零部件的研发、制造、销售、服务以及泛半导体设备表面处理服务"));
    expect(caps.some((c) => c.equipmentType)).toBe(false);
    expect(caps.some((c) => c.componentType === "ceramic_component")).toBe(true);
  });

  it("「与光刻机配合进行作业」不授光刻设备(配对语境)", () => {
    const caps = deriveFromEvidence(ev("涂胶显影设备是集成电路制造过程中不可或缺的关键处理设备，主要与光刻机（芯片生产线上最庞大、最精密复杂、难度最大、价格最昂贵的设备）配合进行作业"));
    expect(caps.some((c) => c.equipmentType === "lithography_equipment")).toBe(false);
  });

  it("行业厂商叙事(「全球光刻机龙头厂商ASML…EUV光刻机首台交付」)不授设备", () => {
    const caps = deriveFromEvidence(ev("全球光刻机龙头厂商ASML推出的新一代EUV系统已实现更高分辨率，其第二代高数值孔径EUV光刻机TWINSCANEXE实现首台交付并开始客户验证"));
    expect(caps.some((c) => c.equipmentType === "lithography_equipment")).toBe(false);
  });

  it("高管简历窗口里的他人公司名(「中微半导体设备(上海)…董事」)不授设备", () => {
    const caps = deriveFromEvidence(ev("2025年2月至今投资四部总经理2023年5月2025年9月中微半导体设备（上海）股份有限公司董事2023年5月"));
    expect(caps.some((c) => c.equipmentType)).toBe(false);
  });

  it("「设备厂商认证/设备商合作」是交易对手语境,不授设备", () => {
    const caps = deriveFromEvidence(ev("公司研发的真空阀门已成功通过多家主流半导体设备厂商及晶圆厂的严苛验证,实现规模化量产销售"));
    expect(caps.some((c) => c.equipmentType)).toBe(false);
  });

  it("processExposure:「靶材应用于PVD工艺」→ 材料角色+工艺曝光,无设备类型(规格第五节)", () => {
    const caps = deriveFromEvidence(ev("公司主要生产超高纯溅射靶材,产品应用于PVD工艺以制备电子薄膜材料,销售收入稳定增长"));
    const target = one(caps, (c) => c.materialType === "target_material");
    expect(target).toBeDefined();
    expect(target!.role).toBe("material_supplier");
    expect(target!.process).toBe("deposition");
    expect(target!.specificProcess).toBe("PVD");
    expect(caps.some((c) => c.equipmentType === "PVD_equipment")).toBe(false);
  });
});

describe("s3-derive-v2 真设备商回归 — 规则收紧不得误杀(规格第十四节)", () => {
  it("「半导体专用设备的研发、生产和销售」+产品枚举 → 设备商", () => {
    const caps = deriveFromEvidence(ev("公司主要从事半导体专用设备的研发、生产和销售，产品主要包括光刻工序涂胶显影设备、单片式湿法设备"));
    const track = one(caps, (c) => c.equipmentType === "track_equipment");
    expect(track?.role).toBe("equipment_supplier");
    const clean = one(caps, (c) => c.equipmentType === "cleaning_equipment");
    expect(clean?.role).toBe("equipment_supplier");
  });

  it("「半导体装备业务实现收入」→ 设备商(收入锚)", () => {
    const caps = deriveFromEvidence(ev("半导体装备业务实现收入约为5.25亿元,机器人与智能装备业务稳步增长"));
    expect(caps.some((c) => c.equipmentType === "semiconductor_equipment" && c.role === "equipment_supplier")).toBe(true);
  });

  it("长产品枚举(「先后开发了…包括A、B、C、PECVD设备」)整链成立", () => {
    const caps = deriveFromEvidence(ev("公司经过多年持续的研发投入和技术积累，先后开发了前道半导体工艺设备，包括清洗设备、半导体电镀设备、立式炉管系列设备、涂胶显影Track设备、等离子体增强化学气相沉积PECVD设备、无应力抛光设备"));
    for (const t of ["cleaning_equipment", "furnace", "track_equipment", "PECVD_equipment"]) {
      expect(caps.some((c) => c.equipmentType === t)).toBe(true);
    }
  });

  it("公司级仲裁:主营是材料/部件厂 ⇒ 次级窗口设备角色整体降级(江丰场景)", () => {
    const primary = ev("公司主要专注于超高纯金属溅射靶材和半导体精密零部件的研发、生产和销售", { evidenceId: "ev_T_001", matchedKeywords: ["主营业务概述"] });
    const secondary = ev("公司产品覆盖了包括PVD、CVD、刻蚀、离子注入以及产业机器人等应用领域，出售给设备制造商用于设备生产", { evidenceId: "ev_T_002" });
    const { caps } = deriveCompanyCaps([primary, secondary]);
    expect(caps.some((c) => c.role === "equipment_supplier")).toBe(false);
    expect(caps.some((c) => c.materialType === "target_material")).toBe(true);
    expect(caps.some((c) => c.componentType === "precision_component")).toBe(true);
  });

  it("公司级仲裁:主营支持设备 ⇒ 次级窗口不降级(真设备商场景)", () => {
    const primary = ev("公司主要从事半导体专用设备的研发、生产和销售", { evidenceId: "ev_T_001", matchedKeywords: ["主营业务概述"] });
    const secondary = ev("公司在半导体设备领域深耕多年,产品覆盖多种高端工艺,实现批量销售", { evidenceId: "ev_T_002" });
    const { caps } = deriveCompanyCaps([primary, secondary]);
    expect(caps.some((c) => c.equipmentType === "semiconductor_equipment" && c.role === "equipment_supplier")).toBe(true);
  });
});

describe("s3-derive-v3 Attribution 闸门 — Presence is not Capability(Stage 3.2)", () => {
  it("§7 客户购买叙事:「晶圆厂…购买…如光刻设备、刻蚀设备…」不授任何设备(中科飞测 p20 场景)", () => {
    const caps = deriveFromEvidence(ev("晶圆厂的主要投资会用于购买生产各类半导体产品所需的关键设备，如光刻设备、刻蚀设备、薄膜沉积设备、质量控制设备、清洗设备、化学研磨CMP设备、离子注入设备等，这些半导体设备应用在半导体制造的核心工艺中。公司专注于质量控制领域"));
    for (const t of ["lithography_equipment", "etcher", "deposition_equipment", "cleaning_equipment", "CMP_equipment", "ion_implanter"]) {
      expect(caps.some((c) => c.equipmentType === t)).toBe(false);
    }
  });

  it("§9 资本壁垒叙事:「光刻机、刻蚀机等昂贵设备的巨额前期投入」不授设备(强一场景)", () => {
    const caps = deriveFromEvidence(ev("探针卡行业属于资本密集型行业。例如，MEMS工艺制造探针过程中需要用到光刻机、刻蚀机、电镀设备、研磨机、激光设备等先进且昂贵的设备，前期投入大、投资风险高。公司深耕探针卡"));
    expect(caps.some((c) => c.equipmentType === "lithography_equipment")).toBe(false);
    expect(caps.some((c) => c.equipmentType === "etcher")).toBe(false);
  });

  it("§10 量测参数:「量测设备…对…刻蚀深度…等参数的量测」工艺词是受测对象,量测能力带 processExposure", () => {
    const trace = deriveWithTrace(ev("公司量测设备销售收入增长，主要功能系对被观测的晶圆电路上的结构尺寸做出量化描述，如薄膜厚度、关键尺寸、刻蚀深度、表面形貌、套刻精度等物理性参数的量测"));
    expect(trace.caps.some((c) => c.equipmentType === "etcher")).toBe(false);
    const metro = trace.caps.find((c) => c.equipmentType === "metrology_equipment");
    expect(metro).toBeDefined();
    expect(metro!.processExposure).toContain("etching");
  });

  it("§12 镀膜自用:「公司利用自主研发的PECVD设备…获得DLC纳米涂层」是制造方法,不是半导体设备(菲沃泰场景)", () => {
    const text = "公司利用自主研发的容性耦合等离子体、感性耦合等离子体等不同放电形式的PECVD设备，通过调整材料配方、镀膜工艺获得了不同性能的DLC纳米涂层。该涂层应用于消费电子柔性显示";
    const caps = deriveFromEvidence(ev(text));
    expect(caps.some((c) => c.equipmentType === "PECVD_equipment")).toBe(false);
    expect(caps.some((c) => c.equipmentType)).toBe(false);
    // §32 改释台账:被拦下的设备词以 MANUFACTURING_METHOD 归属留痕
    const { ledger } = deriveCompanyCaps([ev(text)]);
    expect(ledger.some((l) => l.equipmentType === "PECVD_equipment" && l.attribution === "MANUFACTURING_METHOD")).toBe(true);
  });

  it("研发实验平台:「本项目旨在研发多功能镀膜刻蚀实验平台」不授设备(RND_ONLY)", () => {
    const caps = deriveFromEvidence(ev("本项目旨在研发多功能镀膜刻蚀实验平台。透彻了解射频CCP和ICP放电特性，为沉积刻蚀装备设计和工艺验证提供依据。公司保持研发投入"));
    expect(caps.some((c) => c.equipmentType === "etcher")).toBe(false);
  });

  it("§8 高管履历:「曾任职于中微半导体设备…」整窗不产生任何能力(PERSONNEL_HISTORY)", () => {
    const trace = deriveWithTrace(ev("历任该公司刻蚀设备产品线总经理，曾任职于中微半导体设备（上海）股份有限公司，负责CCP刻蚀设备研发"));
    expect(trace.caps).toHaveLength(0);
    expect(trace.windowAttribution).toBe("PERSONNEL_HISTORY");
  });

  it("§16 低置信章节:财务报告章节的窗口默认不产生能力(LOW_CONFIDENCE_SECTION)", () => {
    const trace = deriveWithTrace(ev("公司刻蚀设备业务相关存货余额增长", { locator: { page: 120, section: "第八节 财务报告" } }));
    expect(trace.caps).toHaveLength(0);
    expect(trace.windowAttribution).toBe("LOW_CONFIDENCE_SECTION");
  });

  it("§21 探针卡是测试部件不是探针台:探针卡→probe_card(component),探针台→prober(equipment)", () => {
    const card = deriveFromEvidence(ev("公司探针卡产品收入稳步增长,客户端为国内主要晶圆厂"));
    const cardCap = card.find((c) => c.componentType === "probe_card");
    expect(cardCap).toBeDefined();
    expect(cardCap!.role).toBe("component_supplier");
    expect(card.some((c) => c.equipmentType === "prober")).toBe(false);
    const station = deriveFromEvidence(ev("公司自动探针台设备已实现量产销售"));
    expect(station.some((c) => c.equipmentType === "prober")).toBe(true);
  });

  it("§14 Evidence Reuse Guard:一条证据支撑 ≥3 类设备且无自主枚举句式 ⇒ 降级留痕", () => {
    const bad = ev("刻蚀设备、清洗设备、CMP设备已在客户端量产应用，公司保持投入", { evidenceId: "ev_R_001", matchedKeywords: ["主营业务概述"] });
    const { caps, reuseChecks } = deriveCompanyCaps([bad]);
    expect(caps.some((c) => c.role === "equipment_supplier")).toBe(false);
    expect(reuseChecks.length).toBeGreaterThan(0);
    expect(reuseChecks.some((r) => !r.legitSelfEnum)).toBe(true);
  });

  it("§14 合法例外:自主产品枚举(「◎开发的…LPCVD、ALD、EPI设备」)多设备共存放行(中微场景)", () => {
    const good = ev("◎开发的CCP和ICP刻蚀两大类细分刻蚀设备已覆盖大多数应用。◎最近十年着重开发多种导体和半导体化学薄膜设备，如LPCVD、ALD、EPI设备等，并取得了可喜的进步。◎开发的MOCVD设备早已投入量产", { evidenceId: "ev_R_002", matchedKeywords: ["主营业务概述"] });
    const { caps, reuseChecks } = deriveCompanyCaps([good]);
    expect(caps.some((c) => c.equipmentType === "etcher")).toBe(true);
    expect(caps.some((c) => c.equipmentType === "ALD_equipment")).toBe(true);
    expect(reuseChecks.filter((r) => !r.legitSelfEnum)).toHaveLength(0);
  });

  it("直接能力归属标注:DIRECT 证据的设备能力带 attribution=DIRECT_COMPANY_CAPABILITY", () => {
    const caps = deriveFromEvidence(ev("公司的CMP设备市场占有率持续提升,客户端为国内主要晶圆厂"));
    const cmp = caps.find((c) => c.equipmentType === "CMP_equipment");
    expect(cmp!.attribution).toBe("DIRECT_COMPANY_CAPABILITY");
    expect(cmp!.evidenceQuality).toBe("DIRECT");
  });
});
describe("mp1.1 (s3-derive-v5) 材料闸门通用化 — silicon_wafer/photomask 同源污染收敛", () => {
  const materialTypes = (caps: ReturnType<typeof deriveFromEvidence>) => caps.map((c) => c.materialType).filter(Boolean);
  const ledgerTags = (trace: ReturnType<typeof deriveWithTrace>) =>
    trace.bareLedger.map((l) => (l.ruleId.match(/s3\.guard\.material-([a-z-]+)\.v5/) ?? [])[1]).filter(Boolean);

  it("M1b 出口管制清单枚举(两用物项清单里的硅片/掩模版)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("公司主营情况说明。零配件（靶材、光刻胶、掩模版、封装载板、抛光垫、抛光液、8英寸及以上硅单晶、8英寸及以上硅片）生产企业等《中华人民共和国两用物项出口管制清单》商务部等部门2024年发布"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
    expect(materialTypes(trace.caps)).not.toContain("photomask");
    expect(ledgerTags(trace)).toContain("policy");
  });

  it("M1b 政府工程(人民政府支持提高碳化硅衬底、大尺寸硅片产能)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("山东省人民政府实施新型电子材料“融链”工程。支持济南、淄博、德州等市提高碳化硅衬底、大尺寸硅片等产能，做大封装材料企业规模"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
    expect(materialTypes(trace.caps)).not.toContain("sic_substrate");
    expect(ledgerTags(trace)).toContain("policy");
  });

  it("M2b 市场份额叙述(仅次于硅片的第二大细分材料市场)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("公司2024年经营情况说明。电子特种气体是半导体晶圆制造材料中仅次于硅片的第二大细分材料市场，总体来看，目前主要由欧美和日本企业主导"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(trace)).toContain("market");
  });

  it("M2b 市场占比/供需叙述(占比为32.84%/趋于饱和)不产生材料能力", () => {
    const t1 = deriveWithTrace(ev("以2024年为例，硅片市场在晶圆制造材料市场中占比为32.84%，位列第1位，光刻材料、掩模板、电子特气分别位列其后，公司持续跟踪行业变化"));
    expect(materialTypes(t1.caps)).not.toContain("silicon_wafer");
    const t2 = deriveWithTrace(ev("公司经营环境说明。上游行业单晶硅的价格对半导体分立器件制造行业的生产成本有直接影响。目前单晶硅片市场趋于饱和，供需基本平衡"));
    expect(materialTypes(t2.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(t2)).toContain("market");
  });

  it("M2b 出货量叙述(全球硅片出货量/SEMI 统计)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("图：2020年-2025年全球硅片出货量和半导体应用领域营收（单位：美元）数据来源：国际半导体产业协会（SEMI），行业产品出货量持续增长"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
  });

  it("M-Def 定义句(硅片是芯片制造的地基/基础材料)不产生材料能力", () => {
    const t1 = deriveWithTrace(ev("硅片是芯片制造的“地基”，其性能和供应能力直接影响半导体产业链的竞争力，行业产品收入规模持续增长"));
    expect(materialTypes(t1.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(t1)).toContain("definition");
    const t2 = deriveWithTrace(ev("硅片是生产太阳能晶硅电池的基础材料，多晶硅料通过铸锭、拉棒技术被加工成硅棒，产品收入稳定"));
    expect(materialTypes(t2.caps)).not.toContain("silicon_wafer");
  });

  it("M-Def 定义行(前驱体:半导体制造中用于…的关键原料)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("前驱体：半导体制造中用于化学气相沉积等工艺的关键原料，可沉积形成薄膜材料，对芯片性能至关重要，公司产品收入稳定"));
    expect(materialTypes(trace.caps)).not.toContain("precursor");
  });

  it("M5c 采购帧(采购以衬底片等重要原材料为主,供应商主要为生产企业)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("公司采购情况说明。LED业务采购以贵金属、衬底片等重要原材料为主，化学品、大宗气体、MO源及硅片等一般原材料为辅，其供应商主要为生产衬底片、MO源、贵金属的企业"));
    expect(materialTypes(trace.caps)).not.toContain("precursor");
    expect(ledgerTags(trace)).toContain("procurement");
  });

  it("M5b 加工对象(可对硅片基底实现平坦化加工)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("CMP抛光垫是化学机械抛光（CMP）工艺的核心耗材，主要应用于半导体晶圆制造环节，可对硅片基底以及氧化硅、金属等薄膜材料表面实现纳米级的全局平坦化加工"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(trace)).toContain("object");
  });

  it("M5b 加工对象(用于切割光伏硅片/直接与硅片或晶圆接触)不产生材料能力", () => {
    const t1 = deriveWithTrace(ev("公司继续收缩传统光伏用金刚线业务规模，降低用于切割光伏硅片的细线占比，聚焦生产研发切割磁性材料所用的粗线"));
    expect(materialTypes(t1.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(t1)).toContain("object");
    const t2 = deriveWithTrace(ev("石英制品在使用过程中直接与硅片或晶圆接触，其性能好坏对下游产品的良品率高低将造成直接影响"));
    expect(materialTypes(t2.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(t2)).toContain("object");
  });

  it("M5b 服务对象(满足光学级碳化硅衬底对热场材料的要求)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("半导体领域，公司通过持续优化纯化工艺技术，相关产品可满足光学级碳化硅衬底对热场材料的高纯度要求"));
    expect(materialTypes(trace.caps)).not.toContain("sic_substrate");
    expect(ledgerTags(trace)).toContain("object");
  });

  it("M-Rnd 建设期(正在建设的项目包含40万片大硅片抛光垫等产能)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("公司正在建设的光电半导体材料研发制造中心项目，包含40万片大硅片抛光垫等产能，项目投产后，将进一步增强公司在相关领域的综合竞争力"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
    expect(materialTypes(trace.caps)).not.toContain("CMP_pad");
    expect(ledgerTags(trace)).toContain("rnd");
  });

  it("M6b 设备复合词头(大硅片设备产品/硅片加工设备/硅片分选机)不产生材料能力", () => {
    const t1 = deriveWithTrace(ev("◎股份有限公司图二大硅片设备产品在芯片制造和封装端，公司开发了应用于芯片制造的8-12英寸减压外延设备、ALD设备"));
    expect(materialTypes(t1.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(t1)).toContain("equip-compound");
    const t2 = deriveWithTrace(ev("硅棒/硅锭制造设备（如单晶炉、铸锭炉等）、硅片加工设备（如切片机、清洗机、插片机等）、电池片生产设备等"));
    expect(materialTypes(t2.caps)).not.toContain("silicon_wafer");
    const t3 = deriveWithTrace(ev("公司主要产品是低氧单晶炉、大尺寸超高速硅片分选机、丝网印刷线、激光辅助烧结设备"));
    expect(materialTypes(t3.caps)).not.toContain("silicon_wafer");
  });

  it("M6b 设备复合词头(碳化硅单晶炉)不产生 sic_substrate 能力", () => {
    const trace = deriveWithTrace(ev("晶体生长设备的研发、生产和销售。。半导体级单晶硅炉、碳化硅单晶炉。8英寸半导体级单晶硅炉、12英寸半导体级单晶硅炉"));
    expect(materialTypes(trace.caps)).not.toContain("sic_substrate");
    expect(trace.caps.some((c) => c.equipmentType === "growth_furnace")).toBe(true);
  });

  it("M6b 整线方案(硅片+电池+组件超级工厂整线解决方案)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("高效BC太阳能电池智能生产线、硅片+电池+组件超级工厂整线解决方案、光伏车间智能制造平台（MES）等整厂工艺及设备解决方案"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(trace)).toContain("equip-compound");
  });

  it("M6c 覆盖域枚举(覆盖硅片、电池和组件环节/覆盖大硅片等多个制造领域)不产生材料能力", () => {
    const t1 = deriveWithTrace(ev("在光伏装备领域，公司产品覆盖了硅片、电池和组件环节，为客户提供光伏整线解决方案"));
    expect(materialTypes(t1.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(t1)).toContain("chain-coverage");
    const t2 = deriveWithTrace(ev("公司积极开展清洗装备研发，已形成覆盖大硅片、化合物半导体等多个制造领域的系列清洗装备布局"));
    expect(materialTypes(t2.caps)).not.toContain("silicon_wafer");
  });

  it("M6d 链条定位语(是硅片和晶圆制造环节使用的关键材料)不产生材料能力", () => {
    const trace = deriveWithTrace(ev("石英制品是硅片和晶圆制造环节使用的关键材料，公司产品收入稳定"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(trace)).toContain("chain-locative");
  });

  it("M-Refer 光罩盒是载具,不产生 photomask 能力", () => {
    const trace = deriveWithTrace(ev("光罩盒是半导体制造关键载具，对精度和可靠性要求极高。本项目围绕定位及保护结构进行优化设计，提升产品对光罩的保护能力与精度控制水平"));
    expect(materialTypes(trace.caps)).not.toContain("photomask");
    expect(ledgerTags(trace)).toContain("container");
  });

  it("M-Refer 掩膜版衬底是上游 blank,不产生 photomask 能力", () => {
    const trace = deriveWithTrace(ev("光刻用掩膜版衬底生产工艺开发完成并逐步送样，产品收入稳定"));
    expect(materialTypes(trace.caps)).not.toContain("photomask");
    expect(ledgerTags(trace)).toContain("blank");
  });

  it("M-Refer LED/蓝宝石衬底片不是硅片,不产生 silicon_wafer 能力", () => {
    const trace = deriveWithTrace(ev("公司主营业务主要为研发、生产和销售LED衬底片、外延片及芯片，蓝宝石衬底片保持国内市场领先供应商地位"));
    expect(materialTypes(trace.caps)).not.toContain("silicon_wafer");
    expect(ledgerTags(trace)).toContain("non-silicon");
    // 外延片本体证据成立:epi_wafer 保留
    expect(materialTypes(trace.caps)).toContain("epi_wafer");
  });

  it("M-Usage 用途必需帧(LED外延片的生产制造均需要半导体掩膜版)不产生 epi_wafer 能力", () => {
    const trace = deriveWithTrace(ev("第三代半导体、光电器件、LED外延片等产品的生产制造均需要半导体掩膜版，下游产品需求旺盛"));
    expect(materialTypes(trace.caps)).not.toContain("epi_wafer");
    expect(ledgerTags(trace)).toContain("usage");
  });

  it("保护:真硅片商自述(研发生产销售+主要产品包括抛光片)保留 silicon_wafer", () => {
    const trace = deriveWithTrace(ev("公司主要从事半导体硅材料的研发、生产和销售，主要产品包括半导体硅抛光片、刻蚀设备用硅材料、刻蚀设备用零部件、半导体区熔硅单晶及硅片等。产品主要用于集成电路、分立器件、功率器件"));
    expect(materialTypes(trace.caps)).toContain("silicon_wafer");
    const caps = deriveFromEvidence(ev("主营构成(按产品):光伏硅片 收入比例35%"));
    expect(materialTypes(caps)).toContain("silicon_wafer");
    const caps2 = deriveFromEvidence(ev("半导体硅片及其他材料的研发、生产和销售。。300mm半导体硅片、200mm及以下尺寸半导体硅片、受托加工服务"));
    expect(materialTypes(caps2)).toContain("silicon_wafer");
  });

  it("保护:真掩膜版商自述(公司生产的掩膜版产品/研发设计生产销售)保留 photomask", () => {
    const caps = deriveFromEvidence(ev("公司生产的掩膜版产品根据基板材质的不同主要可分为石英掩膜版、苏打掩膜版。产品主要应用于平板显示、半导体芯片"));
    expect(materialTypes(caps)).toContain("photomask");
    const caps2 = deriveFromEvidence(ev("公司主要从事掩膜版的研发、设计、生产和销售业务，是国内成立最早、规模最大的掩膜版生产企业之一。公司的主要产品为掩膜版"));
    expect(materialTypes(caps2)).toContain("photomask");
  });

  it("保护:材料板块自述(主营产品分为三大板块,材料板块含硅片)保留 silicon_wafer", () => {
    const trace = deriveWithTrace(ev("公司集研发、生产、销售于一体，专业致力于功率半导体硅片、芯片及器件设计、制造、封装测试等中高端领域的产业发展。公司主营产品主要分为三大板块，具体包括材料板块（单晶硅棒、硅片、外延片）、晶圆板块及封装器件板块"));
    expect(materialTypes(trace.caps)).toContain("silicon_wafer");
  });

  it("保护:光刻胶混合句(部分产品产业化、部分研发中)不被 M-Rnd 拦截", () => {
    const trace = deriveWithTrace(ev("研发生产销售微电子业用超纯电子材料如电子级双氧水、电子级氨水、电子级硝酸等。光刻胶部分产品产业化、部分研发中"));
    expect(materialTypes(trace.caps)).toContain("photoresist");
  });

  it("保护:PCB 光刻胶主营自述保留 photoresist", () => {
    const trace = deriveWithTrace(ev("公司的主营业务为PCB光刻胶、显示用光刻胶、半导体光刻胶及配套化学品等电子感光化学品的研发、生产和销售，主要产品包括感光系列产品"));
    expect(materialTypes(trace.caps)).toContain("photoresist");
  });

  it("保护:主题短语「在PCB光刻胶领域,公司…」不被 M6c 误杀(广信材料案)", () => {
    const trace = deriveWithTrace(ev("密度印制电路板等电子产品的生产要求。在PCB光刻胶领域，公司目前已在原有PCB阻焊油墨主力优势产品基础上进一步加大最新型浸涂型液体感光蚀刻油墨的开发"));
    expect(materialTypes(trace.caps)).toContain("photoresist");
  });

  it("保护:自产产品枚举「…半导体蚀刻引线框架材料」不被 M5b/M6c 误杀(温州宏丰案)", () => {
    const trace = deriveWithTrace(ev("公司研发、生产和销售的产品包括电接触材料、金属基功能复合材料、硬质合金材料、高性能极薄锂电铜箔及半导体蚀刻引线框架材料，产品广泛应用于工业控制、数据中心"));
    expect(materialTypes(trace.caps)).toContain("lead_frame");
  });

  it("拦截:应用对象「应用于引线框架封装的QFN后贴膜」不产生 lead_frame(赛伍案)", () => {
    const trace = deriveWithTrace(ev("CMP固定胶带等主流产品已在多家大型半导体封装厂实现稳定量产与交付。在新产品方面：应用于引线框架封装的QFN后贴膜已成功进入国际一线供应链"));
    expect(materialTypes(trace.caps)).not.toContain("lead_frame");
    expect(ledgerTags(trace)).toContain("object");
  });

  it("保护:公司产品覆盖硅片(自我产品枚举,非链条覆盖)不被 M6c 误杀", () => {
    const trace = deriveWithTrace(ev("公司主要从事单晶硅片的研发、生产和销售，产品涵盖抛光片、外延片，客户为多家晶圆厂"));
    expect(materialTypes(trace.caps)).toContain("silicon_wafer");
  });
});
