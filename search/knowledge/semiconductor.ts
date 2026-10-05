/**
 * Stage 3 semiconductor knowledge layer — evidence → capability derivation.
 *
 * 铁律(规格第八/十/十一/二十七/二十八节):
 *   - 每个 capability 必须回指 evidence(evidenceId);evidence 必须回指权威来源
 *     (Tier1 年报 PDF 带 SHA+页码,或 Tier3 filing-derived 字段带报告期)。
 *   - 词面只能证明到词面:证据写「薄膜设备」就只能得 deposition,不得升级成
 *     CVD/ALD;证据写「薄膜沉积设备」才能同时得 equipmentType。
 *   - 「X指…」定义窗口、纯光伏语境、历史报告期都不冒充当前主营:
 *     status/asOfDate/applications 如实标注,搜索默认消费 CURRENT。
 *
 * s3-derive-v2(Stage 3.1):设备角色要求「谁生产什么」可判。
 *   - 词组级守卫:「半导体设备零部件」「刻蚀机等半导体设备由…零部件构成」
 *     「目前已进入刻蚀…等多种设备」「与光刻机配合」「设备厂商认证」等语境,
 *     设备词不是公司产品的主体 —— 不授 equipmentType(部件语境转记零部件)。
 *   - 供给侧主体锚定:设备词附近必须有公司自己的生产/经营动词或领属结构。
 *   - 主营窗口主体一致性仲裁:主营段只支持材料/零部件时,次级窗口设备角色降级。
 *
 * s3-derive-v3(Stage 3.2):**Presence is not Capability。**
 *   「文档里提到某个工艺」≠「公司拥有该工艺能力」。每条设备能力必须过五闸
 *   (规格第六~十四节):
 *     1. Subject Attribution   —— 主语必须是公司自身,不能是行业/客户/晶圆厂/
 *                                 设备厂商/他人公司/高管履历里的前雇主;
 *     2. Action/Ownership      —— 谓词必须是供给侧动词(研制/生产/销售/提供),
 *                                 购买(购买/采购/引进)与使用(需要用到/利用)
 *                                 是反供给侧谓词,指向客户语境/制造方法;
 *     3. Object Binding        —— 工艺词的宾语决定语义:受测参数(刻蚀深度)=
 *                                 APPLICATION_ONLY;自产涂层(PECVD镀膜)=
 *                                 MANUFACTURING_METHOD;行业枚举=INDUSTRY_CONTEXT;
 *     4. Context Type          —— 章节置信层:财务报告(low)默认不产生能力,
 *                                 履历窗(personnel)永不产生能力;
 *     5. Evidence Locality     —— evidenceQuality(DIRECT/STRONG/WEAK/CONTEXT_ONLY),
 *                                 只有 DIRECT/STRONG 可以产生 equipmentType。
 *   另加 Evidence Reuse Guard(§14):一条证据支持 ≥3 类设备触发复查,仅
 *   「公司自主产品枚举」句式(自主供给动词直接统领枚举链)放行。
 *   所有被移除/改释的能力都留在 attributionLedger(§32:不删证据,只改解释)。
 */

/**
 * kp1 (s3-derive-v4, Residual Remediation Phase 2 — 材料层 Presence is not
 * Capacity):Stage 3.2 五闸门只治理了设备层,材料层 attribution 未同等治理
 * (triage Case A2:捷捷微电凭行业叙述持 photoresist)。材料词在派生时补三道
 * 闸门(全部通用语言规则,零公司专名):
 *   M1 行业分类枚举 ——「晶圆制造材料包括硅片、光掩模、光刻胶、…」枚举谓词的
 *      主语以 材料/行业/市场/领域/产业链/环节 收尾 = 行业分类,不产生材料能力
 *      (安集的 photoresist 与 silicon_wafer 同证据同错);
 *   M2 行业产能叙述 ——「国内硅片、光刻胶等关键材料的产能与技术水平不断提升」
 *      国内/行业/市场 + 产能/技术水平/需求 同句 = 行业叙述(捷捷微电案);
 *   M3 光刻胶复合词头 —— 光刻胶配套试剂/光刻胶用化学品 = photoresist_auxiliary,
 *      光刻胶光引发剂/树脂/专用电子化学品 = photoresist_raw_material;
 *      词面命中的是配套/上游产品,不是光刻胶本体(江化微/格林达/强力案)。
 *   同时 typed materialType 落地(规格§四):photoresist / photoresist_auxiliary /
 *   photoresist_raw_material 分别建 cap,不塌缩为 semiconductor_material;
 *   PCB 光刻胶(广信材料)保持 photoresist 并带 application=pcb —— 光刻胶本体
 *   证据成立,半导体级与 PCB 级的区分在 applications 维度如实记录。
 *
 * mp1.1 (s3-derive-v5, V4.2 pre-promotion — 材料闸门通用化):kp1 的 M 闸门只在
 *   光刻胶方向验证过,silicon_wafer/photomask 轴残留同源污染(V4.2 BACKLOG #1:
 *   42 家非硅片公司凭行业政策枚举句拿到 silicon_wafer,设备商拿到 photomask)。
 *   本版把材料层 Presence is not Capacity 推广为 materialType 通用闸门,并补齐
 *   审计确认的泄漏类:政策/管制清单枚举(M1b)、市场份额/供需叙述(M2b)、采购
 *   与上游帧(M5c)、加工/接触对象(M5b)、设备复合词头(M6b,晶盛/捷佳/晶升案)、
 *   复合词指涉改写(M-Refer,光罩盒/掩膜版衬底/LED衬底片案)、建设期/研发期
 *   (M-Rnd)、定义句(M-Def)。全部通用语言规则,零公司专名;证据不删除
 *   (SOURCE preserved,Attribution changed),旧解释进 attributionLedger(§32)。
 */

export const SEMICONDUCTOR_ENRICHMENT_VERSION = "residual-knowledge-pass-v1.1";
export const SEMICONDUCTOR_DERIVE_VERSION = "s3-derive-v5";
export const PHOTORESIST_CLEANUP_VERSION = "photoresist-cleanup-v1";
/** mp1.1:材料归属闸门版本(独立于光刻胶专项 cleanup,便于按轴审计与回滚)。 */
export const MATERIAL_ATTRIBUTION_VERSION = "material-attribution-v1.1";

export type SemiSourceType = "annual_report" | "filing_summary_zyjs" | "filing_product_split_zygc";

export type SemiEvidence = {
  evidenceId: string;
  companyCode: string;
  sourceType: SemiSourceType;
  sourceTitle: string;
  /** 披露日(年报)或 raw 快照抓取日(filing summary)。 */
  sourceDate: string;
  reportPeriod?: string;
  sourceUrl?: string;
  documentSha256?: string;
  locator: { page?: number; section?: string; field?: string; period?: string };
  evidenceText: string;
  matchedKeywords: string[];
  retrievedAt: string;
  authorityTier: 1 | 3;
  status: "CURRENT" | "HISTORICAL";
  asOfDate: string;
};

export type SemiRole = "equipment_supplier" | "material_supplier" | "component_supplier" | "unknown";

/** 归属判定(Stage 3.2 规格§4/§30 词汇表):这段证据到底在描述什么。 */
export type SemiAttribution =
  | "DIRECT_COMPANY_CAPABILITY" // 公司自有产品/能力 —— 唯一可授 equipmentType/material/component
  | "PROCESS_EXPOSURE"          // 公司能力接触该工艺(检测对象/配套对象),非自有工艺设备
  | "APPLICATION_ONLY"          // 工艺词是本公司检测/量测的受测对象或参数
  | "MANUFACTURING_METHOD"      // 工艺/设备是自产产品的制造手段(自用镀膜机/探针制造工艺)
  | "INDUSTRY_CONTEXT"          // 行业叙述(市场规模/分类/壁垒)
  | "CUSTOMER_CONTEXT"          // 客户/晶圆厂行为(购买/引进) —— 设备是被购买对象
  | "SUPPLY_CHAIN_CONTEXT"      // 供应链/配套关系描述
  | "OTHER_COMPANY_CONTEXT"     // 他人公司的业务
  | "PERSONNEL_HISTORY"         // 高管履历(曾任职公司)
  | "RND_ONLY"                  // 研发阶段/实验平台/样机/募投 —— 还不是在售产品
  | "AMBIGUOUS";

/** 证据局部性(§13):只有 DIRECT/STRONG 可以产生 processCapability/equipmentType。 */
export type EvidenceQuality = "DIRECT" | "STRONG" | "WEAK" | "CONTEXT_ONLY";

/** 低置信章节(§16):窗口级归属,不是公司归属。 */
export type WindowAttribution = SemiAttribution | "LOW_CONFIDENCE_SECTION";

export type SemiCapability = {
  process?: string;
  specificProcess?: string;
  equipmentType?: string;
  materialType?: string;
  componentType?: string;
  role: SemiRole;
  manufacturingStage: string;
  applications: string[];
  confidence: number;
  evidenceIds: string[];
  ruleId: string;
  status: "CURRENT" | "HISTORICAL";
  asOfDate: string;
  /** s3-derive-v3:归属与证据质量(检索只消费 DIRECT_COMPANY_CAPABILITY)。 */
  attribution?: SemiAttribution;
  evidenceQuality?: EvidenceQuality;
  /** 该能力接触但不拥有的工艺(检测对象/配套工艺);由受测语境派生。 */
  processExposure?: string[];
};

/** 归属台账(§32):被移除/改释的能力解释留痕,证据永不删除。 */
export type AttributionLedgerEntry = {
  subject: "equipment" | "process" | "capability";
  process?: string;
  specificProcess?: string;
  equipmentType?: string;
  materialType?: string;
  componentType?: string;
  attribution: WindowAttribution;
  evidenceIds: string[];
  ruleId: string;
};

export type SemiDomainKnowledge = {
  manufacturingStages: string[];
  processCapabilities: SemiCapability[];
  equipmentTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  materialTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  componentTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  applications: string[];
  /** 词面提示存在、但权威来源未能证实的能力(规格第二十七节)。 */
  sourceGap: { capability: string; expectedFrom: string }[];
  /** s3-derive-v3:错误归属的改释台账(audit trail,§32)。 */
  attributionLedger?: AttributionLedgerEntry[];
  /** s3-derive-v3:Reuse Guard 复查记录(§14,health check 输入)。 */
  reuseChecks?: { evidenceId: string; equipmentTypes: string[]; legitSelfEnum: boolean; downgraded: boolean }[];
};

/** 能力派生规则:窗口文本 → 结构化能力。词面到什么程度,派生就到什么程度。 */
type DeriveRule = {
  id: string;
  pattern: RegExp;
  /** 触发即证明的工艺/细分 */
  process?: string;
  specificProcess?: string;
  equipmentType?: string;
  materialType?: string;
  componentType?: string;
  stage: string;
  confidence: number;
  /** 词面本身不足以断言设备/材料时,要求窗口另含的名词证据。 */
  requiresType?: boolean;
  /** 窗口含设备名词时补授的 equipmentType(如 PECVD 触发词+设备语境 ⇒ PECVD_equipment)。 */
  equipmentIfContext?: string;
};

const FRONT = "front_end";
const BACK = "back_end";
const WAFER = "wafer_manufacturing";
const PACK = "packaging";
const TEST = "testing";

