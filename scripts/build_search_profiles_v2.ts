import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadDataset } from "../lib/companies";
import type { Company } from "../lib/types";
import { deriveProfile } from "../search/profile/derive";
import { buildSearchTextV2 } from "../search/profile/searchText";
import { validateProfile, sha16Buffer, hash16 } from "../search/profile/validate";
import {
  SCHEMA_VERSION,
  DERIVATION_VERSION,
  SEMANTIC_ENRICHMENT_VERSION,
  SCHEMA_VERSION_V3,
  SEMANTIC_ENRICHMENT_VERSION_V3,
  EMBEDDING_MODEL,
  P0_DIMENSIONS,
  type CompanySearchProfile,
  type SearchIndexManifest,
  type SourceProvenance,
} from "../search/profile/schema";
import { ONTOLOGY_VERSION, buildOntologyJson, DIMENSIONS } from "../search/ontology/index";
import { DIM } from "../lib/text/embed";
import {
  SEMICONDUCTOR_ENRICHMENT_VERSION,
  PHOTORESIST_CLEANUP_VERSION,
  MATERIAL_ATTRIBUTION_VERSION,
  type SemiDomainKnowledge,
} from "../search/knowledge/semiconductor";
import { COMMODITY_ONTOLOGY_VERSION } from "../search/ontology/commodities";
import { THERMAL_ENRICHMENT_VERSION } from "../search/ontology/thermal";

/**
 * Build the Company Search Profile V2 layer:
 *   canonical facts (companies.json) + raw snapshot → derive → semantic enrich
 *   → validate → data/search_profiles_v2.json + data/search_index_manifest.json
 *
 * Incremental (--incremental): a company is re-derived only when its raw source
 * hash or any build version changed; otherwise the stored profile is reused
 * verbatim. First run derives everything.
 *
 * Stage 3 (--stage3):半导体 domain enrichment(search/knowledge)。输出
 * data/search_profiles_v3.json(schema 2.1.0 + domainKnowledge + 工艺检索行,
 * 受同一 DF 闸门约束),manifest 记 semiconductorEnrichmentVersion +
 * sourcesSnapshotId(规格第十六/十七/十八节)。覆盖旧 manifest 前把 v2 版本
 * 留档为 search_index_manifest_v2.json(钉旧版做 A/B 时版本号仍可对账)。
 *
 * Usage: npx tsx scripts/build_search_profiles_v2.ts [--incremental] [--validate-only] [--stage3]
 */

const root = process.cwd();
const stage3 = process.argv.includes("--stage3");
const OUT = path.join(root, "data", stage3 ? "search_profiles_v3.json" : "search_profiles_v2.json");
const MANIFEST = path.join(root, "data", "search_index_manifest.json");
const ONTOLOGY_OUT = path.join(root, "data", "search_ontology.json");
const RAW_DIR = path.join(root, "data", "raw", "companies");
const ENRICHMENT_FILE = path.join(root, "data", "enrichment", "semiconductor", "enrichment.json");

const incremental = process.argv.includes("--incremental");
const validateOnly = process.argv.includes("--validate-only");
const SCHEMA = stage3 ? SCHEMA_VERSION_V3 : SCHEMA_VERSION;
const SEMANTIC = stage3 ? SEMANTIC_ENRICHMENT_VERSION_V3 : SEMANTIC_ENRICHMENT_VERSION;

type EnrichmentRecord = {
  code: string;
  level: "A" | "B" | "C";
  manufacturingStages: string[];
  processCapabilities: SemiDomainKnowledge["processCapabilities"];
  equipmentTypes: SemiDomainKnowledge["equipmentTypes"];
  materialTypes: SemiDomainKnowledge["materialTypes"];
  componentTypes: SemiDomainKnowledge["componentTypes"];
  applications: string[];
  roles: string[];
  retrievalLabels: string[];
  sourceGap: { capability: string; expectedFrom: string }[];
};

function loadEnrichment(): Record<string, EnrichmentRecord> {
  if (!existsSync(ENRICHMENT_FILE)) {
    console.error(`--stage3 requires ${ENRICHMENT_FILE}; run scripts/stage3_build_enrichment.ts first`);
    process.exit(1);
  }
  const parsed = JSON.parse(readFileSync(ENRICHMENT_FILE, "utf8")) as { version: string; records: EnrichmentRecord[] };
  if (parsed.version !== SEMICONDUCTOR_ENRICHMENT_VERSION) {
    console.error(`enrichment version mismatch: file=${parsed.version} expected=${SEMICONDUCTOR_ENRICHMENT_VERSION}`);
    process.exit(1);
  }
  return Object.fromEntries(parsed.records.map((r) => [r.code, r]));
}

type RawMeta = { sourceHash: string; observedAt: string; sourceDate?: string };

