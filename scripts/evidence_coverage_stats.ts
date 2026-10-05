/**
 * Evidence Coverage Expansion — coverage stats / evidence diff / spot-audit sample (Phase 3.6).
 *
 *   npx tsx scripts/evidence_coverage_stats.ts
 *
 * 产物（reports/EVIDENCE_COVERAGE_EXPANSION/）：
 *   coverage_stats.json    §15 覆盖指标（before = git HEAD facts / after = 在盘 facts）
 *   evidence_diff.json     §29 受影响公司与样本公司的 evidence/searchableText diff
 *   spot_audit_sample.json §37 人工抽查清单（固定种子随机 60 家，含 provenance）
 *
 * 只读观察，不参与 production 构建。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "reports", "EVIDENCE_COVERAGE_EXPANSION");
const FACTS = path.join(ROOT, "data", "source_facts", "facts.jsonl");

type Fact = {
  factId: string;
  companyCode: string;
  factType: string;
  terms: string[];
  rawText: string;
  source: { sourceId: string; sourceName: string; sourceType: string; locator?: string; date?: string };
};

function parseJsonl(text: string): Fact[] {
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Fact);
}

function gitHeadFacts(): Fact[] {
  const raw = execFileSync("git", ["show", "HEAD:data/source_facts/facts.jsonl"], { maxBuffer: 1 << 30 }).toString("utf8");
  return parseJsonl(raw);
}

function factsStats(facts: Fact[]) {
  const byCompany = new Map<string, Fact[]>();
  for (const fact of facts) {
    const bucket = byCompany.get(fact.companyCode) ?? [];
    bucket.push(fact);
    byCompany.set(fact.companyCode, bucket);
  }
  const category = (fact: Fact): string => fact.source.sourceId.split("#")[1] ?? "";
  const has = (predicate: (fact: Fact) => boolean) => [...byCompany.values()].filter((rows) => rows.some(predicate)).length;
  const relation = facts.filter((fact) => fact.factType === "relation");
  return {
    totalFacts: facts.length,
    relationFacts: relation.length,
    fineProductFacts: facts.filter((fact) => category(fact) === "fine_product").length,
    companiesWithRelationEvidence: has((fact) => fact.factType === "relation"),
    companiesWithCustomerEvidence: has((fact) => ["relation:customer", "concentration:customer"].includes(category(fact))),
    companiesWithSupplierEvidence: has((fact) => ["relation:supplier", "concentration:supplier"].includes(category(fact))),
    companiesWithCooperationEvidence: has((fact) => category(fact) === "relation:cooperation"),
    companiesWithConcentrationEvidence: has((fact) => category(fact).startsWith("concentration:")),
    companiesWithFineProductEvidence: has((fact) => category(fact) === "fine_product"),
    avgRelationFactsPerCoveredCompany: (() => {
      const counts = relation.reduce((acc, fact) => {
        acc.set(fact.companyCode, (acc.get(fact.companyCode) ?? 0) + 1);
        return acc;
      }, new Map<string, number>());
      return counts.size ? Math.round((relation.length / counts.size) * 100) / 100 : 0;
    })(),
    byCategory: relation.reduce<Record<string, number>>((acc, fact) => {
      const key = category(fact);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function fetchStatusTally(): Record<string, number> {
  const dir = path.join(ROOT, "data", "raw", "source_facts");
  const tally: Record<string, number> = {};
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("_p36_annual_status_")) continue;
    for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const status = (JSON.parse(line) as { status: string }).status;
      tally[status] = (tally[status] ?? 0) + 1;
    }
  }
  return tally;
}

/** benchmark-affected 公司（§38：只用于 diff 观察，绝不构成构建范围）。 */
function benchmarkGapCompanies(): { id: string; query: string; codes: string[] }[] {
  const benchmark = JSON.parse(readFileSync(path.join(ROOT, "quality", "discovery", "benchmark-v1.json"), "utf8")) as {
    cases: Array<{ id: string; family: string; query: string; anchors?: { shouldInclude?: Array<{ code: string }>; negative?: Array<{ code: string }> } }>;
  };
  return benchmark.cases
    .filter((entry) => entry.family === "relation" || entry.id === "A06")
    .map((entry) => ({
      id: entry.id,
      query: entry.query,
      codes: [
        ...(entry.anchors?.shouldInclude ?? []).map((anchor) => anchor.code),
        ...(entry.anchors?.negative ?? []).map((anchor) => anchor.code),
      ],
    }));
}

/** 固定种子（按 code sha16 排序）的确定性随机抽查样本，§37。 */
function spotAuditSample(docs: { symbol: string }[], n: number): string[] {
  return docs
    .map((doc) => ({ code: doc.symbol, hash: createHash("sha256").update(`p36-spot-${doc.symbol}`).digest("hex") }))
    .sort((a, b) => (a.hash < b.hash ? -1 : 1))
    .slice(0, n)
    .map((row) => row.code);
}

