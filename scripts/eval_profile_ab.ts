import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, dot, embedQuery } from "../lib/text/embed";
import { tokensOf } from "../lib/text/tokenize";
import { exclusionCompanyPatterns, parseQuerySpec } from "../lib/search/querySpec";
import { profileFileFor, vectorsFileFor, type Edition } from "../lib/search/edition";

/**
 * Profile retrieval A/B on a frozen benchmark. Same QuerySpec, same expansion,
 * same RRF(k=60) mechanics as production lib/search/v3.ts — the ONLY variable
 * is the profile edition (searchText + vectors). No LLM involved.
 *
 * Stage 2 ran v1-vs-v2; Stage 3 runs v2-vs-v3 (same Laya V3 checkpoint on the
 * rerank side, see stage3_ranking_ab.py). Defaults preserve the Stage 2 call.
 *
 * Usage: npx tsx scripts/eval_profile_ab.ts [--a=v2] [--b=v3]
 *        [--bench=data/eval/v3_search_benchmark.jsonl]
 *        [--out=reports/SEARCH_PROFILE_V2_BENCHMARK_DATA.json]
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

type Company = { code: string; name: string; judgeText: string; overseasRevenueShare?: number | null };

const K_LIST = [20, 50, 100, 200];
const RRF_K = 60;

function argOf(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
}

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
    .slice(0, 200)
    .map(([i]) => i);
}

type Indexed = {
  postings: Map<string, Map<number, number>>;
  docLen: number[];
  avgdl: number;
  vectors: Float32Array;
};

function indexEdition(edition: Edition, companies: Company[]): Indexed {
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
  const editionA = argOf("a", "v2") as Edition;
  const editionB = argOf("b", "v3") as Edition;
  const benchFile = argOf("bench", "data/eval/v3_search_benchmark.jsonl");
  const outFile = argOf("out", `reports/STAGE3_SEMICONDUCTOR_AB_DATA.json`);

  const companiesDoc = JSON.parse(readFileSync(path.join(process.cwd(), "data", "companies.json"), "utf8"));
  const companies: Company[] = companiesDoc.companies;
  const bench: BenchRow[] = readFileSync(path.join(process.cwd(), benchFile), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  console.log(`A=${editionA} B=${editionB}; benchmark queries: ${bench.length}, pool: ${companies.length}`);

  const indexA = indexEdition(editionA, companies);
  const indexB = indexEdition(editionB, companies);
  console.log("both editions indexed");

  const perQuery: Record<string, unknown>[] = [];
  type Totals = { hit: number[]; first: number[]; relN: number; ndcg: Map<number, number[]> };
  const mk = (): Totals => ({ hit: K_LIST.map(() => 0), first: [], relN: 0, ndcg: new Map(K_LIST.map((k) => [k, [] as number[]])) });
  const totals: Record<string, Totals> = { [editionA]: mk(), [editionB]: mk() };
  const familyTotals: Record<string, Record<string, { n: number; hit200: number }>> = {};

  for (const row of bench) {
    const relCodes = new Set(row.relevant3.map((r) => r.code));
    const spec = parseQuerySpec(row.query);
    const expanded = spec.expansionTerms.length ? `${row.query} ${spec.expansionTerms.join(" ")}` : row.query;
    const qvec = await embedQuery(expanded);
    const entry: Record<string, unknown> = { query_id: row.query_id, family: row.family, query: row.query, rel3: relCodes.size };

    for (const edition of [editionA, editionB]) {
      const keep = (i: number) => {
        const company = companies[i];
        if (spec.exclusions.flatMap((t) => exclusionCompanyPatterns(t).map((p) => new RegExp(p))).some((re) => re.test(company.judgeText))) return false;
        if (spec.attrs.overseasMinShare != null && (company.overseasRevenueShare ?? 0) < spec.attrs.overseasMinShare) return false;
        return true;
      };
      const { postings, docLen, avgdl, vectors } = edition === editionA ? indexA : indexB;
      const words = bm25TopK(postings, docLen, avgdl, expanded, companies.length, keep);
      const embeds: number[] = [];
      for (let i = 0; i < companies.length; i++) if (keep(i)) embeds.push(i);
      embeds.sort((a, b) => dot(qvec, vectors, b * DIM) - dot(qvec, vectors, a * DIM));
      const embedTop = embeds.slice(0, 200);
      const fused = new Map<number, number>();
      embedTop.forEach((i, at) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + at + 1)));
      words.forEach((i, at) => fused.set(i, (fused.get(i) ?? 0) + 1 / (RRF_K + at + 1)));
      const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);

      K_LIST.forEach((k, ki) => {
        const topK = ranked.slice(0, k);
        const hit = topK.filter((i) => relCodes.has(companies[i].code)).length;
        totals[edition].hit[ki] += hit;
        entry[`${edition}_hit@${k}`] = hit;
        // nDCG with binary relevance on rel3
        let dcg = 0;
        topK.forEach((i, at) => {
          if (relCodes.has(companies[i].code)) dcg += 1 / Math.log2(at + 2);
        });
        const ideal = Math.min(relCodes.size, k);
        let idcg = 0;
        for (let at = 0; at < ideal; at++) idcg += 1 / Math.log2(at + 2);
        totals[edition].ndcg.get(k)!.push(idcg ? dcg / idcg : 0);
      });
      totals[edition].relN += relCodes.size;
      const firstRel = ranked.findIndex((i) => relCodes.has(companies[i].code));
      totals[edition].first.push(firstRel < 0 ? -1 : firstRel + 1);
      entry[`${edition}_firstRel`] = firstRel < 0 ? null : firstRel + 1;
      entry[`${edition}_cand`] = ranked.length;
      const top200Codes = ranked.slice(0, 200).map((i) => companies[i].code);
      entry[`${edition}_top200`] = top200Codes;

      familyTotals[row.family] ??= {};
      familyTotals[row.family][edition] ??= { n: 0, hit200: 0 };
      familyTotals[row.family][edition].n += 1;
      familyTotals[row.family][edition].hit200 += ranked.slice(0, 200).filter((i) => relCodes.has(companies[i].code)).length;
    }
    perQuery.push(entry);
    if (perQuery.length % 25 === 0) console.log(`  ${perQuery.length}/${bench.length}`);
  }

  const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 1000) / 1000;
  const report = {
    generatedAt: new Date().toISOString(),
    editions: { a: editionA, b: editionB },
    benchmark: benchFile,
    note: "同一 QuerySpec/RRF/硬过滤机制,唯一变量是 profile 底文+对应向量。召回目标=label-3,分母=Σ|rel3|。nDCG 为二值相关。",
    queries: bench.length,
    recallAt: Object.fromEntries(
      K_LIST.map((k, ki) => [
        `R@${k}`,
        {
          [editionA]: Math.round((totals[editionA].hit[ki] / totals[editionA].relN) * 1000) / 1000,
          [editionB]: Math.round((totals[editionB].hit[ki] / totals[editionB].relN) * 1000) / 1000,
        },
      ]),
    ),
    ndcgAt: Object.fromEntries(
      K_LIST.map((k) => [
        `nDCG@${k}`,
        { [editionA]: mean(totals[editionA].ndcg.get(k)!), [editionB]: mean(totals[editionB].ndcg.get(k)!) },
      ]),
    ),
    meanFirstRelevantRank: {
      [editionA]: mean(totals[editionA].first),
      [editionB]: mean(totals[editionB].first),
    },
    perFamily: Object.fromEntries(
      Object.entries(familyTotals).map(([f, t]) => [
        f,
        Object.fromEntries(
          [editionA, editionB].map((e) => [
            e,
            { hitPerQuery: Math.round((t[e]?.hit200 ?? 0 / Math.max(1, t[e]?.n ?? 1)) * 1000) / 1000, n: t[e]?.n ?? 0, rel3PerQuery: bench.filter((r) => r.family === f).reduce((s, r) => s + r.relevant3.length, 0) / (t[e]?.n ?? 1) },
          ]),
        ),
      ]),
    ),
    perQuery,
  };
  writeFileSync(path.join(process.cwd(), outFile), JSON.stringify(report, null, 1));

  console.log(`\n=== Profile ${editionA} vs ${editionB} (retrieval, R@label-3) ===`);
  for (const [k, v] of Object.entries(report.recallAt)) {
    const r = v as Record<string, number>;
    console.log(`${k}:  ${editionA}=${r[editionA]}  ${editionB}=${r[editionB]}  Δ=${Math.round((r[editionB] - r[editionA]) * 1000) / 1000}`);
  }
  for (const [k, v] of Object.entries(report.ndcgAt)) {
    const r = v as Record<string, number>;
    console.log(`${k}:  ${editionA}=${r[editionA]}  ${editionB}=${r[editionB]}  Δ=${Math.round((r[editionB] - r[editionA]) * 1000) / 1000}`);
  }
  console.log(`wrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
