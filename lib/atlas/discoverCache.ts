import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isValidSearchId } from "../telemetry/ids";
import { evidenceViewsFor, type EvidenceView } from "./evidence";
/**
 * The discover answer cache (Phase 3.4) — moved out of the API route so the
 * evidence explanation surface can look up the EXACT result a user saw without
 * re-running it (and without paying Jev twice for one judgement).
 *
 * Product keys bind corpus, judge, parser and discovery contract. Market
 * snapshots and trading calendars belong to the maintenance lane only.
 */
import { LruCache } from "@/lib/cache";
import { loadDataset } from "@/lib/companies";
import { judgeCacheIdentity, currentJudgeId } from "@/lib/intelligence/capabilities";
import { PARSER_V2_VERSION } from "@/lib/planner/contracts";
import { HYBRID_PLANNER_VERSION } from "@/lib/hybrid/contracts";
import type { HybridDiscoverResult } from "@/lib/hybrid/contracts";
import { COMPANY_DISCOVERY_VERSION } from "@/lib/discovery/contracts";

export type DiscoverResult = HybridDiscoverResult;

const cache = new LruCache<DiscoverResult>(48);
export type AnswerRecord = { answer: DiscoverResult; provider: "jev" | "laya" | "drex"; runtimeModel: string | null; corpusDigest: string; identity: string; evidence: Record<string, EvidenceView[]> };
const answers = new LruCache<AnswerRecord>(128);
const legacy = new Map<string, Map<string, AnswerRecord>>();
export function recordDiscoverAnswer(id: string, answer: DiscoverResult): void {
  const dataset = loadDataset();
  const record = { answer: structuredClone(answer), provider: currentJudgeId(), runtimeModel: answer.intelligence?.runtimeModel ?? null, corpusDigest: dataset.corpus?.contentDigest16 ?? dataset.version, identity: judgeCacheIdentity(), evidence: Object.fromEntries(answer.results.map(row => [row.code, row.judgement ? evidenceViewsFor(row.judgement.evidenceRefs) ?? [] : []])) };
  answers.set(id, record);
  if (isValidSearchId(id)) {
    try {
      const directory = process.env.ATLAS_ANSWER_ROOT ?? join(process.cwd(), "data/discovery-answers");
      mkdirSync(directory, { recursive: true });
      const payload = JSON.stringify(record);
      const sha256 = createHash("sha256").update(payload).digest("hex");
      writeFileSync(join(directory, `${id}.json`), JSON.stringify({ schemaVersion: 1, id, sha256, payload }), { flag: "wx" });
    } catch { /* Disk failure cannot break a search. Memory remains usable; restart shows unavailable. */ }
  }
  const variants = legacy.get(answer.query) ?? new Map<string, AnswerRecord>();
  variants.set(record.identity, record); legacy.delete(answer.query); legacy.set(answer.query, variants);
  if (legacy.size > 48) legacy.delete(legacy.keys().next().value!);
}
export function lookupAnswerRecord(id: string | undefined, query: string): AnswerRecord | undefined {
  if (id) {
    let record = answers.get(id);
    if (!record && isValidSearchId(id)) {
      try {
        const file = join(process.env.ATLAS_ANSWER_ROOT ?? join(process.cwd(), "data/discovery-answers"), `${id}.json`);
        const envelope = JSON.parse(readFileSync(file, "utf8"));
        if (envelope.schemaVersion === 1 && envelope.id === id && typeof envelope.payload === "string" && createHash("sha256").update(envelope.payload).digest("hex") === envelope.sha256) {
          record = JSON.parse(envelope.payload) as AnswerRecord;
          answers.set(id, record);
        }
      } catch { /* Corrupt/missing historical record is unavailable, never recreated. */ }
    }
    return record?.answer.query === query ? record : undefined;
  }
  const variants = legacy.get(query);
  return variants?.size === 1 ? variants.values().next().value : undefined;
}

export function discoverCacheKey(query: string): string {
  const { version } = loadDataset();
  return `${version}:${judgeCacheIdentity()}:${PARSER_V2_VERSION}:${HYBRID_PLANNER_VERSION}:${COMPANY_DISCOVERY_VERSION}:${query}`;
}

export function lookupDiscover(key: string): DiscoverResult | undefined {
  return cache.get(key);
}

export function storeDiscover(key: string, result: DiscoverResult): void {
  cache.set(key, result);
  recordDiscoverAnswer(result.searchId ?? key, result);
}
