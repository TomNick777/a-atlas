import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, dot, embedQuery } from "../lib/text/embed";
import { tokensOf } from "../lib/text/tokenize";
import { exclusionCompanyPatterns, parseQuerySpec } from "../lib/search/querySpec";

/**
 * Retrieval benchmark: BM25 vs bge embedding vs hybrid RRF over the full pool,
 * scored on data/eval/v3_search_benchmark.jsonl (Recall@50/100/200 + best-rank).
 *
 * Systems (each over the full 5,567-company pool):
 *   embed-searchable  production vectors.f32 (bge over searchableText)
 *   embed-judge       bge over judgeText (data/vectors_judge.f32, optional)
 *   bm25-searchable   proper BM25 (tf saturation + length norm) over searchableText
 *   bm25-judge        proper BM25 over judgeText
 *   rrf-best          reciprocal-rank fusion of the best embed + best bm25
 *
 * Usage: npx tsx scripts/eval_retrieval.ts [--k 50,100,200] [--out reports/...]
 */

type BenchRow = {
  query_id: string;
  family: string;
  category: string;
  benchmark: string;
  query: string;
  relevant3: { code: string }[];
  relevant2: { code: string }[];
};

type Company = { code: string; searchableText: string; judgeText: string };

const K_LIST = (process.argv.find((a) => a.startsWith("--k"))?.split("=")[1] ?? "50,100,200")
  .split(",")
  .map((n) => parseInt(n, 10));

function loadFloat32(file: string): Float32Array | null {
  try {
    const buf = readFileSync(path.join(process.cwd(), file));
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  } catch {
    return null;
  }
}

