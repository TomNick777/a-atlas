import { randomBytes } from "node:crypto";

/**
 * The three correlation ids (规格 §4):
 *  - appRunId  one Next/research/CLI process lifecycle
 *  - sessionId one browser user session (kept in sessionStorage, 30min idle expiry)
 *  - searchId  one Search Run — shared with data/search_log/search_log.jsonl
 */

export function newEventId(): string {
  return `ev_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/** Same grammar as the search log's searchId (pipeline.ts) so the join is lossless. */
export function newSearchId(): string {
  return `s_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function newAppRunId(component: "next" | "research" | "cli"): string {
  return `run_${component}_${process.pid}_${Date.now().toString(36)}`;
}

const SESSION_ID_RE = /^sess_[0-9a-z]{10,26}$/;

export function newSessionId(): string {
  return `sess_${randomBytes(8).toString("hex")}`;
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

export function isValidSearchId(value: unknown): value is string {
  return typeof value === "string" && /^s_[a-z0-9]+_[0-9a-f]{6,12}$/.test(value);
}

const SEARCH_ID_RE = /"searchId":"(s_[a-z0-9]+_[0-9a-f]{6,12})"/;

/** Extract the searchId of an event line without a full JSON parse (scan fast path). */
export function searchIdOfLine(line: string): string | null {
  return SEARCH_ID_RE.exec(line)?.[1] ?? null;
}
