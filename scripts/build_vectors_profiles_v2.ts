import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, embedPassages } from "../lib/text/embed";
import { hash16 } from "../search/profile/validate";

/**
 * Embed the profile searchText rows into data/vectors_profile_vN.f32,
 * incrementally: each row carries hash16(searchText); only rows whose stored
 * hash differs get re-embedded, everything else is copied from the existing
 * file. This is the "source changed → re-derive → re-embed only what changed"
 * contract (Stage 3 规格第十九节:changedCompanyCount/embeddingRebuiltCount).
 *
 * Usage: npx tsx scripts/build_vectors_profiles_v2.ts [--force] [--stage3]
 */

const root = process.cwd();
const stage3 = process.argv.includes("--stage3");
const PROFILES = path.join(root, "data", stage3 ? "search_profiles_v3.json" : "search_profiles_v2.json");
const VECTORS = path.join(root, "data", stage3 ? "vectors_profile_v3.f32" : "vectors_profile_v2.f32");
const HASHES = path.join(root, "data", stage3 ? "vectors_profile_v3.hashes.json" : "vectors_profile_v2.hashes.json");

async function main() {
  const force = process.argv.includes("--force");
  const { companies } = JSON.parse(readFileSync(path.join(root, "data", "companies.json"), "utf8")) as { companies: { code: string }[] };
  const profiles = JSON.parse(readFileSync(PROFILES, "utf8")) as Record<string, { searchText: string }>;

  const oldVectors = existsSync(VECTORS)
    ? (() => {
        const buf = readFileSync(VECTORS);
        return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
      })()
    : null;
  const oldHashes: Record<string, string> = existsSync(HASHES) ? JSON.parse(readFileSync(HASHES, "utf8")) : {};
  const orderFile = HASHES.replace(".hashes.json", ".hashes.order.json");
  const oldOrder: string[] = existsSync(orderFile) ? JSON.parse(readFileSync(orderFile, "utf8")) : [];

  const texts: string[] = [];
  const wantHash: string[] = [];
  for (const c of companies) {
    const text = profiles[c.code]?.searchText || c.code;
    texts.push(text);
    wantHash.push(hash16(text));
  }

  const oldIndexByCode = new Map<string, number>();
  if (oldHashes && oldOrder.length === oldVectorsLength(oldVectors)) {
    oldOrder.forEach((code, i) => oldIndexByCode.set(code, i));
  }

  const out = new Float32Array(texts.length * DIM);
  let copied = 0;
  const pending: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const code = companies[i].code;
    const src = oldIndexByCode.get(code);
    if (!force && src != null && oldHashes[code] === wantHash[i] && oldVectors) {
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
  companies.forEach((c, i) => (hashes[c.code] = wantHash[i]));
  writeFileSync(HASHES, JSON.stringify(hashes));
  writeFileSync(HASHES.replace(".hashes.json", ".hashes.order.json"), JSON.stringify(companies.map((c) => c.code)));
  const file = path.basename(VECTORS);
  console.log(`wrote data/${file} (${out.length} floats, ${DIM} dim × ${texts.length} rows, ${copied} reused / ${pending.length} rebuilt)`);
}

function oldVectorsLength(v: Float32Array | null): number {
  return v ? v.length / DIM : -1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
