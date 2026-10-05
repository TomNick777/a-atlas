import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIM, embedPassages } from "../lib/text/embed";

/** Embed the DERIVED search profile text (judgeText + tag line) from search_profiles.json. */
async function main() {
  const companies = JSON.parse(readFileSync(path.join(process.cwd(), "data", "companies.json"), "utf8")).companies as { code: string }[];
  const profiles = JSON.parse(readFileSync(path.join(process.cwd(), "data", "search_profiles.json"), "utf8")) as Record<string, { searchText: string }>;
  const texts = companies.map((c) => profiles[c.code]?.searchText || "无");
  const vectors = new Float32Array(texts.length * DIM);
  const batch = 16;
  for (let at = 0; at < texts.length; at += batch) {
    const rows = await embedPassages(texts.slice(at, at + batch));
    rows.forEach((row, index) => vectors.set(row, (at + index) * DIM));
    if ((at / batch) % 20 === 0) console.log(`embedded ${Math.min(texts.length, at + batch)}/${texts.length}`);
  }
  writeFileSync(path.join(process.cwd(), "data", "vectors_profile.f32"), Buffer.from(vectors.buffer));
  console.log(`wrote data/vectors_profile.f32 (${vectors.length} floats)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