function rawMeta(code: string): RawMeta | null {
  const file = path.join(RAW_DIR, `${code}.json`);
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  const observedAt = statSync(file).mtime.toISOString().slice(0, 10);
  let sourceDate: string | undefined;
  try {
    const raw = JSON.parse(buf.toString("utf8")) as { zygc?: { 报告日期?: unknown }[] };
    const dates = (raw.zygc ?? []).map((r) => String(r["报告日期"] ?? "")).filter(Boolean).sort();
    sourceDate = dates[dates.length - 1] || undefined;
  } catch {
    // raw snapshot unreadable: keep hash/mtime provenance, drop the report date
  }
  return { sourceHash: sha16Buffer(buf), observedAt, sourceDate };
}

function provenanceRows(company: Company, meta: RawMeta | null): SourceProvenance[] {
  const hash = meta?.sourceHash ?? "no-raw";
  const at = meta?.observedAt ?? "unknown";
  const rows: SourceProvenance[] = [
    {
      field: "identity",
      sourceName: "交易所A股列表(ak.stock_zh_a_spot_em / stock_info_a_code_name)",
      sourceType: "exchange_list",
      observedAt: at,
      sourceHash: hash,
    },
    {
      field: "businessDescription",
      sourceName: "ak.stock_zyjs_ths(回退 ak.stock_profile_cninfo 主营业务)",
      sourceType: "business_filing_summary",
      observedAt: at,
      sourceHash: hash,
    },
    {
      field: "mainProducts",
      sourceName: "ak.stock_zygc_em 按产品分类",
      sourceType: "annual_filing_product_split",
      sourceDate: meta?.sourceDate,
      observedAt: at,
      sourceHash: hash,
    },
    {
      field: "overseasRevenueShare",
      sourceName: "ak.stock_zygc_em 按地区分类(境外正则切分)",
      sourceType: "annual_filing_region_split",
      sourceDate: meta?.sourceDate,
      observedAt: at,
      sourceHash: hash,
    },
    {
      field: "swLevel1Industry",
      sourceName: "申万宏源申万指数成分表(ak.sw_index_first_info + index_component_sw,2021版)",
      sourceType: "index_constituents",
      observedAt: existsSync(path.join(root, "data", "raw", "sw", "level1_map.json"))
        ? (JSON.parse(readFileSync(path.join(root, "data", "raw", "sw", "level1_map.json"), "utf8")).fetchedAt as string) ?? at
        : at,
      sourceHash: hash,
    },
  ];
  return rows;
}