export const DERIVE_RULES: DeriveRule[] = [
  // —— 前道设备 ——
  { id: "etch.equipment", pattern: /刻蚀设备|蚀刻设备|刻蚀机|等离子体刻蚀|反应离子刻蚀/, process: "etching", equipmentType: "etcher", stage: FRONT, confidence: 0.95 },
  { id: "etch.ccp", pattern: /CCP/, process: "etching", specificProcess: "CCP", stage: FRONT, confidence: 0.9, requiresType: true, equipmentIfContext: "etcher" },
  { id: "etch.icp", pattern: /ICP/, process: "etching", specificProcess: "ICP", stage: FRONT, confidence: 0.85, requiresType: true, equipmentIfContext: "etcher" },
  { id: "etch.process", pattern: /刻蚀|蚀刻/, process: "etching", stage: FRONT, confidence: 0.7 },
  { id: "dep.equipment", pattern: /薄膜沉积设备|薄膜设备|薄膜装备|薄膜反应/, process: "deposition", equipmentType: "deposition_equipment", stage: FRONT, confidence: 0.9 },
  { id: "dep.cvd.pecvd", pattern: /PECVD/, process: "deposition", specificProcess: "PECVD", stage: FRONT, confidence: 0.9, equipmentIfContext: "PECVD_equipment" },
  { id: "dep.cvd.lpcvd", pattern: /LPCVD/, process: "deposition", specificProcess: "LPCVD", stage: FRONT, confidence: 0.9, equipmentIfContext: "LPCVD_equipment" },
  { id: "dep.cvd.sacvd", pattern: /SACVD/, process: "deposition", specificProcess: "SACVD", stage: FRONT, confidence: 0.9, equipmentIfContext: "SACVD_equipment" },
  { id: "dep.mocvd", pattern: /MOCVD/, process: "deposition", specificProcess: "MOCVD", stage: FRONT, confidence: 0.9, equipmentIfContext: "MOCVD_equipment" },
  { id: "dep.ald", pattern: /ALD|原子层沉积/, process: "deposition", specificProcess: "ALD", stage: FRONT, confidence: 0.9, equipmentIfContext: "ALD_equipment" },
  { id: "dep.cvd", pattern: /CVD|化学气相沉积/, process: "deposition", specificProcess: "CVD", stage: FRONT, confidence: 0.85, equipmentIfContext: "CVD_equipment" },
  { id: "dep.pvd", pattern: /PVD|物理气相沉积|溅射镀膜|溅射设备|磁控溅射/, process: "deposition", specificProcess: "PVD", stage: FRONT, confidence: 0.85, equipmentIfContext: "PVD_equipment" },
  { id: "epi.equipment", pattern: /外延设备|外延炉|EPI设备/, process: "epitaxy", equipmentType: "epitaxy_equipment", stage: FRONT, confidence: 0.9 },
  { id: "epi.process", pattern: /外延/, process: "epitaxy", stage: FRONT, confidence: 0.7 },
  { id: "clean.equipment", pattern: /清洗设备|单片清洗|槽式清洗|湿法设备|湿法清洗|清洗机/, process: "cleaning", equipmentType: "cleaning_equipment", stage: FRONT, confidence: 0.95 },
  { id: "clean.batch", pattern: /槽式清洗/, process: "cleaning", specificProcess: "batch_cleaning", stage: FRONT, confidence: 0.85 },
  { id: "clean.single", pattern: /单片清洗/, process: "cleaning", specificProcess: "single_wafer_cleaning", stage: FRONT, confidence: 0.85 },
  { id: "clean.process", pattern: /湿法工艺|湿法蚀刻|半导体清洗/, process: "cleaning", stage: FRONT, confidence: 0.7 },
  { id: "cmp.equipment", pattern: /CMP设备|CMP装备|化学机械抛光设备|抛光机|减薄抛光一体/, process: "cmp", equipmentType: "CMP_equipment", stage: FRONT, confidence: 0.95 },
  { id: "cmp.process", pattern: /CMP|化学机械抛光|化学机械平坦/, process: "cmp", stage: FRONT, confidence: 0.75 },
  { id: "track.equipment", pattern: /涂胶显影设备|涂胶显影机|Track设备|Track机|涂胶\/显影/, process: "photoresist_track", equipmentType: "track_equipment", stage: FRONT, confidence: 0.95 },
  { id: "track.process", pattern: /涂胶显影/, process: "photoresist_track", stage: FRONT, confidence: 0.75 },
  { id: "implant.equipment", pattern: /离子注入机|离子注入设备|注入机/, process: "ion_implantation", equipmentType: "ion_implanter", stage: FRONT, confidence: 0.95 },
  { id: "implant.process", pattern: /离子注入/, process: "ion_implantation", stage: FRONT, confidence: 0.7 },
  { id: "litho.equipment", pattern: /光刻设备|光刻机|直写光刻|纳米压印/, process: "lithography", equipmentType: "lithography_equipment", stage: FRONT, confidence: 0.9 },
  { id: "thermal.furnace", pattern: /立式炉|(?<!锅)炉管|氧化炉|扩散炉|快速热处理|RTP设备/, process: "thermal_processing", equipmentType: "furnace", stage: FRONT, confidence: 0.9 },
  { id: "thermal.process", pattern: /炉管|快速热处理|RTP|晶圆退火/, process: "thermal_processing", stage: FRONT, confidence: 0.7 },
  { id: "metro.equipment", pattern: /量检测设备|量测设备|检测设备|缺陷检测设备|缺陷检查设备|量测装备/, process: "metrology_inspection", equipmentType: "metrology_equipment", stage: FRONT, confidence: 0.9 },
  { id: "metro.process", pattern: /量测|缺陷检测|缺陷检查|膜厚|关键尺寸/, process: "metrology_inspection", stage: FRONT, confidence: 0.7 },
  // —— 后道/封测设备 ——
  { id: "grind.equipment", pattern: /减薄设备|减薄机|磨削设备/, process: "thinning", equipmentType: "grinding_equipment", stage: BACK, confidence: 0.9 },
  { id: "grind.process", pattern: /减薄/, process: "thinning", stage: BACK, confidence: 0.7 },
  { id: "dice.equipment", pattern: /划片机|激光划片|晶圆切割设备/, process: "dicing", equipmentType: "dicing_equipment", stage: BACK, confidence: 0.9 },
  { id: "ate.equipment", pattern: /测试机|自动测试设备|ATE|测试系统/, process: "testing", equipmentType: "test_equipment", stage: TEST, confidence: 0.9 },
  { id: "handler.equipment", pattern: /分选机|分选系统/, process: "testing", equipmentType: "handler", stage: TEST, confidence: 0.9 },
  // 探针台(机器)与探针卡(测试接口部件)是两种东西(Stage 3.2 §21):
  // 探针卡是装在探针台上的耗材/部件 —— component,不是 prober 设备。
  { id: "probe.equipment", pattern: /探针台|晶圆探针台/, process: "wafer_probing", equipmentType: "prober", stage: TEST, confidence: 0.9 },
  { id: "probe.card", pattern: /探针卡/, process: "wafer_probing", componentType: "probe_card", stage: TEST, confidence: 0.85 },
  { id: "pkg.equipment", pattern: /固晶机|装片机|键合机|焊线机|引线键合|封装设备|塑封设备|切筋成型|封装测试设备|封装工艺设备/, process: "packaging_assembly", equipmentType: "packaging_equipment", stage: PACK, confidence: 0.9 },
  { id: "growth.equipment", pattern: /晶体生长炉|长晶炉|单晶炉|晶体炉|晶体生长设备|区熔炉/, process: "crystal_growth", equipmentType: "growth_furnace", stage: WAFER, confidence: 0.9 },
  { id: "growth.process", pattern: /晶体生长|长晶/, process: "crystal_growth", stage: WAFER, confidence: 0.7 },
  // —— 材料 ——
  { id: "mat.silicon_wafer", pattern: /硅片|抛光片|衬底片/, materialType: "silicon_wafer", stage: WAFER, confidence: 0.85, requiresType: false },
  { id: "mat.epi_wafer", pattern: /外延片/, materialType: "epi_wafer", stage: WAFER, confidence: 0.85 },
  { id: "mat.sic_substrate", pattern: /碳化硅衬底|SiC衬底|碳化硅单晶/, materialType: "sic_substrate", stage: WAFER, confidence: 0.9 },
  { id: "mat.photoresist", pattern: /光刻胶/, materialType: "photoresist", stage: FRONT, confidence: 0.9 },
  { id: "mat.photomask", pattern: /掩膜版|掩模版|光罩/, materialType: "photomask", stage: FRONT, confidence: 0.9 },
  { id: "mat.target", pattern: /靶材/, materialType: "target_material", stage: FRONT, confidence: 0.9 },
  { id: "mat.gas", pattern: /电子特气|特种气体|高纯气体/, materialType: "electronic_special_gas", stage: FRONT, confidence: 0.85 },
  { id: "mat.wet_chemical", pattern: /湿电子化学品|超纯试剂|蚀刻液|刻蚀液|电子级硫酸|电子级双氧水|电子级氢氟酸|抛光清洗液/, materialType: "wet_chemicals", stage: FRONT, confidence: 0.85 },
  { id: "mat.slurry", pattern: /抛光液|Slurry|slurry/, materialType: "CMP_slurry", stage: FRONT, confidence: 0.9 },
  { id: "mat.pad", pattern: /抛光垫|抛光布/, materialType: "CMP_pad", stage: FRONT, confidence: 0.9 },
  { id: "mat.precursor", pattern: /前驱体|MO源|高纯金属有机化合物/, materialType: "precursor", stage: FRONT, confidence: 0.85 },
  { id: "mat.lead_frame", pattern: /引线框架/, materialType: "lead_frame", stage: PACK, confidence: 0.9 },
  { id: "mat.substrate", pattern: /封装基板|IC载板|封装载板/, materialType: "package_substrate", stage: PACK, confidence: 0.9 },
  { id: "mat.bonding_wire", pattern: /键合线|键合丝|键合铜线|铜丝球焊/, materialType: "bonding_wire", stage: PACK, confidence: 0.85 },
  { id: "mat.diamond", pattern: /金刚石微粉|金刚石单晶|CVD金刚石|金刚石工具/, materialType: "cvd_diamond", stage: WAFER, confidence: 0.8 },
  // —— 零部件/耗材件 ——
  { id: "comp.quartz", pattern: /石英舟|石英环|石英件|石英扩散管|石英坩埚|石英玻璃/, componentType: "quartz_component", stage: FRONT, confidence: 0.85 },
  { id: "comp.ceramic", pattern: /陶瓷外壳|陶瓷基板|电子陶瓷|陶瓷封装/, componentType: "ceramic_component", stage: PACK, confidence: 0.85 },
  // 设备用先进陶瓷结构件(珂玛类「先进陶瓷材料零部件」口径)是前道部件,不是封装陶瓷
  { id: "comp.ceramic_part", pattern: /陶瓷零部件|陶瓷材料零部件|先进陶瓷零部件/, componentType: "ceramic_component", stage: FRONT, confidence: 0.85 },
  { id: "comp.silicon", pattern: /硅零部件|硅电极|硅环|硅结构件/, componentType: "silicon_component", stage: FRONT, confidence: 0.85 },
  { id: "comp.vacuum", pattern: /真空腔体|真空阀|气体管路|管阀件|真空泵/, componentType: "vacuum_component", stage: FRONT, confidence: 0.8 },
  { id: "comp.precision", pattern: /半导体零部件|精密零部件/, componentType: "precision_component", stage: FRONT, confidence: 0.75 },
  // —— 通用半导体设备(无具体工艺时可证角色/环节,不给工艺) ——
  // 半导体专用设备是年报主营段的常见措辞(芯源微/华海清科等「专用设备」口径)。
  { id: "general.semi_equip", pattern: /半导体设备|半导体装备|半导体专用设备|集成电路设备|晶圆制造设备|电子工艺装备/, equipmentType: "semiconductor_equipment", stage: FRONT, confidence: 0.8 },
];

/** 窗口必须是业务语境(排除定义句/泛涉句)。 */
const BUSINESS_CONTEXT = /研发|生产|制造|销售|产品|收入|亿元|客户|应用|推出|量产|覆盖|供应|开发|装备|设备|材料|基地|产线|投产|交付|付运|技术|业务|解决方案|平台|申请|授权|专利/;

/** 公司锚定:能力必须有「这是该公司自己的业务/产品/收入」的语言锚点。
 *  年报的行业描述段(「全球刻蚀设备占市场约22%」「加工使用的光刻机受波长限制」)
 *  讲的是行业不是公司 —— 无锚定即不产生能力(规格第十一节:不得凭印象升级)。 */
const COMPANY_ANCHOR = /公司|本公司|发行人|我们|◎|开发|研制|自研|主营|销售|收入|亿元|付运|产品|推出|量产|客户|应用|订单|中标|交付|专利|方案|平台|服务|产线|产能|基地/;

/** 分类学枚举:「晶圆制造设备可以分为刻蚀、薄膜沉积、光刻…」是行业分类描述,
 *  主语是设备/产业而非公司 —— 与「公司产品包括刻蚀设备」区分。 */
const TAXONOMY_ENUM = /(可以?分为|划分为|包括|涵盖)[一-龥、,]{0,30}(刻蚀|薄膜沉积|光刻|量检测|离子|涂胶|清洗|CMP|测试|封装|减薄|划片|外延)/;
const TAXONOMY_SUBJECT = /(设备|装备|工艺|产业|行业|市场|领域|环节)(可以?分为|划分为|包括|涵盖)/;

/** 半导体语境:没有它,能力只记审计层,不进 profile。 */
export const SEMI_CONTEXT = /半导体|集成电路|晶圆|芯片|微机电|MEMS|LED|功率器件|化合物|光电|面板|光伏|太阳能|电子/;
const APP_RULES: [RegExp, string][] = [
  [/先进逻辑|逻辑器件|逻辑芯片|集成电路|晶圆|芯片|半导体/, "semiconductor_ic"],
  [/先进逻辑|逻辑器件|逻辑芯片/, "logic"],
  [/存储|DRAM|NAND|3D NAND/, "memory"],
  [/功率器件|IGBT|MOSFET|功率半导体/, "power"],
  [/LED|发光二极管|氮化镓基|Mini\s*LED|Micro\s*LED/, "led_display"],
  [/化合物|碳化硅|SiC|砷化镓|氮化镓|GaN/, "compound"],
  [/MEMS|微机电|传感器/, "mems_sensor"],
  [/光伏|太阳能/, "pv"],
  [/面板|显示/, "display"],
  [/先进封装|晶圆级|2\.5D|3D封装|Chiplet/, "advanced_packaging"],
  [/汽车|车规/, "automotive"],
  // kp1:PCB 级材料的光刻胶应用(广信/强力/容大类)。只记录,不升格。
  [/PCB|印制电路板/, "pcb"],
];

