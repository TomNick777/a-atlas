import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, dot, embedQuery } from "../lib/text/embed";
import { tokensOf } from "../lib/text/tokenize";
import { parseQuerySpec, exclusionCompanyPatterns } from "../lib/search/querySpec";

/**
 * V4 role-aware held-out benchmark pools (spec §17): retrieval mechanism EXACTLY
 * as production / the frozen Stage3 pools (BM25 + bge RRF, RRF_K=60, Top-200) —
 * retrieval is frozen for V4 (§4); this builder only OBSERVES it for new
 * held-out query texts. Queries come from data/eval/v4_role_queries.json
 * (dumped by scripts/laya_v4_query_sets.py — single source of truth).
 *
 * Usage: npx tsx scripts/build_v4_role_pools.ts
 *   → data/eval/v4_role_ranking_candidates.json
 */

const root = process.cwd();
const RRF_K = 60;
const POOL = 200;

function bm25TopK(postings: Map<string, Map<number, number>>, docLen: number[], avgdl: number, query: string, n: number, keep: (i: number) => boolean): number[] {
  const scores = new Map<number, number>();
  const seen = new Set<string>();
  for (const term of tokensOf(query)) {
    if (seen.has(term)) continue;
    seen.add(term);
    const list = postings.get(term);
    if (!list) continue;
    const df = list.size;
    const w = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const [di, tf] of list) {
      const denom = tf + 1.2 * (1 - 0.75 + 0.75 * (docLen[di] / avgdl));
      scores.set(di, (scores.get(di) ?? 0) + w * ((tf * 2.2) / denom));
    }
  }
  return [...scores.entries()].filter(([i, s]) => s > 0 && keep(i)).sort((a, b) => b[1] - a[1]).slice(0, POOL).map(([i]) => i);
}

async function main() {
  const queriesDoc = JSON.parse(readFileSync(path.join(root, "data", "eval", "v4_role_queries.json"), "utf8")) as {
    queries: { split: string; family: string; expect: string; query: string }[];
  };
  const companiesDoc = JSON.parse(readFileSync(path.join(root, "data", "companies.json"), "utf8"));
  const companies: { code: string; name: string; judgeText: string }[] = companiesDoc.companies;
  const profiles = JSON.parse(readFileSync(path.join(root, "data", "search_profiles_v3.json"), "utf8")) as Record<string, { searchText: string }>;
  const vectors = new Float32Array(readFileSync(path.join(root, "data", "vectors_profile_v3.f32")).buffer);
  const postings = new Map<string, Map<number, number>>();
  const docLen: number[] = [];
  companies.forEach((c, di) => {
    const tf = new Map<string, number>();
    for (const t of tokensOf(profiles[c.code]?.searchText || c.judgeText)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let len = 0;
    for (const [term, count] of tf) {
      len += count;
      let list = postings.get(term);
      if (!list) postings.set(term, (list = new Map()));
      list.set(di, count);
    }
    docLen.push(len);
  });
  const avgdl = docLen.reduce((a, b) => a + b, 0) / Math.max(1, docLen.length);

  const queries: any[] = [];
  for (const fq of queriesDoc.queries) {
    const spec = parseQuerySpec(fq.query);
    const keep = (i: number) => {
      const company = companies[i];
      if (spec.exclusions.flatMap((t) => exclusionCompanyPatterns(t).map((p) => new RegExp(p))).some((re) => re.test(company.judgeText))) return false;
      return true;
    };
    const expanded = spec.expansionTerms.length ? `${fq.query} ${spec.expansionTerms.join(" ")}` : fq.query;
    const words = bm25TopK(postings, docLen, avgdl, expanded, companies.length, keep);
    const embeds: number[] = [];
    for (let i = 0; i < companies.length; i++) if (keep(i)) embeds.push(i);
    const qvec = await embedQuery(expanded);
    embeds.sort((a, b) => dot(qvec!, vectors, b * DIM) - dot(qvec!, vectors, a * DIM));
    const embedTop = embeds.slice(0, POOL);
    const fused = new Map<number, number>();
    embedTop.forEach((i, at) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + at + 1)));
    words.forEach((i, at) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + at + 1)));
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, POOL).map(([i]) => companies[i].code);
    queries.push({ query_id: `V4-${fq.split.toUpperCase()}-${fq.family}::${queries.length}`, split: fq.split, family: fq.family, expect: fq.expect, query: fq.query, candidates: ranked.map((code) => ({ code })) });
    console.log(`${fq.split}/${fq.family}: ${fq.query} → top5 ${ranked.slice(0, 5).join(",")}`);
  }
  writeFileSync(
    path.join(root, "data", "eval", "v4_role_ranking_candidates.json"),
    JSON.stringify({ builtAt: new Date().toISOString(), pool: companies.length, edition: "v3", retrieval: { rrfK: RRF_K, pool: POOL, frozen: true }, queries }, null, 1) + "\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
