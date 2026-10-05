import { createHash } from "node:crypto";
import { DIMENSIONS, NEGATIVE_RULES, CONCEPT_GROUPS } from "../ontology/index";
import type { CompanySearchProfile } from "./schema";
import { P0_DIMENSIONS } from "./schema";

/**
 * Profile 构建自动验证(规格第二十七节):
 *   schema — 必备字段存在、版本号一致
 *   ontology — 每个派生值/负向概念必须存在于本体
 *   provenance — 每条派生必须有 rule + evidence + derivedFrom
 *   contradiction — 负向概念不得与已有派生值共存
 *   stale — searchTextHash 必须与内容一致
 * 返回错误列表;非空即 build 失败。
 */

export type ValidationIssue = { code: string; code6?: string; detail: string };

export function validateProfile(p: CompanySearchProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const where = (detail: string) => issues.push({ code: "schema", code6: p.identity.code, detail });

  if (p.schemaVersion !== "2.0.0" && p.schemaVersion !== "2.1.0") where(`schemaVersion=${p.schemaVersion}`);
  if (!p.identity?.code || !p.identity.name) where("identity missing");
  if (!p.searchText) where("searchText empty");
  if (hash16(p.searchText) !== p.searchTextHash) where("searchTextHash mismatch (stale text)");

  // Stage 3 domain knowledge: every capability must trace back to evidence.
  const semi = p.domainKnowledge?.semiconductor;
  if (semi) {
    const capIds = new Set<string>();
    for (const cap of semi.processCapabilities ?? []) {
      if (!cap.ruleId?.startsWith("s3.") && !cap.ruleId?.includes("s3.")) {
        issues.push({ code: "provenance", code6: p.identity.code, detail: `capability ${cap.process ?? cap.equipmentType ?? cap.materialType} missing s3 ruleId` });
      }
      if (!cap.evidenceIds?.length) {
        issues.push({ code: "provenance", code6: p.identity.code, detail: `capability ${cap.process ?? "?"} has no evidenceIds` });
      }
      for (const id of cap.evidenceIds ?? []) capIds.add(id);
    }
    const knownStages = new Set(["wafer_manufacturing", "front_end", "middle_end", "back_end", "packaging", "testing", "silicon_wafer", "compound_semiconductor", "display_semiconductor"]);
    for (const stage of semi.manufacturingStages ?? []) {
      if (!knownStages.has(stage)) where(`unknown manufacturingStage ${stage}`);
    }
    for (const view of [semi.equipmentTypes, semi.materialTypes, semi.componentTypes] as const) {
      for (const item of view ?? []) {
        if (!item.evidenceIds?.length) {
          issues.push({ code: "provenance", code6: p.identity.code, detail: `${item.type} has no evidenceIds` });
        }
        for (const id of item.evidenceIds ?? []) capIds.add(id);
      }
    }
    if (capIds.size && !p.enrichmentVersion?.match(/^(stage3|residual-knowledge-pass)/)) {
      where("domainKnowledge present but enrichmentVersion missing");
    }
  } else if (p.enrichmentVersion && p.enrichmentVersion !== "none") {
    where(`enrichmentVersion=${p.enrichmentVersion} without domainKnowledge`);
  }

  const valueIndex = new Map<string, { dimension: string; label: string }>();
  for (const dim of DIMENSIONS) for (const r of dim.rules) valueIndex.set(r.value, { dimension: dim.id, label: r.label });

  for (const entry of p.derived) {
    const known = valueIndex.get(entry.value);
    if (!known) {
      issues.push({ code: "ontology", code6: p.identity.code, detail: `unknown derived value ${entry.value}` });
      continue;
    }
    if (known.dimension !== entry.dimension) {
      issues.push({ code: "ontology", code6: p.identity.code, detail: `${entry.value} claims dimension ${entry.dimension}, ontology says ${known.dimension}` });
    }
    if (!entry.derivationRule || !entry.evidence?.length || !entry.derivedFrom?.length) {
      issues.push({ code: "provenance", code6: p.identity.code, detail: `derived ${entry.value} missing rule/evidence/derivedFrom` });
    }
  }

  const negativeRules = new Set(NEGATIVE_RULES.map((n) => n.rule));
  const presentValues = new Set(p.derived.map((e) => e.value));
  for (const neg of p.semantic.negativeConcepts) {
    if (!negativeRules.has(neg.rule)) {
      issues.push({ code: "ontology", code6: p.identity.code, detail: `negative ${neg.concept} rule ${neg.rule} not in ontology` });
    }
    if (presentValues.has(neg.concept)) {
      issues.push({ code: "contradiction", code6: p.identity.code, detail: `negative ${neg.concept} coexists with derived value of the same id` });
    }
  }

  for (const tag of p.semantic.semanticTags) {
    if (!CONCEPT_GROUPS[tag.tag]) {
      issues.push({ code: "ontology", code6: p.identity.code, detail: `semantic tag ${tag.tag} not in concept groups` });
    }
  }

  // unknownDimensions must be the exact complement of coverage over P0 dims.
  const expectedUnknown = P0_DIMENSIONS.filter((d) => !p.coverage.includes(d)).sort();
  if (JSON.stringify(expectedUnknown) !== JSON.stringify([...p.unknownDimensions].sort())) {
    where(`unknownDimensions inconsistent: got [${p.unknownDimensions}] want [${expectedUnknown}]`);
  }
  if (!p.provenance?.length) {
    issues.push({ code: "provenance", code6: p.identity.code, detail: "no source provenance rows" });
  }

  return issues;
}

export function hash16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function sha16Buffer(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
