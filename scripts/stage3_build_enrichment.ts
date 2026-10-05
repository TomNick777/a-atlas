import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SEMICONDUCTOR_DERIVE_VERSION,
  SEMICONDUCTOR_ENRICHMENT_VERSION,
  deriveCompanyCaps,
  SEMI_CONTEXT,
  type AttributionLedgerEntry,
  type SemiCapability,
  type SemiDomainKnowledge,
  type SemiEvidence,
} from "../search/knowledge/semiconductor";

/**
 * Stage 3 enrichment builder(规格第七/八/九/十/二十七节):
 *   Tier1 年报证据(data/sources/semiconductor/<code>/evidence_raw.json)
 *   + Tier3 filing-derived 证据(zyjs/zygc,LEVEL A 补充 / LEVEL B 主源)
 *   → derive 规则(s3-derive-v1)→ 结构化能力 + 检索标签 + SOURCE_GAP。
 *
 * 输出:
 *   data/enrichment/semiconductor/evidence.json   证据库(每条回指来源+SHA+页码)
 *   data/enrichment/semiconductor/enrichment.json 每公司 enrichment 记录
 *   data/enrichment/semiconductor/enrichment_stats.json 统计(报告用)
 *
 * Usage: npx tsx scripts/stage3_build_enrichment.ts
 */

const root = process.cwd();
const OUT_DIR = path.join(root, "data", "enrichment", "semiconductor");
const SRC_BASE = path.join(root, "data", "sources", "semiconductor");
const RAW_DIR = path.join(root, "data", "raw", "companies");

const EQUIP_LABELS: Record<string, string> = {
  etcher: "刻蚀设备", deposition_equipment: "薄膜沉积设备", cleaning_equipment: "清洗设备",
  CMP_equipment: "CMP设备", track_equipment: "涂胶显影设备", ion_implanter: "离子注入机",
  lithography_equipment: "光刻设备", furnace: "炉管设备", epitaxy_equipment: "外延设备",
  grinding_equipment: "减薄设备", dicing_equipment: "划片机", test_equipment: "测试机",
  handler: "分选机", prober: "探针台", metrology_equipment: "量测设备", packaging_equipment: "封装设备",
  growth_furnace: "长晶炉", semiconductor_equipment: "半导体设备",
  PECVD_equipment: "PECVD设备", LPCVD_equipment: "LPCVD设备", SACVD_equipment: "SACVD设备",
  MOCVD_equipment: "MOCVD设备", ALD_equipment: "ALD设备", CVD_equipment: "CVD设备", PVD_equipment: "PVD设备",
};
const SPECIFIC_LABELS: Record<string, string> = {
  CCP: "CCP刻蚀", ICP: "ICP刻蚀", PECVD: "PECVD", LPCVD: "LPCVD", SACVD: "SACVD",
  MOCVD: "MOCVD", ALD: "ALD", single_wafer_cleaning: "单片清洗", batch_cleaning: "槽式清洗",
};
const MATERIAL_LABELS: Record<string, string> = {
  silicon_wafer: "硅片", epi_wafer: "外延片", sic_substrate: "碳化硅衬底", photoresist: "光刻胶",
  photoresist_auxiliary: "光刻胶配套材料", photoresist_raw_material: "光刻胶上游材料",
  photomask: "掩膜版", target_material: "溅射靶材", electronic_special_gas: "电子特气",
  wet_chemicals: "湿电子化学品", CMP_slurry: "抛光液", CMP_pad: "抛光垫", precursor: "前驱体",
  lead_frame: "引线框架", package_substrate: "封装基板", bonding_wire: "键合线", cvd_diamond: "CVD金刚石",
};
const COMPONENT_LABELS: Record<string, string> = {
  quartz_component: "石英件", ceramic_component: "陶瓷件", silicon_component: "硅零部件",
  vacuum_component: "真空件", precision_component: "半导体零部件", probe_card: "探针卡",
};