function applicationsOf(window: string): string[] {
  const apps: string[] = [];
  for (const [re, app] of APP_RULES) if (re.test(window)) apps.push(app);
  return apps;
}

export type CapabilityDraft = Omit<SemiCapability, "status" | "asOfDate" | "evidenceIds"> & {
  evidenceIds: Set<string>;
};

function keyOf(cap: Pick<SemiCapability, "process" | "specificProcess" | "equipmentType" | "materialType" | "componentType" | "role">): string {
  return [cap.process ?? "-", cap.specificProcess ?? "-", cap.equipmentType ?? "-", cap.materialType ?? "-", cap.componentType ?? "-", cap.role].join("|");
}

// ===================== s3-derive-v2 设备主体守卫(Stage 3.1) =====================
// 目标:设备角色要求「谁生产什么」可判(规格第三/四节)。以下全部是通用语言
// 规则,不含任何公司专名;每个守卫都能由 evidence+ruleId+守卫名回放审计。

/** 「半导体设备零部件/设备核心零件/石英件」:设备词是零部件的修饰语,短语主体是零部件。 */
const HEAD_PART = /(零部件|配件|部件|零件|石英件|硅件|陶瓷件|石墨件|耗材)/;
/** 「…设备用(先进陶瓷)材料/精密阀门/法兰」:设备是用途修饰语,主体是材料/零部件。 */
const USED_FOR = /^用(?:于|在)?[一-龥]{0,4}(?:材料|零部件|部件|零件|陶瓷|阀门|法兰|锻件|泵|密封|喷头|喷嘴|电极|管件|管路|腔体|加热器|托盘|花篮|静电卡盘)/;
/** 「泛半导体设备表面处理服务」:设备是被服务对象,不是产品。 */
const SERVICE_SUFFIX = /^(?:表面处理|维修|维护|保养|改造|回收|服务)/;
/** 「半导体设备厂商/设备商合作/设备客户」:设备方是交易对手,不是公司自己。 */
const COUNTERPARTY = /^(?:厂商|厂家|制造商|生产商|供应商|客户|企业|公司|龙头|商)/;
/** 「X设备由…零部件结合构成」:设备解剖句,讲的是设备构成不是公司产品。 */
const ANATOMY = /(?:由|是)[一-龥A-Za-z]{0,20}(?:构成|组成|结合而成)/;
/** 「覆盖了包括PVD、CVD、刻蚀…等应用领域」「进入刻蚀…等多种设备」:应用域列举。 */
const APP_ENUM = /(?:等|以及|和|或)[一-龥]{0,8}(?:应用领域|应用|领域|环节)/;
/** 「等核心钨钼材料及器件」:枚举以「等+修饰+材料」收尾,枚举项是被配套的设备。
 *  必须以「等」开头 —— 「以及硅材料衬底…」里的「材料」属于术语,不是枚举落点。 */
const ENUM_LANDS_MATERIAL = /等[一-龥A-Za-z]{0,10}(?:材料|器件|配件|耗材)/;
/** 公司自我主语(领属/产销动词),可豁免行业语境类守卫并充当供给侧锚。 */
const SELF_SUBJECT = /(?:公司|本司|发行人|我们)[一-龥]{0,10}(?:的|是|为|系|作为|已成为|成为|跻身|研制|研发|开发|推出|生产|制造|销售|主营|产品)/;
/** 「全球/主流/龙头+设备」:行业叙事里的设备(「全球光刻机龙头厂商ASML」「主流光刻机XT860」)。
 *  不含「先进」—— 「先进封装/先进制程」是固定术语,不是行业叙事标记。 */
const INDUSTRY_QUALIFIER = /(?:全球|国际|国外|海外|境外|龙头|头部|知名|主流|领先)$/;
/** 窗口级行业厂商叙事:「全球光刻机龙头厂商ASML推出…」—— 整窗在讲行业与
 *  对手产品;窗口内设备词除非带公司自我主语,否则不授设备。要求厂商名词
 *  落点,避免误伤「先进封装工艺设备」等自家产品措辞(「主流光刻机XT860」类
 *  由局部 INDUSTRY_QUALIFIER 前缀守卫处理)。 */
const INDUSTRY_VENDOR = /(?:全球|国际|国外|海外|境外)[一-龥A-Za-z]{0,8}(?:设备|机|装备)(?:龙头)?(?:厂商|制造商|生产商|企业)|(?:龙头|头部|知名|主流|领先|先进)(?:的)?[一-龥A-Za-z]{0,6}(?:设备|机|装备)(?:厂商|制造商|生产商|企业)/;
/** 「与/和…(光刻)机…配合/联机」:设备是被配合的他人设备(芯源微×光刻机语境)。 */
const PAIRING_SPAN = /(?:与|和|同|跟)[一-龥A-Za-z（）()0-9、]{0,40}(?:设备|机|装备)[一-龥（）()]{0,12}?(?:配合|配套|协同|联合|衔接|并用|联机|搭配|适配)/g;
/** 前置应用语:「应用于刻蚀设备」「利用单晶炉」—— 设备是用途/生产资料。 */
const APP_PREFIX = /(?:用于|用在|适用于|供于|进入|面向|所需|配套|下游|服务|利用|应用|除)$/;  // 除=「除X外」排除句

/** 供给侧锚定(词组级,规格第三节:研发/生产/制造/销售/提供设备的公司语义):
 *  设备词附近必须有公司自己的产销动词,否则词面只到词面(高管简历里出现的
 *  「中微半导体设备(上海)股份有限公司」、行业句里的裸设备词都过不了这关)。 */
const SUPPLY_NEAR = /(?:研制|研发|开发|自研|推出|主营|产品|销售|交付|付运|量产|出货|中标|订单|收入|市占|供应商|生产基地)/;
const PROD_NEAR = /生产(?!线|基地|厂|环节|工艺|过程|经营|中使用|出)/;
const MFG_NEAR = /制造(?!商|企业|厂|环节|工艺|过程)/;

// ===================== s3-derive-v3 Subject/Context 闸门(Stage 3.2) =====================
// Presence is not Capability(规格第六~十四节)。全部为通用语言规则,零公司专名。

/** §8 高管履历:曾任职/历任/工作经历窗 —— 他人公司的业务不是本公司能力。 */
const PERSONNEL_HISTORY = /曾(?:任职|就职|工作)于|历任|工作经历|曾在[一-龥A-Za-z]{2,10}(?:公司|股份|集团|有限)/;
/** §7 客户/行业购买谓词:设备是被购买/引进对象(购买主体通常是客户/晶圆厂/产业)。 */
const PURCHASE_VERB = /(?:购买|采购|购置|购入|引进)/;
/** 使用谓词:「需要用到光刻机、刻蚀机…」—— 设备是生产资料,不是公司产品(强一场景)。 */
const USAGE_VERB = /(?:需要|需|要)用到|需用到|所(?:需|使用)的(?:关键)?设备/;
/** §9 资本/壁垒行业叙事:「光刻机、刻蚀机等昂贵设备的巨额前期投入」—— 行业成本描述。 */
const CAPITAL_NARRATIVE = /(?:巨额|高昂|庞大)[一-龥]{0,8}(?:前期)?投入|(?:前期投入|投入)大|资金与?技术(?:挑战|壁垒)|准入壁垒|资金壁垒|技术壁垒|资本密集/;
/** §10 量测框架:「主要功能系对…参数的量测」「对…工艺…进行…测量」——
 *  框架内的工艺词是受测对象,不是自有工艺设备。 */
const MEASURE_FRAME = /(?:量测|测量|检测|监控|监测|表征|描述|评估)[一-龥、]{0,10}(?:的)?(?:物理性)?参数|主要(?:功能|应用)[一-龥]{0,12}(?:测量|量测|检测|监控|监测)|进行[一-龥、，]{0,10}(?:测量|量测|检测|监控|监测)|等[一-龥]{0,10}参数/;
/** 受测参数后缀:「刻蚀深度/薄膜厚度/关键尺寸/套刻精度」—— 工艺词是量测对象。 */
const PARAM_SUFFIX = /^(?:深度|厚度|宽度|尺寸|速率|均匀性|精度|形貌|缺陷|浓度|平整度|套刻)/;
/** §12 镀膜/涂层自用语境:「利用自主研发的PECVD设备…获得DLC纳米涂层」——
 *  设备是自产涂层的制造方法,不是晶圆工艺设备(菲沃泰场景)。 */
const COATING_USAGE = /(?:纳米)?(?:涂层|镀层)|镀膜工艺|纳米薄膜|薄膜制备|DLC|待镀|基材|镀(?:出|覆)/;
/** 晶圆制造语境(存在时镀膜设备才可能是半导体设备)。 */
const SEMI_MFG_CONTEXT = /半导体制造|晶圆(?:制造|生产|厂)|芯片制造|集成电路制造|前道|制程/;
/** 研发阶段/实验平台/募投:还不是在售产品能力(§16 medium 保守化)。 */
const RND_CONTEXT = /实验平台|实验样机|样机|小试|中试|处于研发|研发阶段|研发一种|本项目(?:旨在|创新|拟)/;
/** 量测仪器形态词:设备词自身是量测/检测仪器时豁免受测对象判定(「量测设备」是仪器,
 *  它 clause 里的「刻蚀」才是受测对象)。 */
const INSTRUMENT_MORPHEME = /量测|检测|测量|量检测|监控|监测|探针|测试/;
/** 制造方法语境(裸工艺词归属):「MEMS工艺涉及的光刻、刻蚀…等制造工艺」——
 *  工艺是本公司产品的制造手段。 */
const MFG_METHOD_CONTEXT = /制造工艺|工艺(?:涉及|流程|步骤)|(?:采用|使用|利用|借助|通过)[一-龥]{0,10}工艺/;
/** §14 自主产品枚举框架:供给动词直接统领设备枚举链(中微「◎开发的CCP…LPCVD、
 *  ALD、EPI设备」)—— Reuse Guard 的合法例外。 */
const SELF_ENUM_FRAME = /(?:(?:公司|本司|发行人|我们|◎)(?:的)?|开发|研制|研发|自研|推出|生产|销售|提供|产品|主营|包括|涵盖)[一-龥A-Za-z0-9、，：:（）()\/\s]{0,80}(?:设备|装备|机)/;

/** 产品清单框架:「主要产品包括X、Y设备」—— 年报产品枚举的固定自我句式,
 *  主语(公司)常被窗口截断掉,但句式本身就是自我指向。 */
const PRODUCT_ENUM_FRAME = /主要产品(?:包括|有|涵盖|为)|产品(?:包括|涵盖|有|为)/;

// ===================== kp1 (s3-derive-v4) 材料层归属闸门 =====================
// Stage 3.2 五闸门的材料层补全(Presence is not Capacity,规格§四~§六)。

const MATERIAL_ENUM_PREDICATE = /(?:包括|涵盖|分为|划分为)/g;
/** 行业分类枚举的主语落点(「晶圆制造材料包括…」的主语是材料类名词;
 *  「应用场景涵盖…」的主语是场景词 —— 688630 案)。 */
const MATERIAL_TAXONOMY_SUBJECT = /(?:材料|行业|市场|领域|产业链|环节|分类|场景)$/;
/** kp1 M2:行业产能/市场叙述(「国内硅片、光刻胶等关键材料的产能与技术水平
 *  不断提升」)—— 标记词 + 产能类名词同句,材料词是叙述对象不是公司产品。 */
const MATERIAL_NARRATIVE = /(?:国内|全球|国际|行业|市场|业界)[一-龥、,，。；0-9A-Za-z%％()（）]{0,40}(?:产能|技术水平|市场规模|需求量?|国产化|进口|自给)/g;
/** M2 自有豁免:材料词被 公司/本公司/我们 直接领属(±8 字符)时不按行业叙述处理。 */
const MATERIAL_SELF_POSSESSION = /(?:公司|本公司|我们)(?:的)?[一-龥]{0,8}$/;
/** M2/M5 供给侧豁免:「国内领先的光刻胶生产企业/溅射靶材研发与生产的企业」是
 *  自我产能自述,不是行业叙述 —— 材料词 ±16 内有供给侧动词时 M2/M5 不拦。
 *  不含裸「研发」:「检测分析技术研发」的研发属于分析业务不属于材料生产(胜科纳米案)。 */
const MATERIAL_SUPPLY_NEAR = /(生产|研制|供应商|制造商|生产商|出货|销售|主营)/;
/** M2b 市场叙述豁免的严格供给词表:裸「生产」会混入「生产成本」「生产成本
 *  有直接影响」这类行业成本叙述(300623 案),裸「出货」会混入「硅片出货量」
 *  行业统计(920368 案),市场叙述豁免改用本表。 */
const MATERIAL_SUPPLY_NEAR_STRICT = /(研制|研发|供应商|制造商|生产商|销售|主营|生产(?:企业|商)|出货(?:企业|商))/;

