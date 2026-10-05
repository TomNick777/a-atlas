import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, dot, embedQuery } from "../lib/text/embed";
import { tokensOf } from "../lib/text/tokenize";
import { exclusionCompanyPatterns, parseQuerySpec } from "../lib/search/querySpec";
import { profileFileFor, vectorsFileFor, type Edition } from "../lib/search/edition";

/**
 * Freeze the Stage 3 rerank candidate pools: for each frozen benchmark query,
 * run the SAME retrieval mechanics as production for each edition and store the
 * Top-200 pool. The Python side then scores both pools through the SAME Laya
 * V3 sidecar (spec §23: only the profile differs; query/Laya/QuerySpec/RRF/
 * thresholds identical).
 *
 * Usage: npx tsx scripts/stage3_build_ranking_candidates.ts
 *   → data/eval/stage3_ranking_candidates_v2.json / _v3.json
 */

type BenchRow = { query_id: string; family: string; query: string; relevant3: { code: string }[] };
type Company = { code: string; name: string; judgeText: string; overseasRevenueShare?: number | null };

const RRF_K = 60;
const POOL = 200;
const EDITIONS: Edition[] = ["v2", "v3"];

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
  return [...scores.entries()]
    .filter(([i, s]) => s > 0 && keep(i))
    .sort((a, b) => b[1] - a[1])
    .slice(0, POOL)
    .map(([i]) => i);
}

function indexEdition(edition: Edition, companies: Company[]) {
  const profiles = JSON.parse(readFileSync(path.join(process.cwd(), profileFileFor(edition)), "utf8")) as Record<string, { searchText: string }>;
  const texts = companies.map((c) => profiles[c.code]?.searchText || c.judgeText);
  const vectors = new Float32Array(readFileSync(path.join(process.cwd(), vectorsFileFor(edition))).buffer);
  if (vectors.length !== companies.length * DIM) throw new Error(`${edition} vectors dim mismatch`);
  const postings = new Map<string, Map<number, number>>();
  const docLen: number[] = [];
  texts.forEach((text, di) => {
    const tf = new Map<string, number>();
    for (const t of tokensOf(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
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
  return { postings, docLen, avgdl, vectors };
}

async function main() {
  const companiesDoc = JSON.parse(readFileSync(path.join(process.cwd(), "data", "companies.json"), "utf8"));
  const companies: Company[] = companiesDoc.companies;
  const bench: BenchRow[] = readFileSync(path.join(process.cwd(), "data", "eval", "stage3_semiconductor_benchmark.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`stage3 benchmark: ${bench.length} queries, pool ${companies.length}`);

  const indexes = new Map<Edition, ReturnType<typeof indexEdition>>();
  for (const edition of EDITIONS) indexes.set(edition, indexEdition(edition, companies));
  console.log("editions indexed");

  for (const edition of EDITIONS) {
    const { postings, docLen, avgdl, vectors } = indexes.get(edition)!;
    const queries: { query_id: string; family: string; query: string; candidates: { code: string }[] }[] = [];
    for (const row of bench) {
      const spec = parseQuerySpec(row.query);
      const keep = (i: number) => {
        const company = companies[i];
        if (spec.exclusions.flatMap((t) => exclusionCompanyPatterns(t).map((p) => new RegExp(p))).some((re) => re.test(company.judgeText))) return false;
        if (spec.attrs.overseasMinShare != null && (company.overseasRevenueShare ?? 0) < spec.attrs.overseasMinShare) return false;
        return true;
      };
      const expanded = spec.expansionTerms.length ? `${row.query} ${spec.expansionTerms.join(" ")}` : row.query;
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
      queries.push({ query_id: row.query_id, family: row.family, query: row.query, candidates: ranked.map((code) => ({ code })) });
      if (queries.length % 20 === 0) console.log(`  ${edition}: ${queries.length}/${bench.length}`);
    }
    const out = path.join(process.cwd(), "data", "eval", `stage3_ranking_candidates_${edition}.json`);
    writeFileSync(out, JSON.stringify({ builtAt: new Date().toISOString(), pool: companies.length, edition, queries }, null, 1));
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
