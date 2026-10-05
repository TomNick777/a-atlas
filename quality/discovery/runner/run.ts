/**
 * Jev Discovery Quality Baseline runner (Phase 3.5).
 *
 *   npm run quality:discovery -- --label r1
 *   npm run quality:discovery -- --label r2 --family relation,comparison
 *   npm run quality:discovery -- --label debug --offline          (plumbing only)
 *
 * Measurement purity (§1): this runner observes the frozen production query
 * path (deterministic parser → hybrid executor → Jev capabilities) and never
 * changes it. Every case runs through the same seam the product uses.
 * Official baselines are LIVE only (§30) — the offline mode exists to debug
 * plumbing and writes artifacts marked offline-debug that can never be a
 * baseline.
 *
 * Artifacts per run land in quality/discovery/snapshots/<label>/:
 *   environment.json · run.json · results.jsonl · metrics.json · report.md
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocalEnv } from "../../../scripts/load-env";
import { typesafeKey, jevBaseUrl } from "../../../lib/env";
import { loadDataset } from "../../../lib/companies";
import { loadCommittedMarketStateManifest, loadMarketStateRows } from "../../../lib/market/state";
import { identityProbe, runSemanticComparison, subjectsOf, JEV_CAPABILITY_CONTRACT_VERSIONS, JEV_PRODUCTION_MODEL, runEvidenceExplanation } from "../../../lib/jev/capabilities";
import type { EvidenceItem, JudgementSubject } from "../../../lib/jev/capabilities";
import { runHybridQuery } from "../../../lib/hybrid/execute";
import { resolveEvidenceRef } from "../../../lib/atlas/evidence";
import type { Company } from "../../../lib/types";
import {
  BENCHMARK_VERSION,
  benchmarkSha256,
  loadBenchmark,
  loadGoldenEvidence,
  parseBenchmark,
  selectCases,
  SNAPSHOTS_DIR,
  type BenchmarkCase,
  type BenchmarkDoc,
  type FamilyId,
} from "./benchmark";
import { collectEnvironmentPin } from "./env";
import { createAccounting } from "./accounting";
import { computeMetrics, type CaseRecord, type ComparisonDecisionRecord, type ResultRecord } from "./metrics";

const CAPABILITY_TIMEOUT_MS = 30_000;

/** Explanation sampling (§29 companion): flagship judgements get a grounded
 * explanation run whose verbatim grounding is mechanically checked. */
const EXPLAIN_PLAN: Record<string, string[]> = {
  A01: ["688017"],
  A02: ["300124", "688320"],
  A04: ["603290", "688187"],
  A08: ["688686", "688003"],
  C01: ["603626"],
  H01: ["600519", "000858"],
};

