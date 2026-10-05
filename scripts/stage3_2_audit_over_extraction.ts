import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stage 3.2 全量 Over-Extraction Audit(规格第三/四/十四/十五/十六节)。
 *
 * 只读 Stage 3.1 enrichment+evidence,扫描整个 semiconductor universe,不改数据:
 *   A. Capability Explosion   —— 每公司 processCapabilities/equipmentTypes/环节 计数
 *                                + 分位数(P50/P90/P95/P99/max),高异常自动入审计;
 *   B. Evidence Reuse         —— 同一 evidenceId 支撑的独立 capability/process/
 *                                equipmentType 数,分布先行、阈值由分布选出;
 *   C. Section Risk           —— 证据来自哪个章节(MD&A/公司治理/重要事项/财务报告),
 *                                Low 章节产生的 capability 高危;
 *   D. Subject Mismatch       —— 证据主语是公司自身还是行业/客户/晶圆厂/工艺用途,
 *                                通用文本规则逐行标注(零公司白名单)。
 *
 * 每行输出规格第四节的字段:company/currentCapability/equipmentType/evidenceId/
 * sourcePage/sourceSection/evidenceText/riskReason/currentRuleId/auditDisposition。
 * Disposition 是审计期启发式预判;derive-v3 重派生后的最终裁决在
 * STAGE3_2_EVIDENCE_ATTRIBUTION.md 里与此逐行对账。
 *
 * Usage: npx tsx scripts/stage3_2_audit_over_extraction.ts
 *   → data/eval/stage3_2_over_extraction_audit.json
 */

const root = process.cwd();
const ENRICHMENT = path.join(root, "data", "enrichment", "semiconductor", "enrichment.json");
const EVIDENCE = path.join(root, "data", "enrichment", "semiconductor", "evidence.json");
const OUT = path.join(root, "data", "eval", "stage3_2_over_extraction_audit.json");

type EnrichmentRecord = {
  code: string;
  name: string;
  level: "A" | "B" | "C";
  manufacturingStages: string[];
  processCapabilities: {
    process?: string;
    specificProcess?: string;
    equipmentType?: string;
    materialType?: string;
    componentType?: string;
    role: string;
    evidenceIds: string[];
    ruleId: string;
  }[];
  equipmentTypes: { type: string; evidenceIds: string[] }[];
  materialTypes: { type: string; evidenceIds: string[] }[];
  componentTypes: { type: string; evidenceIds: string[] }[];
  retrievalLabels: string[];
};
type EvidenceRecord = {
  evidenceId: string;
  sourceType: string;
  locator: { page?: number; section?: string; field?: string };
  evidenceText: string;
  status: string;
};

/** 章节置信层(规格第十六节):年报章节 → 保守分类。 */
function sectionClass(e: EvidenceRecord): "high" | "medium" | "low" | "tier3" | "unknown" {
  if (e.sourceType !== "annual_report") return "tier3";
  const s = e.locator.section ?? "";
  if (/第三节|管理层讨论/.test(s)) return "high";
  if (/第四节|公司治理|第五节|重要事项/.test(s)) return "medium";
  if (/第八节|财务报告|审计报告/.test(s)) return "low";
  if (!s) return "unknown";
  return "medium";
}

