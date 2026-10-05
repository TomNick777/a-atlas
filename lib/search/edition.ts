import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SearchIndexManifest } from "../../search/profile/schema";

/**
 * Which search-profile edition the runtime reads. Newest wins when its files
 * exist; SEARCH_PROFILE_EDITION=v1|v2 pins a legacy profile (used for the
 * Stage 2 / Stage 3 A/B benchmarks). Never guess: a missing file silently
 * degrades to the newest edition that IS present.
 */

export type Edition = "v1" | "v2" | "v3";

const MANIFEST = path.join(process.cwd(), "data", "search_index_manifest.json");

export function readManifest(): SearchIndexManifest | null {
  if (!existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8")) as SearchIndexManifest;
  } catch {
    return null;
  }
}

function editionReady(edition: Edition): boolean {
  return existsSync(path.join(process.cwd(), profileFileFor(edition)));
}

export function profileEdition(): Edition {
  const override = process.env.SEARCH_PROFILE_EDITION?.trim();
  if (override === "v1" || override === "v2" || override === "v3") {
    if (!editionReady(override)) {
      console.warn(`[profile-edition] SEARCH_PROFILE_EDITION=${override} but files missing; falling back`);
    } else {
      return override;
    }
  }
  if (editionReady("v3")) return "v3";
  if (editionReady("v2")) return "v2";
  return "v1";
}

export function profileFileFor(edition: Edition): string {
  if (edition === "v3") return "data/search_profiles_v3.json";
  return edition === "v2" ? "data/search_profiles_v2.json" : "data/search_profiles.json";
}

export function vectorsFileFor(edition: Edition): string {
  if (edition === "v3") {
    const manifest = readManifest();
    if (manifest?.vectorsFile && manifest.vectorsFile.includes("v3") && existsSync(path.join(process.cwd(), manifest.vectorsFile))) {
      return manifest.vectorsFile;
    }
    return "data/vectors_profile_v3.f32";
  }
  if (edition === "v2") {
    // v2 向量路径钉死:共享 manifest 可能已被 v3 构建覆盖(留档在 _v2.json)。
    return "data/vectors_profile_v2.f32";
  }
  return "data/vectors_profile.f32";
}
