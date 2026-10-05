import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Phase 3A ground-truth evidence audit.
 *
 * Reads benchmark.v1.json and, for every expected symbol of every case, finds
 * where the case's requiredEvidence terms actually live in that company's corpus
 * document (searchableText and the structured fields). The output is
 * expected-evidence.json — the auditable justification layer for the ground
 * truth. Mechanical only: no search system runs here, no LLM, no scores.
 *
 * corpusVerified = at least one requiredEvidence term appears in the company's
 * searchableText (the text retrieval, embeddings and the judge all read).
 * Terms found only in structured fields (truncated out of searchableText) are
 * recorded as representation gaps, not counted as verified.
 */

type BenchmarkCase = {
  id: string;
  category: string;
  query: string;
  expected?: { strongMatches?: string[]; acceptableMatches?: string[]; exclusions?: string[] };
  requiredEvidence?: string[];
  noUniqueAnswer?: boolean;
  notes?: string;
};

type CorpusDoc = {
  symbol: string;
  name: string;
  aliases?: string[];
  profile?: string;
  business?: string[];
  products?: Array<{ name: string; revenueShare?: number }>;
  revenueMix?: Array<{ name: string; revenueShare?: number }>;
  overseasRevenueShare?: number | null;
  concepts?: string[];
  themes?: Array<{ label: string; evidence?: string }>;
  exclusions?: Array<{ label: string }>;
  searchableText: string;
};

type FieldHit = { field: string; quote: string };

const benchmarkPath = path.join(process.cwd(), "evaluation", "discovery", "benchmark.v1.json");
const corpusPath = path.join(process.cwd(), "data", "company-corpus", "companies.jsonl");
const outPath = path.join(process.cwd(), "evaluation", "discovery", "expected-evidence.json");

function loadCorpus(): Map<string, CorpusDoc> {
  const map = new Map<string, CorpusDoc>();
  for (const line of readFileSync(corpusPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as CorpusDoc;
    map.set(doc.symbol, doc);
  }
  return map;
}

function around(text: string, term: string): string {
  const at = text.indexOf(term);
  const start = Math.max(0, at - 18);
  const end = Math.min(text.length, at + term.length + 18);
  // Exact substring of the source text (whitespace intact) so back-point checks
  // can be mechanical substring containment.
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function fieldHits(doc: CorpusDoc, terms: string[]): FieldHit[] {
  const hits: FieldHit[] = [];
  const text = doc.searchableText;
  for (const term of terms) {
    if (text.includes(term)) hits.push({ field: "searchableText", quote: around(text, term) });
  }
  const structured: Array<[string, string[]]> = [
    ["business", doc.business ?? []],
    ["products", (doc.products ?? []).map((p) => p.name)],
    ["revenueMix", (doc.revenueMix ?? []).map((p) => p.name)],
    ["concepts", doc.concepts ?? []],
    ["themes", (doc.themes ?? []).map((t) => t.label)],
    ["aliases", doc.aliases ?? []],
    ["profile", doc.profile ? [doc.profile] : []],
  ];
  for (const [field, values] of structured) {
    for (const value of values) {
      if (typeof value !== "string") continue;
      for (const term of terms) {
        if (value.includes(term)) hits.push({ field, quote: around(value, term) });
      }
    }
  }
  // Dedupe by field+quote.
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.field}:${h.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const benchmark = JSON.parse(readFileSync(benchmarkPath, "utf8")) as { cases: BenchmarkCase[] };
const corpus = loadCorpus();
const companies = JSON.parse(readFileSync(path.join(process.cwd(), "data", "companies.json"), "utf8")) as { companies: Array<{ code: string; name: string }> };
const names = new Map(companies.companies.map((c) => [c.code, c.name]));

const out: Record<string, unknown> = {};
const problems: string[] = [];

for (const kase of benchmark.cases) {
  const expected = kase.expected ?? {};
  const all = [
    ...[...new Set([...(expected.strongMatches ?? []), ...(expected.acceptableMatches ?? [])])].map((code) => ({ code, role: "strong" as const })),
    // roles fixed below
  ];
  const entries: Record<string, unknown> = {};
  const roles = new Map<string, "strong" | "acceptable">();
  for (const code of expected.strongMatches ?? []) roles.set(code, "strong");
  for (const code of expected.acceptableMatches ?? []) if (!roles.has(code)) roles.set(code, "acceptable");

  for (const [code, role] of roles) {
    const name = names.get(code);
    if (!name) {
      problems.push(`${kase.id}: symbol ${code} not in companies.json`);
      continue;
    }
    const doc = corpus.get(code);
    if (!doc) {
      problems.push(`${kase.id}: symbol ${code} (${name}) has no corpus document`);
      continue;
    }
    const corpusNameMatches = doc.name === name;
    if (!corpusNameMatches) problems.push(`${kase.id}: ${code} name mismatch benchmark-side assumption (${name}) vs corpus (${doc.name})`);
    const hits = fieldHits(doc, kase.requiredEvidence ?? []);
    const inSearchableText = hits.some((h) => h.field === "searchableText");
    entries[code] = {
      role,
      name: doc.name,
      corpusVerified: inSearchableText,
      evidence: hits.slice(0, 6),
      note: inSearchableText ? null : kase.requiredEvidence?.length ? "no requiredEvidence term in searchableText; expectation rests on external/domain knowledge — corpus coverage candidate" : "no requiredEvidence defined for this case",
    };
  }
  // Exclusion symbols are audited only for existence (they are "must NOT appear" checks).
  for (const code of expected.exclusions ?? []) {
    if (!names.has(code)) problems.push(`${kase.id}: exclusion symbol ${code} not in companies.json`);
  }
  out[kase.id] = entries;
}

const digest16 = createHash("sha256").update(readFileSync(corpusPath)).digest("hex").slice(0, 16);
const allCases = Object.values(out).flatMap((entries) => Object.values(entries as Record<string, { corpusVerified: boolean }>));
const total = allCases.length;
const verified = allCases.filter((e) => e.corpusVerified).length;

writeFileSync(
  outPath,
  JSON.stringify(
    {
      version: "1.0.0",
      benchmarkVersion: "v1",
      corpusContentDigest16: digest16,
      generatedBy: "scripts/build_expected_evidence.ts",
      summary: { expectedSymbols: total, corpusVerified: verified, corpusVerifiedShare: total ? Math.round((verified / total) * 1000) / 10 : 0 },
      cases: out,
    },
    null,
    1,
  ) + "\n",
  "utf8",
);

console.log(`expected symbols: ${total}, corpusVerified: ${verified} (${total ? Math.round((verified / total) * 100) : 0}%)`);
if (problems.length) {
  console.log(`\n--- ${problems.length} PROBLEMS ---`);
  for (const problem of problems) console.log(problem);
  process.exit(2);
}
if (!existsSync(benchmarkPath)) {
  console.error("benchmark file missing?");
  process.exit(1);
}
console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