type UniverseEntry = {
  code: string;
  name: string;
  level: "A" | "B" | "C";
  signals: { productEquipWords: string[]; productMaterialWords: string[]; textEquipWords: string[] };
};

type EnrichmentRecord = {
  code: string;
  name: string;
  level: "A" | "B" | "C";
  domain: "semiconductor";
  enrichmentVersion: string;
  deriveVersion: string;
  manufacturingStages: string[];
  processCapabilities: SemiCapability[];
  equipmentTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  materialTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  componentTypes: { type: string; applications: string[]; evidenceIds: string[] }[];
  applications: string[];
  roles: string[];
  retrievalLabels: string[];
  sourceGap: { capability: string; expectedFrom: string }[];
  attributionLedger: AttributionLedgerEntry[];
  reuseChecks: NonNullable<SemiDomainKnowledge["reuseChecks"]>;
  checkedSources: { sourceType: string; title: string; date: string; documentSha256?: string }[];
};

function isoDate(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "";
}

function tier3Evidence(code: string): { evidence: SemiEvidence[]; checked: EnrichmentRecord["checkedSources"] } {
  const rawFile = path.join(RAW_DIR, `${code}.json`);
  if (!existsSync(rawFile)) return { evidence: [], checked: [] };
  const raw = JSON.parse(readFileSync(rawFile, "utf8"));
  const evidence: SemiEvidence[] = [];
  const checked: EnrichmentRecord["checkedSources"] = [];
  const observedAt = statSync(rawFile).mtime.toISOString().slice(0, 10);
  const zygc: { 报告日期?: number; 分类类型?: string; 主营构成?: string; 收入比例?: number }[] = raw.zygc ?? [];
  const periods = [...new Set(zygc.map((r) => isoDate(r["报告日期"])).filter(Boolean))].sort();
  const latestPeriod = periods.at(-1) ?? observedAt;

  const zyjs = raw.zyjs ?? {};
  const zyjsText = [zyjs["主营业务"], zyjs["产品类型"], zyjs["产品名称"]].filter(Boolean).join("。");
  if (zyjsText) {
    evidence.push({
      evidenceId: "",
      companyCode: code,
      sourceType: "filing_summary_zyjs",
      sourceTitle: "主营介绍(同花顺,ak.stock_zyjs_ths;filing-derived)",
      sourceDate: observedAt || "unknown",
      locator: { field: "zyjs.主营业务/产品类型/产品名称" },
      evidenceText: zyjsText.slice(0, 190),
      matchedKeywords: [],
      retrievedAt: observedAt || "unknown",
      authorityTier: 3,
      status: "CURRENT",
      asOfDate: latestPeriod || observedAt || "unknown",
    });
    checked.push({ sourceType: "filing_summary_zyjs", title: "主营介绍(THS, filing-derived)", date: observedAt || "unknown" });
  }

  // 按产品分类的主营构成行:最新报告期 CURRENT,更早 HISTORICAL(时间性纪律 §29)
  const productRows = zygc.filter((r) => r["分类类型"] === "按产品分类" && r["主营构成"]);
  const byPeriod = new Map<string, typeof productRows>();
  for (const row of productRows) {
    const period = isoDate(row["报告日期"]);
    if (!period) continue;
    const list = byPeriod.get(period) ?? [];
    list.push(row);
    byPeriod.set(period, list);
  }
  const sortedPeriods = [...byPeriod.keys()].sort().at(-1);
  for (const [period, rows] of byPeriod) {
    for (const row of rows) {
      const share = row["收入比例"] != null ? ` 收入比例${Math.round((row["收入比例"] as number) * 100)}%` : "";
      const text = `主营构成(按产品):${row["主营构成"]}${share}`.slice(0, 190);
      evidence.push({
        evidenceId: "",
        companyCode: code,
        sourceType: "filing_product_split_zygc",
        sourceTitle: "主营构成按产品分类(东方财富,ak.stock_zygc_em;filing-derived)",
        sourceDate: period,
        reportPeriod: period,
        locator: { field: "zygc.按产品分类", period },
        evidenceText: text,
        matchedKeywords: [],
        retrievedAt: observedAt || "unknown",
        authorityTier: 3,
        status: sortedPeriods === period ? "CURRENT" : "HISTORICAL",
        asOfDate: period,
      });
    }
  }
  if (productRows.length) {
    checked.push({ sourceType: "filing_product_split_zygc", title: "主营构成按产品(EM, filing-derived)", date: sortedPeriods ?? "unknown" });
  }
  return { evidence, checked };
}

