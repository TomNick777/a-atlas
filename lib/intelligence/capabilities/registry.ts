/**
 * JevCapabilityRegistry (Phase 3.3 §7) — the explicit, closed set of
 * intelligence Atlas may ask of Jev.
 *
 * Deliberately NOT: a plugin system, dynamic tool discovery, a prompt template
 * registry, or an agent framework. It is one static table; a capability that
 * is not listed here does not exist, and asking for one fails with
 * capability_unsupported instead of improvising.
 */
import { JEV_CAPABILITY_CONTRACT_VERSIONS, type JevCapability } from "./contracts";

export const JEV_CAPABILITY_REGISTRY_VERSION = "jev-capability-registry-1";
/** A versioned consumption policy over the registered match/relation heads,
 * not a fifth judge or capability. Ranking callers use this strict seam. */
export const MARKET_ELIGIBILITY_POLICY = {
  version: "market-eligibility-1",
  capabilities: ["semantic_match", "semantic_relation"],
  requires: ["live", "answered identity", "known finite score", "evidenceRefs"],
  midpoint: "unknown",
  eligibility: "capability matched; never SHOWN retrieval eligibility",
} as const;

export type JevCapabilityDescriptor = {
  id: JevCapability;
  contractVersion: string;
  description: string;
  input: string;
  output: string;
  /** Facts come from Atlas; Jev judges them. Frozen Phase 3.3 §9. */
  factAuthority: "atlas";
  allowedInference: string;
  forbidden: string;
};

export const JEV_CAPABILITY_REGISTRY: {
  registryVersion: string;
  capabilities: readonly JevCapabilityDescriptor[];
} = {
  registryVersion: JEV_CAPABILITY_REGISTRY_VERSION,
  capabilities: [
    {
      id: "semantic_match",
      contractVersion: JEV_CAPABILITY_CONTRACT_VERSIONS.semantic_match,
      description: "用户的语义残留是否命中候选公司（每家一题 yes/no）。",
      input: "query + subjects(companyId/name/evidence)",
      output: "decisions: {companyId, score, matched, evidenceRefs}（输入顺序对齐）",
      factAuthority: "atlas",
      allowedInference: "依据所给 profile 判断主营业务是否符合 query。",
      forbidden: "同义词扩展、行业映射、概念词典、地域/排除条件的猜测。",
    },
    {
      id: "semantic_relation",
      contractVersion: JEV_CAPABILITY_CONTRACT_VERSIONS.semantic_relation,
      description: "公司与用户描述的对象之间是否存在所述关系（供应/配套/合作/产业链位置）。",
      input: "relationQuery + subjects（每家必须带 evidence）",
      output: "decisions: {companyId, matched, score, relationLabel(=relationQuery 原文), evidenceRefs}",
      factAuthority: "atlas",
      allowedInference: "仅依据所给 evidence 判断关系是否被资料支持。",
      forbidden: "凭内部知识补充关系；relationLabel 改写；无 evidence 时作答。",
    },
    {
      id: "semantic_comparison",
      contractVersion: JEV_CAPABILITY_CONTRACT_VERSIONS.semantic_comparison,
      description: "各对象与用户描述维度的相对贴合度（0-3 打分，排序即比较结论）。",
      input: "comparisonQuery + subjects（Atlas 决定比较对象与证据、数据版本）",
      output: "decisions: {companyId, grade, score, evidenceRefs}（输入顺序对齐）",
      factAuthority: "atlas",
      allowedInference: "基于所给证据给每个对象与描述的相对语义关系打分。",
      forbidden: "自由问答、比较对象增删、evidence 之外的事实。",
    },
    {
      id: "evidence_explanation",
      contractVersion: JEV_CAPABILITY_CONTRACT_VERSIONS.evidence_explanation,
      description: "解释一个既有 judgement：从所给 evidence 中选出真正支持它的部分。",
      input: "userQuery + judgement(JudgementRecord) + evidence",
      output: "lines: {ref, quote(=evidence 原文)}；insufficientEvidence 为真时 lines 为空",
      factAuthority: "atlas",
      allowedInference: "只判断所给 evidence 是否支持既有判断。",
      forbidden: "产生新事实、外部检索、补全企业关系、把推测写成事实。",
    },
  ],
} as const;

export function isRegisteredJevCapability(id: string): id is JevCapability {
  return JEV_CAPABILITY_REGISTRY.capabilities.some((capability) => capability.id === id);
}

export function jevCapabilityDescriptor(id: JevCapability): JevCapabilityDescriptor | null {
  return JEV_CAPABILITY_REGISTRY.capabilities.find((capability) => capability.id === id) ?? null;
}
