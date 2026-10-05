import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, dot, embedQuery } from "../lib/text/embed";
import { tokensOf } from "../lib/text/tokenize";
import { exclusionCompanyPatterns, parseQuerySpec } from "../lib/search/querySpec";
import { profileEdition, profileFileFor, vectorsFileFor } from "../lib/search/edition";
import { requireLayaLane } from "./require-laya-lane";

requireLayaLane("build_ranking_candidates.ts");


/**
 * V3 candidate pools for the ranking benchmark: production retrieval path
 * (QuerySpec -> expanded BM25 over searchProfile text ⊕ bge over profile vectors,
 * RRF, hard filters) frozen to data/eval/. The Python acceptance/ranking runners
 * then rerank these pools through the sidecar.
 *
 * The frozen V1 baseline is data/eval/v3_ranking_candidates.json — do not overwrite.
 * V2 pools: SEARCH_PROFILE_EDITION=v2 npx tsx scripts/build_ranking_candidates.ts
 *   --out=data/eval/v3_ranking_candidates_v2.json
 */

type Company = { code: string; name: string; judgeText: string; overseasRevenueShare?: number | null };

function bm25Top(docs: { tokens: Map<string, number>; len: number }[], postings: Map<string, Map<number, number>>, docLen: number[], avgdl: number, query: string, k: number) {
  const scores = new Map<number, number>();
  const seen = new Set<string>();
  for (const term of tokensOf(query)) {
    if (seen.has(term)) continue;
    seen.add(term);
    const list = postings.get(term);
    if (!list) continue;
    const df = list.size;
    const w = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
    for (const [di, tf] of list) {
      const denom = tf + 1.2 * (1 - 0.75 + 0.75 * (docLen[di] / avgdl));
      scores.set(di, (scores.get(di) ?? 0) + w * ((tf * 2.2) / denom));
    }
  }
  return [...scores.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

async function main() {
  const poolSize = parseInt(process.argv.find((a) => a.startsWith("--pool"))?.split("=")[1] ?? "200", 10);
  const outArg = process.argv.find((a) => a.startsWith("--out"))?.split("=")[1];
  const edition = profileEdition();
  const dataset = JSON.parse(readFileSync(path.join(process.cwd(), "data", "companies.json"), "utf8"));
  const companies: Company[] = dataset.companies;
  const profiles: Record<string, { searchText: string }> = JSON.parse(
    readFileSync(path.join(process.cwd(), profileFileFor(edition)), "utf8"),
  );
  const texts = companies.map((c) => profiles[c.code]?.searchText || c.judgeText);
  const vectors = new Float32Array(
    readFileSync(path.join(process.cwd(), vectorsFileFor(edition))).buffer,
  );
  console.log(`edition=${edition} profiles=${profileFileFor(edition)} vectors=${vectorsFileFor(edition)}`);

  const docTokens = texts.map((t) => {
    const m = new Map<string, number>();
    for (const tok of tokensOf(t)) m.set(tok, (m.get(tok) ?? 0) + 1);
    return m;
  });
  const postings = new Map<string, Map<number, number>>();
  docTokens.forEach((tf, di) => {
    for (const [term, count] of tf) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = new Map()));
      list.set(di, count);
    }
  });
  const docLen = docTokens.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const avgdl = docLen.reduce((a, b) => a + b, 0) / Math.max(1, docLen.length);

  // queries: internal ranking benchmark (EV, non-external) + the 20 acceptance queries
  const bench: { query_id: string; family: string; benchmark: string; query: string }[] = readFileSync(
    path.join(process.cwd(), "data", "eval", "v3_search_benchmark.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const queries = bench.filter((r) => r.benchmark === "ranking");
  const acceptance: [string, string][] = [
    ["Q01", "人形机器人上游核心零部件，但不要整机厂"],
    ["Q02", "给数据中心做液冷散热的公司"],
    ["Q03", "AI 算力相关的硬件公司，但不要纯软件公司"],
    ["Q04", "做工业自动化，同时海外业务比较多的公司"],
    ["Q05", "铜价上涨可能直接受益的资源类公司，不要铜加工企业"],
    ["Q06", "新能源汽车上游材料公司，但不要整车厂"],
    ["Q07", "国产半导体设备公司"],
    ["Q08", "专门做半导体清洗、刻蚀或者薄膜沉积设备的公司"],
    ["Q09", "做机器人减速器、伺服、电机这些核心零部件的公司"],
    ["Q10", "给数据中心做供配电、UPS、电源保障的公司"],
    ["Q11", "做消费电子精密零部件，同时有大量海外客户的公司"],
    ["Q12", "主营和苹果产业链有关，但不是手机品牌公司的公司"],
    ["Q13", "工业机器人相关，但不要只因为“机器人概念”就算进去"],
    ["Q14", "AI 数据中心建设会需要的基础设施公司，不要大模型软件公司"],
    ["Q15", "真正做新能源汽车电池材料的公司，不要因为投资了新能源项目就算"],
    ["Q16", "类似汇川技术：工业自动化、伺服、控制器、电机这些方向的公司"],
    ["Q17", "机器人灵巧手可能需要的电机、传动、传感器公司"],
    ["Q18", "半导体国产替代里真正卖生产设备的公司，不要芯片设计公司"],
    ["Q19", "主要靠海外市场赚钱的中国制造业公司"],
    ["Q20", "主营业务和服务器散热、机房温控、液冷有关的公司"],
  ];
  const seenQ = new Set(queries.map((q) => q.query));
  const all = [
    ...queries.map((q) => ({ qid: q.query_id, family: q.family, query: q.query })),
    ...acceptance.filter(([, text]) => !seenQ.has(text)).map(([qid]) => ({ qid, family: "ACCEPTANCE", query: acceptance.find(([id, t]) => id === qid)![1] })),
  ];

  const out: Record<string, unknown>[] = [];
  for (const { qid, family, query } of all) {
    const spec = parseQuerySpec(query);
    const expanded = spec.expansionTerms.length ? `${query} ${spec.expansionTerms.join(" ")}` : query;
    const [qvec, eqvec] = await Promise.all([embedQuery(query), embedQuery(expanded)]);
    const keep = (i: number) => {
      const text = companies[i].judgeText;
      if (spec.exclusions.flatMap((t) => exclusionCompanyPatterns(t).map((p) => new RegExp(p))).some((r) => r.test(text))) return false;
      if (spec.attrs.overseasMinShare != null) {
        const share = companies[i].overseasRevenueShare;
        if (share == null || share < spec.attrs.overseasMinShare) return false;
      }
      return true;
    };
    const emb = [] as { index: number; score: number }[];
    for (let i = 0; i < companies.length; i++) if (keep(i)) emb.push({ index: i, score: dot(eqvec, vectors, i * DIM) });
    emb.sort((a, b) => b.score - a.score);
    const lex = bm25Top(docTokens as never, postings, docLen, avgdl, expanded, poolSize * 2).filter((r) => keep(r.index));
    const fused = new Map<number, number>();
    emb.slice(0, poolSize).forEach((r, at) => fused.set(r.index, (fused.get(r.index) ?? 0) + 1 / (60 + at + 1)));
    lex.slice(0, poolSize).forEach((r, at) => fused.set(r.index, (fused.get(r.index) ?? 0) + 1 / (60 + at + 1)));
    const ranking = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, poolSize)
      .map(([index]) => index);

    out.push({
      query_id: qid,
      family,
      query,
      spec: { concepts: spec.concepts, exclusions: spec.exclusions, overseasMinShare: spec.attrs.overseasMinShare, expansionTerms: spec.expansionTerms.length },
      candidates: ranking.map((i) => ({ code: companies[i].code, name: companies[i].name })),
      n_candidates: ranking.length,
    });
    console.log(`${qid}: ${ranking.length} candidates (spec excl: ${spec.exclusions.join(",") || "-"}), top5: ${ranking.slice(0, 5).map((i) => companies[i].name).join("/")}`);
  }

  const outPath = outArg ?? path.join(process.cwd(), "data", "eval", "v3_ranking_candidates.json");
  writeFileSync(
    outPath,
    JSON.stringify({ builtAt: new Date().toISOString(), pool: poolSize, edition, queries: out }, ensureAsciiSafe(), 1),
  );
  console.log(`written ${path.relative(process.cwd(), outPath)}`);
}

function ensureAsciiSafe() {
  return (key: string, value: unknown) => value;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
