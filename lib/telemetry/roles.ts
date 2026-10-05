import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Lazy company → industry-chain-role map for the yellow-flag detectors (§30).
 * Read from data/search_profiles_v3.json derived entries; cached per process;
 * best-effort — a missing file just means the role-based suspects stay silent.
 */

export type RoleMap = Map<string, string[]>;

const store = globalThis as unknown as { __telemetryRoles?: { version: string; map: RoleMap } };

export function companyRoles(edition: "v1" | "v2" | "v3" = "v3"): RoleMap {
  const file = edition === "v3" ? "search_profiles_v3.json" : edition === "v2" ? "search_profiles_v2.json" : "search_profiles.json";
  let stamp: string;
  try {
    stamp = `${file}:${statSync(path.join(process.cwd(), "data", file)).mtimeMs}`;
  } catch {
    return new Map();
  }
  if (store.__telemetryRoles?.version === stamp) return store.__telemetryRoles.map;
  const map: RoleMap = new Map();
  try {
    const profiles = JSON.parse(readFileSync(path.join(process.cwd(), "data", file), "utf8")) as Record<string, { derived?: { dimension: string; label: string }[] }>;
    for (const [code, entry] of Object.entries(profiles)) {
      const roles = (entry.derived ?? []).filter((row) => row.dimension === "industryChainRole" && row.label).map((row) => row.label);
      if (roles.length) map.set(code, roles);
    }
  } catch {
    return map;
  }
  store.__telemetryRoles = { version: stamp, map };
  return map;
}