/** M1 行业分类枚举判定:材料/零部件词位于「X包括A、B、C」枚举链,且枚举谓词
 *  主语是行业/材料类名词 → INDUSTRY_CONTEXT(安集 ev_026 案)。
 *  主语是 产品/主营/业务/公司 类名词(自我产品枚举)时不拦 —— 保护真材料商
 *  的「主要产品包括硅片、光刻胶」句式。 */
export function materialTaxonomyGuard(window: string, index: number): boolean {
  const before = window.slice(Math.max(0, index - 60), index);
  MATERIAL_ENUM_PREDICATE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (let m = MATERIAL_ENUM_PREDICATE.exec(before); m; m = MATERIAL_ENUM_PREDICATE.exec(before)) last = m;
  if (!last) return false;
  const head = before.slice(last.index + last[0].length);
  if (head.length > 30) return false;
  const subject = before.slice(0, last.index).replace(/[。；！？!?,，、\s]+$/, "").slice(-14);
  if (!subject) return false;
  return MATERIAL_TAXONOMY_SUBJECT.test(subject);
}

/** M2 行业产能叙述判定:材料词被「国内/行业/市场 … 产能/需求」叙述短语
 *  直接包住(「国内硅片、光刻胶等关键材料的产能」)→ INDUSTRY_CONTEXT(捷捷
 *  ev_048、强力 ev_025 沪硅产业行业叙述案)。句中别处的市场叙述不牵连自家
 *  产品句 —— 叙述短语不包含材料词即放行(隆华 ev_001 案);材料词被公司直接
 *  领属或 ±16 内有供给侧动词(生产企业/研发)时豁免。 */
export function materialNarrativeGuard(window: string, index: number, end: number): boolean {
  MATERIAL_NARRATIVE.lastIndex = 0;
  for (let m = MATERIAL_NARRATIVE.exec(window); m; m = MATERIAL_NARRATIVE.exec(window)) {
    if (m.index <= index && end <= m.index + m[0].length) {
      if (MATERIAL_SELF_POSSESSION.test(window.slice(Math.max(0, index - 12), index))) return false;
      if (MATERIAL_SUPPLY_NEAR.test(window.slice(Math.max(0, index - 16), end + 16))) return false;
      return true;
    }
  }
  return false;
}

/** M3 光刻胶复合词头:「光刻胶配套试剂/光刻胶用化学品」= 配套(auxiliary),
 *  「光刻胶光引发剂/树脂/专用电子化学品」= 上游原材料(raw_material)。
 *  词面命中的不是光刻胶本体 —— 江化微/格林达/强力新材案。 */
export function photoresistCompoundOverride(afterText: string): "photoresist_auxiliary" | "photoresist_raw_material" | undefined {
  const tail = afterText.slice(0, 8);
  if (/^(光引发剂|树脂|单体|中间体|专用电子化学品)/.test(tail)) return "photoresist_raw_material";
  if (/^(配套|用|级)/.test(tail)) return "photoresist_auxiliary";
  return undefined;
}

/** M5 检测分析对象:「先进材料（…、光刻胶）等先进工艺的检测分析技术研发」——
 *  材料词是检测/失效分析业务的受检对象(胜科纳米案),不是公司产品。
 *  ±16 内有供给侧动词时豁免(自产产品的检测叙述)。 */
const MATERIAL_ANALYSIS_CONTEXT = /检测分析|分析检测|失效分析|表征分析|检测表征/;

// —— mp1.1 (s3-derive-v5) 守卫判定函数(导出供回归测试与审计回放) ——

/** M1b 政策/管制清单枚举:窗口有政策权威词 + 材料词所在句有清单/扶持动词。 */
export function materialPolicyGuard(window: string, clause: string): boolean {
  if (!POLICY_AUTHORITY.test(window)) return false;
  return POLICY_CLAUSE.test(clause);
}

/** M2b 市场/行业叙述扩展:材料词所在句含份额/出货/供需/增长/出口叙述。 */
export function materialMarketGuard(clause: string): boolean {
  return MATERIAL_MARKET_CLAUSE.test(clause) || MATERIAL_DEMAND_FRAME.test(clause);
}

/** M-Def 定义/原材句:材料词紧跟「是/：+ 行业释义」。 */
export function materialDefinitionGuard(after: string): boolean {
  return MATERIAL_DEFINITION.test(after);
}

/** M5c 采购/上游帧:材料词处于采购清单位/供应商位,且所在句有采购帧。 */
export function materialProcurementGuard(preTail: string, post: string, near16: string, clause: string): boolean {
  if (!MATERIAL_PROCUREMENT_CLAUSE.test(clause)) return false;
  if (MATERIAL_PARTNER_CLAUSE.test(clause)) return true;
  return MATERIAL_LIST_POSITION.test(preTail)
    || /^(?:的)?(?:重要|一般|主要)?原材料/.test(post)
    || /供应商主要为?/.test(near16);
}

/** M5b 加工/接触对象:材料词是工艺动作对象或介质接触面(仅紧邻自我领属豁免)。 */
/** M5b 加工/接触对象判定:TARGET 组照拦;PROCESS 组在材料词后接「材料/产品」
 *  (产品复合词修饰语)时豁免。 */
export function materialObjectGuard(preTail: string, post: string, clause: string): boolean {
  if (MATERIAL_CONTACT_CLAUSE.test(clause)) return true;
  if (MATERIAL_OBJECT_POST.test(post)) return true;
  if (MATERIAL_OBJECT_PRE_PROCESS.test(preTail)) return !/^(?:材料|产品)/.test(post);
  return MATERIAL_OBJECT_PRE_TARGET.test(preTail);
}

/** M-Rnd 建设期/研发期:在建/募投/在研句,同句无 产业化/量产/已投产。 */
export function materialRndGuard(clause: string): boolean {
  return MATERIAL_RND_CLAUSE.test(clause) && !MATERIAL_RND_EXEMPT.test(clause);
}

/** M6b 设备复合词头:材料词直接修饰设备/装备/整线方案/供应系统。 */
export function materialEquipmentHeadGuard(after: string): boolean {
  return MATERIAL_EQUIP_HEAD.test(after);
}

/** M6c 覆盖域枚举:材料词在「覆盖…环节/制造领域」枚举里。 */
export function materialChainCoverageGuard(after: string): boolean {
  return MATERIAL_CHAIN_COVERAGE.test(after);
}

/** M6d 链条定位语:材料词是「制造环节/流程/端」标签(「硅片制造端,公司的主要
 *  产品有…晶体生长设备」「是硅片和晶圆制造环节使用的关键材料」)。公司领属
 *  短语(「公司(12英寸)硅片生产工艺」)豁免 —— 那是自家产线描述。 */
export function materialChainLocativeGuard(after: string, pre16: string): boolean {
  if (/(?:公司|本公司|我们)[一-龥0-9A-Za-z]{0,12}$/.test(pre16)) return false;
  return MATERIAL_CHAIN_LOCATIVE.test(after);
}

/** M-Refer 复合词指涉改写:词面命中的是载具/上游 blank/非硅衬底复合词。
 *  「光罩盒」是掩膜版载具(部件);「掩膜版衬底/基板」是掩膜版上游 blank;
 *  「LED衬底片/蓝宝石衬底片」不是硅片;「(公司)蓝宝石产品包括…晶棒和衬底片」
 *  的枚举主体是蓝宝石产品(300323 案);衬底片窗口同现 蓝宝石/LED 时指涉为
 *  蓝宝石/LED 家族衬底。不做供给豁免 —— 词面指涉由复合词头决定。 */
export function materialReferentGuard(matched: string, preTail: string, after: string, window: string, start: number): "container" | "blank" | "non-silicon" | null {
  const isMaskFamily = /掩[膜模]版|光罩/.test(matched);
  if (isMaskFamily && MATERIAL_REFERENT_CONTAINER.test(after)) return "container";
  if (isMaskFamily && MATERIAL_REFERENT_BLANK.test(after)) return "blank";
  // 非硅修饰语紧贴衬底词面:「(生产和销售)LED衬底片」「蓝宝石衬底片」
  if (/衬底(?:片)?$/.test(matched) && MATERIAL_REFERENT_NON_SILICON.test(preTail)) return "non-silicon";
  // 合格限定产品枚举:「公司蓝宝石产品包括…晶棒和衬底片」—— 枚举主体是
  // 另一材料家族的产品,枚举链里的衬底片属于该家族。
  if (/衬底(?:片)?$/.test(matched)) {
    const before = window.slice(Math.max(0, start - 80), start);
    const enumAt = Math.max(before.lastIndexOf("包括"), before.lastIndexOf("涵盖"), before.lastIndexOf("分为"), before.lastIndexOf("划分为"));
    if (enumAt >= 0 && before.length - enumAt <= 34) {
      const subject = before.slice(0, enumAt).replace(/[。；！？!?,，、\s]+$/, "").slice(-16);
      if (/(?:蓝宝石|石英|陶瓷|玻璃|LED|金刚石|碳化硅|SiC|砷化镓|磷化铟|石墨)[一-龥]{0,6}(?:产品|业务)?$/.test(subject)) return "non-silicon";
    }
    // 窗口同现蓝宝石/LED 家族信号(「在同一台晶体炉内生长…4寸衬底片…LED外延片」)
    if (/蓝宝石|LED/.test(window)) return "non-silicon";
  }
  return null;
}

/** M-Usage 用途必需帧:材料词是被需要/被使用的对象。 */
export function materialUsageGuard(clause: string): boolean {
  return MATERIAL_USAGE_CLAUSE.test(clause);
}

/** M-Svc 服务/配套帧:「主要为单晶硅棒硅片的生产和辅助材料资源回收循环利用,
 *  提供配套产品及服务」—— 公司提供的是配套/服务。公司领属短语豁免。 */
export function materialServiceFrameGuard(after: string, pre16: string): boolean {
  if (/(?:公司|本公司|我们)[一-龥0-9A-Za-z]{0,12}$/.test(pre16)) return false;
  return MATERIAL_SERVICE_POST.test(after);
}

/** M-Seg 工序节点限定语:材料词在（含…)括号里做下游工序段限定词。 */
export function materialSegmentQualifierGuard(pre16: string): boolean {
  return MATERIAL_SEGMENT_QUALIFIER.test(pre16);
}

/** M-Make 制作对象后接:材料词直接接制版/加工等动名词,句内无公司主语。 */
export function materialMakePostGuard(after: string, clauseSelf: boolean): boolean {
  if (clauseSelf) return false;
  return MATERIAL_MAKE_POST.test(after);
}

/** M6 设备语境续接:「涂胶显影设备与客户具体制造工艺、光刻胶材料」——
 *  材料词挂在设备名词后做对象枚举(芯源微案),设备商不是材料商。 */
const MATERIAL_EQUIP_TAIL = /(?:设备|装备)[与和、][一-龥、]{0,16}$/;

// ===================== mp1.1 (s3-derive-v5) 材料闸门通用化 =====================
// kp1 的 M 闸门只在光刻胶方向做过回归;silicon_wafer/photomask 轴残留同源污染。
// 以下推广/补齐全部为通用语言规则,零公司专名,每条可由 evidence+ruleId+守卫名
// 回放;拦截只改解释(SOURCE preserved),旧解释进 attributionLedger(§32)。

/** M1b 政策/管制清单枚举:出口管制清单、政府工程、产业政策对材料品类的枚举
 *  (「《两用物项出口管制清单》(…硅片…)生产企业」「人民政府实施"融链"工程,
 *  支持…提高碳化硅衬底、大尺寸硅片等产能」)。政策文本讲的是管制/扶持范围,
 *  不是公司产品。 */
const POLICY_AUTHORITY = /人民政府|发改委|发展改革委|工业和信息化部|工信部|商务部|国务院|财政部|税务总局|出口管制|两用物项|国家级|省政府|市政府/;
const POLICY_CLAUSE = /清单|目录|名录|管制|条例|规划|(?:支持|鼓励|推动|提高|做大|做强|培育|实施|印发|发布|出台|开展|建设)[一-龥、]{0,24}(?:产能|规模|工程|项目|基地|集群|企业)/;

/** M2b 市场/行业叙述扩展( clause 级,补 M2 窗口级 regex 的盲区):份额、出货、
 *  供需、增长、出口结构(「仅次于硅片的第二大细分材料市场」「硅片市场在晶圆
 *  制造材料市场中占比为32.84%」「全球硅片出货量」「单晶硅片市场趋于饱和,
 *  供需基本平衡」「硅片、电池片等上游产品出口占比提升」)。 */
