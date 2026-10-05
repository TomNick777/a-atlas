const ASCII = /[a-z0-9]+/g;
const CJK = /[\u3400-\u9fff]/;

/** Character bigrams for Chinese, whole tokens for latin and digits. */
export function tokensOf(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const match of lower.matchAll(ASCII)) out.push(match[0]);
  const han = [...lower].filter((ch) => CJK.test(ch));
  for (let i = 0; i < han.length - 1; i++) out.push(han[i] + han[i + 1]);
  for (const ch of han) out.push(ch);
  return out;
}

export type LexicalIndex = {
  idf: Map<string, number>;
  docs: Map<string, number>[];
};

export function buildLexicalIndex(docs: string[]): LexicalIndex {
  const counts = docs.map((doc) => {
    const map = new Map<string, number>();
    for (const token of tokensOf(doc)) map.set(token, (map.get(token) ?? 0) + 1);
    return map;
  });
  const df = new Map<string, number>();
  for (const map of counts) for (const token of map.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const idf = new Map<string, number>();
  const n = Math.max(1, docs.length);
  for (const [token, seen] of df) idf.set(token, Math.log((n + 1) / (seen + 0.5)));
  return { idf, docs: counts };
}

/**
 * Product words a short query never spells out. These are categories, not company names:
 * a data-center query should still be able to hit 光模块, a robot query 减速器.
 */
const EXPANSIONS: Array<[RegExp, string]> = [
  [/数据中心/, "光模块 光通信 机房温控 印制电路 服务器"],
  [/机器人/, "谐波减速器 伺服"],
  [/电力设备|输配电/, "输配电 开关设备"],
];

export function expandQuery(query: string): string {
  const extra = EXPANSIONS.filter(([pattern]) => pattern.test(query)).map(([, add]) => add);
  return extra.length ? `${query} ${extra.join(" ")}` : query;
}

/** 1 when every query token is in the document, weighted by idf. */
export function lexicalScore(index: LexicalIndex, query: string, docIndex: number): number {
  const doc = index.docs[docIndex];
  if (!doc) return 0;
  let hit = 0;
  let all = 0;
  const seen = new Set<string>();
  for (const token of tokensOf(expandQuery(query))) {
    if (seen.has(token)) continue;
    seen.add(token);
    const weight = index.idf.get(token) ?? Math.log(index.docs.length + 1);
    all += weight;
    if (doc.has(token)) hit += weight;
  }
  return all > 0 ? hit / all : 0;
}
