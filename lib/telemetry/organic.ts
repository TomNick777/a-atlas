import { createHash } from "node:crypto";
import type { OrganicEligibility, RequestOrigin } from "./types";

export type { OrganicEligibility, RequestOrigin };

/**
 * Organic eligibility (规格 §13, §31): normal UI input defaults to
 * organic_ui/CANDIDATE without asking the user; scripted callers declare
 * themselves. The freeze protocol applies pre-registered rules later — the
 * field only records what the run was, honestly.
 */

export const REQUEST_ORIGINS: RequestOrigin[] = ["organic_ui", "developer", "smoke", "benchmark", "replay", "api"];

export function normalizeOrigin(raw: unknown): { origin: RequestOrigin; invalidProvided: string | null } {
  if (typeof raw !== "string" || !raw.trim()) return { origin: "organic_ui", invalidProvided: null };
  const value = raw.trim() as RequestOrigin;
  if (REQUEST_ORIGINS.includes(value)) return { origin: value, invalidProvided: null };
  return { origin: "organic_ui", invalidProvided: raw.trim() };
}

export function organicEligibilityFor(origin: RequestOrigin, options: { cached?: boolean; corrupt?: boolean } = {}): OrganicEligibility {
  if (options.corrupt) return "EXCLUDED_CORRUPT";
  if (options.cached) return "EXCLUDED_CACHE";
  switch (origin) {
    case "organic_ui":
      return "CANDIDATE";
    case "developer":
      return "EXCLUDED_DEVELOPER";
    case "smoke":
      return "EXCLUDED_SMOKE";
    case "benchmark":
    case "replay":
    case "api":
      return origin === "replay" ? "EXCLUDED_REPLAY" : origin === "benchmark" ? "EXCLUDED_SYSTEM_TEST" : "EXCLUDED_DEVELOPER";
    default: {
      const never: never = origin;
      return never;
    }
  }
}

/** Stable content hash of the normalized query (no query content in the id). */
export function queryHash16(normalizedQuery: string): string {
  return createHash("sha256").update(normalizedQuery).digest("hex").slice(0, 16);
}

/** Levenshtein distance on characters — reformulation evidence, small strings only. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Reformulation grouping (§26): consecutive searches in one session within
 * REFORMULATION_WINDOW_MS share a group. Recorded as a research signal only —
 * a reformulation is NOT automatically a failed previous search.
 */
export const REFORMULATION_WINDOW_MS = 120_000;

export type ReformulationState = { lastSearchId: string; lastAt: number; lastNormalized: string; groupId: string | null };

export function reformulationLink(
  state: ReformulationState | undefined,
  now: number,
  normalizedQuery: string,
  newSearchId: string,
): { groupId: string | null; previousSearchId: string | null; editDistance: number | null; timeDeltaMs: number | null; nextState: ReformulationState } {
  if (state && now - state.lastAt <= REFORMULATION_WINDOW_MS) {
    const groupId = state.groupId ?? `rg_${state.lastSearchId}`;
    return {
      groupId,
      previousSearchId: state.lastSearchId,
      editDistance: editDistance(state.lastNormalized, normalizedQuery),
      timeDeltaMs: now - state.lastAt,
      nextState: { lastSearchId: newSearchId, lastAt: now, lastNormalized: normalizedQuery, groupId },
    };
  }
  return {
    groupId: null,
    previousSearchId: null,
    editDistance: null,
    timeDeltaMs: null,
    nextState: { lastSearchId: newSearchId, lastAt: now, lastNormalized: normalizedQuery, groupId: null },
  };
}