const MATERIAL_MARKET_CLAUSE = /仅次于|第[一二三四五]大|市场(?:份额|占比|规模|需求|空间|格局|趋于)|占比|位列第|出货(?:量|面积)|供需(?:基本)?平衡|趋于饱和|市场价格|价格(?:下跌|上涨|下行)|出口(?:结构|占比)|用量(?:均)?(?:持续)?(?:提升|增长)|增长(?:幅度|率)|复合(?:年)?增长率|产业链(?:上游|下游|中游)|集中度|行业壁垒|议价能力|(?:国内|全球|海外|国际|境外)(?:头部|龙头|领先|知名)?(?:企业|厂商|公司|厂家)/;
/** 「以新能源动力电池、光伏硅片、半导体芯片为代表的新兴高端制造领域」——
 *  行业需求叙述的领域框架(落点是领域/产业/市场/行业/应用,不是产品)。 */
const MATERIAL_DEMAND_FRAME = /以[一-龥、A-Za-z0-9]{0,30}为代表的新?(?:一代)?[一-龥]{0,6}(?:领域|产业|市场|行业|应用)/;

/** M5b 加工/接触对象:材料词是工艺动作的对象或介质接触面(「可对硅片基底…
 *  实现纳米级全局平坦化加工」「降低用于切割光伏硅片的细线占比」「石英制品在
 *  使用过程中直接与硅片或晶圆接触」「满足光学级碳化硅衬底对热场材料的要求」
 *  「多晶硅料…被加工成多晶或单晶硅片」—— 行业流程链叙述的终点产物)。
 *  仅在紧邻自我领属(±8「公司生产的」)时豁免 —— 满足/用于/对 框架里材料词
 *  是参照物,不是产品主张。 */
/** M5b 加工/接触对象 —— 两组前置信号:
 *  TARGET 组(对/用于/应用于/满足…):材料词是用途/指向的宾语,材料词后接
 *  「产品」不豁免(「应用于先进封装掩模版产品的高解析直写光刻解决方案」——
 *  设备的加工对象是掩膜版,603800 案);
 *  PROCESS 组(切割/蚀刻/加工成…):动词常是产品复合词的修饰语(「半导体蚀刻
 *  引线框架材料」是自产产品,300283 案),材料词后接「材料/产品」时豁免。 */
const MATERIAL_OBJECT_PRE_TARGET = /(?:对|用于|用在|应用于|适用于|面向|服务于|满足|符合)[一-龥]{0,14}$|与$/;
const MATERIAL_OBJECT_PRE_PROCESS = /(?:切割|划片|减薄|研磨|抛光|清洗|蚀刻|刻蚀|量测|测量|检测|探伤|键合|焊接)[一-龥]{0,4}$|(?:加工|生产|制)成[一-龥]{0,8}$/;
const MATERIAL_OBJECT_POST = /^(?:基底|基板|表面|正反面|上下表面|衬底表面)/;
const MATERIAL_CONTACT_CLAUSE = /与[一-龥]{0,8}[或和及][一-龥]{0,6}(?:直接)?(?:接触|贴合)|直接与[一-龥]{0,8}(?:接触|贴合)/;

/** M-Svc 服务/配套帧:「公司立足于单晶硅材料产业链,主要为单晶硅棒硅片的生产
 *  和辅助材料资源回收循环利用,提供配套产品及服务」—— 材料词在「为…的生产
 *  …提供配套」框架里,公司提供的是配套/服务,不是材料本体(欧晶案)。
 *  公司领属短语(「公司硅片的生产、销售和服务」)豁免。 */
const MATERIAL_SERVICE_POST = /^(?:的生产|制造|加工|切割|切片|回收)(?:和|、|与)?[^。；！？!?]{0,20}(?:提供|配套|服务)/;

/** M5c 采购/上游帧:材料词出现在采购清单或上游供应商描述里(「采购以贵金属、
 *  衬底片等重要原材料为主…其供应商主要为生产衬底片、MO源…的企业」「与国内
 *  设备商、特种气体等上游企业联合研发」)。材料词需处于清单位/供应商位 ——
 *  保护「公司主要产品为硅片,原材料为多晶硅料」这类同句真供给。 */
const MATERIAL_PROCUREMENT_CLAUSE = /采购(?:以|模式|清单|需求)|(?:重要|一般|主要)原材料|原材料为辅|供应商主要为?|上游(?:企业|厂商|供应商)/;
const MATERIAL_LIST_POSITION = /(?:以|、|和|及|与|包括|为)$|(?:供应商|供货方)主要为?(?:生产|制造)?$/;
const MATERIAL_PARTNER_CLAUSE = /(?:与|和)[一-龥、]{0,24}等?上游(?:企业|厂商|供应商)|上游(?:企业|厂商|供应商)(?:联合|协同)/;

/** M-Rnd 建设期/研发期:「公司正在建设的…项目,包含40万片大硅片(、)抛光垫等
 *  产能」「钛基金属前驱体纯化工艺的研发800.00…正在进行」—— 在建/募投/在研
 *  还不是在售能力(§16)。同句出现 产业化/量产/已投产/批量销售 时放行
 *  (「光刻胶部分产品产业化、部分研发中」这类混合句不拦)。 */
const MATERIAL_RND_CLAUSE = /正在建设|在建|筹建|拟建|规划建设|募投|募资|处于研发|研发阶段|研发中|在研|正在进行|本项目|试产/;
const MATERIAL_RND_EXEMPT = /产业化|已投产|已量产|批量(?:供应|销售|出货)|规模销售|已实现销售/;

/** M6b 设备复合词头(材料轴,kp1 只做了光刻胶 M3 的同族推广):材料词直接修饰
 *  设备/装备/方案 ——「大硅片设备产品」「硅片加工设备(如切片机…)」「碳化硅
 *  单晶炉」「大尺寸超高速硅片分选机」「硅片+电池+组件超级工厂整线解决方案」。
 *  设备商不是材料商(晶盛/捷佳/晶升案)。设备语境可带供给动词(「生产硅片
 *  设备」),不做供给豁免 —— 词面主体是设备。 */
const MATERIAL_EQUIP_HEAD = /^(?:(?:加工|减薄|切割|分选|抛光|清洗|检测|直写|长晶)[一-龥]{0,2})?(?:设备|装备|机台|分选机|贴片机|单晶炉|退火炉|炉)(?![会构遇械能密房])|^[\d一-龥+、]{0,12}(?:整线|解决方案|整厂)|^(?:供应|回收|输送|配送|分配|供给)(?:与|和|及)?[一-龥]{0,8}(?:系统|设备|服务|工程|技术|装置|管路)/;

/** M6c 覆盖域枚举:「公司产品覆盖了硅片、电池和组件环节」「已形成覆盖大硅片、
 *  化合物半导体等多个制造领域的系列清洗装备布局」—— 材料词在业务覆盖域
 *  枚举里,公司供给的是该环节的设备/服务,不是材料本体。必须有列表标记
 *  (顿号续接 / 「等」收尾)—— 「在PCB光刻胶领域」是主题短语不是枚举(300537 案),
 *  「引线框架材料等高端新材料领域」是自产产品扩展(300283 案)。 */
const MATERIAL_CHAIN_COVERAGE = /^[、和与及][一-龥A-Za-z+]{0,16}(?:等多个?)?(?:环节|制造领域|领域|场景)|^等[一-龥A-Za-z]{0,10}(?:环节|制造领域|领域|场景)|^[一-龥A-Za-z+]{0,12}等多个?[一-龥]{0,4}(?:环节|制造领域|领域|场景)/;

/** M6d 链条定位语:「硅片制造端,公司的主要产品有全自动晶体生长设备」「是硅片
 *  和晶圆制造环节使用的关键材料」「在单晶硅片生产流程中,石英坩埚是…关键部件」
 *  —— 材料词是产业环节标签,不是产品主张。 */
const MATERIAL_CHAIN_LOCATIVE = /^[、和或及]?(?:晶圆|半导体|光伏|芯片|单晶)?(?:制造|生产|加工|制备)(?:环节|流程|工艺|端|领域)/;

/** M-Seg 工序节点限定语:「公司8-12英寸的半导体产品（含大硅片、先进封装、
 *  三代半导体）实现销售额…」—— 材料词在（含…)括号里做下游工序段限定词,
 *  不是产品主张(江化微案:化学品商按下游段披露销售额)。 */
const MATERIAL_SEGMENT_QUALIFIER = /[0-9]{1,4}[-~—至][0-9]{1,4}英寸[一-龥]{0,10}（含[一-龥]{0,3}$/;

/** M-Def 定义/原材句:「硅片是生产太阳能晶硅电池的基础材料」「硅片是光伏产业
 *  链中集中度最高的环节之一」「硅片是芯片制造的“地基”」「前驱体:半导体制造
 *  中用于化学气相沉积等工艺的关键原料」—— 行业释义,不是公司产品主张。
 *  产品主张(「硅片是公司的核心产品」)不拦。 */
const MATERIAL_DEFINITION = /^(?:是|作为|[:：])(?:生产|制造)?[一-龥A-Za-z]{0,18}的?(?:基础|关键|核心|重要|主要|必不可少|不可替代|关键性)(?:材料|原料)|^是[一-龥]{0,14}的?["“”]?地基["“”]?|^是[一-龥]{0,14}(?:产业链)?环节(?:之一)?|^[:：][一-龥A-Za-z]{0,24}(?:用于|指)/;

/** M-Make 制作对象后接:材料词直接接制作/加工动名词(「掩模版制版的高精度
 *  需求」—— 设备商的设备用来制版,不是公司产掩膜版(芯碁微装案)。「生产/
 *  制造」后接已由设备方向守卫 B 处理。句内有公司自我主语时豁免
 *  (「公司专注于半导体掩膜版制造」是自产)。 */
const MATERIAL_MAKE_POST = /^(?:制版|制作|加工|曝光|光刻|直写)(?:的|需求|能力|业务|服务)?/;

/** M-Refer 复合词指涉改写:词面命中但复合词头指涉另一物 ——「光罩盒」是掩膜版
 *  载具(部件),「掩膜版衬底/基板」是掩膜版上游 blank,「LED衬底片/蓝宝石衬底
 *  片」不是硅片(300323/688079/300151 案)。不做供给豁免 —— 词面指涉由复合词
 *  头决定,「销售LED衬底片」的销售动词改变不了指涉对象。 */
const MATERIAL_REFERENT_CONTAINER = /^(?:盒|框|箱|夹具|卡匣|花篮)/;
const MATERIAL_REFERENT_BLANK = /^(?:衬底|基板|玻璃|母版|坯|基片)/;
const MATERIAL_REFERENT_NON_SILICON = /(?:蓝宝石|LED|砷化镓|磷化铟|碳化硅|SiC|锗|玻璃|陶瓷|石墨)$/;

/** M-Usage 用途必需帧:「第三代半导体、光电器件、MEMS传感器、LED外延片的生产
 *  制造均需要半导体掩膜版」—— 材料词是被需要/被使用的对象(688401 案)。 */
const MATERIAL_USAGE_CLAUSE = /均需(?:要)?|(?:需要|需)用到|(?:不可或缺|必不可少)的?(?:关键)?(?:材料|原料)/;

/** §10 受测语境判定:该工艺/设备词是否是量测/检测的受测对象。
 *  量测仪器自身(量测设备/检测设备/测试机)豁免 —— 仪器是公司产品,
 *  它所在句里的工艺词才是受测对象。 */
function isMeasuredContext(window: string, index: number, end: number, matchedText: string): boolean {
  if (INSTRUMENT_MORPHEME.test(matchedText)) return false;
  if (INSTRUMENT_MORPHEME.test(window.slice(Math.max(0, index - 8), index))) return false;
  if (MEASURE_FRAME.test(clauseAt(window, index, end))) return true;
  if (PARAM_SUFFIX.test(window.slice(end, end + 6).replace(/^(?:的|等|、)/, ""))) return true;
  return false;
}
/** §16 章节置信层(年报):high=MD&A,medium=治理/重要事项,low=财务报告(默认不产生能力)。 */
export function sectionClassOf(e: SemiEvidence): "high" | "medium" | "low" | "registry" | "unknown" {
  if (e.sourceType !== "annual_report") return "registry";
  const s = e.locator.section ?? "";
  if (/第三节|管理层讨论/.test(s)) return "high";
  if (/第四节|公司治理|第五节|重要事项/.test(s)) return "medium";
  if (/第八节|财务报告|审计报告/.test(s)) return "low";
  if (!s) return "unknown";
  return "medium";
}

/** 句级子窗口(。；！？切分):Subject/Predicate 闸门在句内判,避免整窗误伤
 *  「一句行业叙述+一句自主产品」混合窗(§17:章节/主语/谓词/宾语合判)。 */
function clauseAt(window: string, index: number, end: number): string {
  let start = index;
  while (start > 0 && !/[。；！？!?;]/.test(window[start - 1])) start--;
  let stop = end;
  while (stop < window.length && !/[。；！？!?;]/.test(window[stop])) stop++;
  return window.slice(start, stop);
}

type GuardTag =
  | "app-prefix" | "head-part" | "used-for" | "service" | "counterparty" | "anatomy"
  | "industry-subject" | "pairing" | "app-enum" | "no-anchor"
  | "purchase-frame" | "usage-frame" | "capital-narrative" | "measure-param"
  | "coating-usage" | "rnd-context" | "location-phrase" | "enum-anaphor" | "mfg-method-flow";
