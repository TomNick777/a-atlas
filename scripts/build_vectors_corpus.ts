import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, embedPassages } from "../lib/text/embed";
import { hash16 } from "../search/profile/validate";

/**
 * Embed the corpus searchableText rows into data/vectors_corpus.f32 — the
 * discovery index's vector channel, built FROM the corpus artifact (never from
 * a parallel text source). Incremental: each row carries hash16(searchableText);
 * only changed rows re-embed (same contract as build_vectors_profiles_v2).
 *
 * Usage: npx tsx scripts/build_vectors_corpus.ts [--force]
 */

const root = process.cwd();
const CORPUS = path.join(root, "data", "company-corpus", "companies.jsonl");
const VECTORS = path.join(root, "data", "vectors_corpus.f32");
const HASHES = path.join(root, "data", "vectors_corpus.hashes.json");
const ORDER = path.join(root, "data", "vectors_corpus.hashes.order.json");

async function main() {
  const force = process.argv.includes("--force");
  const docs = readFileSync(CORPUS, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { symbol: string; searchableText: string });

  const oldVectors = existsSync(VECTORS)
    ? (() => {
        const buf = readFileSync(VECTORS);
        return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
      })()
    : null;
  const oldHashes: Record<string, string> = existsSync(HASHES) ? JSON.parse(readFileSync(HASHES, "utf8")) : {};
  const oldOrder: string[] = existsSync(ORDER) ? JSON.parse(readFileSync(ORDER, "utf8")) : [];

  const texts = docs.map((doc) => doc.searchableText || doc.symbol);
  const wantHash = texts.map((text) => hash16(text));

  const oldIndexByCode = new Map<string, number>();
  if (oldVectors && oldOrder.length === oldVectors.length / DIM) {
    oldOrder.forEach((code, i) => oldIndexByCode.set(code, i));
  }

  const out = new Float32Array(texts.length * DIM);
  let copied = 0;
  const pending: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const code = docs[i].symbol;
    const src = oldIndexByCode.get(code);
    if (!force && oldVectors && src != null && oldHashes[code] === wantHash[i]) {
      out.set(oldVectors.subarray(src * DIM, src * DIM + DIM), i * DIM);
      copied += 1;
    } else {
      pending.push(i);
    }
  }

  console.log(`rows: ${texts.length}, reuse ${copied}, embed ${pending.length}`);
  const batch = 16;
  for (let at = 0; at < pending.length; at += batch) {
    const rows = pending.slice(at, at + batch);
    const embedded = await embedPassages(rows.map((i) => texts[i]));
    rows.forEach((row, k) => out.set(embedded[k], row * DIM));
    if ((at / batch) % 40 === 0) console.log(`  embedded ${Math.min(pending.length, at + batch)}/${pending.length}`);
  }

  writeFileSync(VECTORS, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  const hashes: Record<string, string> = {};
  docs.forEach((doc, i) => (hashes[doc.symbol] = wantHash[i]));
  writeFileSync(HASHES, JSON.stringify(hashes));
  writeFileSync(ORDER, JSON.stringify(docs.map((doc) => doc.symbol)));
  console.log(`wrote data/vectors_corpus.f32 (${out.length} floats, ${DIM} dim × ${texts.length} rows, ${copied} reused / ${pending.length} rebuilt)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
