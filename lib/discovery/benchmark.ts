import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Discovery Benchmark contract (evaluation/discovery/benchmark.v1.json).
 *
 * The dataset is frozen committed data — this module is the single parser both
 * the runner and the tests use. Cases carry intents and auditable expectations,
 * never codes fitted to system output (evaluation/discovery/README.md §integrity).
 */

export const BENCHMARK_VERSION = "v1";

export const BENCHMARK_CATEGORIES = [
  "direct_business",
  "paraphrase",
  "product_first",
  "industry_chain",
  "multi_condition",
  "exclusion_contrast",
  "ambiguous_exploration",
  "entity_collision",
  "negative_no_answer",
] as const;

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];

export type BenchmarkCase = {
  id: string;
  category: BenchmarkCategory;
  query: string;
  expected?: {
    strongMatches?: string[];
    acceptableMatches?: string[];
    exclusions?: string[];
  };
  requiredEvidence?: string[];
  noUniqueAnswer?: boolean;
  notes?: string;
};

export type Benchmark = {
  name: string;
  benchmarkVersion: string;
  schemaVersion: string;
  cases: BenchmarkCase[];
};

export function parseBenchmark(json: unknown): Benchmark {
  const data = json as Benchmark;
  if (!data || !Array.isArray(data.cases)) throw new Error("benchmark: missing cases array");
  if (data.benchmarkVersion !== BENCHMARK_VERSION) throw new Error(`benchmark: expected v1, got ${data.benchmarkVersion}`);
  for (const c of data.cases) {
    if (!/^[A-I]\d{2}$/.test(c.id)) throw new Error(`benchmark: bad id ${c.id}`);
    if (!(BENCHMARK_CATEGORIES as readonly string[]).includes(c.category)) throw new Error(`benchmark: ${c.id} bad category ${c.category}`);
    const q = c.query ?? "";
    if (q.trim().length < 2 || q.length > 120) throw new Error(`benchmark: ${c.id} bad query length`);
    for (const code of [...(c.expected?.strongMatches ?? []), ...(c.expected?.acceptableMatches ?? []), ...(c.expected?.exclusions ?? [])]) {
      if (!/^\d{6}$/.test(code)) throw new Error(`benchmark: ${c.id} bad symbol ${code}`);
    }
    for (const term of c.requiredEvidence ?? []) {
      if (typeof term !== "string" || !term.trim()) throw new Error(`benchmark: ${c.id} empty requiredEvidence term`);
    }
  }
  return data;
}

export function loadBenchmarkCases(root: string = process.cwd()): BenchmarkCase[] {
  const file = path.join(root, "evaluation", "discovery", "benchmark.v1.json");
  return parseBenchmark(JSON.parse(readFileSync(file, "utf8"))).cases;
}