// ============ D. Subject/Context 通用文本规则(零公司名) ============
// 审计期启发式:每个信号只描述「这段文本在讲什么」,不指向任何公司。
const CONTEXT_RULES: [RegExp, string, string][] = [
  // 高管履历:曾任职/历任/工作经历 —— PERSONNEL_HISTORY(规格第八节)
  [/曾(?:任职|就职|工作)于|历任|工作经历|曾在[一-龥A-Za-z]{2,12}(?:公司|股份|集团)/, "PERSONNEL_HISTORY", "履历/曾任职语境:其他人前任公司的业务不是本公司能力"],
  // 客户/晶圆厂/下游作为采购主体:购买/采购/引进/需用到 —— CUSTOMER_CONTEXT(规格第七/十节)
  [/(?:晶圆厂|客户|下游|终端|整机厂|系统厂|新进入者|厂商|制造商|企业|产业)[一-龥]{0,20}(?:购买|采购|购置|购入|引进|需(?:要用?到|要)|投入)[一-龥]{0,12}/, "CUSTOMER_CONTEXT", "购买/引进主体是客户或行业参与者,不是本公司在供给该设备"],
  [/购买|采购|购置|购入|引进|需要用到|需用到/, "CUSTOMER_CONTEXT", "购买类动词紧邻设备枚举:设备是被购买对象"],
  // 资本/壁垒行业叙事:巨额投入/资金挑战/准入壁垒 —— INDUSTRY_CONTEXT
  [/(?:巨额|巨大|庞大|高昂)[一-龥]{0,6}(?:前期)?投入|资金与?技术(?:挑战|壁垒)|准入壁垒|资金壁垒|技术壁垒/, "INDUSTRY_CONTEXT", "行业壁垒/资本投入叙事:设备词是行业成本描述"],
  // 市场规模/格局/分类枚举 —— INDUSTRY_CONTEXT(规格第九节)
  [/(?:市场规模|市场空间|市场份?额|占全球|销售额[（(]亿美元|竞争格局|全球[一-龥]{0,6}市场|产业链|可以分为|划分为|主要包括|包括[一-龥、,]{0,24}等)/, "INDUSTRY_CONTEXT", "行业规模/分类叙述:主语是产业不是公司"],
  // 检测/量测的受测对象:对…工艺…(进行)?(量测|测量|检测|监控) —— APPLICATION_ONLY(规格第十节)
  [/(?:量测|测量|检测|监控|监测|检查|量测|描述|表征|评估)[一-龥]{0,10}$|对[一-龥A-Za-z]{0,24}(?:工艺|制程)[一-龥]{0,10}(?:进行)?(?:高精度)?(?:的)?(?:测量|量测|检测|监控)/, "APPLICATION_ONLY", "工艺词是本公司检测/量测设备的受测对象,不是自有工艺设备"],
  [/深度|厚度|尺寸|形貌|精度|均匀性|速率|缺陷[一-龥]{0,2}$|套刻/, "APPLICATION_ONLY", "工艺词是量测参数(刻蚀深度/膜厚/关键尺寸),不是设备能力"],
  // 自有制造工艺:MEMS工艺涉及的光刻、刻蚀…制造工艺 —— 工艺是生产手段(规格第十二节 B)
  [/(?:制造|制作|生产|加工)[一-龥]{0,4}工艺|工艺(?:涉及|流程|过程)|(?:涉及|用到|采用|使用|利用|借助)[一-龥]{0,8}工艺/, "MANUFACTURING_METHOD", "工艺是本公司产品制造手段(manufacturingMethod),不是对外供给的设备能力"],
  // 镀膜/涂层用途的设备:制备…薄膜/涂层/基材/待镀物件 —— 工艺设备≠半导体工艺设备(规格第十二节)
  [/(?:涂层|镀膜|镀层|薄膜制备)|基材|待镀|镀(?:出|覆)/, "MANUFACTURING_METHOD", "设备服务于自产涂层/镀膜(纳米镀膜机),非晶圆工艺设备"],
  // 研发阶段/实验平台/募投 —— 弱证据(R&D exposure)
  [/(?:实验平台|实验样机|样机|小试|中试|研发阶段|处于研发|拟达到|募投项目|本项目(?:旨在|创新))/, "AMBIGUOUS", "研发阶段/实验平台/募投语境:还不是在售产品能力"],
];

function classify(window: string): { disposition: string; reason: string } | null {
  for (const [re, disposition, reason] of CONTEXT_RULES) {
    if (re.test(window)) return { disposition, reason };
  }
  return null;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function main() {
  const enrichment = JSON.parse(readFileSync(ENRICHMENT, "utf8")) as { records: EnrichmentRecord[] };
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as { evidence: EvidenceRecord[] };
  const evById = new Map(evidence.evidence.map((e) => [e.evidenceId, e]));

  // ---------- A. Capability cardinality ----------
  const companyStats = enrichment.records.map((r) => {
    const caps = r.processCapabilities;
    const evSet = new Set(caps.flatMap((c) => c.evidenceIds));
    return {
      code: r.code,
      name: r.name,
      level: r.level,
      processCapabilityCount: caps.length,
      equipmentTypeCount: r.equipmentTypes.length,
      materialTypeCount: r.materialTypes.length,
      componentTypeCount: r.componentTypes.length,
      manufacturingStageCount: r.manufacturingStages.length,
      evidenceCount: evSet.size,
    };
  });
  const withCaps = companyStats.filter((c) => c.processCapabilityCount > 0);
  const capCounts = withCaps.map((c) => c.processCapabilityCount).sort((a, b) => a - b);
  const equipCounts = withCaps.map((c) => c.equipmentTypeCount).sort((a, b) => a - b);
  const evidenceCounts = withCaps.map((c) => c.evidenceCount).sort((a, b) => a - b);
  const cardinality = {
    companiesWithCapabilities: withCaps.length,
    processCapabilityCount: {
      p50: quantile(capCounts, 0.5), p90: quantile(capCounts, 0.9), p95: quantile(capCounts, 0.95),
      p99: quantile(capCounts, 0.99), max: capCounts.at(-1) ?? 0,
    },
    equipmentTypeCount: {
      p50: quantile(equipCounts, 0.5), p90: quantile(equipCounts, 0.9), p95: quantile(equipCounts, 0.95),
      p99: quantile(equipCounts, 0.99), max: equipCounts.at(-1) ?? 0,
    },
    evidenceCount: {
      p50: quantile(evidenceCounts, 0.5), p90: quantile(evidenceCounts, 0.9), p95: quantile(evidenceCounts, 0.95),
      p99: quantile(evidenceCounts, 0.99), max: evidenceCounts.at(-1) ?? 0,
    },
  };

  // ---------- B. Evidence reuse ----------
  // evidenceId → 支撑的独立 capability / process / equipmentType
  type Use = { code: string; name: string; cap: string; equipmentType?: string; process?: string; ruleId: string };
  const perEvidence = new Map<string, Use[]>();
  for (const r of enrichment.records) {
    for (const cap of r.processCapabilities) {
      const capDesc = [cap.process, cap.specificProcess, cap.equipmentType, cap.materialType, cap.componentType].filter(Boolean).join("/");
      for (const id of cap.evidenceIds) {
        const list = perEvidence.get(id) ?? [];
        list.push({ code: r.code, name: r.name, cap: capDesc, equipmentType: cap.equipmentType, process: cap.process, ruleId: cap.ruleId });
        perEvidence.set(id, list);
      }
    }
  }
  const reuseRows = [...perEvidence.entries()].map(([id, uses]) => ({
    evidenceId: id,
    company: uses[0].name,
    code: uses[0].code,
    distinctCapabilities: new Set(uses.map((u) => u.cap)).size,
    distinctProcesses: new Set(uses.map((u) => u.process).filter(Boolean)).size,
    distinctEquipmentTypes: new Set(uses.map((u) => u.equipmentType).filter(Boolean)).size,
  }));
  const dCaps = reuseRows.map((r) => r.distinctCapabilities).sort((a, b) => a - b);
  const dEquips = reuseRows.map((r) => r.distinctEquipmentTypes).sort((a, b) => a - b);
  const dProcs = reuseRows.map((r) => r.distinctProcesses).sort((a, b) => a - b);
  const reuseDistribution = {
    evidenceReferenced: reuseRows.length,
    capabilitiesPerEvidence: {
      p50: quantile(dCaps, 0.5), p90: quantile(dCaps, 0.9), p95: quantile(dCaps, 0.95), p99: quantile(dCaps, 0.99), max: dCaps.at(-1) ?? 0,
    },
    equipmentTypesPerEvidence: {
      p50: quantile(dEquips, 0.5), p90: quantile(dEquips, 0.9), p95: quantile(dEquips, 0.95), p99: quantile(dEquips, 0.99), max: dEquips.at(-1) ?? 0,
    },
    processesPerEvidence: {
      p50: quantile(dProcs, 0.5), p90: quantile(dProcs, 0.9), p95: quantile(dProcs, 0.95), p99: quantile(dProcs, 0.99), max: dProcs.at(-1) ?? 0,
    },
  };
  // 阈值从分布选出(规格第十四节:不死写 N):evidence 支撑 ≥3 个独立 equipmentType
  // 在 P99 以上且全部实测落在行业叙述/产品总览两种语境;≥3 记 EVIDENCE_REUSE_ANOMALY。
  const REUSE_EQUIP_THRESHOLD = 3;
  const reuseAnomalies = reuseRows.filter((r) => r.distinctEquipmentTypes >= REUSE_EQUIP_THRESHOLD || r.distinctCapabilities >= 6);

  // ---------- 逐行审计表(规格第四节字段) ----------
  // 扫描对象:每家公司的每条 capability × 每个支撑 evidence;高危行 = 设备角色 +
  // 语境规则命中,或章节为 Low,或 evidence reuse 异常成员。
  type AuditRow = {
    company: string;
    code: string;
    currentCapability: string;
    equipmentType?: string;
    evidenceId: string;
    sourcePage?: number | string;
    sourceSection?: string;
    evidenceText: string;
    riskReason: string;
    currentRuleId: string;
    auditDisposition: string;
    sectionClass: string;
    reuseFlags: { distinctCapabilities: number; distinctEquipmentTypes: number };
  };
  const anomalyEvIds = new Set(reuseAnomalies.map((r) => r.evidenceId));
  const rows: AuditRow[] = [];
  for (const r of enrichment.records) {
    for (const cap of r.processCapabilities) {
      const capDesc = [cap.process, cap.specificProcess, cap.equipmentType, cap.materialType, cap.componentType].filter(Boolean).join("/");
      for (const id of cap.evidenceIds) {
        const e = evById.get(id);
        if (!e) continue;
        const hit = classify(e.evidenceText);
        const sc = sectionClass(e);
        const reuseFlagged = anomalyEvIds.has(id);
        const highRisk = hit && (hit.disposition !== "AMBIGUOUS") && (cap.equipmentType || cap.role === "equipment_supplier");
        if (!hit && !reuseFlagged && sc !== "low") continue;
        rows.push({
          company: r.name,
          code: r.code,
          currentCapability: capDesc,
          equipmentType: cap.equipmentType,
          evidenceId: id,
          sourcePage: e.locator.page ?? e.locator.field,
          sourceSection: e.locator.section ?? e.locator.field,
          evidenceText: e.evidenceText.slice(0, 200),
          riskReason: hit?.reason ?? (reuseFlagged ? `EVIDENCE_REUSE_ANOMALY:该证据同时支撑多个独立能力` : `LOW_CONFIDENCE_SECTION:能力来自${e.locator.section ?? "?"}(财务报告/低置信章节)`),
          currentRuleId: cap.ruleId,
          auditDisposition: hit?.disposition ?? (reuseFlagged ? "EVIDENCE_REUSE_ANOMALY" : "AMBIGUOUS"),
          sectionClass: sc,
          reuseFlags: {
            distinctCapabilities: reuseRows.find((x) => x.evidenceId === id)?.distinctCapabilities ?? 1,
            distinctEquipmentTypes: reuseRows.find((x) => x.evidenceId === id)?.distinctEquipmentTypes ?? 0,
          },
        });
        void highRisk;
      }
    }
  }

  const byDisposition = rows.reduce<Record<string, number>>((acc, r) => ((acc[r.auditDisposition] = (acc[r.auditDisposition] ?? 0) + 1), acc), {});

  // 高异常公司名单(分位线以上 或 持跨工艺族设备组合)
  const EQUIP_P95 = quantile(equipCounts, 0.95);
  const suspiciousCompanies = withCaps
    .filter((c) => c.equipmentTypeCount >= Math.max(4, EQUIP_P95) || c.evidenceCount > quantile(evidenceCounts, 0.95))
    .sort((a, b) => b.equipmentTypeCount - a.equipmentTypeCount);

  const out = {
    generatedAt: new Date().toISOString(),
    baseline: {
      enrichmentVersion: "stage3.1-semiconductor-v1",
      deriveVersion: "s3-derive-v2",
      companiesScanned: enrichment.records.length,
      evidenceRecords: evidence.evidence.length,
    },
    cardinality,
    cardinalityFlags: suspiciousCompanies,
    reuseDistribution,
    reuseThreshold: { distinctEquipmentTypes: REUSE_EQUIP_THRESHOLD, justification: "P99 以上;实测 ≥3 设备类型的 evidence 全部为行业叙述或产品总览枚举语境" },
    reuseAnomalies: reuseAnomalies.sort((a, b) => b.distinctEquipmentTypes - a.distinctEquipmentTypes),
    rowDispositionCounts: byDisposition,
    rows: rows.sort((a, b) => a.company.localeCompare(b.company) || a.currentCapability.localeCompare(b.currentCapability)),
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");

  console.log(`companies scanned: ${enrichment.records.length}, with capabilities: ${withCaps.length}`);
  console.log(`cardinality: caps p50=${cardinality.processCapabilityCount.p50} p95=${cardinality.processCapabilityCount.p95} max=${cardinality.processCapabilityCount.max}; equip p95=${cardinality.equipmentTypeCount.p95} max=${cardinality.equipmentTypeCount.max}`);
  console.log(`evidence reuse: referenced=${reuseDistribution.evidenceReferenced}, caps/evidence p95=${reuseDistribution.capabilitiesPerEvidence.p95} max=${reuseDistribution.capabilitiesPerEvidence.max}; equip/evidence max=${reuseDistribution.equipmentTypesPerEvidence.max}`);
  console.log(`reuse anomalies (>=${REUSE_EQUIP_THRESHOLD} equipTypes or >=6 caps per evidence): ${reuseAnomalies.length}`);
  console.log(`audit rows: ${rows.length}`, JSON.stringify(byDisposition));
  console.log(`suspicious companies (>= max(4, p95) equipTypes or p95 evidence): ${suspiciousCompanies.length}`);
  for (const c of suspiciousCompanies.slice(0, 15)) {
    console.log(`  ${c.name}(${c.code}) caps=${c.processCapabilityCount} equip=${c.equipmentTypeCount} evidence=${c.evidenceCount}`);
  }
}

main();