/** 工艺词被这些「良性用途」守卫挡下时,词面仍然证明「材料/部件 × 工艺」的
 *  processExposure(role 保持 material/component,不给 equipmentType)。 */
const BENIGN_EXPOSURE_TAGS: GuardTag[] = ["app-prefix", "head-part", "used-for", "app-enum"];
/** v3 语境守卫 → 归属映射(ledger 与审计对账用)。 */
export const GUARD_ATTRIBUTION: Record<string, WindowAttribution> = {
  "purchase-frame": "CUSTOMER_CONTEXT",
  "usage-frame": "INDUSTRY_CONTEXT",
  "capital-narrative": "INDUSTRY_CONTEXT",
  "measure-param": "APPLICATION_ONLY",
  "coating-usage": "MANUFACTURING_METHOD",
  "rnd-context": "RND_ONLY",
  "location-phrase": "APPLICATION_ONLY",
  "app-prefix": "PROCESS_EXPOSURE",
  "head-part": "PROCESS_EXPOSURE",
  "used-for": "PROCESS_EXPOSURE",
  "app-enum": "PROCESS_EXPOSURE",
  "service": "INDUSTRY_CONTEXT",
  "counterparty": "SUPPLY_CHAIN_CONTEXT",
  "anatomy": "INDUSTRY_CONTEXT",
  "industry-subject": "INDUSTRY_CONTEXT",
  "pairing": "INDUSTRY_CONTEXT",
  "enum-anaphor": "INDUSTRY_CONTEXT",
  "mfg-method-flow": "MANUFACTURING_METHOD",
  "no-anchor": "AMBIGUOUS",
};

function selfAnchorAt(window: string, index: number): boolean {
  return SELF_SUBJECT.test(window.slice(Math.max(0, index - 16), index));
}

function supplyAnchorAt(window: string, index: number, end: number): boolean {
  const post = window.slice(end).replace(/\s+/g, "");
  const near = window.slice(Math.max(0, index - 20), Math.min(window.length, end + 20));
  if (SUPPLY_NEAR.test(near) || PROD_NEAR.test(near) || MFG_NEAR.test(near)) return true;
  // 产品目录回指:「边缘湿法刻蚀设备该设备支持…」—— 该/本+设备词是产品
  // 描述段的回指,与产销动词同等效力的供给侧锚。
  if (/^(?:该|本)(?:设备|机型|机|产品|系列|装备)/.test(post.slice(0, 6))) return true;
  // 产品枚举链:「先后开发了前道…设备,包括清洗设备、电镀设备、…、PECVD设备」
  // —— 一个产销动词统领整条枚举,后面的枚举项距动词超过 ±20 仍是自家产品。
  const pre = window.slice(Math.max(0, index - 100), index);
  return /(?:开发|研制|研发|自研|推出|生产|销售|提供|包括|涵盖|产品(?:有|包括|涵盖|为|是)?)[了过]?(?:有|是|为)?[一-龥A-Za-z0-9、，；:：()（）\/\s]{0,80}$/.test(pre);
}

function inPairingSpan(window: string, index: number, end: number): boolean {
  PAIRING_SPAN.lastIndex = 0;
  for (let m = PAIRING_SPAN.exec(window); m; m = PAIRING_SPAN.exec(window)) {
    if (index >= m.index && end <= m.index + m[0].length) return true;
  }
  return false;
}

/** 设备词的主体守卫:返回拦截标签,或 null(放行,继续走供给侧锚定)。
 *  v3 新增五类 Subject/Context 闸门(购买/使用/资本叙事/量测参数/镀膜自用/研发),
 *  全部在句级子窗口内判定;公司自我主语在句内出现时豁免(「公司为客户提供设备」
 *  是供给句不是购买句)。 */