function tier1Evidence(code: string): { evidence: SemiEvidence[]; checked: EnrichmentRecord["checkedSources"] } {
  const rawPath = path.join(SRC_BASE, code, "evidence_raw.json");
  if (!existsSync(rawPath)) return { evidence: [], checked: [] };
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  const evidence: SemiEvidence[] = raw.evidences.map((e: { page: number; section: string; keyword: string; text: string }) => ({
    evidenceId: "",
    companyCode: code,
    sourceType: "annual_report" as const,
    sourceTitle: raw.sourceTitle,
    sourceDate: raw.sourceDate,
    reportPeriod: raw.reportPeriod,
    sourceUrl: raw.sourceUrl,
    documentSha256: raw.documentSha256,
    locator: { page: e.page, section: e.section },
    evidenceText: e.text,
    matchedKeywords: [e.keyword],
    retrievedAt: raw.extractedAt,
    authorityTier: 1 as const,
    status: "CURRENT" as const,
    asOfDate: raw.reportPeriod ?? raw.sourceDate,
  }));
  return {
    evidence,
    checked: [{
      sourceType: "annual_report",
      title: `${raw.sourceTitle}(${raw.reportPeriod})`,
      date: raw.sourceDate,
      documentSha256: raw.documentSha256?.slice(0, 16),
    }],
  };
}

