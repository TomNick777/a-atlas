import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, dot, embedQuery } from "../lib/text/embed";
import { tokensOf } from "../lib/text/tokenize";
import { parseQuerySpec, exclusionCompanyPatterns } from "../lib/search/querySpec";

/**
 * Stage 3.1 四组区分测试(规格第十五节)的候选池构建:
 *   ALD(设备商 vs 前驱体材料) / PVD(设备商 vs 靶材) /
 *   刻蚀(设备 vs 石英/硅部件) / 半导体设备(设备厂 vs 零部件供应商)。
 * 检索机制与生产/冻结基准完全一致(BM25 + bge 向量 RRF,Top-20)。
 *
 * Usage: npx tsx scripts/stage3_1_focus_pools.ts
 *   → data/eval/stage3_1_focus_pools.json
 */

const root = process.cwd();
const snapshot = process.argv.includes("--snapshot");
const PROFILE_FILE = snapshot ? "data/eval/snapshot_stage3/search_profiles_v3.json" : "data/search_profiles_v3.json";
const VECTOR_FILE = snapshot ? "data/eval/snapshot_stage3/vectors_profile_v3.f32" : "data/vectors_profile_v3.f32";
const OUT_FILE = snapshot ? "stage3_1_focus_pools_stage3.json" : "stage3_1_focus_pools.json";
const RRF_K = 60;
const POOL = 20;
const FOCUS_QUERIES: { group: string; expect: string; query: string }[] = [
  { group: "ALD", expect: "equipment", query: "半导体ALD设备厂商" },
  { group: "ALD", expect: "material", query: "ALD前驱体材料供应商" },
  { group: "PVD", expect: "equipment", query: "PVD镀膜设备制造商" },
  { group: "PVD", expect: "material", query: "溅射靶材供应商" },
  { group: "ETCH", expect: "equipment", query: "等离子刻蚀设备" },
  { group: "ETCH", expect: "component", query: "刻蚀设备用石英件硅部件供应商" },
  { group: "GENERAL-EQUIP", expect: "equipment", query: "半导体设备厂" },
  { group: "GENERAL-EQUIP", expect: "component", query: "半导体设备零部件" },
];

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
  const companiesDoc = JSON.parse(readFileSync(path.join(root, "data", "companies.json"), "utf8"));
  const companies: { code: string; name: string; judgeText: string }[] = companiesDoc.companies;
  const profiles = JSON.parse(readFileSync(path.join(root, PROFILE_FILE), "utf8")) as Record<string, { searchText: string }>;
  const vectors = new Float32Array(readFileSync(path.join(root, VECTOR_FILE)).buffer);
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
  for (const fq of FOCUS_QUERIES) {
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
    queries.push({ ...fq, candidates: ranked.map((code) => ({ code })) });
    console.log(`${fq.group}/${fq.expect}: ${fq.query} → top5 ${ranked.slice(0, 5).join(",")}`);
  }
  writeFileSync(path.join(root, "data", "eval", OUT_FILE), JSON.stringify({ builtAt: new Date().toISOString(), pool: companies.length, queries }, null, 1) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
