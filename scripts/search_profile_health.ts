import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Knowledge Health(Stage 3.2 规格第三十一节)—— enrichment 数据层永久健康检查。
 *
 *   npm run search-profile:health [-- --domain semiconductor]
 *
 * 六项检查(对任何 domain 的 enrichment 通用,机器人/液冷等后续行业直接复用):
 *   CAPABILITY_EXPLOSION        单公司能力基数异常(分位线 + 跨工艺族组合)
 *   EVIDENCE_REUSE_ANOMALY      一条证据支撑过多独立能力(阈值:≥3 类设备/≥6 能力)
 *   LOW_CONFIDENCE_CAPABILITY   设备能力缺少 DIRECT/STRONG 证据质量标注
 *   CONTEXT_ONLY_CAPABILITY     语境归属的能力却带 equipmentType(不变量,必须为 0)
 *   SUBJECT_MISMATCH            能力证据含他人主语标记(履历/行业购买/其他公司)
 *   ROLE_CAPABILITY_CONFLICT    设备角色能力无主营窗口支撑(主营仲裁漏洞)
 *
 * 输出 reports/knowledge-health/knowledge_health_<date>.{json,md}。
 * 发现不阻断构建;CONTEXT_ONLY_CAPABILITY/SUBJECT_MISMATCH 非零 = 数据不变量
 * 被破坏,晋级前必须清零。
 */

const root = process.cwd();
const argIdx = process.argv.indexOf("--domain");
const domain = argIdx >= 0 ? process.argv[argIdx + 1] : "semiconductor";
const DIR = path.join(root, "data", "enrichment", domain);

type Cap = {
  process?: string;
  specificProcess?: string;
  equipmentType?: string;
  materialType?: string;
  componentType?: string;
  role: string;
  confidence: number;
  evidenceIds: string[];
  attribution?: string;
  evidenceQuality?: string;
  ruleId: string;
};
type Record0 = {
  code: string;
  name: string;
  processCapabilities: Cap[];
  equipmentTypes: { type: string; evidenceIds: string[] }[];
  attributionLedger?: { attribution: string; evidenceIds: string[]; equipmentType?: string }[];
  reuseChecks?: { evidenceId: string; equipmentTypes: string[]; legitSelfEnum: boolean; downgraded: boolean }[];
};
type Evidence0 = { evidenceId: string; evidenceText: string; sourceType: string };

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// 通用主语失配标记(零公司专名,任何行业可复用)。
// 注意:「客户…采购」通常是销售语境(客户买公司的产品),不构成失配;
// 厂商类标记要求设备词紧邻(「光刻机龙头厂商」),「封装厂商/面板厂商」不触发。
const SUBJECT_MISMATCH_MARKERS: [RegExp, string][] = [
  [/曾(?:任职|就职|工作)于|历任|工作经历/, "personnel-history"],
  [/(?:晶圆厂|下游|终端|整机厂)[一-龥]{0,16}(?:购买|采购|购置|引进)/, "customer-purchase"],
  [/(?:全球|国际|国外|海外)[一-龥A-Za-z]{0,8}(?:设备|机|装备)(?:龙头)?(?:厂商|制造商|生产商|企业)|(?:龙头|头部|知名|主流|领先)[一-龥A-Za-z]{0,6}(?:设备|机|装备)(?:厂商|制造商|生产商|企业)/, "industry-vendor"],
];

/** 跨工艺族设备组合(检测企业挂着 刻蚀+沉积+清洗+CMP+光刻+注入 的形状)。 */
const PROCESS_FAMILIES = ["etcher", "deposition_equipment", "cleaning_equipment", "CMP_equipment", "lithography_equipment", "ion_implanter"];

