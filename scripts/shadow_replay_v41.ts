/**
 * V4.1 real-search shadow replay (spec §5): same frozen pool, only the reranker
 * checkpoint changes.
 *
 * For every entry in data/eval/v4_1_real_search_holdout.json the frozen pool is
 * the fusedTop200 the production run itself logged. Both arms run the exact
 * production code path — judgeGraded (SystemOne wire shape, CHUNK=100) + fuse +
 * constraintsFromQuery — against two sidecars that differ only in checkpoint:
 *   arm "v3"  → LAYA_URL port 8791 (a-share-laya-v3/checkpoint_best)
 *   arm "v41" → LAYA_URL port 8792 (a-share-laya-v4.1-candidate/checkpoint_best)
 *
 * No retrieval is re-run, no query is edited, nothing is logged to search_log.
 * Output: reports/v4_1_eval/v41_real_shadow_replay.json
 *
 * Usage:
 *   npm run laya:v3 -- --port 8791   (separate shells)
 *   npm run laya:v4.1 -- --port 8792
 *   npx tsx scripts/shadow_replay_v41.ts
 */

import { writeFileSync, mkdirSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import type { Company } from "../lib/types";
import { loadDataset } from "../lib/companies";
import { judgeGraded } from "../lib/jev/judge";
import { constraintsFromQuery } from "../lib/search/constraints";
import { fuse, matchCount } from "../lib/search/score";
import { requireLayaLane } from "./require-laya-lane";

requireLayaLane("shadow_replay_v41.ts");


const ROOT = path.resolve(import.meta.dirname, "..");
const HOLDOUT = path.join(ROOT, "data", "eval", "v4_1_real_search_holdout.json");
const OUT_DIR = path.join(ROOT, "reports", "v4_1_eval");
const ARMS = [
  { id: "v3", port: 8791, checkpoint: "models/a-share-laya-v3/checkpoint_best", sha16: "419daa881b727083" },
  { id: "v41", port: 8792, checkpoint: "models/a-share-laya-v4.1-candidate/checkpoint_best", sha16: "2742affc3f677d71" },
] as const;

type ArmId = (typeof ARMS)[number]["id"];

/**
 * Arms run SEQUENTIALLY in separate invocations (one sidecar up at a time):
 * this 8GB GPU is shared with other tenants and running both models at once
 * pushed chunk latency past the production 12s client timeout. Same frozen
 * pools, same code path; the merge step joins the per-arm files by entryId.
 */
const armArg = process.argv[process.argv.indexOf("--arm") + 1] as ArmId | undefined;
if (armArg !== "v3" && armArg !== "v41") {
  console.error("usage: tsx scripts/shadow_replay_v41.ts --arm v3|v41");
  process.exit(2);
}
const ARM = ARMS.find(({ id }) => id === armArg)!;

type HoldoutEntry = {
  entryId: string;
  logIndex: number;
  query: string;
  normalized: string;
  timestamp: string;
  era: string;
  frozenPool: string[];
  v3Top20: { rank: number; code: string; name: string; score: number }[];
  domainTag: string;
};

async function health(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/health`);
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function main() {
  const holdout = JSON.parse(await fsPromises.readFile(HOLDOUT, "utf8"));
  const entries: HoldoutEntry[] = holdout.queries;
  const { companies } = loadDataset();
  const byCode = new Map(companies.map((c) => [c.code, c]));

  const base = `http://127.0.0.1:${ARM.port}`;
  const h = await health(base);
  console.log(`[arm ${ARM.id}] sidecar health:`, JSON.stringify(h));
  if (!String(h.ok)) throw new Error(`${ARM.id} sidecar not ok`);
  // Steady-state warmup (production sidecar is a long-running warm server);
  // excluded from every timing below.
  process.env.LAYA_URL = base;
  process.env.TYPESAFE_API_KEY = "";
  await judgeGraded("warmup 探针", companies.slice(0, 3), undefined);
  console.log(`[arm ${ARM.id}] warmup done`);

  const results: unknown[] = [];
  const codeToIndex = new Map(companies.map((c, index) => [c.code, index]));
  for (const entry of entries) {
    const poolCodes = entry.frozenPool;
    const absent = poolCodes.filter((code) => !byCode.has(code));
    if (absent.length) throw new Error(`${entry.entryId}: ${absent.length} pool codes absent from dataset: ${absent.slice(0, 5)}`);
    const poolCompanies = poolCodes.map((code) => byCode.get(code)!);
    const poolIndexes = poolCodes.map((code) => codeToIndex.get(code)!);
    const constraints = constraintsFromQuery(entry.normalized);

    const arms: Record<ArmId, unknown> = {} as Record<ArmId, unknown>;
    {
      const arm = ARM;
      process.env.LAYA_URL = `http://127.0.0.1:${arm.port}`;
      process.env.TYPESAFE_API_KEY = "";
      // The production client times a chunk at 12s (judge.ts) and degrades on
      // timeout. Deterministic model → a timed-out chunk is a transport loss,
      // not a different score, so the replay retries it and records attempts.
      let verdict: Awaited<ReturnType<typeof judgeGraded>> | null = null;
      let attempts = 0;
      const armStarted = performance.now();
      while (!verdict?.live && attempts < 3) {
        attempts += 1;
        const chunkStarted = performance.now();
        verdict = await judgeGraded(entry.normalized, poolCompanies, undefined);
        if (!verdict?.live) {
          console.warn(`[retry] ${entry.entryId}/${arm.id} attempt ${attempts} failed after ${Math.round(performance.now() - chunkStarted)}ms`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      const rerankMs = performance.now() - armStarted;
      if (!verdict?.live) throw new Error(`${entry.entryId}/${arm.id}: judge not live after ${attempts} attempts`);
      const scores = verdict.scores;
      const gradeOf = new Map(poolIndexes.map((index, at) => [index, Math.round((scores[at] ?? 0) * 3)]));
      const ranked = fuse(companies, poolIndexes, scores, constraints);
      const matches = matchCount(ranked);
      const top20 = ranked.slice(0, Math.max(matches, 0)).slice(0, 20).map((row, rank) => {
        const company = companies[row.index];
        return {
          rank: rank + 1,
          code: company.code,
          name: company.name,
          score: Math.round(row.probability * 1000) / 1000,
          grade: gradeOf.get(row.index) ?? 0,
        };
      });
      const fullRank = new Map(ranked.map((row, at) => [companies[row.index].code, at + 1]));
      arms[arm.id] = {
        checkpoint: arm.checkpoint,
        rerankerSha16: arm.sha16,
        rerankMs: Math.round(rerankMs * 100) / 100,
        rerankAttempts: attempts,
        matches,
        top20,
        rankById: Object.fromEntries(fullRank),
        gradeById: Object.fromEntries([...gradeOf].map(([index, grade]) => [companies[index].code, grade])),
      };
      console.log(
        `[${entry.entryId.slice(0, 14)}] ${arm.id} rerank=${Math.round(rerankMs)}ms matches=${matches} top1=${top20[0]?.name ?? "-"}`,
      );
    }

    results.push({
      entryId: entry.entryId,
      logIndex: entry.logIndex,
      query: entry.query,
      normalized: entry.normalized,
      domainTag: entry.domainTag,
      era: entry.era,
      originalTimestamp: entry.timestamp,
      poolSize: entry.frozenPool.length,
      loggedV3Top20: entry.v3Top20,
      arms,
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `v41_real_shadow_replay.${ARM.id}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      { generatedBy: "scripts/shadow_replay_v41.ts", arm: { id: ARM.id, checkpoint: ARM.checkpoint, rerankerSha16: ARM.sha16 }, results },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`wrote ${outFile} (${results.length} entries)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
