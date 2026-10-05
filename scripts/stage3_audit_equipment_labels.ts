import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deriveFromEvidence, mergeCapabilities, type SemiCapability, type SemiEvidence } from "../search/knowledge/semiconductor";

/**
 * Stage 3.1 设备标签词面审计(before 侧扫描器,规格第二节)。
 *
 * 对每家带 equipmentTypes 的公司:
 *   1. 找出主营窗口(年报主营业务概述段 + zyjs/zygc filing 主营行)作为
 *      「公司自我语义」参照,独立重派生 primary 能力;
 *   2. 对当前每条设备能力的支撑窗口做负语境/正语境特征标记;
 *   3. 公司级判定 TRUE_EQUIPMENT / COMPONENT_SUPPLIER / MATERIAL_SUPPLIER /
 *      AMBIGUOUS。
 *
 * 扫描器只读 Stage 3 数据,不改派生 —— 它是审计证据,不是修复本身。
 *
 * Usage: npx tsx scripts/stage3_audit_equipment_labels.ts [before|after]
 *   → data/eval/stage3_1_equipment_audit_<side>.json
 */

const root = process.cwd();
const side = process.argv[2] === "after" ? "after" : "before";
const ENRICHMENT = path.join(root, "data", "enrichment", "semiconductor", "enrichment.json");
const EVIDENCE = path.join(root, "data", "enrichment", "semiconductor", "evidence.json");

/** 负语境:设备词不是「公司生产的产品」的信号(词面特征,不指向任何公司)。 */
const NEG_CONTEXT: [RegExp, string][] = [
  [/半导体设备零(部|配)件|设备零(部|配)件|设备部件|设备核心零(部|配)件|设备用(材料|部件|零件)|设备耗材/, "equipment-part-phrase"],
  [/(下游|用于|用在|适用于|供|配套|配套设备|服务|面向|供货|进入|所需|相关)(的)?[^。]{0,8}(半导体)?设备/, "application-or-downstream"],
  [/等(半导体)?(设备)?[一-龥]{0,4}(应用领域|领域|应用)/, "application-enumeration"],
  [/(由|是)[一-龥]{0,20}(构成|组成|结合)/, "equipment-anatomy"],
  [/(全球|国外|海外|国际|境外|各家|众多|头部|龙头|知名|主要|其他)[一-龥]{0,6}(设备)?(厂商|制造商|生产商|企业|公司)/, "industry-subject"],
  [/(厂商|制造商|生产商|客户|企业)$/, "counterparty-suffix"],
  [/与[一-龥A-Za-z（）()0-9、]{0,40}(设备|机|装备)[一-龥（）()]{0,12}(配合|配套|协同|联合|衔接|并用|联机)/, "paired-equipment"],
  [/(设备)?(表面处理|维修|维护|保养|改造|回收|清洁)服务/, "equipment-service"],
];

/** 正语境:公司自身语义明确在研发/生产/制造/销售/提供设备的信号。 */
const POS_CONTEXT: [RegExp, string][] = [
  [/(公司|本司|发行人|我们)[一-龥]{0,6}的[^。]{0,8}(设备|机|装备)/, "possessive-equipment"],
  [/(研发|研制|生产|制造|销售|提供|推出|开发|自研|主营|交付|付运|量产|出货|中标)[^。]{0,14}(半导体)?(设备|装备|机)/, "production-verb"],
  [/(设备|装备)[^。]{0,10}(销售收入|收入|订单|营业收入|业务收入)/, "equipment-revenue"],
  [/(主营)?产品(包括|为|有|涵盖)[^。]{0,20}(设备|机|装备)/, "product-frame"],
];

type WindowFlag = { evidenceId: string; ruleId: string; equipmentType?: string; neg: string[]; pos: string[]; text: string };

type CompanyAudit = {
  code: string;
  name: string;
  currentEquipmentTypes: string[];
  currentRoles: string[];
  primaryBusinessText: string;
  primaryDerived: { roles: string[]; equipmentTypes: string[]; materialTypes: string[]; componentTypes: string[] };
  suspectWindows: WindowFlag[];
  judgment: "TRUE_EQUIPMENT" | "COMPONENT_SUPPLIER" | "MATERIAL_SUPPLIER" | "AMBIGUOUS";
  reason: string;
};

function isPrimaryWindow(e: SemiEvidence): boolean {
  if (e.sourceType !== "annual_report") return true; // zyjs/zygc filing 行=公司自我申报
  if ((e.matchedKeywords ?? []).includes("主营业务概述")) return true;
  return /主营业务|主要业务|主要产品与业务|从事的主要业务|主要产品或服务|经营情况讨论/.test(e.evidenceText.slice(0, 90));
}