type Args = { label: string | null; offline: boolean; families: string[] | null; ids: string[] | null };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { label: null, offline: false, families: null, ids: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--label") args.label = argv[i + 1] ?? null;
    else if (argv[i] === "--offline") args.offline = true;
    else if (argv[i] === "--family") args.families = (argv[i + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    else if (argv[i] === "--query") args.ids = (argv[i + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  }
  return args;
}

function die(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

// ---- case execution ---------------------------------------------------------

function evidenceTextFor(refs: { companyId: string; ref: string }[]): { text: string | null; resolved: boolean } {
  if (refs.length === 0) return { text: null, resolved: false };
  const views = refs.map((ref) => resolveEvidenceRef(ref.ref));
  if (views.some((view) => view === null)) return { text: null, resolved: false };
  return { text: views.map((view) => (view as { text: string }).text).join("\n"), resolved: true };
}

function termHits(terms: string[] | undefined, text: string | null): string[] {
  if (!terms || text === null) return [];
  return terms.filter((term) => text.includes(term));
}

async function runDiscoverCase(benchCase: BenchmarkCase, offline: boolean, accounting: ReturnType<typeof createAccounting>): Promise<CaseRecord> {
  const started = Date.now();
  accounting.enter(benchCase.id);
  const before = accounting.attempts();
  try {
    const manifest = loadCommittedMarketStateManifest();
    const result = await runHybridQuery(benchCase.query, {
      log: false, skipJev: offline,
      marketInject: { manifest, rows: manifest ? loadMarketStateRows(manifest.latestTradingDay, manifest) ?? undefined : undefined },
    });
    const unsupported = result.plan.unsupported ?? (result.execution.order === "unsupported" ? { intent: "unsupported_or_combination", detail: "execution order unsupported" } : null);
    const rows: ResultRecord[] = result.results.map((row, index) => {
      const judgement = row.judgement;
      const refs = judgement?.evidenceRefs ?? [];
      const evidence = evidenceTextFor(refs);
      return {
        rank: index + 1,
        code: row.code,
        name: row.name,
        capability: judgement?.capability ?? null,
        score: judgement?.score ?? null,
        matched: judgement?.matched ?? null,
        relationLabel: judgement?.relationLabel ?? null,
        judged: judgement !== null && judgement !== undefined,
        evidenceRefs: refs,
        evidenceResolved: judgement ? evidence.resolved : false,
        evidenceExcerpt: evidence.text ? evidence.text.slice(0, 240) : null,
        evidenceTermHits: termHits(benchCase.requiredEvidence, evidence.text),
        marketCapYi: row.market?.state.marketCapYi ?? null,
        heroKey: row.hero?.key ?? null,
      };
    });
    const status: CaseRecord["status"] = unsupported
      ? unsupported.intent === "ambiguous_query"
        ? "ambiguous_refusal"
        : "unsupported"
      : result.execution.degraded
        ? "degraded"
        : rows.length === 0
          ? "empty"
          : "ok";

    let explanation: CaseRecord["explanation"] = null;
    if (!offline && status === "ok") {
      explanation = await maybeExplain(benchCase, rows);
    }

    return {
      id: benchCase.id,
      family: benchCase.family,
      query: benchCase.query,
      kind: "discover",
      mode: offline ? "offline-debug" : "live",
      status,
      error: null,
      planUnsupported: unsupported,
      executionOrder: result.execution.order,
      decidedBy: result.execution.decidedBy,
      degraded: result.execution.degraded,
      degradedReason: result.execution.degradedReason,
      parserVersion: result.parser.version,
      parseMs: result.parser.parseMs,
      timings: {
        totalMs: Date.now() - started,
        semanticMs: result.execution.timings.semanticMs,
        marketMs: result.execution.timings.marketMs,
      },
      capability: result.intelligence && result.intelligence.provider === "jev"
        ? {
            capability: result.intelligence.capability,
            contractVersion: result.intelligence.contractVersion,
            status: result.intelligence.degraded ? "degraded" : "ok",
            failure: result.intelligence.degraded ? (result.execution.degradedReason ?? "degraded") : null,
            live: !result.intelligence.degraded,
            runtimeModel: result.intelligence.runtimeModel,
            judgeMs: result.execution.timings.semanticMs ?? 0,
            tokens: 0,
            costUsd: null,
          }
        : null,
      wireCalls: accounting.attempts() - before,
      results: rows,
      comparison: null,
      explanation,
    };
  } catch (error) {
    return {
      id: benchCase.id,
      family: benchCase.family,
      query: benchCase.query,
      kind: "discover",
      mode: offline ? "offline-debug" : "live",
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      planUnsupported: null,
      executionOrder: null,
      decidedBy: null,
      degraded: false,
      degradedReason: null,
      parserVersion: null,
      parseMs: null,
      timings: { totalMs: Date.now() - started, semanticMs: null, marketMs: null },
      capability: null,
      wireCalls: accounting.attempts() - before,
      results: [],
      comparison: null,
      explanation: null,
    };
  } finally {
    accounting.exit();
  }
}

/** §29 companion: explain one flagship judgement; grounding checked verbatim. */
async function maybeExplain(benchCase: BenchmarkCase, rows: ResultRecord[]): Promise<CaseRecord["explanation"]> {
  const preferred = EXPLAIN_PLAN[benchCase.id];
  if (!preferred) return null;
  const row = rows.find((candidate) => preferred.includes(candidate.code) && candidate.judged && candidate.evidenceResolved);
  if (!row) return null;
  const evidence: EvidenceItem[] = (resolveEvidenceRef(`judge-profile:${row.code}`)?.text ?? "")
    .split(" | ")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 8)
    .map((segment, index) => ({ ref: `judge-profile:${row.code}#${index}`, text: segment }));
  if (evidence.length === 0) return null;
  try {
    const result = await runEvidenceExplanation({
      userQuery: benchCase.query,
      judgement: {
        capability: row.capability === "semantic_relation" ? "semantic_relation" : "semantic_match",
        query: benchCase.query,
        companyId: row.code,
        companyName: row.name,
        score: row.score ?? 0,
        matched: row.matched ?? false,
      },
      evidence,
    });
    const refs = new Set(evidence.map((item) => item.ref));
    const texts = new Set(evidence.map((item) => item.text));
    return {
      subjectCode: row.code,
      status: result.status,
      insufficientEvidence: result.insufficientEvidence,
      lines: result.lines.length,
      groundedRefs: result.lines.every((line) => refs.has(line.ref)),
      groundedVerbatim: result.lines.every((line) => texts.has(line.quote)),
    };
  } catch {
    return { subjectCode: row.code, status: "error", insufficientEvidence: false, lines: 0, groundedRefs: false, groundedVerbatim: false };
  }
}

async function runComparisonCase(benchCase: BenchmarkCase, offline: boolean, accounting: ReturnType<typeof createAccounting>): Promise<CaseRecord> {
  const started = Date.now();
  accounting.enter(benchCase.id);
  const before = accounting.attempts();
  const dataset = loadDataset();
  const byCode = new Map(dataset.companies.map((company) => [company.code, company]));
  const missing = (benchCase.subjects ?? []).filter((code) => !byCode.has(code));
  const base: Omit<CaseRecord, "comparison" | "capability" | "status"> = {
    id: benchCase.id,
    family: benchCase.family,
    query: benchCase.query,
    kind: "comparison",
    mode: offline ? "offline-debug" : "live",
    error: null,
    planUnsupported: null,
    executionOrder: null,
    decidedBy: null,
    degraded: false,
    degradedReason: null,
    parserVersion: null,
    parseMs: null,
    timings: { totalMs: Date.now() - started, semanticMs: null, marketMs: null },
    wireCalls: accounting.attempts() - before,
    results: [],
    explanation: null,
  };
  if (missing.length > 0) {
    accounting.exit();
    return { ...base, status: "error", capability: null, comparison: null, error: `subjects missing from corpus: ${missing.join(",")}`, timings: { totalMs: Date.now() - started, semanticMs: null, marketMs: null } };
  }
  if (offline) {
    accounting.exit();
    return { ...base, status: "skipped", capability: null, comparison: null, error: "comparison needs the live judge — skipped in offline-debug mode", timings: { totalMs: Date.now() - started, semanticMs: null, marketMs: null } };
  }
  try {
    const subjectCompanies = (benchCase.subjects ?? []).map((code) => byCode.get(code) as Company);
    const subjectList: JudgementSubject[] = subjectsOf(subjectCompanies, "zh");
    const result = await runSemanticComparison({ comparisonQuery: benchCase.query, subjects: subjectList }, { deadlineAt: Date.now() + CAPABILITY_TIMEOUT_MS });
    const decisions: ComparisonDecisionRecord[] = result.decisions.map((decision) => {
      const subject = subjectList.find((candidate) => candidate.companyId === decision.companyId);
      const text = subject?.evidence.map((item) => item.text).join("\n") ?? null;
      return {
        code: decision.companyId,
        name: subject?.name ?? decision.companyId,
        grade: decision.grade,
        score: decision.score,
        evidenceTermHits: termHits(benchCase.requiredEvidence, text),
      };
    });
    let strictGradientOk: boolean | null = null;
    if (benchCase.strictGradient && result.status === "ok") {
      const top = decisions.find((decision) => decision.code === benchCase.strictGradient?.top);
      const bottom = decisions.find((decision) => decision.code === benchCase.strictGradient?.bottom);
      strictGradientOk = top !== undefined && bottom !== undefined ? (top.grade ?? 0) > (bottom.grade ?? 0) : false;
    }
    return {
      ...base,
      status: result.status === "ok" ? "ok" : result.status === "rejected" ? "unsupported" : "degraded",
      degraded: result.status === "degraded",
      degradedReason: result.failure,
      decidedBy: result.status === "ok" ? "jev" : null,
      capability: {
        capability: "semantic_comparison",
        contractVersion: result.contractVersion,
        status: result.status,
        failure: result.failure,
        live: result.live,
        runtimeModel: result.runtimeModel,
        judgeMs: result.timings.judgeMs,
        tokens: result.tokens,
        costUsd: result.costUsd,
      },
      timings: { totalMs: Date.now() - started, semanticMs: result.timings.judgeMs, marketMs: null },
      wireCalls: accounting.attempts() - before,
      comparison: { subjects: decisions, strictGradientOk },
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      capability: null,
      comparison: null,
      error: error instanceof Error ? error.message : String(error),
      timings: { totalMs: Date.now() - started, semanticMs: null, marketMs: null },
    };
  } finally {
    accounting.exit();
  }
}

// ---- artifacts --------------------------------------------------------------

function renderReport(doc: BenchmarkDoc, records: CaseRecord[], metricsJson: string, label: string, offline: boolean): string {
  const byId = new Map(doc.cases.map((row) => [row.id, row]));
  const lines: string[] = [];
  lines.push(`# Discovery quality run — ${label}`);
  lines.push("");
  lines.push(`- mode: ${offline ? "offline-debug (never a baseline, §30)" : "live"}`);
  lines.push(`- benchmark: discovery-quality-${BENCHMARK_VERSION} · cases: ${records.length}`);
  lines.push(`- corpus digest: ${collectEnvironmentPin({ benchmarkVersion: BENCHMARK_VERSION, sha16: benchmarkSha256(doc) }).corpus.digest16} · market date: ${doc.marketDate}`);
  lines.push("");
  lines.push("| id | family | status | order | decidedBy | #res | judged | must@10 | neg@10 | wire | ms |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const record of records) {
    const benchCase = byId.get(record.id) as BenchmarkCase;
    const must = benchCase.anchors?.mustInclude?.map((anchor) => anchor.code) ?? [];
    const negative = benchCase.anchors?.negative?.map((anchor) => anchor.code) ?? [];
    const mustHit = must.length ? String(record.results.some((row) => row.rank <= 10 && must.includes(row.code))) : "—";
    const negHit = negative.length ? String(record.results.some((row) => row.rank <= 10 && negative.includes(row.code) && ((row.matched ?? false) || (row.score ?? 0) >= 0.6))) : "—";
    lines.push(
      `| ${record.id} | ${record.family} | ${record.status} | ${record.executionOrder ?? "—"} | ${record.decidedBy ?? "—"} | ${record.results.length} | ${record.results.filter((row) => row.judged).length} | ${mustHit} | ${negHit} | ${record.wireCalls} | ${record.timings.totalMs ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push("## metrics.json");
  lines.push("");
  lines.push("```json");
  lines.push(metricsJson);
  lines.push("```");
  return `${lines.join("\n")}\n`;
}

// ---- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const doc = parseBenchmark(loadBenchmark());
  const cases = selectCases(doc, args.families, args.ids);
  if (cases.length === 0) die("no cases selected");
  const label = args.label ?? (args.offline ? "debug" : null);
  if (!label) die("--label <name> is required for a run (snapshots/<label>)");

  const offline = args.offline;
  const dataset = loadDataset();
  const preflight: Record<string, unknown> = { mode: offline ? "offline-debug" : "live" };

  if (!offline) {
    loadLocalEnv();
    if (!typesafeKey()) die("TYPESAFE_API_KEY is empty — an official baseline is LIVE only (§30). For plumbing debugging use --offline.");
    if (jevBaseUrl() !== "https://api.typesafe.ai/v1/systemone") {
      die(`refusing to run a baseline against a non-production surface (${jevBaseUrl()})`);
    }
    const probe = await identityProbe();
    preflight.identityProbe = probe;
    if (!probe.ok || probe.model !== JEV_PRODUCTION_MODEL) {
      die(`identity probe failed: ok=${probe.ok} model=${probe.model} (contract ${JEV_PRODUCTION_MODEL}) — fix the judge before measuring it`);
    }
  }

  const market = loadCommittedMarketStateManifest();
  if (market?.latestTradingDay !== doc.marketDate) {
    die(`market snapshot drift: on-disk ${market?.latestTradingDay} ≠ benchmark ${doc.marketDate} — the baseline coordinate system moved, re-freeze or rebuild`);
  }
  const corpusDigest = dataset.corpus?.contentDigest16 ?? null;
  if (corpusDigest !== doc.corpusContentDigest16) {
    die(`corpus drift: on-disk ${corpusDigest} ≠ benchmark ${doc.corpusContentDigest16} — re-verify anchors and bump the benchmark version (§27/§28)`, 2);
  }

  // Golden-evidence pre-flight (§29): the corpus must still carry the frozen
  // flagship facts, otherwise the benchmark measures a different world.
  const golden = loadGoldenEvidence();
  if (golden.corpusContentDigest16 !== doc.corpusContentDigest16) die("golden-evidence digest does not match the benchmark digest", 2);
  const byCode = new Map(dataset.companies.map((company) => [company.code, company]));
  const goldenFailures: string[] = [];
  for (const entry of golden.entries) {
    const company = byCode.get(entry.code);
    if (!company) goldenFailures.push(`${entry.id}: ${entry.code} missing from corpus`);
    else {
      const text = company.searchProfileText ?? "";
      for (const term of entry.requiredTerms) {
        if (!text.includes(term)) goldenFailures.push(`${entry.id}: ${entry.code} (${company.name}) lost required term 「${term}」`);
      }
    }
  }
  if (goldenFailures.length > 0) die(`golden evidence no longer holds:\n  ${goldenFailures.join("\n  ")}\ncorpus moved — re-verify anchors and bump the benchmark version`, 2);
  preflight.goldenEvidence = { entries: golden.entries.length, ok: true };

  const accounting = createAccounting();
  accounting.wrap();

  const records: CaseRecord[] = [];
  const startedAt = new Date().toISOString();
  console.log(`== discovery quality run ${label} ==`);
  console.log(`mode: ${offline ? "offline-debug" : "live"} · cases: ${cases.length} · corpus ${corpusDigest} · market ${doc.marketDate}`);

  for (const benchCase of cases) {
    const record = benchCase.family === "comparison" ? await runComparisonCase(benchCase, offline, accounting) : await runDiscoverCase(benchCase, offline, accounting);
    records.push(record);
    const tail = record.comparison
      ? ` grades ${record.comparison.subjects.map((decision) => `${decision.code}:${decision.grade}`).join(" ")}${record.comparison.strictGradientOk === false ? " · STRICT GRADIENT VIOLATED" : ""}`
      : ` ${record.results.length} rows`;
    console.log(`[${record.id}] ${record.status}${record.error ? ` (${record.error.slice(0, 80)})` : ""}${tail} · wire ${record.wireCalls} · ${record.timings.totalMs ?? "?"}ms`);
  }
  accounting.restore();

  const unexpected = accounting.orphans();
  const dir = resolve(SNAPSHOTS_DIR, label);
  mkdirSync(dir, { recursive: true });
  const environment = collectEnvironmentPin({ benchmarkVersion: BENCHMARK_VERSION, sha16: benchmarkSha256(doc) });
  writeFileSync(resolve(dir, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);

  const resultsPath = resolve(dir, "results.jsonl");
  writeFileSync(resultsPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

  const runJson = {
    run: label,
    suite: "atlas-jev-discovery-quality/1",
    benchmarkVersion: BENCHMARK_VERSION,
    benchmarkSha16: benchmarkSha256(doc),
    capabilityContracts: JEV_CAPABILITY_CONTRACT_VERSIONS,
    mode: offline ? "offline-debug" : "live",
    startedAt,
    finishedAt: new Date().toISOString(),
    preflight,
    totals: {
      cases: records.length,
      byStatus: records.reduce<Record<string, number>>((acc, record) => {
        acc[record.status] = (acc[record.status] ?? 0) + 1;
        return acc;
      }, {}),
      wireAttempts: accounting.attempts(),
      unexpectedAttempts: unexpected.length,
      strictGradientViolations: records.filter((record) => record.comparison?.strictGradientOk === false).length,
      explanationRuns: records.filter((record) => record.explanation).length,
    },
    unexpectedAttemptsDetail: unexpected,
  };
  writeFileSync(resolve(dir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`);

  const metrics = computeMetrics(doc, label, offline ? "offline-debug" : "live", records, null);
  const metricsJson = `${JSON.stringify(metrics, null, 2)}\n`;
  writeFileSync(resolve(dir, "metrics.json"), metricsJson);
  writeFileSync(resolve(dir, "report.md"), renderReport(doc, records, JSON.stringify(metrics, null, 2), label, offline));

  console.log(`\ntotals: ${runJson.totals.byStatus ? JSON.stringify(runJson.totals.byStatus) : ""}`);
  console.log(`wire: ${runJson.totals.wireAttempts} attempts · unexpected ${runJson.totals.unexpectedAttempts}`);
  console.log(`artifacts: ${dir}`);
  if (runJson.totals.unexpectedAttempts > 0) die("unexpected judge attempts outside case windows — run fails (§13 discipline)");
  const degraded = records.filter((record) => record.status === "degraded" || record.status === "error");
  if (!offline && degraded.length > 0) {
    console.error(`WARNING: ${degraded.length} degraded/error cases — a baseline with degraded judge calls is not a healthy baseline; inspect before freezing`);
    process.exitCode = 3;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
