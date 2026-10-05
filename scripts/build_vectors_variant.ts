import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Dataset } from "../lib/types";
import { DIM, embedPassages } from "../lib/text/embed";

/** Same as build_vectors.ts but for any text field, so retrieval variants can be
 *  compared against the production vectors without touching data/vectors.f32. */
async function main() {
  const field = process.argv[2] ?? "judgeText";
  const out = process.argv[3] ?? `data/vectors_${field}.f32`;
  const file = path.join(process.cwd(), "data", "companies.json");
  const dataset = JSON.parse(readFileSync(file, "utf8")) as Dataset;
  const texts = dataset.companies.map((company) => (company as unknown as Record<string, string>)[field] ?? "无");
  const vectors = new Float32Array(texts.length * DIM);
  const batch = 16;
  for (let at = 0; at < texts.length; at += batch) {
    const slice = texts.slice(at, at + batch);
    const rows = await embedPassages(slice);
    rows.forEach((row, index) => vectors.set(row, (at + index) * DIM));
    if ((at / batch) % 20 === 0) console.log(`embedded ${Math.min(texts.length, at + batch)}/${texts.length}`);
  }
  writeFileSync(path.join(process.cwd(), out), Buffer.from(vectors.buffer));
  console.log(`wrote ${out} (${vectors.length} floats)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
