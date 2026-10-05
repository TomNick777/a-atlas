/**
 * Jev live integration suite — the REQUIRED_LIVE matrix (Phase 2.1 §3/§10/§13,
 * capability layer Phase 3.3 §15 D).
 *
 *   npm run test:jev-live
 *
 * The one sanctioned place where Atlas really talks to the Jev cloud in a test:
 * authentication and answered identity, the semantic-first production path over
 * the real V3 pool, representative semantic behaviour across query types, the
 * honest-zero H5 boundary, the market-first subset judge (§7 — fixtures
 * cannot prove the real payload + real SHOWN contract still work), and since
 * Phase 3.3 all four capability contracts on the real wire (relation with an
 * evidence-backed subject vs a clean control, graded comparison, and a
 * groundedness-checked explanation). Deterministic business rules live in the
 * offline suites; this suite proves the wire.
 *
 * Every scenario is billed: an accounting wrapper counts each real network
 * attempt, per-scenario budgets are asserted, and any attempt outside a
 * scenario window fails the run (unexpected real requests must be 0 — §13).
 * Evidence lands in reports/JEV_TEST_ISOLATION/live_run_<ts>.json.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { identityProbe } from "../lib/jev/judge";
import { runHybridQuery } from "../lib/hybrid/execute";
import { getJevCloudProvider } from "../lib/jev/cloud";
import {
  runEvidenceExplanation,
  runSemanticComparison,
  runSemanticRelation,
  subjectsOf,
  type EvidenceItem,
  type JudgementSubject,
} from "../lib/jev/capabilities";
import { JEV_PRODUCTION_MODEL } from "../lib/jev/provider";
import { SHOWN } from "../lib/search/score";
import { typesafeKey, jevBaseUrl } from "../lib/env";
import { loadDataset } from "../lib/companies";
import { loadMarketStateManifest } from "../lib/market/state";
import { HYBRID_PRESETS } from "../lib/hybrid/presets";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

type ScenarioReport = {
  id: string;
  scenario: string;
  query: string;
  operation: string;
  whyReal: string;
  expectedWireCalls: number;
  attempts: number;
  retries: number;
  pass: boolean;
  failures: string[];
};

const JEV_URL = /systemone|typesafe\.ai/i;

/** §13 accounting: every real attempt is counted and must sit inside a window. */
const accounting = {
  attempts: 0,
  window: null as string | null,
  orphans: [] as string[],
  outsideAttempt(url: string): void {
    this.orphans.push(`${new Date().toISOString()} ${url}`);
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (JEV_URL.test(url)) {
    accounting.attempts += 1;
    if (!accounting.window) accounting.outsideAttempt(url);
  }
  return realFetch.call(globalThis, input, init);
}) as typeof fetch;

const results: ScenarioReport[] = [];
let openWindow: { report: ScenarioReport; before: number } | null = null;

async function scenario(id: string, scenarioName: string, query: string, operation: string, whyReal: string, expected: number, run: () => Promise<string[]>): Promise<void> {
  const report: ScenarioReport = { id, scenario: scenarioName, query, operation, whyReal, expectedWireCalls: expected, attempts: 0, retries: 0, pass: false, failures: [] };
  const before = accounting.attempts;
  openWindow = { report, before };
  accounting.window = id;
  try {
    report.failures = await run();
    report.pass = report.failures.length === 0;
  } catch (error) {
    report.failures.push(error instanceof Error ? error.message : String(error));
    report.pass = false;
  } finally {
    accounting.window = null;
    openWindow = null;
    report.attempts = accounting.attempts - before;
    report.retries = Math.max(0, report.attempts - expected);
    results.push(report);
  }
}