function main() {
  const { companies } = loadDataset();
  if (!companies.length) {
    console.error("companies.json empty; run npm run data first");
    process.exit(1);
  }

  // Keep the generated ontology artifact in sync with the TS source of truth.
  writeFileSync(ONTOLOGY_OUT, JSON.stringify(buildOntologyJson(), null, 1) + "\n");

  const enrichment = stage3 ? loadEnrichment() : {};
  const knowledgeLabels = new Map<string, string[]>();
  for (const [code, record] of Object.entries(enrichment)) {
    knowledgeLabels.set(code, record.retrievalLabels ?? []);
  }

  const previous: Record<string, CompanySearchProfile> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  const out: Record<string, CompanySearchProfile> = {};
  const issues: string[] = [];
  let derived = 0;
  let reused = 0;

  // Pass 1 (fresh derives only): derive bundles, then compute label document
  // frequency. Dimension labels whose df exceeds GENERIC_LABEL_DF appear on too
  // many companies to be discriminative — they stay in `derived` (audit layer)
  // but are kept out of searchText so BM25/embedding vocabulary stays sharp.
  const GENERIC_LABEL_DF = 0.05;
  const bundles = new Map<string, ReturnType<typeof deriveProfile>>();
  const labelDf = new Map<string, number>();
  const metaByCode = new Map<string, RawMeta | null>();
  companies.forEach((company) => {
    const meta = rawMeta(company.code);
    metaByCode.set(company.code, meta);
    const sourceHash = meta?.sourceHash ?? "no-raw";
    const prev = previous[company.code];
    const unchanged =
      incremental &&
      prev &&
      prev.schemaVersion === SCHEMA &&
      prev.ontologyVersion === ONTOLOGY_VERSION &&
      prev.derived.every((e) => e.derivationVersion === DERIVATION_VERSION) &&
      (prev as CompanySearchProfile & { sourceHash?: string }).sourceHash === sourceHash;
    if (unchanged && prev) return;
    const bundle = deriveProfile(company);
    bundles.set(company.code, bundle);
    for (const value of new Set(bundle.derived.map((e) => e.label))) {
      labelDf.set(value, (labelDf.get(value) ?? 0) + 1);
    }
  });
  const genericLabels = new Set(
    [...labelDf.entries()].filter(([, n]) => n / companies.length > GENERIC_LABEL_DF).map(([label]) => label),
  );
  // Stage 3 知识标签吃同一个 DF 闸门(规格第十八节):高 DF 泛化标签只留审计层。
  const knowledgeDf = new Map<string, number>();
  for (const labels of knowledgeLabels.values()) {
    for (const label of new Set(labels)) knowledgeDf.set(label, (knowledgeDf.get(label) ?? 0) + 1);
  }
  for (const [label, n] of knowledgeDf) {
    if (n / companies.length > GENERIC_LABEL_DF) genericLabels.add(label);
  }
  if (genericLabels.size) {
    const knowledgeGated = [...knowledgeDf.keys()].filter((l) => genericLabels.has(l));
    console.log(`generic labels kept out of searchText (df > ${GENERIC_LABEL_DF}): ${[...genericLabels].join("、")}${knowledgeGated.length ? ` [knowledge-gated: ${knowledgeGated.join("、")}]` : ""}`);
  }

  const started = Date.now();
  const expectedEnrichmentVersion = (code: string) => (knowledgeLabels.has(code) ? SEMICONDUCTOR_ENRICHMENT_VERSION : "none");
  const unchangedSince = (prev: CompanySearchProfile | undefined, sourceHash: string) =>
    !!prev &&
    incremental &&
    prev.schemaVersion === SCHEMA &&
    prev.ontologyVersion === ONTOLOGY_VERSION &&
    prev.derived.every((e) => e.derivationVersion === DERIVATION_VERSION) &&
    (prev as CompanySearchProfile & { sourceHash?: string }).sourceHash === sourceHash &&
    (prev.enrichmentVersion ?? "none") === expectedEnrichmentVersion(prev.identity.code);

  companies.forEach((company, i) => {
    const meta = metaByCode.get(company.code) ?? null;
    const sourceHash = meta?.sourceHash ?? "no-raw";
    const prev = previous[company.code];
    if (validateOnly) {
      if (!prev) {
        issues.push(`${company.code}: no profile`);
        return;
      }
      issues.push(...validateProfile(prev).map((x) => `${x.code6 ?? company.code} [${x.code}] ${x.detail}`));
      return;
    }

    const unchanged = unchangedSince(prev, sourceHash);

    let profile: CompanySearchProfile;
    if (unchanged && prev) {
      profile = prev;
      reused += 1;
    } else {
      derived += 1;
      const bundle = bundles.get(company.code) ?? deriveProfile(company);
      const knowledge = knowledgeLabels.get(company.code);
      const searchText = buildSearchTextV2(company, bundle, genericLabels, knowledge);
      const record = stage3 ? enrichment[company.code] : undefined;
      const domainKnowledge = record
        ? {
            semiconductor: {
              manufacturingStages: record.manufacturingStages,
              processCapabilities: record.processCapabilities,
              equipmentTypes: record.equipmentTypes,
              materialTypes: record.materialTypes,
              componentTypes: record.componentTypes,
              applications: record.applications,
              sourceGap: record.sourceGap,
            } satisfies SemiDomainKnowledge,
          }
        : undefined;
      profile = {
        schemaVersion: SCHEMA,
        ontologyVersion: ONTOLOGY_VERSION,
        identity: { code: company.code, name: company.name, exchange: company.exchange },
        classification: { swLevel1: company.swLevel1Industry, industry: company.industry, board: company.board },
        business: {
          mainBusiness: (company.businessDescription || "").slice(0, 160),
          products: company.mainProducts.slice(0, 5).map((p) => p.name),
        },
        derived: bundle.derived,
        semantic: bundle.semantic,
        provenance: provenanceRows(company, meta),
        coverage: bundle.coverage,
        unknownDimensions: bundle.unknownDimensions,
        searchText,
        searchTextHash: hash16(searchText),
        updatedAt: new Date().toISOString().slice(0, 10),
        ...(stage3 ? { domainKnowledge, enrichmentVersion: expectedEnrichmentVersion(company.code) } : {}),
      };
    }
    (profile as CompanySearchProfile & { sourceHash?: string }).sourceHash = sourceHash;
    issues.push(...validateProfile(profile).map((x) => `${x.code6} [${x.code}] ${x.detail}`));
    out[company.code] = profile;
    if ((i + 1) % 1000 === 0) console.log(`  ${i + 1}/${companies.length}`);
  });

  if (issues.length) {
    console.error(`validate failed: ${issues.length} issues (first 20)`);
    for (const line of issues.slice(0, 20)) console.error("  " + line);
    process.exit(1);
  }

  if (validateOnly) {
    console.log(`validate OK: ${companies.length} profiles, schema ${SCHEMA}, ontology ${ONTOLOGY_VERSION}${stage3 ? " + stage3" : ""}`);
    return;
  }

  writeFileSync(OUT, JSON.stringify(out));

  // Snapshot id: stable hash over per-company source hashes (order-independent).
  const snapshotId = sha16Buffer([...new Set(Object.values(out).map((p) => (p as CompanySearchProfile & { sourceHash?: string }).sourceHash ?? ""))].sort().join(","));
  // Stage 3: stable id over the Tier1 source set (url+sha per company).
  let sourcesSnapshotId: string | undefined;
  if (stage3) {
    const srcDir = path.join(root, "data", "sources", "semiconductor");
    const rows: string[] = [];
    if (existsSync(srcDir)) {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      for (const dir of readdirSync(srcDir).sort()) {
        const manifestPath = path.join(srcDir, dir, "manifest.json");
        if (!existsSync(manifestPath)) continue;
        const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { sourceUrl?: string; documentSha256?: string };
        rows.push(`${dir}:${m.sourceUrl}:${m.documentSha256}`);
      }
    }
    sourcesSnapshotId = sha16Buffer(rows.join("\n"));
  }
  const coverageCounts: Record<string, number> = {};
  for (const dim of P0_DIMENSIONS) coverageCounts[dim] = 0;
  let withAny = 0;
  let withNegative = 0;
  let textLenSum = 0;
  for (const p of Object.values(out)) {
    if (p.coverage.length) withAny += 1;
    if (p.semantic.negativeConcepts.length) withNegative += 1;
    textLenSum += p.searchText.length;
    for (const dim of p.coverage) coverageCounts[dim] = (coverageCounts[dim] ?? 0) + 1;
  }

  const enrichedCount = stage3 ? [...knowledgeLabels.keys()].filter((c) => out[c]?.domainKnowledge?.semiconductor).length : 0;
  const manifest: SearchIndexManifest = {
    schemaVersion: SCHEMA,
    ontologyVersion: ONTOLOGY_VERSION,
    derivationVersion: DERIVATION_VERSION,
    semanticEnrichmentVersion: SEMANTIC,
    semiconductorEnrichmentVersion: stage3 ? SEMICONDUCTOR_ENRICHMENT_VERSION : undefined,
    photoresistCleanupVersion: stage3 ? PHOTORESIST_CLEANUP_VERSION : undefined,
    materialAttributionVersion: stage3 ? MATERIAL_ATTRIBUTION_VERSION : undefined,
    commodityOntologyVersion: stage3 ? COMMODITY_ONTOLOGY_VERSION : undefined,
    thermalEnrichmentVersion: stage3 ? THERMAL_ENRICHMENT_VERSION : undefined,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDim: DIM,
    builtAt: new Date().toISOString(),
    sourceSnapshotId: snapshotId,
    sourcesSnapshotId,
    datasetSha16: sha16Buffer(readFileSync(path.join(root, "data", "companies.json"))),
    profileFile: stage3 ? "data/search_profiles_v3.json" : "data/search_profiles_v2.json",
    vectorsFile: stage3 ? "data/vectors_profile_v3.f32" : "data/vectors_profile_v2.f32",
    counts: {
      companies: companies.length,
      withDerived: withAny,
      withNegativeConcepts: withNegative,
      avgSearchTextChars: Math.round(textLenSum / companies.length),
      ...coverageCounts,
      ...(stage3
        ? {
            enrichedCompanies: enrichedCount,
            withProcessCapabilities: [...Object.values(out)].filter((p) => p.domainKnowledge?.semiconductor?.processCapabilities?.length).length,
          }
        : {}),
      derivedThisRun: derived,
      reusedThisRun: reused,
      ontologyRules: DIMENSIONS.reduce((sum, d) => sum + d.rules.length, 0),
    },
  };
  // 旧版 manifest 留档(SEARCH_PROFILE_EDITION=v2 钉版时版本号可对账)
  if (stage3 && existsSync(MANIFEST)) {
    const existing = JSON.parse(readFileSync(MANIFEST, "utf8")) as SearchIndexManifest;
    if (!existing.semiconductorEnrichmentVersion) {
      writeFileSync(path.join(root, "data", "search_index_manifest_v2.json"), JSON.stringify(existing, null, 2) + "\n");
    }
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`profiles[${stage3 ? "v3+stage3" : "v2"}]: ${companies.length} (derived ${derived}, reused ${reused}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (stage3) console.log(`enriched: ${enrichedCount} companies with domainKnowledge`);
  console.log(`coverage: withDerived=${withAny} (${((withAny / companies.length) * 100).toFixed(1)}%), negatives=${withNegative}`);
  for (const [dim, n] of Object.entries(coverageCounts)) {
    console.log(`  ${dim}: ${n} (${((n / companies.length) * 100).toFixed(1)}%)`);
  }
}

main();
