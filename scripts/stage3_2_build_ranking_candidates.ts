import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DIM, dot, embedQuery } from "../lib/text/embed";
import { tokensOf } from "../lib/text/tokenize";
import { exclusionCompanyPatterns, parseQuerySpec } from "../lib/search/querySpec";

/**
 * Stage 3.2 搜索 A/B 冻结候选池(规格第二十六/二十八节):
 *   同一 V4.1 reranker(SHA 2742affc 全程不动),唯一变量 = Search Profile
 *   (Stage 3.1 snapshot vs Stage 3.2)。检索机制与生产完全一致
 *   (BM25 + bge 向量 RRF60,Top-200;QuerySpec/排除/境外硬条件不变)。
 *
 * 题集 = data/eval/stage3_semiconductor_benchmark.jsonl(87 题,冻结真值)
 *      + §26 十条聚焦查询(底部 FOCUS_QUERIES,rel3 依据已核实的 DIRECT 能力)。
 *
 * Usage: npx tsx scripts/stage3_2_build_ranking_candidates.ts
 *   → data/eval/stage3_2_ranking_candidates_31.json / _32.json
 */

const root = process.cwd();
const RRF_K = 60;
const POOL = 200;

const ARMS = {
  "31": {
    profiles: "data/eval/snapshot_stage3_1/search_profiles_v3.json",
    vectors: "data/eval/snapshot_stage3_1/vectors_profile_v3.f32",
  },
  "32": {
    profiles: "data/search_profiles_v3.json",
    vectors: "data/vectors_profile_v3.f32",
  },
} as const;

/** §26 十条聚焦查询 + rel3(来自本轮已核实的 DIRECT_COMPANY_CAPABILITY 数据,
 *  非搜索结果反推)。 */
const FOCUS_QUERIES: { query_id: string; family: string; query: string; relevant3: string[] }[] = [
  { query_id: "S32-FOCUS-CLEANDEP", family: "focus", query: "清洗/刻蚀/沉积设备", relevant3: ["002371", "688082", "688012"] },
  { query_id: "S32-FOCUS-ETCH", family: "focus", query: "刻蚀设备", relevant3: ["688012", "002371"] },
  { query_id: "S32-FOCUS-SEMIEQUIP", family: "focus", query: "半导体设备", relevant3: ["002371", "688012"] },
  { query_id: "S32-FOCUS-YIELD", family: "focus", query: "良率检测", relevant3: ["688361", "300567"] },
  { query_id: "S32-FOCUS-INSP", family: "focus", query: "半导体检测设备", relevant3: ["688361", "300567"] },
  { query_id: "S32-FOCUS-PROBECARD", family: "focus", query: "探针卡", relevant3: ["688809"] },
  { query_id: "S32-FOCUS-COMP", family: "focus", query: "半导体设备零部件", relevant3: ["301611", "300666", "688605"] },
  { query_id: "S32-FOCUS-PVD", family: "focus", query: "PVD设备", relevant3: ["002371"] },
  { query_id: "S32-FOCUS-TARGET", family: "focus", query: "PVD靶材", relevant3: ["300666"] },
  { query_id: "S32-FOCUS-ALD", family: "focus", query: "ALD设备", relevant3: ["688072", "002371", "688147"] },
  // §29:真实搜索回放 —— 冻结 holdout(data/eval/v4_1_real_search_holdout.json)
  // 里的真实用户 Query(中科飞测 #1 事件的原始查询),rel3 同上口径。
  { query_id: "S32-REAL-s_mueej67x", family: "real", query: "专门做半导体清洗、刻蚀或者薄膜沉积设备的公司", relevant3: ["688082", "603690", "002371"] },
  { query_id: "S32-REAL-s_mueg82x2", family: "real", query: "做刻蚀设备的公司", relevant3: ["688012", "002371", "688082"] },
  { query_id: "S32-REAL-s_muer4ygw", family: "real", query: "半导体刻蚀设备厂商", relevant3: ["688012", "002371", "688082"] },
];

type Company = { code: string; name: string; judgeText: string; overseasRevenueShare?: number | null };

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

function indexArm(arm: keyof typeof ARMS, companies: Company[]) {
  const { profiles: profileFile, vectors: vectorFile } = ARMS[arm];
  if (!existsSync(path.join(root, profileFile))) throw new Error(`missing ${profileFile}`);
  const profiles = JSON.parse(readFileSync(path.join(root, profileFile), "utf8")) as Record<string, { searchText: string }>;
  const texts = companies.map((c) => profiles[c.code]?.searchText || c.judgeText);
  const vectors = new Float32Array(readFileSync(path.join(root, vectorFile)).buffer);
  if (vectors.length !== companies.length * DIM) throw new Error(`${arm} vectors dim mismatch`);
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
  const companiesDoc = JSON.parse(readFileSync(path.join(root, "data", "companies.json"), "utf8"));
  const companies: Company[] = companiesDoc.companies;
  const bench: { query_id: string; family: string; query: string }[] = readFileSync(path.join(root, "data", "eval", "stage3_semiconductor_benchmark.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const all = [...bench, ...FOCUS_QUERIES];
  console.log(`queries: ${bench.length} benchmark + ${FOCUS_QUERIES.length} focus, pool ${companies.length}`);

  for (const arm of ["31", "32"] as const) {
    const { postings, docLen, avgdl, vectors } = indexArm(arm, companies);
    const queries: { query_id: string; family: string; query: string; relevant3?: string[]; candidates: { code: string }[] }[] = [];
    for (const row of all) {
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
      const focus = FOCUS_QUERIES.find((f) => f.query_id === row.query_id);
      queries.push({ query_id: row.query_id, family: row.family, query: row.query, ...(focus ? { relevant3: focus.relevant3 } : {}), candidates: ranked.map((code) => ({ code })) });
      if (queries.length % 20 === 0) console.log(`  arm${arm}: ${queries.length}/${all.length}`);
    }
    const out = path.join(root, "data", "eval", `stage3_2_ranking_candidates_${arm}.json`);
    writeFileSync(out, JSON.stringify({ builtAt: new Date().toISOString(), pool: companies.length, arm, queries }, null, 1));
    console.log(`wrote ${path.relative(root, out)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