function main() {
  if (!existsSync(path.join(DIR, "enrichment.json"))) {
    console.error(`no enrichment for domain ${domain} at ${DIR}`);
    process.exit(1);
  }
  const records = (JSON.parse(readFileSync(path.join(DIR, "enrichment.json"), "utf8")).records ?? []) as Record0[];
  const evidencePath = path.join(DIR, "evidence.json");
  const evidenceById = new Map<string, Evidence0>();
  if (existsSync(evidencePath)) {
    for (const e of (JSON.parse(readFileSync(evidencePath, "utf8")).evidence ?? []) as Evidence0[]) evidenceById.set(e.evidenceId, e);
  }

  const findings: { type: string; code?: string; name?: string; detail: string }[] = [];

  // —— 基数分位(§15) ——
  const withCaps = records.filter((r) => r.processCapabilities.length);
  const equipCounts = withCaps.map((r) => r.equipmentTypes.length).sort((a, b) => a - b);
  const capCounts = withCaps.map((r) => r.processCapabilities.length).sort((a, b) => a - b);
  const equipP95 = quantile(equipCounts, 0.95);
  const capP95 = quantile(capCounts, 0.95);

  for (const r of records) {
    const equipN = r.equipmentTypes.length;
    const capN = r.processCapabilities.length;
    // 1. CAPABILITY_EXPLOSION
    if (capN > 0 && (equipN >= Math.max(4, equipP95) || capN >= Math.max(6, capP95))) {
      const families = new Set(r.equipmentTypes.map((e) => e.type).filter((t) => PROCESS_FAMILIES.includes(t)));
      const crossFamily = families.size >= 4;
      findings.push({
        type: "CAPABILITY_EXPLOSION",
        code: r.code,
        name: r.name,
        detail: `equip=${equipN}(p95=${equipP95}) caps=${capN}(p95=${capP95})${crossFamily ? ` 跨工艺族组合 [${[...families].join("、")}] —— 需确认自主产品枚举支撑` : ""}`,
      });
    }
    for (const cap of r.processCapabilities) {
      // 2. CONTEXT_ONLY_CAPABILITY(不变量:语境归属不得带设备类型)
      if (cap.equipmentType && cap.attribution && cap.attribution !== "DIRECT_COMPANY_CAPABILITY") {
        findings.push({ type: "CONTEXT_ONLY_CAPABILITY", code: r.code, name: r.name, detail: `${cap.equipmentType} attribution=${cap.attribution} —— 不变量被破坏` });
      }
      // 3. LOW_CONFIDENCE_CAPABILITY
      if (cap.equipmentType && (cap.evidenceQuality === "WEAK" || (cap.evidenceQuality == null && cap.confidence < 0.75))) {
        findings.push({ type: "LOW_CONFIDENCE_CAPABILITY", code: r.code, name: r.name, detail: `${cap.equipmentType} quality=${cap.evidenceQuality ?? "missing"} confidence=${cap.confidence} rule=${cap.ruleId}` });
      }
      // 4. SUBJECT_MISMATCH:DIRECT 设备能力的**全部**支撑证据都含他人主语标记
      //    (任一干净证据存在即可信;全脏 = 主语失配不变量被破坏)
      if (cap.equipmentType && cap.attribution === "DIRECT_COMPANY_CAPABILITY" && cap.evidenceIds.length) {
        const dirty = cap.evidenceIds.filter((id) => {
          const ev = evidenceById.get(id);
          if (!ev) return false;
          return SUBJECT_MISMATCH_MARKERS.some(([re]) => re.test(ev.evidenceText));
        });
        if (dirty.length === cap.evidenceIds.length) {
          findings.push({ type: "SUBJECT_MISMATCH", code: r.code, name: r.name, detail: `${cap.equipmentType} 的全部 ${dirty.length} 条证据含他人主语标记(如 ${dirty[0]})—— 主语失配` });
        }
      }
    }
  }
  // 5. EVIDENCE_REUSE_ANOMALY(enrichment 记录的复查项)
  let reuseAnomalies = 0;
  for (const r of records) {
    for (const chk of r.reuseChecks ?? []) {
      if (!chk.legitSelfEnum) {
        reuseAnomalies += 1;
        findings.push({ type: "EVIDENCE_REUSE_ANOMALY", code: r.code, name: r.name, detail: `${chk.evidenceId} 支撑 [${chk.equipmentTypes.join("、")}] 且非自主枚举${chk.downgraded ? " —— 已降级" : ""}` });
      }
    }
  }
  // 6. ROLE_CAPABILITY_CONFLICT:设备能力没有任何主营级(直接句式)证据支撑 ——
  //    粗判:设备 cap 的全部证据 id 都不在 DIRECT 质量集合里
  for (const r of records) {
    for (const cap of r.processCapabilities) {
      if (!cap.equipmentType || cap.role !== "equipment_supplier") continue;
      const directEv = cap.evidenceIds.filter((id) => evidenceById.get(id)?.sourceType !== "annual_report");
      if (cap.evidenceQuality === "STRONG" && directEv.length === 0 && cap.evidenceIds.length === 1) {
        findings.push({ type: "ROLE_CAPABILITY_CONFLICT", code: r.code, name: r.name, detail: `${cap.equipmentType} 仅由单一 STRONG 证据支撑,无主营/registry 直接证据 rule=${cap.ruleId}` });
      }
    }
  }

  const counts = findings.reduce<Record<string, number>>((a, f) => ((a[f.type] = (a[f.type] ?? 0) + 1), a), {});
  const out = {
    generatedAt: new Date().toISOString(),
    domain,
    enrichmentVersion: JSON.parse(readFileSync(path.join(DIR, "enrichment_stats.json"), "utf8")).enrichmentVersion,
    deriveVersion: JSON.parse(readFileSync(path.join(DIR, "enrichment_stats.json"), "utf8")).deriveVersion,
    companies: records.length,
    withCapabilities: withCaps.length,
    cardinality: { equipP95, capP95, equipMax: equipCounts.at(-1) ?? 0, capMax: capCounts.at(-1) ?? 0 },
    reuseAnomalies,
    findingCounts: counts,
    findings,
  };
  const dir = path.join(root, "reports", "knowledge-health");
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  writeFileSync(path.join(dir, `knowledge_health_${date}.json`), JSON.stringify(out, null, 1));
  const lines = [
    `# Knowledge Health — ${domain} ${date}`,
    "",
    `enrichment=${out.enrichmentVersion} derive=${out.deriveVersion};${records.length} 家(${withCaps.length} 家有能力)`,
    "",
    ...Object.entries(counts).map(([k, n]) => `- ${k}: ${n}`),
    "",
  ];
  for (const f of findings.slice(0, 60)) lines.push(`- **${f.type}** ${f.name}(${f.code}) ${f.detail}`);
  writeFileSync(path.join(dir, `knowledge_health_${date}.md`), lines.join("\n") + "\n");
  console.log(`domain=${domain} companies=${records.length} findings:`, JSON.stringify(counts));
  console.log(`wrote reports/knowledge-health/knowledge_health_${date}.{json,md}`);
}

main();