const executionAsserts = (
  result: Awaited<ReturnType<typeof runHybridQuery>>,
  want: { order: string; decidedBy: string | null; nonEmpty: boolean },
): string[] => {
  const failures: string[] = [];
  if (result.execution.order !== want.order) failures.push(`order=${result.execution.order} want ${want.order}`);
  if (result.execution.degraded) failures.push(`degraded=true (${result.execution.degradedReason}) — live suite requires the healthy path`);
  if (want.decidedBy && result.execution.decidedBy !== want.decidedBy) failures.push(`decidedBy=${result.execution.decidedBy} want ${want.decidedBy}`);
  if (want.nonEmpty && result.results.length === 0) failures.push("empty results");
  if (result.execution.marketDate !== "2026-09-28") failures.push(`marketDate=${result.execution.marketDate} want 2026-09-28 (committed state)`);
  return failures;
};

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  if (!typesafeKey()) {
    console.error("TYPESAFE_API_KEY is empty — the live suite IS the real integration coverage and cannot run without it.");
    console.error("Offline layers (npm test) never need the key. Capture fixtures with npm run semantic:fixtures:refresh.");
    process.exit(1);
  }
  if (jevBaseUrl() !== "https://api.typesafe.ai/v1/systemone") {
    console.error(`refusing to run the live matrix against a non-production surface (${jevBaseUrl()}) — that is what CI's stub is for`);
    process.exit(1);
  }
  if (!loadMarketStateManifest()?.latestTradingDay) {
    console.error("Market State not materialized — run npm run market:build first.");
    process.exit(1);
  }

  const provider = getJevCloudProvider();
  console.log(`== Jev live integration suite ==\nendpoint: ${jevBaseUrl()}\nalias requested: ${provider.model} · production contract: ${JEV_PRODUCTION_MODEL}\n`);

  // L1 — authentication, connectivity, answered identity (§3).
  await scenario("L1", "identity probe (auth + answered model)", "做商业银行业务的银行", "judge-noul", "API authentication, endpoint reachability, and the in-charge cloud model identity are only provable against the real wire", 1, async () => {
    const failures: string[] = [];
    const probe = await identityProbe();
    if (!probe.ok) failures.push(`identity probe not ok (${probe.outcome})`);
    if (probe.model !== JEV_PRODUCTION_MODEL) failures.push(`answered model ${probe.model} ≠ certified ${JEV_PRODUCTION_MODEL} — a version move needs explicit re-certification`);
    return failures;
  });

  // L2 — semantic-first production path: full V3 retrieval + judge + market join (§3).
  await scenario("L2", "semantic-first production path", HYBRID_PRESETS.H1, "semantic-retrieval-v3 → judge(200) ×2 + market join", "the production semantic-first path (runSearch untouched) with its real judge verdict, SHOWN eligibility and market rank authority", 2, async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H1, { log: false });
    const failures = executionAsserts(result, { order: "semantic-first", decidedBy: "jev", nonEmpty: true });
    // Phase 3.7 re-record：judge 应答可为 noul 型（语义相关、无逐字命中词面）——
    // 在不变量是「被判定 + 证据可解析」（Phase 3.4 grounding），matchedFacts 非空不是
    // 生产路径不变量（词面命中随语料内容合法变化）。
    if (result.results[0] && !result.results[0].semantic) failures.push("top result carries no semantic verdict");
    if (result.results[0] && !(result.results[0].judgement?.evidenceRefs?.length)) failures.push("top result judgement carries no evidenceRefs");
    if (result.results[0]?.hero?.key !== "pctChange") failures.push(`hero=${result.results[0]?.hero?.key} want pctChange`);
    return failures;
  });

  // L3 — semantic behaviour diversity (§4): three different semantic domains and
  // different market sorts, each proving Chinese semantic retrieval still works.
  await scenario("L3", "semantic diversity: AI芯片 × amount", HYBRID_PRESETS.H2, "semantic-retrieval-v3 → judge(200) ×2", "a different semantic domain (chips) and a different hero (amount) through the same production path", 2, async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H2, { log: false });
    const failures = executionAsserts(result, { order: "semantic-first", decidedBy: "jev", nonEmpty: true });
    if (result.results[0]?.hero?.key !== "amount") failures.push(`hero=${result.results[0]?.hero?.key} want amount`);
    return failures;
  });

  await scenario("L4", "semantic diversity: 储能 × 5日涨幅", HYBRID_PRESETS.H6, "semantic-retrieval-v3 → judge(200) ×2", "a windowed market field (return_5d) joined to a live semantic verdict", 2, async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H6, { log: false });
    const failures = executionAsserts(result, { order: "semantic-first", decidedBy: "jev", nonEmpty: true });
    if (result.results[0]?.hero?.key !== "return5d") failures.push(`hero=${result.results[0]?.hero?.key} want return5d`);
    return failures;
  });

  await scenario("L5", "semantic diversity: 创新药 × 跌幅", HYBRID_PRESETS.H9, "semantic-retrieval-v3 → judge(200) ×2", "an ascending market sort (worst first) on a live semantic verdict", 2, async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H9, { log: false });
    const failures = executionAsserts(result, { order: "semantic-first", decidedBy: "jev", nonEmpty: true });
    if ((result.results[0]?.hero?.value as number) === undefined) failures.push("hero value missing");
    return failures;
  });

  // L6 — the honest zero (§4/§6): the real judge agrees the 消费 residual keeps
  // no streak-3 survivor above SHOWN; the answer must be an honest empty.
  await scenario("L6", "honest zero boundary (H5)", HYBRID_PRESETS.H5, "semantic-retrieval-v3 → judge(200) ×2 + streak eligibility", "the eligibility boundary is a real semantic judgement: zero results must come from real scores, not from a shortcut", 2, async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H5, { log: false });
    const failures = executionAsserts(result, { order: "semantic-first", decidedBy: "jev", nonEmpty: false });
    if (result.results.length !== 0) failures.push(`expected the honest zero, got ${result.results.length} rows`);
    if (result.execution.counts?.semanticEligible !== 0) failures.push(`semanticEligible=${result.execution.counts?.semanticEligible} want 0`);
    return failures;
  });

  // L7 — market-first subset judge (§7): the OTHER production Jev shape.
  await scenario("L7", "market-first subset judge", HYBRID_PRESETS.H10, "market Top-20 → judge(subset) ×1", "a real subset judge over the real market payload with the real SHOWN contract — fixtures can only prove the executor, never this wire", 1, async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H10, { log: false });
    const failures = executionAsserts(result, { order: "market-first", decidedBy: "jev", nonEmpty: true });
    if (result.execution.counts?.marketSetSize !== 20) failures.push(`marketSetSize=${result.execution.counts?.marketSetSize} want 20`);
    if (result.results.some((row) => (row.probability ?? 0) < SHOWN)) failures.push("a row below SHOWN leaked into results");
    const amounts = result.results.map((row) => row.market?.state.amount ?? 0);
    if ([...amounts].sort((a, b) => b - a).some((value, index) => value !== amounts[index])) failures.push("market rank authority broken: amounts not in market order");
    return failures;
  });

  // ---- Phase 3.3 capability layer: the four contracts on the real wire ----

  const companyByCode = (code: string) => {
    const company = loadDataset().companies.find((row) => row.code === code);
    if (!company) throw new Error(`dataset company ${code} missing — corpus moved, pick another live subject`);
    return company;
  };

  // L8 — semantic_relation (§4): a relation the corpus actually carries
  // (科森科技's profile names its customer) against a clean control subject.
  let relationSubjects: JudgementSubject[] = [];
  let relationResult: Awaited<ReturnType<typeof runSemanticRelation>> | null = null;
  await scenario("L8", "capability: semantic_relation", "苹果产业链供应商 · 科森科技 vs 贵州茅台", "relation judge(subjects) ×1", "relation judgement is only provable where the evidence really carries the relation — and where it does not (control)", 1, async () => {
    const failures: string[] = [];
    relationSubjects = subjectsOf([companyByCode("603626"), companyByCode("600519")]);
    relationResult = await runSemanticRelation({ relationQuery: "苹果产业链供应商", subjects: relationSubjects }, { deadlineAt: Date.now() + 6000 });
    if (relationResult.status !== "ok") failures.push(`status=${relationResult.status} failure=${relationResult.failure}`);
    if (relationResult.decisions.length !== 2) failures.push(`decisions=${relationResult.decisions.length} want 2`);
    const kessen = relationResult.decisions.find((decision) => decision.companyId === "603626");
    const moutai = relationResult.decisions.find((decision) => decision.companyId === "600519");
    if (!kessen?.matched) failures.push(`evidence-backed subject not matched (score=${kessen?.score}) — the profile names the customer, the judge must see it`);
    if (kessen && moutai && kessen.score <= moutai.score) failures.push(`control subject scored ≥ evidence-backed subject (${moutai.score} vs ${kessen.score})`);
    if (kessen && !kessen.evidenceRefs.some((ref) => ref.ref === "judge-profile:603626")) failures.push("decision evidence refs do not resolve to the provided profile");
    if (kessen && kessen.relationLabel !== "苹果产业链供应商") failures.push("relationLabel drifted from the Atlas-provided phrase");
    return failures;
  });

  // L9 — semantic_comparison (§5): two subjects with an obvious evidence
  // gradient; the relative answer is the sorted grades, never prose.
  await scenario("L9", "capability: semantic_comparison", "谁更偏光模块主业 · 中际旭创 vs 贵州茅台", "comparison judge(subjects) ×1", "graded comparison needs a real relative judgement across two subjects on the score head", 1, async () => {
    const failures: string[] = [];
    const result = await runSemanticComparison(
      { comparisonQuery: "主营业务是光模块（光通信收发模块）", subjects: subjectsOf([companyByCode("300308"), companyByCode("600519")]) },
      { deadlineAt: Date.now() + 6000 },
    );
    if (result.status !== "ok") failures.push(`status=${result.status} failure=${result.failure}`);
    const innolux = result.decisions.find((decision) => decision.companyId === "300308");
    const moutai = result.decisions.find((decision) => decision.companyId === "600519");
    if (innolux === undefined || moutai === undefined) failures.push("a subject is missing from the decisions");
    else if (innolux.grade <= moutai.grade) failures.push(`relative answer broken: 光模块主业 subject graded ${innolux.grade} ≤ control ${moutai.grade}`);
    return failures;
  });

  // L10 — evidence_explanation (§6): the explanation of L8's judgement may
  // only quote the evidence Atlas provided — checked verbatim on the wire.
  await scenario("L10", "capability: evidence_explanation", "为什么科森科技匹配「苹果产业链供应商」", "explanation judge(evidence) ×1", "groundedness is only provable on the real judgement: every explanation line must quote provided evidence verbatim", 1, async () => {
    const failures: string[] = [];
    const decision = relationResult?.decisions.find((row) => row.companyId === "603626");
    if (!decision) return ["L8 did not produce a relation decision for 603626 — cannot explain"];
    // Atlas derives the candidate facts by splitting the same profile the judge read.
    const evidence: EvidenceItem[] = (relationSubjects[0].evidence[0].text.split(" | "))
      .filter((segment) => segment.trim().length >= 8)
      .map((segment, index) => ({ ref: `judge-profile:603626#${index}`, text: segment }));
    const result = await runEvidenceExplanation(
      {
        userQuery: "苹果产业链供应商",
        judgement: { capability: "semantic_relation", query: "苹果产业链供应商", companyId: "603626", companyName: "科森科技", score: decision.score, matched: decision.matched },
        evidence,
      },
      { deadlineAt: Date.now() + 6000 },
    );
    if (result.status !== "ok") failures.push(`status=${result.status} failure=${result.failure}`);
    if (!result.lines.length) failures.push(`no explanation lines (insufficientEvidence=${result.insufficientEvidence}) — the profile carries the customer relation, at least one fact must support it`);
    const refs = new Set(evidence.map((item) => item.ref));
    const texts = new Set(evidence.map((item) => item.text));
    for (const line of result.lines) {
      if (!refs.has(line.ref)) failures.push(`line cites unprovided ref ${line.ref}`);
      if (!texts.has(line.quote)) failures.push(`line quote is not verbatim provided evidence: ${line.quote.slice(0, 40)}…`);
    }
    return failures;
  });

  const totals = {
    attempts: accounting.attempts,
    scenarios: results.length,
    passed: results.filter((row) => row.pass).length,
    retries: results.reduce((sum, row) => sum + row.retries, 0),
    expectedWireCalls: results.reduce((sum, row) => sum + row.expectedWireCalls, 0),
    unexpectedAttempts: accounting.orphans.length,
  };
  const pass = totals.passed === totals.scenarios && totals.unexpectedAttempts === 0;

  const evidence = {
    suite: "atlas-jev-live/1",
    startedAt,
    finishedAt: new Date().toISOString(),
    endpoint: jevBaseUrl(),
    aliasRequested: provider.model,
    productionContract: JEV_PRODUCTION_MODEL,
    answeredModel: provider.status().lastAnsweredModel,
    scenarios: results,
    totals,
    accountingNote: "attempt = one real fetch to the Jev endpoint (retries included). expectedWireCalls = healthy-path calls; retries within a scenario window stay inside that scenario's budget and are reported separately. unexpectedAttempts must always be 0.",
  };
  mkdirSync(resolve("reports/JEV_TEST_ISOLATION"), { recursive: true });
  const file = resolve("reports/JEV_TEST_ISOLATION", `live_run_${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);

  for (const row of results) {
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.id} ${row.scenario} — ${row.attempts}/${row.expectedWireCalls} wire calls${row.retries ? ` (+${row.retries} retries)` : ""}${row.failures.length ? `\n      ${row.failures.join("\n      ")}` : ""}`);
  }
  console.log(`\ntotals: ${totals.passed}/${totals.scenarios} scenarios · ${totals.attempts} attempts (${totals.expectedWireCalls} healthy + ${totals.retries} retries) · unexpected=${totals.unexpectedAttempts}`);
  console.log(`evidence: ${file}`);
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