/** Proper BM25 over pre-tokenized docs, inverted index for speed. */
function buildBm25(docs: string[]) {
  const docTokens = docs.map((d) => tokensOf(d));
  const docLen = docTokens.map((t) => t.length);
  const avgdl = docLen.reduce((a, b) => a + b, 0) / Math.max(1, docLen.length);
  const postings = new Map<string, Map<number, number>>();
  docTokens.forEach((tokens, di) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = new Map()));
      list.set(di, count);
    }
  });
  const n = docs.length;
  const idf = (term: string) => {
    const df = postings.get(term)?.size ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  };
  return (query: string, k: number): { index: number; score: number }[] => {
    const scores = new Map<number, number>();
    const seen = new Set<string>();
    for (const term of tokensOf(query)) {
      if (seen.has(term)) continue;
      seen.add(term);
      const list = postings.get(term);
      if (!list) continue;
      const w = idf(term);
      for (const [di, tf] of list) {
        // standard BM25: tf*(k1+1) / (tf + k1*(1-b+b*dl/avgdl)), k1=1.2 b=0.75
        const denom = tf + 1.2 * (1 - 0.75 + 0.75 * (docLen[di] / avgdl));
        scores.set(di, (scores.get(di) ?? 0) + w * ((tf * 2.2) / denom));
      }
    }
    return [...scores.entries()]
      .map(([index, score]) => ({ index, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  };
}

function embedRank(queryVec: Float32Array, vectors: Float32Array, count: number, k: number) {
  const scores: { index: number; score: number }[] = [];
  for (let i = 0; i < count; i++) scores.push({ index: i, score: dot(queryVec, vectors, i * DIM) });
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

function rrfFuse(rankings: { index: number }[][], k: number): { index: number }[] {
  const fused = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((row, at) => {
      if (at >= k) return;
      fused.set(row.index, (fused.get(row.index) ?? 0) + 1 / (60 + at + 1));
    });
  }
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([index]) => ({ index }));
}

async function main() {
  const dataset = JSON.parse(readFileSync(path.join(process.cwd(), "data", "companies.json"), "utf8"));
  const companies: Company[] = dataset.companies;
  const profiles: Record<string, { searchText: string }> = JSON.parse(
    readFileSync(path.join(process.cwd(), "data", "search_profiles.json"), "utf8"),
  );
  const profileTexts = companies.map((c) => profiles[c.code]?.searchText || c.judgeText);
  const n = companies.length;
  const bench: BenchRow[] = readFileSync(path.join(process.cwd(), "data", "eval", "v3_search_benchmark.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  console.log(`pool=${n} queries=${bench.length}`);

  const maxK = Math.max(...K_LIST, 250);
  const vecSearchable = loadFloat32("data/vectors.f32");
  const vecJudge = loadFloat32("data/vectors_judge.f32");
  const vecProfile = loadFloat32("data/vectors_profile.f32");
  if (!vecSearchable || vecSearchable.length !== n * DIM) throw new Error("vectors.f32 missing or size mismatch");
  if (vecJudge && vecJudge.length !== n * DIM) throw new Error("vectors_judge.f32 size mismatch");
  if (vecProfile && vecProfile.length !== n * DIM) throw new Error("vectors_profile.f32 size mismatch");
  const bm25Searchable = buildBm25(companies.map((c) => c.searchableText));
  const bm25Judge = buildBm25(companies.map((c) => c.judgeText));
  const bm25Profile = buildBm25(profileTexts);

  /** QuerySpec hard filters: exclusion company-patterns zeroed; attribute bounds. */
  const specFilter = (query: string): ((i: number) => boolean) => {
    const spec = parseQuerySpec(query);
    const drop: RegExp[] = spec.exclusions.flatMap((t) => exclusionCompanyPatterns(t).map((p) => new RegExp(p)));
    return (i: number) => {
      const c = companies[i];
      const text = `${c.judgeText}`;
      if (drop.some((r) => r.test(text))) return false;
      if (spec.attrs.overseasMinShare != null) {
        const share = dataset.companies[i].overseasRevenueShare;
        if (share == null || share < spec.attrs.overseasMinShare) return false;
      }
      return true;
    };
  };

  const systems = [
    "embed-searchable",
    ...(vecJudge ? ["embed-judge"] : []),
    "bm25-searchable",
    "bm25-judge",
    "rrf-searchable",
    ...(vecJudge ? ["rrf-judge"] : []),
    ...(vecProfile ? ["spec-embed", "spec-bm25", "spec-rrf"] : []),
  ];
  const hits = new Map<string, Map<string, number>>();
  for (const s of systems) hits.set(s, new Map());

  const perQuery: Record<string, unknown>[] = [];
  for (const row of bench) {
    const rel3 = new Set(row.relevant3.map((r) => r.code));
    const rel2 = new Set(row.relevant2.map((r) => r.code));
    if (rel3.size === 0 && rel2.size === 0) continue;

    const qvec = await embedQuery(row.query);
    const spec = parseQuerySpec(row.query);
    const keep = specFilter(row.query);
    const expanded = spec.expansionTerms.length ? `${row.query} ${spec.expansionTerms.join(" ")}` : row.query;
    const eqvec = spec.expansionTerms.length ? await embedQuery(expanded) : qvec;
    const rankings: Record<string, { index: number }[]> = {
      "embed-searchable": embedRank(qvec, vecSearchable, n, maxK),
      "bm25-searchable": bm25Searchable(row.query, maxK),
      "bm25-judge": bm25Judge(row.query, maxK),
    };
    if (vecJudge) rankings["embed-judge"] = embedRank(qvec, vecJudge, n, maxK);
    rankings["rrf-searchable"] = rrfFuse([rankings["embed-searchable"], rankings["bm25-searchable"]], maxK);
    if (vecJudge) rankings["rrf-judge"] = rrfFuse([rankings["embed-judge"], rankings["bm25-judge"]], maxK);
    if (vecProfile) {
      // QuerySpec systems: profile text + query expansion + hard filters
      const specEmbed = embedRank(eqvec, vecProfile, n, maxK).filter((r) => keep(r.index));
      const specBm25 = bm25Profile(expanded, maxK).filter((r) => keep(r.index));
      rankings["spec-embed"] = specEmbed;
      rankings["spec-bm25"] = specBm25;
      rankings["spec-rrf"] = rrfFuse([specEmbed, specBm25], maxK);
    }

    const queryStats: Record<string, unknown> = { query_id: row.query_id, family: row.family, query: row.query };
    for (const [system, ranking] of Object.entries(rankings)) {
      const codes = ranking.map((r) => companies[r.index].code);
      for (const k of K_LIST) {
        const top = new Set(codes.slice(0, k));
        const key = `${system}@R${k}`;
        const rec3 = [...rel3].filter((c) => top.has(c)).length / rel3.size;
        const hitMap = hits.get(system)!;
        hitMap.set(key, (hitMap.get(key) ?? 0) + rec3);
        queryStats[key] = rec3;
      }
      const first3 = codes.findIndex((c) => rel3.has(c));
      const firstRel = codes.findIndex((c) => rel3.has(c) || rel2.has(c));
      const h = hits.get(system)!;
      h.set("best3", (h.get("best3") ?? 0) + (first3 < 0 ? maxK : first3 + 1));
      h.set("bestAny", (h.get("bestAny") ?? 0) + (firstRel < 0 ? maxK : firstRel + 1));
      queryStats[`${system}.best3`] = first3 < 0 ? null : first3 + 1;
    }
    perQuery.push(queryStats);
  }

  const nq = perQuery.length;
  const summary: Record<string, Record<string, number>> = {};
  for (const [system, m] of hits) {
    summary[system] = {};
    for (const k of K_LIST) summary[system][`R${k}`] = round4((m.get(`${system}@R${k}`) ?? 0) / nq);
    summary[system]["avgBest3Rank"] = round4((m.get("best3") ?? 0) / nq);
    summary[system]["avgBestAnyRank"] = round4((m.get("bestAny") ?? 0) / nq);
  }

  // tight-query subset: EV families only (the manually reviewed ranking benchmark)
  const evRows = perQuery.filter((q) => String(q["family"]).startsWith("EV-"));
  if (evRows.length) {
    console.log(`\n=== EV-only (n=${evRows.length}) ===`);
    for (const system of systems) {
      const r50 = mean(evRows.map((q) => Number(q[`${system}@R50`] ?? 0)));
      const r200 = mean(evRows.map((q) => Number(q[`${system}@R200`] ?? 0)));
      console.log(system.padEnd(18), `R50=${r50.toFixed(3)} R200=${r200.toFixed(3)}`);
    }
  }

  console.log(`\n=== Recall@K over relevant-3 (all queries, n=${nq}) ===`);
  for (const [system, s] of Object.entries(summary)) console.log(system.padEnd(18), JSON.stringify(s));

  writeFileSync(
    path.join(process.cwd(), "data", "eval", "retrieval_eval_perquery.json"),
    JSON.stringify({ n_queries: nq, summary, per_query: perQuery }, null, 1),
  );
  console.log("written data/eval/retrieval_eval_perquery.json");
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
