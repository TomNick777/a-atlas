import { writeFileSync } from "node:fs";
import path from "node:path";
import { requireLayaLane } from "./require-laya-lane";

requireLayaLane("laya_v4_2_eval_grade.ts");


/**
 * Grade frozen V4.2 pools (fixed pools or the Knowledge Pass 30-pool file)
 * through the running sidecar (LAYA_URL) — the exact judgeGraded production
 * path, identical to residual_triage's grade step. Only the checkpoint behind
 * the sidecar changes between arms; pools, order and protocol never do.
 *
 * Usage:
 *   npx tsx scripts/laya_v4_2_eval_grade.ts --in data/eval/v4_2_fixed_pools.json \
 *       --out data/eval/v4_2_fixed_pools_grades_<arm>.json
 *   npx tsx scripts/laya_v4_2_eval_grade.ts --in data/eval/residual_triage_pools_kp1.json \
 *       --out data/eval/residual_triage_grades_v42_kp1.json [--limit <n>]
 * --limit grades only the first N candidates per pool (debug).
 */

process.env.LAYA_URL ||= "http://127.0.0.1:8787";
delete process.env.TYPESAFE_API_KEY;

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1];
  };
  const inFile = getArg("--in");
  const outFile = getArg("--out");
  const limit = getArg("--limit") ? Number(getArg("--limit")) : null;
  if (!inFile || !outFile) throw new Error("--in and --out are required");

  const doc = JSON.parse(await (await import("node:fs")).promises.readFile(inFile, "utf8"));
  const pools: Record<string, { query: string; candidates: { code: string; name: string; profile?: string }[] }> =
    doc.pools ?? doc;

  const { judgeGraded } = await import("../lib/jev/judge");
  const out: Record<string, unknown> = {};
  let done = 0;
  for (const [key, pool] of Object.entries(pools)) {
    const all = pool.candidates;
    const slice = limit ? all.slice(0, limit) : all;
    const companies = slice.map((c) => ({
      name: c.name, code: c.code,
      searchProfileText: c.profile ?? "", judgeText: c.profile ?? "",
    }));
    const verdict = await judgeGraded(pool.query, companies as never);
    if (!verdict?.live) {
      console.warn(`[grades] ${key}: sidecar not live — skipping`);
      continue;
    }
    const graded = slice.map((c, at) => ({
      code: c.code, name: c.name, rank: at + 1,
      grade: Math.round((verdict.scores[at] ?? 0) * 3 * 1000) / 1000,
    }));
    out[key] = { query: pool.query, poolSize: all.length, graded: graded.length, grades: graded };
    done += 1;
    const top8 = graded.slice(0, 8).map((g) => `${g.name}@${g.grade}`).join(" ");
    console.log(`[grades] ${key}: ${top8}`);
  }
  writeFileSync(path.resolve(outFile), JSON.stringify(out, null, 1), "utf8");
  console.log(`[done] pools=${Object.keys(pools).length} graded=${done} → ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
