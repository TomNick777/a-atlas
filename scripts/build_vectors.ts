import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Dataset } from "../lib/types";
import { DIM, embedPassages } from "../lib/text/embed";

async function main() {
  const file = path.join(process.cwd(), "data", "companies.json");
  const dataset = JSON.parse(readFileSync(file, "utf8")) as Dataset;
  const texts = dataset.companies.map((company) => company.searchableText);
  const vectors = new Float32Array(texts.length * DIM);
  const batch = 16;
  for (let at = 0; at < texts.length; at += batch) {
    const slice = texts.slice(at, at + batch);
    const rows = await embedPassages(slice);
    rows.forEach((row, index) => vectors.set(row, (at + index) * DIM));
    console.log(`embedded ${Math.min(texts.length, at + batch)}/${texts.length}`);
  }
  writeFileSync(path.join(process.cwd(), "data", "vectors.f32"), Buffer.from(vectors.buffer));
  console.log(`wrote ${vectors.length} floats`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
