/**
 * Company Search Profile V2 — 三层 schema。
 *
 * Layer 1 SOURCE FACT:canonical facts live in data/companies.json (untouched);
 *   the profile carries only provenance pointers (sourceType/endpoint/date/hash).
 * Layer 2 DERIVED:reproducible derivations from source text (this file's
 *   DerivedEntry) — every entry carries derivedFrom + rule + version + confidence.
 * Layer 3 SEARCH SEMANTIC:search-only text/tags; may be regenerated wholesale
 *   without touching L1/L2; generator identity is recorded.
 *
 * 模型推断永远不允许写回 canonical facts;semantic 层整体可重建。
 */

import type { SemiDomainKnowledge } from "../knowledge/semiconductor";

export const SCHEMA_VERSION = "2.0.0";
/** Stage 1: deterministic word-level rules only (search/ontology/*). */
export const DERIVATION_VERSION = "stage1-rules-v3";
/** Stage 2 (GLM teacher) not yet run; nothing in the profile depends on a model. */
export const SEMANTIC_ENRICHMENT_VERSION = "stage1-deterministic-v2";
/** Stage 3: semiconductor process knowledge from Tier1/Tier3 authoritative sources. */
export const SCHEMA_VERSION_V3 = "2.1.0";
export const SEMANTIC_ENRICHMENT_VERSION_V3 = "stage3-semiconductor-v1";
export const EMBEDDING_MODEL = "Xenova/bge-small-zh-v1.5";

export type DerivedEntry = {
  dimension: string;
  dimLabel: string;
  value: string;
  label: string;
  /** Matched spans from the source text, kept short. */
  evidence: string[];
  /** Which source fields the evidence came from. */
  derivedFrom: string[];
  derivationRule: string;
  derivationVersion: string;
  confidence: number;
};

/** V1-compat concept-group tag (retrieval continuity line). */
export type SemanticTag = {
  tag: string;
  evidence: string;
  provenance: "DERIVED:业务文本词面命中";
};

export type NegativeTag = {
  concept: string;
  label: string;
  because: string;
  rule: string;
  derivationVersion: string;
};

export type SourceProvenance = {
  /** Canonical field in companies.json this provenance describes. */
  field: string;
  sourceName: string;
  sourceType: string;
  /** Filing/report date when the source exposes one (主营构成报告期). */
  sourceDate?: string;
  /** Date the raw response was fetched (raw file mtime, UTC date). */
  observedAt: string;
  /** sha256[:16] of the raw company file — the incremental-build key. */
  sourceHash: string;
};

export type CompanySearchProfile = {
  schemaVersion: string;
  ontologyVersion: string;
  identity: { code: string; name: string; exchange: string };
  classification: { swLevel1: string; industry: string; board: string };
  /** Short previews kept for self-contained review exports (not the full filing). */
  business: { mainBusiness: string; products: string[] };
  derived: DerivedEntry[];
  semantic: { semanticTags: SemanticTag[]; negativeConcepts: NegativeTag[] };
  provenance: SourceProvenance[];
  /** Dimension ids with ≥1 derived entry. */
  coverage: string[];
  /** P0 dimensions with zero evidence — recorded as UNKNOWN, never as 0. */
  unknownDimensions: string[];
  searchText: string;
  searchTextHash: string;
  updatedAt: string;
  /** Stage 3: per-company domain knowledge (evidence-backed, see search/knowledge). */
  domainKnowledge?: { semiconductor?: SemiDomainKnowledge };
  /** Which enrichment version produced domainKnowledge ("none" when absent). */
  enrichmentVersion?: string;
};

export type SearchIndexManifest = {
  schemaVersion: string;
  ontologyVersion: string;
  derivationVersion: string;
  semanticEnrichmentVersion: string;
  /** Stage 3 domain-enrichment version ("none" before Stage 3). */
  semiconductorEnrichmentVersion?: string;
  /** kp1 (Residual Remediation Phase 2) 知识基线子版本(规格§二十一)。 */
  photoresistCleanupVersion?: string;
  /** mp1.1 (s3-derive-v5) 材料归属闸门版本(silicon_wafer/photomask 收敛)。 */
  materialAttributionVersion?: string;
  commodityOntologyVersion?: string;
  thermalEnrichmentVersion?: string;
  embeddingModel: string;
  embeddingDim: number;
  builtAt: string;
  /** sha16 over the per-company sourceHash list — identifies the raw snapshot. */
  sourceSnapshotId: string;
  /** sha16 over data/sources/* manifests (Tier1 source set), when Stage 3 ran. */
  sourcesSnapshotId?: string;
  datasetSha16: string;
  profileFile: string;
  vectorsFile: string;
  counts: Record<string, number>;
};

export const P0_DIMENSIONS = [
  "industryChainRole",
  "applicationScenario",
  "semiconductorSegment",
  "thermalSegment",
  "thermalProduct",
  "thermalCoolingMode",
  "roboticsSegment",
  "commodityExposure",
];
