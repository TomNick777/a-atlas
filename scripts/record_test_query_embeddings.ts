/** Explicit maintenance: record real local bge vectors for offline mechanical tests. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DIM, MODEL, embedQuery } from "../lib/text/embed";

async function main() {
  const file = path.join(process.cwd(), "tests", "fixtures", "query_embeddings.json");
  const previous = JSON.parse(readFileSync(file, "utf8")) as { vectors: Record<string, number[]> };
  const queries = new Set(Object.keys(previous.vectors));
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== "--query" || !args[i + 1]) throw new Error("Usage: npm run test:embeddings:record -- [--query <actual-query> ...]");
    queries.add(args[i + 1]);
  }
  const cache = path.join(process.cwd(), ".cache", "huggingface", MODEL);
  if (!existsSync(cache)) throw new Error("A warmed local embedding model cache is required; this command does not download a model");
  const cacheFiles: Record<string, string> = {};
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(target);
      else if (entry.isFile()) cacheFiles[path.relative(cache, target).replaceAll("\\", "/")] = createHash("sha256").update(readFileSync(target)).digest("hex");
    }
  }
  collect(cache);
  // Defense in depth: missing files cannot trigger a silent network download.
  const { env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  const vectors: Record<string, number[]> = {};
  for (const query of [...queries].sort()) vectors[query] = Array.from(await embedQuery(query));
  const fixture = { schemaVersion: "query-embeddings-1", model: MODEL, dimension: DIM, queryCount: queries.size, cacheFiles, vectors, contentDigest: { algorithm: "sha256", scope: "JSON.stringify(vectors), keys sorted", value: createHash("sha256").update(JSON.stringify(vectors)).digest("hex") } };
  writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`recorded ${queries.size} real query embeddings; model cache hashes pinned; no cloud judge`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