function equipmentGuard(window: string, index: number, end: number, selfAnchor: boolean, windowIndustry: boolean, matchedText: string): GuardTag | null {
  const pre = window.slice(Math.max(0, index - 4), index);
  const post = window.slice(end).replace(/\s+/g, "");
  const clause = clauseAt(window, index, end);
  const clauseSelf = clause.includes("◎") || SELF_SUBJECT.test(clause);
  if (APP_PREFIX.test(pre)) return "app-prefix";
  // 「应用于…PVD工艺」「（PVD）环节」:讲的是工艺应用,不断言设备(沿用 v1)
  if (/^(?:工艺|环节|过程|应用|技术)/.test(post)) return "app-prefix";
  if (/^[（(][A-Za-z0-9（）()]{0,10}(?:工艺|环节|过程|应用|技术)/.test(post)) return "app-prefix";
  if (HEAD_PART.test(post.slice(0, 8))) return "head-part";
  if (USED_FOR.test(post.slice(0, 14))) return "used-for";
  if (SERVICE_SUFFIX.test(post.slice(0, 6))) return "service";
  // —— s3-derive-v3 闸门(Presence is not Capability) ——
  // §10 量测参数:设备词是受测对象/参数(「刻蚀深度」「对…刻蚀…工艺…测量」);
  // 设备词自身是量测仪器(量测设备/检测设备/测试机)时豁免 —— 仪器是公司产品。
  if (isMeasuredContext(window, index, end, matchedText)) return "measure-param";
  // §12 自用生产资料:「(公司的)生产工艺流程包括…设备」—— 枚举的是公司产线
  // 构成,不是公司卖的产品(模组厂/晶圆厂的产线清单;强于句内公司主语信号)。
  {
    const flowAt = clause.search(/(?:生产|制造)?工艺流程(?:包括|含|有)/);
    if (flowAt >= 0) {
      let cs = index;
      while (cs > 0 && !/[。；！？!?;]/.test(window[cs - 1])) cs--;
      if (index - cs > flowAt) return "mfg-method-flow";
    }
  }
  // 研发阶段/实验平台/募投样机:还不是在售产品能力。窗口级判断(「实验平台」
  // 与设备词常分属两句),句内有公司自我主语或产品清单框架时豁免。
  if (RND_CONTEXT.test(window) && !clauseSelf && !PRODUCT_ENUM_FRAME.test(clause)) return "rnd-context";
  // §7/§9 购买/使用叙事:句内无公司自我主语时,设备是被购买/使用对象
  if (!clauseSelf) {
    if (PURCHASE_VERB.test(clause)) return "purchase-frame";
    if (USAGE_VERB.test(clause)) return "usage-frame";
  }
  if (CAPITAL_NARRATIVE.test(clause) && !selfAnchor) return "capital-narrative";
  // §12 镀膜自用:窗口有涂层/镀膜语境且无晶圆制造语境 —— 设备是自产涂层的制造方法
  if (!selfAnchor && COATING_USAGE.test(window) && !SEMI_MFG_CONTEXT.test(window)) return "coating-usage";
  if (COUNTERPARTY.test(post.slice(0, 4)) && !selfAnchor) return "counterparty";
  if (ANATOMY.test(post.slice(0, 44))) return "anatomy";
  // 「安装在探针台上使用」:设备是产品的工作位置/搭档,不是公司产品(探针卡场景)
  if (/^上(?:使用|完成|进行|测试|作业)/.test(post) || /安装在$|装载在$|装在$/.test(pre)) return "location-phrase";
  // 「…设备等，这些半导体设备应用在…」:枚举回指句 —— 提及项是被综述的行业
  // 设备集合成员,不是公司产品(句内无公司主语时)。
  if (!clauseSelf && /^(?:等)?[，,]?(?:这些|上述|此类)[一-龥]{0,8}设备/.test(post)) return "enum-anaphor";
  if ((INDUSTRY_QUALIFIER.test(window.slice(Math.max(0, index - 6), index)) || windowIndustry) && !selfAnchor) return "industry-subject";
  if (inPairingSpan(window, index, end)) return "pairing";
  if (!selfAnchor) {
    if (APP_ENUM.test(post.slice(0, 32))) return "app-enum";
    if (ENUM_LANDS_MATERIAL.test(post.slice(0, 20))) return "app-enum";
  }
  return null;
}

/** 「刻蚀、薄膜沉积、热处理、湿法清洗等主力设备系列持续放量」:裸工艺词列举
 *  + 设备系列标记 ⇒ 列举项就是设备品类,映射到对应设备类型。 */
const SERIES_MARKER = /(设备系列|装备系列|设备产品|产品系列|主力设备|系列设备|设备业务|设备平台)/;
const PROCESS_DEFAULT_EQUIPMENT: Record<string, string> = {
  etching: "etcher",
  deposition: "deposition_equipment",
  epitaxy: "epitaxy_equipment",
  cleaning: "cleaning_equipment",
  cmp: "CMP_equipment",
  photoresist_track: "track_equipment",
  ion_implantation: "ion_implanter",
  thermal_processing: "furnace",
};

export type DeriveTrace = {
  caps: SemiCapability[];
  blocked: { ruleId: string; tag: GuardTag; process?: string; specificProcess?: string; equipmentType?: string }[];
  /** v3:整窗级归属(履历窗/低置信章节),窗口本身不产生能力。 */
  windowAttribution?: WindowAttribution;
  /** v3:受测工艺曝光 —— 量测窗内被拦下的工艺词,应挂到本公司量测能力的
   *  processExposure(§10:检测范围 ≠ 自有能力)。 */
  measuredProcesses: string[];
  /** v3:裸工艺词的改释台账(§32)—— role=unknown,只进 ledger 不进 profile。 */
  bareLedger: AttributionLedgerEntry[];
};

/**
 * 从一条 evidence 的文本派生能力(可复现:同一文本+同一规则表 ⇒ 同一结果),
 * 并返回守卫拦截轨迹(供主营主体一致性仲裁与审计使用)。
 * 整窗级定义守卫:「X指用…」「LED外延片指…」是释义句(年报第一节样板),
 * 窗口出现即整窗按定义处理(其中的其他工艺词只是释义链条的一环)。
 * 裸工艺词不要求设备名词 —— role=unknown,不断言供给角色;
 * 「做刻蚀工艺」不等于「卖刻蚀设备」。
 */
export function deriveWithTrace(evidence: SemiEvidence): DeriveTrace {
  const window = evidence.evidenceText;
  const measuredProcesses: string[] = [];
  const bareLedger: AttributionLedgerEntry[] = [];
  // §16 章节闸门:财务报告(low)默认不产生能力;履历窗(§8)永不产生能力。
  const secClass = sectionClassOf(evidence);
  if (secClass === "low") {
    return { caps: [], blocked: [], windowAttribution: "LOW_CONFIDENCE_SECTION", measuredProcesses, bareLedger };
  }
  if (PERSONNEL_HISTORY.test(window)) {
    return { caps: [], blocked: [], windowAttribution: "PERSONNEL_HISTORY", measuredProcesses, bareLedger };
  }
  if (!BUSINESS_CONTEXT.test(window)) return { caps: [], blocked: [], measuredProcesses, bareLedger };
  if (/[一-龥A-Za-z]指[用一是在具]/.test(window.replace(/\s+/g, ""))) return { caps: [], blocked: [], measuredProcesses, bareLedger };
  if (!COMPANY_ANCHOR.test(window)) return { caps: [], blocked: [], measuredProcesses, bareLedger };
  if (TAXONOMY_SUBJECT.test(window.replace(/\s+/g, ""))) return { caps: [], blocked: [], measuredProcesses, bareLedger };
  const hasTypeNoun = /设备|装备|机器|系统|材料|试剂|气体|胶|液|垫|靶|片|粉|坩埚|舟|环|部件|基板|框架|丝|线/.test(window);
  const caps: SemiCapability[] = [];
  const emitted = new Set<string>();
  const blocked: DeriveTrace["blocked"] = [];
  const exposure: { process?: string; specificProcess?: string }[] = [];
  for (const rule of DERIVE_RULES) {
    const match = rule.pattern.exec(window);
    if (!match) continue;
    if (rule.requiresType && !hasTypeNoun) continue;
    const start = match.index;
    const end = match.index + match[0].length;
    const after = window.slice(end).replace(/\s+/g, "");
    const emitsEquipment = !!(rule.equipmentType || rule.equipmentIfContext);
    if (emitsEquipment) {
      const selfAnchor = selfAnchorAt(window, start);
      const guard = equipmentGuard(window, start, end, selfAnchor, INDUSTRY_VENDOR.test(window), match[0]);
      if (guard) {
        blocked.push({ ruleId: rule.id, tag: guard, process: rule.process, specificProcess: rule.specificProcess, equipmentType: rule.equipmentType ?? rule.equipmentIfContext });
        // 量测参数语境的工艺词 → 受测工艺曝光(§10),挂到同窗量测能力上
        if (guard === "measure-param" && (rule.process || rule.specificProcess)) {
          measuredProcesses.push(rule.specificProcess ?? rule.process!);
        }
        if (BENIGN_EXPOSURE_TAGS.includes(guard) && (rule.process || rule.specificProcess)) {
          exposure.push({ process: rule.process, specificProcess: rule.specificProcess });
        }
        // 「半导体设备零部件/刻蚀设备用硅部件」:词面主体是零部件 —— 转记
        // precision_component(部件供给),绝不授 equipmentType(规格第四/五节)。
        if ((guard === "head-part" || guard === "used-for") && hasTypeNoun) {
          const cap: SemiCapability = {
            process: rule.process,
            specificProcess: rule.specificProcess,
            componentType: "precision_component",
            role: "component_supplier",
            manufacturingStage: rule.stage,
            applications: applicationsOf(window),
            confidence: Math.max(0.7, rule.confidence - 0.1),
            evidenceIds: [evidence.evidenceId],
            ruleId: `s3.rule.${rule.id}+s3.rule.part-conversion.v2`,
            status: evidence.status,
            asOfDate: evidence.asOfDate,
            attribution: "DIRECT_COMPANY_CAPABILITY",
            evidenceQuality: evidence.sourceType !== "annual_report" || selfAnchorAt(window, start) ? "DIRECT" : "STRONG",
          };
          const key = keyOf(cap);
          if (!emitted.has(key)) {
            emitted.add(key);
            caps.push(cap);
          }
        }
        continue;
      }
      // 供给侧主体锚定:过不了守卫也没有公司产销动词 ⇒ 不授设备(留审计轨迹)
      if (!selfAnchor && !supplyAnchorAt(window, start, end)) {
        blocked.push({ ruleId: rule.id, tag: "no-anchor" });
        continue;
      }
    }
    // 设备方向守卫 B(续接):「PVD镀膜材料」「溅射靶材」是材料方向续接,
    // 不能给设备类型 —— 转记为材料供给(靶材/镀膜材料)。
    if (rule.materialType) {
      if (/^(去除|剥离|清除|洗去|溶解|工艺|生产|制造|产线|生产线|厂|表面|上)/.test(after)) continue;
    }
    // 材料/零部件供给侧锚定:工艺词 ±16 字符内必须有供给语(生产/销售/收入/
    // 主营/产品…),否则视为应用语境(PECVD 功能描述里提到硅片 ≠ 拓荆卖硅片)。
    if (rule.materialType || rule.componentType) {
      const near = window.slice(Math.max(0, start - 16), end + 16);
      if (!/(生产|销售|收入|主营|产品|产能|产业化|供应商|出货|市占|制造|研发|研制)/.test(near)) continue;
      // v3 §10:量测枚举里的材料词是受测对象(「多层薄膜、光刻胶等厚度测量」)
      if (isMeasuredContext(window, start, end, match[0])) {
        if (rule.process) measuredProcesses.push(rule.process);
        continue;
      }
      // kp1 (s3-derive-v4) + mp1.1 (s3-derive-v5):材料归属闸门全链。kp1 只在
      // 光刻胶方向验证 M1/M2/M5/M6;mp1.1 推广为 materialType 通用闸门并补齐
      // silicon_wafer/photomask 审计确认的泄漏类 —— 均不产生材料能力,证据与
      // 解释进 ledger(§32,SOURCE preserved / Attribution changed)。
      const near16 = window.slice(Math.max(0, start - 16), end + 16);
      const pre16 = window.slice(Math.max(0, start - 16), start);
      const pre12 = window.slice(Math.max(0, start - 12), start);
      const pre8 = window.slice(Math.max(0, start - 8), start);
      const clause = clauseAt(window, start, end);
      const clauseSelf = clause.includes("◎") || SELF_SUBJECT.test(clause);
      const selfNear = MATERIAL_SELF_POSSESSION.test(pre12) || MATERIAL_SUPPLY_NEAR_STRICT.test(near16) || clauseSelf;
      const materialGuard = materialReferentGuard(match[0], pre8, after, window, start)
        ?? (materialPolicyGuard(window, clause) ? "policy" : null)
        ?? (materialTaxonomyGuard(window, start) ? "taxonomy" : null)
        ?? (materialNarrativeGuard(window, start, end) || (!selfNear && materialMarketGuard(clause)) ? "market" : null)
        // 定义句只豁免紧邻自我领属(「公司生产的硅片是…」);句内别处的公司
        // 主语/供给动词不豁免 —— 「(公司认为)硅片是…基础材料」「前驱体:…关键原料」
        // 是行业释义,「硅片是公司的主要原材料」的“公司”在材料词之后拦得到。
        ?? (!MATERIAL_SELF_POSSESSION.test(pre12) && materialDefinitionGuard(after) ? "definition" : null)
        ?? (materialProcurementGuard(pre12, after, near16, clause) ? "procurement" : null)
        ?? (materialUsageGuard(clause) ? "usage" : null)
        ?? (materialRndGuard(clause) ? "rnd" : null)
        ?? (materialEquipmentHeadGuard(after) ? "equip-compound" : null)
        ?? (materialChainLocativeGuard(after, pre16) ? "chain-locative" : null)
        ?? (materialSegmentQualifierGuard(pre16) ? "segment-qualifier" : null)
        ?? (materialChainCoverageGuard(after) ? "chain-coverage" : null)
        ?? (materialServiceFrameGuard(after, pre16) ? "service-frame" : null)
        ?? (materialMakePostGuard(after, clauseSelf) ? "make-object" : null)
        ?? (!MATERIAL_SELF_POSSESSION.test(pre8) && materialObjectGuard(pre16, after, clause) ? "object" : null)
        ?? (MATERIAL_ANALYSIS_CONTEXT.test(clause) && !MATERIAL_SUPPLY_NEAR.test(near16) ? "analysis" : null)
        ?? (MATERIAL_EQUIP_TAIL.test(window.slice(Math.max(0, start - 40), start)) ? "equipment-context" : null);
      if (materialGuard) {
        const guardAttribution =
          materialGuard === "container" || materialGuard === "blank" || materialGuard === "non-silicon" ? "AMBIGUOUS"
          : materialGuard === "object" || materialGuard === "chain-locative" || materialGuard === "analysis" || materialGuard === "make-object" ? "APPLICATION_ONLY"
          : materialGuard === "procurement" || materialGuard === "equip-compound" || materialGuard === "chain-coverage" || materialGuard === "equipment-context" || materialGuard === "service-frame" ? "SUPPLY_CHAIN_CONTEXT"
          : materialGuard === "rnd" ? "RND_ONLY"
          : "INDUSTRY_CONTEXT";
        bareLedger.push({
          subject: "capability",
          process: rule.process,
          specificProcess: rule.specificProcess,
          materialType: rule.materialType,
          componentType: rule.componentType,
          attribution: guardAttribution,
          evidenceIds: [evidence.evidenceId],
          ruleId: `s3.rule.${rule.id}+s3.guard.material-${materialGuard}.v5`,
        });
        continue;
      }
    }
    // 分类学枚举兜底(主语词不在 TAXONOMY_SUBJECT 里的变体,按列表位置判断):
    // 关键词命中处于「A、B、C 等品类」枚举链中时不产生能力。
    if (TAXONOMY_ENUM.test(window.replace(/\s+/g, ""))) {
      const list = window.replace(/\s+/g, "");
      const at = list.indexOf(match[0]);
      const near = list.slice(Math.max(0, at - 14), at + match[0].length + 6);
      if (/[、,](刻蚀|薄膜沉积|光刻|量检测|离子掺杂|清洗|涂胶显影|CMP|测试|封装|减薄|划片|外延)[、,]?(等|是)/.test(near)) continue;
    }
    // 角色推断:有材料/零部件/设备名词才能断言对应供给角色;裸工艺词
    // (「刻蚀工艺量产」)不能区分设备商与晶圆厂工艺使用 —— role=unknown,
    // 由 merge 阶段在同工艺存在设备证据时才升级(规格第十三节)。
    const contextEquipment = rule.equipmentIfContext && /设备|装备|机台|反应腔|整机/.test(window) ? rule.equipmentIfContext : undefined;
    // 设备方向守卫 B(续接):specificProcess 后紧跟材料名词 ⇒ 材料方向
    // (「PVD镀膜材料」= 靶材商,不是 PVD 设备商),改记材料供给。
    let materialOverride: string | undefined;
    if (!rule.equipmentType && contextEquipment && !rule.materialType) {
      if (/^镀膜?材料|^靶材|^气体|^试剂|^胶/.test(after)) materialOverride = "target_material";
    }
    // 设备系列枚举:「刻蚀、薄膜沉积…等主力设备系列」⇒ 列举项即设备品类
    let seriesEquipment: string | undefined;
    if (!rule.equipmentType && !materialOverride && !rule.materialType && !rule.componentType && rule.process && PROCESS_DEFAULT_EQUIPMENT[rule.process]) {
      const m2 = SERIES_MARKER.exec(window);
      if (m2 && m2.index > match.index && m2.index - match.index <= 24) {
        seriesEquipment = PROCESS_DEFAULT_EQUIPMENT[rule.process];
      }
    }
    const equipmentType = rule.equipmentType ?? contextEquipment ?? seriesEquipment;
    // kp1 M3:光刻胶复合词头(配套试剂/用化学品/光引发剂/树脂)→ typed 上游/
    // 配套 subtype,不再冒充光刻胶本体。
    const prSubtype = rule.id === "mat.photoresist" ? photoresistCompoundOverride(after) : undefined;
    const role: SemiRole =
      materialOverride || rule.materialType ? "material_supplier"
      : rule.componentType ? "component_supplier"
      : equipmentType ? "equipment_supplier"
      : "unknown";
    // v3 证据局部性(§13):registry 行/公司自我主语 = DIRECT;供给动词锚 = STRONG;
    // 裸工艺词 = WEAK(不得自称设备)。
    const quality: EvidenceQuality =
      role === "unknown" ? "WEAK"
      : evidence.sourceType !== "annual_report" || selfAnchorAt(window, start) ? "DIRECT"
      : "STRONG";
    const cap: SemiCapability = {
      process: rule.process,
      specificProcess: rule.specificProcess,
      equipmentType: materialOverride ? undefined : equipmentType,
      materialType: prSubtype ?? rule.materialType ?? materialOverride,
      componentType: rule.componentType,
      role,
      manufacturingStage: rule.stage,
      applications: applicationsOf(window),
      confidence: rule.confidence,
      evidenceIds: [evidence.evidenceId],
      ruleId: `s3.rule.${rule.id}${prSubtype ? "+s3.rule.pr-compound.v4" : ""}`,
      status: evidence.status,
      asOfDate: evidence.asOfDate,
      attribution: role === "unknown" ? undefined : "DIRECT_COMPANY_CAPABILITY",
      evidenceQuality: quality,
    };
    // 通用规则不给工艺;具体规则先到先得:已由更高精度规则覆盖时跳过
    if (rule.id.startsWith("general.") && caps.some((c) => c.process)) continue;
    if (role === "unknown") {
      // 裸工艺词(§32 改释台账):量测窗→受测工艺曝光;制造方法窗/镀膜窗→
      // MANUFACTURING_METHOD;研发窗→RND_ONLY;其余 AMBIGUOUS。不进 profile。
      const clause = clauseAt(window, start, end);
      let attribution: WindowAttribution = "AMBIGUOUS";
      if (isMeasuredContext(window, start, end, match[0])) {
        attribution = "APPLICATION_ONLY";
        // 量测本身不是受测工艺(「量测」裸词不进 processExposure)
        if (rule.process && rule.process !== "metrology_inspection") measuredProcesses.push(rule.process);
      } else if (MFG_METHOD_CONTEXT.test(clause) || (COATING_USAGE.test(window) && !SEMI_MFG_CONTEXT.test(window))) {
        attribution = "MANUFACTURING_METHOD";
      } else if (RND_CONTEXT.test(window)) {
        attribution = "RND_ONLY";
      } else if (PURCHASE_VERB.test(clause) && !clause.includes("◎") && !SELF_SUBJECT.test(clause)) {
        attribution = "CUSTOMER_CONTEXT";
      } else if (CAPITAL_NARRATIVE.test(clause)) {
        attribution = "INDUSTRY_CONTEXT";
      }
      bareLedger.push({
        subject: "process",
        process: rule.process,
        specificProcess: rule.specificProcess,
        attribution,
        evidenceIds: [evidence.evidenceId],
        ruleId: `s3.rule.${rule.id}+s3.rule.bare-context.v3`,
      });
      continue;
    }
    const key = keyOf(cap);
    if (emitted.has(key)) continue;
    emitted.add(key);
    caps.push(cap);
  }
  // processExposure(规格第五节,Role 与 Process 分维):工艺词因「用于/部件/
  // 应用域」被挡下设备时,同窗的材料/零部件能力带上该工艺曝光 —— 「靶材用于
  // PVD」= PVD 相关靶材商,不是 PVD 设备商。只挂一个工艺对,保持确定性。
  if (exposure.length) {
    const pair = exposure.find((p) => p.process || p.specificProcess);
    if (pair) {
      for (const cap of caps) {
        if ((cap.materialType || cap.componentType) && !cap.process) {
          cap.process = pair.process;
          cap.specificProcess = pair.specificProcess;
          cap.ruleId += "+s3.rule.process-exposure.v2";
        }
      }
    }
  }
  // §10 量测窗受测曝光:同窗存在量测能力时,受测工艺词挂到它的 processExposure
  // (「可对刻蚀、沉积、清洗、CMP 等工艺进行缺陷检测」= 检测能力 × 工艺曝光,
  // 不是刻蚀/沉积/清洗/CMP 设备能力)。
  const metroCap = caps.find((c) => c.process === "metrology_inspection" && c.equipmentType === "metrology_equipment");
  if (metroCap && measuredProcesses.length) {
    metroCap.processExposure = [...new Set([...(metroCap.processExposure ?? []), ...measuredProcesses])];
  }
  // 同窗共存裁决:一个窗口同时给出「设备」与「材料/零部件」能力时,该窗口讲的是
  // 「刻蚀设备用的硅部件/陶瓷件」类语境 —— 设备能力降级 unknown(审计可见、
  // 标签退出);真设备商的窗口不会同时罗列自家耗材件(规格第十一节不得升级)。
  const hasConsumable = caps.some((c) => c.materialType || c.componentType);
  if (hasConsumable) {
    for (const cap of caps) {
      if (cap.role === "equipment_supplier") {
        cap.role = "unknown";
        cap.equipmentType = undefined;
        cap.ruleId += "+s3.rule.window-consumable-demote.v2";
      }
    }
  }
  return { caps, blocked, measuredProcesses, bareLedger };
}

export function deriveFromEvidence(evidence: SemiEvidence): SemiCapability[] {
  return deriveWithTrace(evidence).caps;
}

/** 主营窗口 = 公司自我语义的权威位置:年报主营业务概述段 + zyjs/zygc filing 行。 */
export function isPrimaryEvidence(e: SemiEvidence): boolean {
  if (e.sourceType !== "annual_report") return true;
  if ((e.matchedKeywords ?? []).includes("主营业务概述")) return true;
  return /主营业务|主要业务|主要产品与业务|从事的主要业务|主要产品或服务|经营情况讨论/.test(e.evidenceText.slice(0, 90));
}

/** 触发主营仲裁的设备语境守卫(良性用途 + 行业/解刨/配对语境;no-anchor 太弱不触发)。 */
const ARBITRATION_TAGS: GuardTag[] = ["head-part", "used-for", "service", "counterparty", "anatomy", "industry-subject", "pairing", "app-prefix", "app-enum"];

export type CompanyDeriveTrace = {
  caps: SemiCapability[];
  demotedEquipment: number;
  /** v3:Re:use Guard 复查记录(§14)。 */
  reuseChecks: NonNullable<SemiDomainKnowledge["reuseChecks"]>;
  /** v3:归属台账(§32)—— 被移除/改释的能力解释。 */
  ledger: AttributionLedgerEntry[];
};

/** Evidence Reuse Guard 阈值(§14):分布先行(p95=3、p99=5,见
 *  STAGE3_2_OVER_EXTRACTION_AUDIT §2),≥3 类设备/证据即触发复查;
 *  「公司自主产品枚举」句式放行,否则降级为曝光。 */
export const REUSE_EQUIP_THRESHOLD = 3;

/**
 * 公司级派生(规格第二节:主营主体一致性仲裁):
 *   主营窗口只支持材料/零部件、或设备词在主营窗口里只出现在被守卫拦下的语境
 *   ⇒ 次级窗口(行业描述/工艺映射表/应用列举)的设备角色整体降级为 unknown
 *   (审计可见,不删除)。主营窗口自己支持设备 ⇒ 次级窗口互证,不降级。
 * s3-derive-v3 增量:§14 Evidence Reuse Guard + §32 归属台账。
 * 不含任何公司专名;对全体公司同一规则。
 */
export function deriveCompanyCaps(evidence: SemiEvidence[]): CompanyDeriveTrace {
  const evidenceById = new Map(evidence.map((e) => [e.evidenceId, e]));
  const primary = evidence.filter(isPrimaryEvidence);
  const secondary = evidence.filter((e) => !isPrimaryEvidence(e));
  const primaryRun = primary.map((e) => deriveWithTrace(e));
  const secondaryRun = secondary.map((e) => deriveWithTrace(e));
  const primaryCaps = mergeCapabilities(primaryRun.flatMap((r) => r.caps));
  const secondaryCaps = mergeCapabilities(secondaryRun.flatMap((r) => r.caps));
  const primaryEquipment = primaryCaps.some((c) => c.role === "equipment_supplier" && c.equipmentType);
  const primaryConsumable = primaryCaps.some((c) => (c.materialType || c.componentType) && c.role !== "unknown");
  const primaryEquipmentBlocked = primaryRun.some((r) => r.blocked.some((b) => ARBITRATION_TAGS.includes(b.tag)));
  let demotedEquipment = 0;
  const ledger: AttributionLedgerEntry[] = [];
  if (!primaryEquipment && (primaryConsumable || primaryEquipmentBlocked)) {
    for (const cap of secondaryCaps) {
      if (cap.role === "equipment_supplier") {
        ledger.push({ subject: "capability", process: cap.process, specificProcess: cap.specificProcess, equipmentType: cap.equipmentType, attribution: "AMBIGUOUS", evidenceIds: cap.evidenceIds, ruleId: `${cap.ruleId}+s3.arbitrate.primary-frame.v2` });
        cap.role = "unknown";
        cap.equipmentType = undefined;
        cap.ruleId += "+s3.arbitrate.primary-frame.v2";
        demotedEquipment += 1;
      }
    }
  }
  let caps = mergeCapabilities([...primaryCaps, ...secondaryCaps]);
  // v3 §32:裸工艺词改释台账归集(量测/制造方法/研发/购买/行业语境)
  for (const run of [...primaryRun, ...secondaryRun]) ledger.push(...run.bareLedger);
  // v3 §32:被守卫拦下的设备词解释留痕(按 ruleId×tag 聚合,no-anchor 太弱不记)
  const blockedAgg = new Map<string, AttributionLedgerEntry>();
  const runPairs: [DeriveTrace, SemiEvidence][] = [
    ...primaryRun.map((r, i): [DeriveTrace, SemiEvidence] => [r, primary[i]]),
    ...secondaryRun.map((r, i): [DeriveTrace, SemiEvidence] => [r, secondary[i]]),
  ];
  for (const [run, ev] of runPairs) {
    for (const b of run.blocked) {
      if (b.tag === "no-anchor") continue;
      const key = `${b.ruleId}|${b.tag}`;
      const entry = blockedAgg.get(key) ?? {
        subject: "equipment" as const,
        process: b.process,
        specificProcess: b.specificProcess,
        equipmentType: b.equipmentType,
        attribution: GUARD_ATTRIBUTION[b.tag] ?? "AMBIGUOUS",
        evidenceIds: [],
        ruleId: `s3.rule.${b.ruleId}+s3.guard.${b.tag}.v3`,
      };
      entry.evidenceIds.push(ev.evidenceId);
      blockedAgg.set(key, entry);
    }
  }
  for (const entry of blockedAgg.values()) {
    entry.evidenceIds = [...new Set(entry.evidenceIds)];
    ledger.push(entry);
  }
  // 受测工艺曝光聚合:量测窗拦下的工艺词(§10)挂到公司级量测能力上
  const measured = [...primaryRun, ...secondaryRun].flatMap((r) => r.measuredProcesses);
  if (measured.length) {
    const metro = caps.find((c) => c.process === "metrology_inspection" && c.equipmentType === "metrology_equipment");
    if (metro) {
      metro.processExposure = [...new Set([...(metro.processExposure ?? []), ...measured])];
      ledger.push({ subject: "process", attribution: "APPLICATION_ONLY", evidenceIds: [], process: "metrology_inspection", ruleId: "s3.rule.measured-exposure.v3" });
    }
  }
  // §14 Evidence Reuse Guard:一条 evidence 支撑 ≥3 类设备 ⇒ 复查窗口是否为
  // 「公司自主产品枚举」句式;不合法的证据不再支撑设备(证据级摘除,§32)。
  // zygc/zyjs registry 行(主营构成/主营介绍)本身就是公司自己的产品清单,
  // 不含「公司」主语是正常形态 —— 豁免主语检查。
  const reuseChecks: NonNullable<SemiDomainKnowledge["reuseChecks"]> = [];
  const evEquip = new Map<string, Set<string>>();
  for (const cap of caps) {
    if (cap.equipmentType && cap.role === "equipment_supplier") {
      for (const id of cap.evidenceIds) {
        const set = evEquip.get(id) ?? new Set<string>();
        set.add(cap.equipmentType);
        evEquip.set(id, set);
      }
    }
  }
  const flagged = new Set<string>();
  for (const [evId, types] of evEquip) {
    if (types.size < REUSE_EQUIP_THRESHOLD) continue;
    const ev = evidenceById.get(evId);
    const legitSelfEnum =
      !!ev &&
      SELF_ENUM_FRAME.test(ev.evidenceText) &&
      (/◎|公司|我们|主要产品|产品包括|产品涵盖/.test(ev.evidenceText) || ev.sourceType !== "annual_report");
    reuseChecks.push({ evidenceId: evId, equipmentTypes: [...types].sort(), legitSelfEnum, downgraded: !legitSelfEnum });
    if (!legitSelfEnum) flagged.add(evId);
  }
  if (flagged.size) {
    for (const cap of [...caps]) {
      if (!cap.equipmentType || cap.role !== "equipment_supplier") continue;
      const flaggedIds = cap.evidenceIds.filter((id) => flagged.has(id));
      if (!flaggedIds.length) continue;
      const surviving = cap.evidenceIds.filter((id) => !flagged.has(id));
      ledger.push({
        subject: "capability",
        process: cap.process,
        specificProcess: cap.specificProcess,
        equipmentType: cap.equipmentType,
        attribution: "INDUSTRY_CONTEXT",
        evidenceIds: flaggedIds,
        ruleId: `${cap.ruleId}+s3.rule.evidence-reuse-guard.v3`,
      });
      if (!surviving.length) {
        cap.equipmentType = undefined;
        cap.role = "unknown";
      }
      cap.evidenceIds = surviving.length ? surviving : cap.evidenceIds;
      cap.ruleId += "+s3.rule.evidence-reuse-guard.v3";
    }
  }
  return { caps, demotedEquipment, reuseChecks, ledger };
}

export function mergeCapabilities(caps: SemiCapability[]): SemiCapability[] {
  const byKey = new Map<string, SemiCapability>();
  for (const cap of caps) {
    const key = keyOf(cap);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...cap, evidenceIds: [...cap.evidenceIds] });
      continue;
    }
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...cap.evidenceIds])];
    existing.applications = [...new Set([...existing.applications, ...cap.applications])];
    existing.confidence = Math.max(existing.confidence, cap.confidence);
    if (existing.status === "HISTORICAL" && cap.status === "CURRENT") existing.status = "CURRENT";
    existing.asOfDate = [existing.asOfDate, cap.asOfDate].sort().at(-1)!;
    if (existing.processExposure || cap.processExposure) {
      existing.processExposure = [...new Set([...(existing.processExposure ?? []), ...(cap.processExposure ?? [])])];
    }
  }
  const merged = [...byKey.values()];
  // 角色升级:同工艺已有 equipment_supplier 证据时,unknown(裸工艺词)升级;
  // 晶圆厂/材料厂的「XX工艺」字样不足以自称设备商,保持 unknown(审计层可见,
  // 不进检索文本)。升级本身也留 ruleId 痕迹。
  const equipmentProcesses = new Set(merged.filter((c) => c.equipmentType && c.equipmentType !== "semiconductor_equipment").map((c) => c.process!));
  for (const cap of merged) {
    if (cap.role === "unknown" && cap.process && equipmentProcesses.has(cap.process)) {
      cap.role = "equipment_supplier";
      cap.ruleId += "+s3.merge.role-upgrade.v1";
    }
  }
  // 去冗:(process,specificProcess) 已有带设备类型的版本时,无类型的冗余项
  // (含升级后的裸工艺项)吸收进设备项 —— 证据 id 并入,不丢追溯。
  const covered = new Map<string, SemiCapability>();
  for (const cap of merged) {
    if (cap.equipmentType && cap.role !== "unknown") covered.set(`${cap.process}|${cap.specificProcess ?? ""}`, cap);
  }
  const absorbed: SemiCapability[] = [];
  for (const cap of merged) {
    if (cap.equipmentType || !cap.process) {
      absorbed.push(cap);
      continue;
    }
    const cover = covered.get(`${cap.process}|${cap.specificProcess ?? ""}`);
    if (!cover) {
      absorbed.push(cap);
      continue;
    }
    cover.evidenceIds = [...new Set([...cover.evidenceIds, ...cap.evidenceIds])];
    cover.applications = [...new Set([...cover.applications, ...cap.applications])];
    if (cap.processExposure) {
      cover.processExposure = [...new Set([...(cover.processExposure ?? []), ...cap.processExposure])];
    }
  }
  return absorbed;
}