function main() {
  const enrichment = JSON.parse(readFileSync(ENRICHMENT, "utf8")) as {
    records: { code: string; name: string; roles: string[]; equipmentTypes: { type: string }[]; processCapabilities: SemiCapability[] }[];
  };
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as { evidence: SemiEvidence[] };
  const byCompany = new Map<string, SemiEvidence[]>();
  for (const e of evidence.evidence) {
    const list = byCompany.get(e.companyCode) ?? [];
    list.push(e);
    byCompany.set(e.companyCode, list);
  }

  const audits: CompanyAudit[] = [];
  for (const rec of enrichment.records) {
    const equipTypes = (rec.equipmentTypes ?? []).map((t) => t.type);
    if (!equipTypes.length) continue;
    const all = byCompany.get(rec.code) ?? [];
    const evById = new Map(all.map((e) => [e.evidenceId, e]));
    const primary = all.filter(isPrimaryWindow);
    const primaryCaps = mergeCapabilities(primary.flatMap((e) => deriveFromEvidence(e)).filter((c) => c.role !== "unknown"));
    const primaryRoles = [...new Set(primaryCaps.map((c) => c.role))];
    const primaryEquip = [...new Set(primaryCaps.filter((c) => c.equipmentType).map((c) => c.equipmentType!))];
    const primaryMat = [...new Set(primaryCaps.filter((c) => c.materialType).map((c) => c.materialType!))];
    const primaryComp = [...new Set(primaryCaps.filter((c) => c.componentType).map((c) => c.componentType!))];
    const primaryText = primary.find((e) => e.sourceType === "annual_report")?.evidenceText.slice(0, 120)
      ?? primary.find((e) => e.sourceType === "filing_summary_zyjs")?.evidenceText.slice(0, 120) ?? "";

    // 支撑当前设备标签的窗口,逐一标记正/负语境
    const suspectWindows: WindowFlag[] = [];
    const seenWindows = new Set<string>();
    for (const cap of rec.processCapabilities) {
      if (!cap.equipmentType) continue;
      for (const id of cap.evidenceIds) {
        if (seenWindows.has(id)) continue;
        seenWindows.add(id);
        const e = evById.get(id);
        if (!e) continue;
        const flat = e.evidenceText.replace(/\s+/g, "");
        const neg = NEG_CONTEXT.filter(([re]) => re.test(flat)).map(([, tag]) => tag);
        const pos = POS_CONTEXT.filter(([re]) => re.test(flat)).map(([, tag]) => tag);
        const primaryWin = isPrimaryWindow(e);
        if (neg.length && !primaryWin) {
          suspectWindows.push({ evidenceId: id, ruleId: cap.ruleId, equipmentType: cap.equipmentType, neg, pos, text: e.evidenceText.slice(0, 160) });
        }
      }
    }

    const primarySupportsEquipment = primaryEquip.length > 0;
    let judgment: CompanyAudit["judgment"];
    let reason: string;
    if (primarySupportsEquipment && !suspectWindows.length) {
      judgment = "TRUE_EQUIPMENT";
      reason = `主营窗口支持设备能力(${primaryEquip.join("/")}),支撑窗口无负语境`;
    } else if (primarySupportsEquipment && suspectWindows.length) {
      judgment = "TRUE_EQUIPMENT";
      reason = `主营窗口支持设备能力(${primaryEquip.join("/")});另有 ${suspectWindows.length} 个次级窗口疑点待核`;
    } else if (primaryComp.length) {
      judgment = "COMPONENT_SUPPLIER";
      reason = `主营窗口只支持零部件(${primaryComp.join("/")}),设备标签全部来自次级窗口`;
    } else if (primaryMat.length) {
      judgment = "MATERIAL_SUPPLIER";
      reason = `主营窗口只支持材料(${primaryMat.join("/")}),设备标签全部来自次级窗口`;
    } else {
      judgment = "AMBIGUOUS";
      reason = "主营窗口无法派生出任何供给角色,设备标签无主营佐证";
    }

    audits.push({
      code: rec.code,
      name: rec.name,
      currentEquipmentTypes: equipTypes,
      currentRoles: rec.roles,
      primaryBusinessText: primaryText,
      primaryDerived: { roles: primaryRoles, equipmentTypes: primaryEquip, materialTypes: primaryMat, componentTypes: primaryComp },
      suspectWindows,
      judgment,
      reason,
    });
  }

  const order = { TRUE_EQUIPMENT: 0, AMBIGUOUS: 1, COMPONENT_SUPPLIER: 2, MATERIAL_SUPPLIER: 3 } as const;
  audits.sort((a, b) => order[a.judgment] - order[b.judgment] || a.code.localeCompare(b.code));
  const counts = audits.reduce<Record<string, number>>((acc, a) => ((acc[a.judgment] = (acc[a.judgment] ?? 0) + 1), acc), {});
  const out = { side, generatedAt: new Date().toISOString(), counts, audits };
  const outPath = path.join(root, "data", "eval", `stage3_1_equipment_audit_${side}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
  console.log(`audited ${audits.length} companies with equipment labels → ${path.relative(root, outPath)}`);
  console.log("counts:", JSON.stringify(counts));
}

main();