function main() {
  const before = gitHeadFacts();
  const after = parseJsonl(readFileSync(FACTS, "utf8"));
  const corpus = JSON.parse(readFileSync(path.join(ROOT, "data", "company-corpus", "manifest.json"), "utf8")) as {
    contentDigest: { value: string };
    stats: Record<string, number>;
    schemaVersion: string;
  };
  const corpusBefore = JSON.parse(
    execFileSync("git", ["show", "HEAD:data/company-corpus/manifest.json"], { maxBuffer: 1 << 26 }).toString("utf8"),
  ) as { contentDigest: { value: string }; stats: Record<string, number> };

  const beforeDocs = new Map(
    (execFileSync("git", ["show", "HEAD:data/company-corpus/companies.jsonl"], { maxBuffer: 1 << 30 })
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { symbol: string; searchableText: string; sourceFacts?: unknown[] }))
      .map((doc) => [doc.symbol, doc]),
  );
  const afterDocs = new Map(
    (readFileSync(path.join(ROOT, "data", "company-corpus", "companies.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { symbol: string; searchableText: string; evidenceSpans?: Array<{ evidence: string; factType: string; text: string }> }))
      .map((doc) => [doc.symbol, doc]),
  );

  const beforeStats = factsStats(before);
  const afterStats = factsStats(after);
  const fetchTally = fetchStatusTally();

  const coverage = {
    corpusDigest: { before: corpusBefore.contentDigest.value, after: corpus.contentDigest.value },
    facts: { before: beforeStats, after: afterStats, delta: after.length - before.length },
    corpusStats: {
      before: { sourceFactsCoverage: corpusBefore.stats.sourceFactsCoverage },
      after: {
        sourceFactsCoverage: corpus.stats.sourceFactsCoverage,
        evidenceSpansCoverage: corpus.stats.evidenceSpansCoverage,
        evidenceSpanCount: corpus.stats.evidenceSpanCount,
        avgSearchableTextChars: corpus.stats.avgSearchableTextChars,
        maxSearchableTextChars: corpus.stats.maxSearchableTextChars,
      },
    },
    annualReportChannel: {
      fetchStatusTally: fetchTally,
    },
  };

  // §29 diff：benchmark-affected 公司 + 每题锚点公司
  const diff: unknown[] = [];
  for (const gap of benchmarkGapCompanies()) {
    for (const code of gap.codes) {
      diff.push(diffFor(code, `anchor:${gap.id}`, gap.query, beforeDocs, afterDocs, after));
    }
  }
  // §37 抽查：固定种子 60 家（与 anchor 样本独立）
  const sampleCodes = spotAuditSample([...afterDocs.values()], 60);
  const spot = sampleCodes.map((code) => diffFor(code, "spot-audit", null, beforeDocs, afterDocs, after));

  writeFileSync(path.join(OUT, "coverage_stats.json"), `${JSON.stringify(coverage, null, 1)}\n`);
  writeFileSync(path.join(OUT, "evidence_diff.json"), `${JSON.stringify({ anchorDiff: diff, spotAudit: spot }, null, 1)}\n`);
  console.log(`coverage stats written; facts ${before.length} -> ${after.length} (+${after.length - before.length})`);
  console.log(`relation facts: ${beforeStats.relationFacts} -> ${afterStats.relationFacts}`);
  console.log(`companies with relation evidence: ${beforeStats.companiesWithRelationEvidence} -> ${afterStats.companiesWithRelationEvidence}`);
  console.log(`corpus digest: ${corpusBefore.contentDigest.value.slice(0, 16)} -> ${corpus.contentDigest.value.slice(0, 16)}`);
}

function diffFor(
  code: string,
  tag: string,
  query: string | null,
  beforeDocs: Map<string, { searchableText: string; sourceFacts?: unknown[] }>,
  afterDocs: Map<string, { searchableText: string; evidenceSpans?: Array<{ evidence: string; factType: string; text: string }> }>,
  after: Fact[],
) {
  const beforeDoc = beforeDocs.get(code);
  const afterDoc = afterDocs.get(code);
  const newFacts = after.filter((fact) => fact.companyCode === code && fact.source.sourceType === "filing_annual_report");
  const beforeLines = new Set((beforeDoc?.searchableText ?? "").split("\n"));
  const afterLines = new Set((afterDoc?.searchableText ?? "").split("\n"));
  return {
    code,
    tag,
    query,
    annualFacts: newFacts.map((fact) => ({
      factId: fact.factId,
      category: fact.source.sourceId.split("#")[1] ?? "",
      date: fact.source.date ?? null,
      locator: fact.source.locator ?? null,
      textHead: fact.rawText.slice(0, 90),
    })),
    searchableTextLinesAdded: [...afterLines].filter((line) => !beforeLines.has(line)),
    searchableTextLinesRemoved: [...beforeLines].filter((line) => !afterLines.has(line)),
  };
}

main();