function main() {
  const universe = JSON.parse(readFileSync(path.join(OUT_DIR, "universe.json"), "utf8"));
  const targets = (universe.companies as UniverseEntry[]).filter((c) => c.level === "A" || c.level === "B");

  const allEvidence: SemiEvidence[] = [];
  const records: EnrichmentRecord[] = [];
  const stats = {
    enrichmentVersion: SEMICONDUCTOR_ENRICHMENT_VERSION,
    deriveVersion: SEMICONDUCTOR_DERIVE_VERSION,
    generatedAt: new Date().toISOString(),
    companiesChecked: 0,
    companiesWithCapabilities: 0,
    withEquipment: 0,
    withMaterial: 0,
    withComponent: 0,
    tier1Companies: 0,
    tier1Evidence: 0,
    tier3Evidence: 0,
    sourceGapCompanies: 0,
    attribution: {} as Record<string, number>,
    evidenceQuality: {} as Record<string, number>,
    ledgerAttribution: {} as Record<string, number>,
    reuseChecksTotal: 0,
    reuseDowngraded: 0,
    perProcess: {} as Record<string, number>,
    perEquipment: {} as Record<string, number>,
    perMaterial: {} as Record<string, number>,
  };

  for (const entry of targets) {
    const { evidence: tier1, checked: checked1 } = tier1Evidence(entry.code);
    const { evidence: tier3, checked: checked3 } = tier3Evidence(entry.code);
    // evidenceId 稳定序:Tier1 在前(页序),Tier3 在后;逐公司重编号
    const ordered = [...tier1, ...tier3];
    ordered.forEach((e, i) => (e.evidenceId = `ev_${entry.code}_${String(i + 1).padStart(3, "0")}`));

    // s3-derive-v3:公司级派生 —— v2 全部守卫 + Subject/Context 闸门 + §14 Reuse
    // Guard + §10 受测曝光 + §32 归属台账(Presence is not Capability)。
    const inContext = ordered.filter((e) => SEMI_CONTEXT.test(e.evidenceText));
    const { caps, ledger, reuseChecks } = deriveCompanyCaps(inContext);
    const profileCaps = caps.filter((c) => c.role !== "unknown");
    const stages = [...new Set(profileCaps.map((c) => c.manufacturingStage))];
    const applications = [...new Set(profileCaps.flatMap((c) => c.applications))];
    const roles = [...new Set(profileCaps.map((c) => c.role))];
    const equipmentTypes = [...new Set(profileCaps.filter((c) => c.equipmentType).map((c) => c.equipmentType!))].map((type) => ({
      type,
      applications: [...new Set(profileCaps.filter((c) => c.equipmentType === type).flatMap((c) => c.applications))],
      evidenceIds: [...new Set(profileCaps.filter((c) => c.equipmentType === type).flatMap((c) => c.evidenceIds))],
    }));
    const materialTypes = [...new Set(profileCaps.filter((c) => c.materialType).map((c) => c.materialType!))].map((type) => ({
      type,
      applications: [...new Set(profileCaps.filter((c) => c.materialType === type).flatMap((c) => c.applications))],
      evidenceIds: [...new Set(profileCaps.filter((c) => c.materialType === type).flatMap((c) => c.evidenceIds))],
    }));
    const componentTypes = [...new Set(profileCaps.filter((c) => c.componentType).map((c) => c.componentType!))].map((type) => ({
      type,
      applications: [...new Set(profileCaps.filter((c) => c.componentType === type).flatMap((c) => c.applications))],
      evidenceIds: [...new Set(profileCaps.filter((c) => c.componentType === type).flatMap((c) => c.evidenceIds))],
    }));

    const labels = new Set<string>();
    for (const cap of profileCaps) {
      // s3-derive-v3(§30):只有 DIRECT_COMPANY_CAPABILITY 可作为检索标签 ——
      // 受测曝光/制造方法/行业语境的解释不进入 searchText。
      if (cap.attribution !== "DIRECT_COMPANY_CAPABILITY") continue;
      // pv/display-only 应用的能力不进检索标签(规格第十三节:光伏/显示设备
      // ≠ 半导体设备;能力保留在 domainKnowledge 供区分,标签只给半导体语境)。
      const pvDisplayOnly = cap.applications.length > 0 && cap.applications.every((a) => a === "pv" || a === "display");
      if (pvDisplayOnly) continue;
      if (cap.equipmentType && EQUIP_LABELS[cap.equipmentType]) labels.add(EQUIP_LABELS[cap.equipmentType]);
      if (cap.materialType && MATERIAL_LABELS[cap.materialType]) labels.add(MATERIAL_LABELS[cap.materialType]);
      if (cap.componentType && COMPONENT_LABELS[cap.componentType]) labels.add(COMPONENT_LABELS[cap.componentType]);
      if (cap.specificProcess && SPECIFIC_LABELS[cap.specificProcess]) labels.add(SPECIFIC_LABELS[cap.specificProcess]);
    }

    // SOURCE_GAP(规格第二十七节):universe 词面提示、但权威来源未见的能力
    const sourceGap: EnrichmentRecord["sourceGap"] = [];
    if (entry.level === "A" && profileCaps.length === 0) {
      const expected = [...entry.signals.productEquipWords, ...entry.signals.productMaterialWords, ...entry.signals.textEquipWords];
      if (expected.length) {
        sourceGap.push({ capability: expected.slice(0, 5).join("/"), expectedFrom: "universe 产品词面" });
      }
    }

    const record: EnrichmentRecord = {
      code: entry.code,
      name: entry.name,
      level: entry.level,
      domain: "semiconductor",
      enrichmentVersion: SEMICONDUCTOR_ENRICHMENT_VERSION,
      deriveVersion: SEMICONDUCTOR_DERIVE_VERSION,
      manufacturingStages: stages,
      processCapabilities: profileCaps,
      equipmentTypes,
      materialTypes,
      componentTypes,
      applications,
      roles,
      retrievalLabels: [...labels],
      sourceGap,
      attributionLedger: ledger,
      reuseChecks,
      checkedSources: [...checked1, ...checked3],
    };
    records.push(record);

    // 证据入库:Tier1 全留(页码证据);Tier3 留 CURRENT + 能力引用到的,
    // 其余 HISTORICAL 行只留样本(整段历史主营构成在 raw 快照里可重放)
    const referencedIds = new Set(profileCaps.flatMap((c) => c.evidenceIds));
    const keep = ordered.filter((e) => {
      if (e.sourceType === "annual_report") return true;
      if (referencedIds.has(e.evidenceId)) return true;
      return e.status === "CURRENT";
    });
    if (profileCaps.length === 0) {
      const audit = keep.filter((e) => e.sourceType === "annual_report").slice(0, 12);
      const tier3Keep = keep.filter((e) => e.sourceType !== "annual_report").slice(0, 3);
      allEvidence.push(...audit, ...tier3Keep);
    } else {
      allEvidence.push(...keep);
    }

    // stats
    stats.companiesChecked += 1;
    if (profileCaps.length) {
      stats.companiesWithCapabilities += 1;
      if (equipmentTypes.length) stats.withEquipment += 1;
      if (materialTypes.length) stats.withMaterial += 1;
      if (componentTypes.length) stats.withComponent += 1;
    }
    if (tier1.length) {
      stats.tier1Companies += 1;
      stats.tier1Evidence += tier1.length;
    }
    stats.tier3Evidence += tier3.length;
    if (sourceGap.length) stats.sourceGapCompanies += 1;
    // s3-derive-v3 数据质量统计(规格§24/§31):归属/证据质量/复用复查
    for (const cap of profileCaps) {
      const attr = cap.attribution ?? "DIRECT_COMPANY_CAPABILITY";
      stats.attribution[attr] = (stats.attribution[attr] ?? 0) + 1;
      const q = cap.evidenceQuality ?? "STRONG";
      stats.evidenceQuality[q] = (stats.evidenceQuality[q] ?? 0) + 1;
    }
    for (const entry of ledger) {
      stats.ledgerAttribution[entry.attribution] = (stats.ledgerAttribution[entry.attribution] ?? 0) + 1;
    }
    stats.reuseChecksTotal += reuseChecks.length;
    stats.reuseDowngraded += reuseChecks.filter((c) => c.downgraded).length;
    for (const cap of profileCaps) {
      const key = cap.process ?? "?";
      stats.perProcess[key] = (stats.perProcess[key] ?? 0) + 1;
      if (cap.equipmentType) stats.perEquipment[cap.equipmentType] = (stats.perEquipment[cap.equipmentType] ?? 0) + 1;
      if (cap.materialType) stats.perMaterial[cap.materialType] = (stats.perMaterial[cap.materialType] ?? 0) + 1;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "evidence.json"), JSON.stringify({ version: SEMICONDUCTOR_ENRICHMENT_VERSION, evidence: allEvidence }));
  writeFileSync(path.join(OUT_DIR, "enrichment.json"), JSON.stringify({ version: SEMICONDUCTOR_ENRICHMENT_VERSION, records }, null, 1) + "\n");
  writeFileSync(path.join(OUT_DIR, "enrichment_stats.json"), JSON.stringify(stats, null, 1) + "\n");

  console.log(`checked ${stats.companiesChecked} (A+B) companies, ${stats.companiesWithCapabilities} with capabilities`);
  console.log(`equipment ${stats.withEquipment}, material ${stats.withMaterial}, component ${stats.withComponent}, sourceGap ${stats.sourceGapCompanies}`);
  console.log(`evidence: tier1=${stats.tier1Evidence}(${stats.tier1Companies} companies) tier3=${stats.tier3Evidence}`);
  console.log("perProcess:", JSON.stringify(stats.perProcess));
}

main();
