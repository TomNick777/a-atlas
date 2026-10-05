import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Company, Dataset, Identity } from "./types";
import { DIM } from "./text/embed";
import { profileEdition, profileFileFor, readManifest } from "./search/edition";
import type { CorpusManifest } from "./corpus/contracts";

const DATA = path.join(process.cwd(), "data", "companies.json");
const VECTORS = path.join(process.cwd(), "data", "vectors.f32");
const CORPUS_JSONL = path.join(process.cwd(), "data", "company-corpus", "companies.jsonl");
const CORPUS_MANIFEST = path.join(process.cwd(), "data", "company-corpus", "manifest.json");
const CORPUS_VECTORS = path.join(process.cwd(), "data", "vectors_corpus.f32");

/**
 * The discovery semantic layer actually in effect for this load. `null` means
 * the corpus artifact (or its vectors) is absent/misaligned and the search fell
 * back to the legacy search-profile layer — every consumer surfaces this, never
 * silently: telemetry and the search log carry it verbatim.
 */
export type CorpusInfo = {
  schemaVersion: string;
  contentDigest16: string;
  companyCount: number;
  generatedAt: string | null;
  ontologyVersion: string;
  knowledgeEnrichmentVersion: string;
  embeddingModel: string;
};

export type Loaded = {
  companies: Company[];
  /** Row-major, one DIM-vector per company, or null before `build:vectors`. */
  vectors: Float32Array | null;
  version: string;
  /** Snapshot generation time of companies.json, for honest data-age captions. */
  generatedAt: string | null;
  /** Which search-profile edition this load attached (newest present). */
  edition: "v1" | "v2" | "v3";
  manifest: import("../search/profile/schema").SearchIndexManifest | null;
  /** Company Knowledge Corpus in effect (null = legacy profile fallback). */
  corpus: CorpusInfo | null;
};

let cached: Loaded | null = null;

export function datasetPath(): string {
  return DATA;
}

/** The corpus embedding file the discovery index reads when the corpus is in effect. */
export const CORPUS_VECTORS_FILE = "data/vectors_corpus.f32";

/**
 * Load the corpus semantic layer. All-or-nothing: documents AND their embedding
 * vectors must both be present and aligned, otherwise the corpus is not in
 * effect (half a corpus — new BM25 text over old embedding space — is worse
 * than either layer alone).
 */
