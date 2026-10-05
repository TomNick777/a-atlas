import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// Mechanical tests replay actual local-model vectors; production still embeds normally.
// No fake zero/hash vectors, model download, query rewriting or extra judge calls.
vi.mock("../../lib/text/embed", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/text/embed")>();
  const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "query_embeddings.json"), "utf8")) as {
    schemaVersion: string; model: string; dimension: number; queryCount: number;
    vectors: Record<string, number[]>; contentDigest: { value: string };
  };
  const digest = createHash("sha256").update(JSON.stringify(fixture.vectors)).digest("hex");
  if (fixture.schemaVersion !== "query-embeddings-1" || fixture.model !== actual.MODEL || fixture.dimension !== actual.DIM || fixture.queryCount !== Object.keys(fixture.vectors).length || digest !== fixture.contentDigest.value) throw new Error("Invalid offline query embedding fixture");
  for (const vector of Object.values(fixture.vectors)) {
    if (vector.length !== actual.DIM || vector.some(value => !Number.isFinite(value))) throw new Error("Invalid offline embedding shape");
  }
  return { ...actual, embedQuery: async (query: string) => {
    const vector = fixture.vectors[query];
    if (!vector) throw new Error("Missing recorded query embedding; run npm run test:embeddings:record -- --query with the actual query");
    return new Float32Array(vector);
  } };
});