function loadCorpus(companyCount: number): { texts: Map<string, string> | null; info: CorpusInfo | null } {
  if (!existsSync(CORPUS_JSONL) || !existsSync(CORPUS_MANIFEST) || !existsSync(CORPUS_VECTORS)) {
    return { texts: null, info: null };
  }
  try {
    const manifest = JSON.parse(readFileSync(CORPUS_MANIFEST, "utf8")) as CorpusManifest;
    const texts = new Map<string, string>();
    for (const line of readFileSync(CORPUS_JSONL, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const doc = JSON.parse(line) as { symbol: string; searchableText: string };
      if (doc.symbol && doc.searchableText) texts.set(doc.symbol, doc.searchableText);
    }
    if (texts.size !== companyCount || manifest.companyCount !== companyCount) {
      console.warn(`[corpus] company count misaligned (corpus ${manifest.companyCount}/texts ${texts.size} vs dataset ${companyCount}); legacy profile layer stays`);
      return { texts: null, info: null };
    }
    const vectorBuf = readFileSync(CORPUS_VECTORS);
    const floats = new Float32Array(vectorBuf.buffer, vectorBuf.byteOffset, Math.floor(vectorBuf.byteLength / 4));
    if (floats.length !== companyCount * DIM) {
      console.warn(`[corpus] vectors misaligned (${floats.length} floats vs ${companyCount * DIM}); legacy profile layer stays`);
      return { texts: null, info: null };
    }
    return {
      texts,
      info: {
        schemaVersion: manifest.schemaVersion,
        contentDigest16: manifest.contentDigest.value.slice(0, 16),
        companyCount: manifest.companyCount,
        generatedAt: manifest.generatedAt,
        ontologyVersion: manifest.ontologyVersion,
        knowledgeEnrichmentVersion: manifest.knowledgeEnrichmentVersion,
        embeddingModel: manifest.embeddingModel,
      },
    };
  } catch (error) {
    console.warn("[corpus] unreadable; legacy profile layer stays:", error instanceof Error ? error.message : error);
    return { texts: null, info: null };
  }
}

export function loadDataset(): Loaded {
  if (cached) return cached;
  if (!existsSync(DATA)) {
    cached = { companies: [], vectors: null, version: "empty", generatedAt: null, edition: "v1", manifest: null, corpus: null };
    return cached;
  }
  const dataset = JSON.parse(readFileSync(DATA, "utf8")) as Dataset;
  const companies = dataset.companies ?? [];
  const edition = profileEdition();
  const { texts: corpusTexts, info: corpus } = loadCorpus(companies.length);
  let profiles: Record<string, { searchText: string }> = {};
  const profilesPath = path.join(process.cwd(), profileFileFor(edition));
  if (!corpus && existsSync(profilesPath)) {
    try {
      profiles = JSON.parse(readFileSync(profilesPath, "utf8"));
    } catch {
      profiles = {};
    }
  }
  const withProfiles = companies.map((company) => ({
    ...company,
    // The corpus document is the discovery semantic input when present; the
    // legacy profile searchText is the labeled fallback layer.
    searchProfileText: (corpusTexts?.get(company.code) ?? profiles[company.code]?.searchText) || null,
  }));
  let vectors: Float32Array | null = null;
  if (corpus) {
    const buf = readFileSync(CORPUS_VECTORS);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    if (floats.length === companies.length * DIM) vectors = floats;
  } else if (existsSync(VECTORS)) {
    const buf = readFileSync(VECTORS);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    if (floats.length === companies.length * DIM) vectors = floats;
  }
  const manifest = edition === "v1" ? null : readManifest();
  const stamp = statSync(DATA).mtimeMs;
  cached = {
    companies: withProfiles,
    vectors,
    version: `${dataset.generatedAt ?? "na"}:${companies.length}:${stamp}:${edition}:${corpus ? corpus.contentDigest16.slice(0, 8) : "nocorpus"}`,
    generatedAt: dataset.generatedAt ?? null,
    edition,
    manifest,
    corpus,
  };
  return cached;
}

export function identities(): Identity[] {
  return loadDataset().companies.map((company) => ({ code: company.code, name: company.name }));
}

/**
 * The visible pile is a sample; the search index is not. Same dataset, same
 * pool, on every load: the shuffle is seeded, not Date.now().
 */
export function physicsPoolSize(): number {
  const n = Number(process.env.PHYSICS_POOL_SIZE ?? 300);
  return Number.isFinite(n) && n >= 60 ? Math.min(1200, Math.round(n)) : 300;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function physicalPlates(): { code: string; name: string; industry: string }[] {
  const { companies } = loadDataset();
  const size = Math.min(physicsPoolSize(), companies.length);
  const pool = [...companies];
  const random = mulberry32(0x5ea1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, size).map((company) => ({ code: company.code, name: company.name, industry: company.swLevel1Industry }));
}

export function resetDatasetCache() {
  cached = null;
}

/**
 * The manifest as it was when this process loaded the dataset (telemetry §10:
 * manifestOnDisk vs manifestLoadedInMemory). Null until loadDataset first ran.
 */
export function loadedManifestStamp(): {
  builtAt: string | null;
  datasetSha16: string | null;
  knowledgeVersions: string | null;
  loadedAt: string;
  corpusDigest16: string | null;
} | null {
  if (!cached) return null;
  const manifest = cached.manifest as Record<string, unknown> | null;
  return {
    builtAt: (manifest?.builtAt as string | undefined) ?? null,
    datasetSha16: (manifest?.datasetSha16 as string | undefined) ?? null,
    knowledgeVersions:
      [manifest?.semiconductorEnrichmentVersion, manifest?.materialAttributionVersion, manifest?.ontologyVersion].filter(Boolean).join("/") || null,
    loadedAt: cached.version,
    corpusDigest16: cached.corpus?.contentDigest16 ?? null,
  };
}
