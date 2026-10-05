/**
 * Hybrid Query CLI — Phase 2 Hybrid Market Discovery + Phase 3.2 Jev-First
 * query compilation (§11/§19 debug surface).
 *
 * Usage:
 *   npm run hybrid:query -- --explain "今天领涨的机器人公司"   routed plan + parser provenance
 *   npm run hybrid:query -- "今天领涨的机器人公司"              plan + ranked results
 *   npm run hybrid:query -- --json "..."                        full envelope JSON
 *   npm run hybrid:query -- --preset H1                         canonical queries H1–H10
 *   npm run hybrid:query -- --preset P1                         canonical Phase 3 queries P1–P22
 *   npm run hybrid:query -- --suite                             run H1–H10 with timings
 *   npm run hybrid:query -- --vocab                             the frozen query grammar
 *
 * The parser (lib/hybrid/parser-v2.ts + the frozen V1 grammar) is deterministic
 * and dataset-free. --explain answers from the query alone. Execution reads the
 * committed Market State and the discovery layer — set TYPESAFE_API_KEY for the
 * live judge, otherwise runs label themselves DEGRADED onto the deterministic
 * blend.
 */

import { compileHybridQuery } from "../lib/hybrid/compile";
import { runHybridQuery } from "../lib/hybrid/execute";
import { SUPPORTED_VOCAB } from "../lib/hybrid/planner";
import { heroText } from "../lib/hybrid/hero";
import { HYBRID_PRESETS } from "../lib/hybrid/presets";
import { PHASE3_PRESETS } from "../lib/hybrid/presets3";
import { grammarSummary } from "../lib/planner/grammar";

export { HYBRID_PRESETS, PHASE3_PRESETS };

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const explain = args.includes("--explain");
const suite = args.includes("--suite");
const presetIdx = args.indexOf("--preset");
const raw = args.find((a, i) => !a.startsWith("--") && !(presetIdx >= 0 && i === presetIdx + 1));

const PRESETS = { ...HYBRID_PRESETS, ...PHASE3_PRESETS };

async function printPlan(query: string): Promise<void> {
  const { plan, provenance } = compileHybridQuery(query);
  if (jsonOut) {
    console.log(JSON.stringify({ provenance, plan }, null, 2));
    return;
  }
  console.log(`\n== plan (${plan.plannerVersion}) ==`);
  console.log(JSON.stringify(plan, null, 2));
  console.log(`\n== parser ==`);
  console.log(`route=${provenance.route} · version=${provenance.version} · parse=${provenance.parseMs}ms`);
}

async function printResult(query: string): Promise<void> {
  if (explain) return printPlan(query);
  const result = await runHybridQuery(query, { log: false });
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`\n== ${query} ==`);
  console.log(`parser=${result.parser.route}(${result.parser.version}) · order=${result.execution.order} · degraded=${result.execution.degraded}${result.execution.degradedReason ? ` (${result.execution.degradedReason})` : ""} · ${result.planCaption}`);
  if (result.plan.notes.length) for (const note of result.plan.notes) console.log(`note: ${note}`);
  if (result.plan.assumptions?.length) for (const assumption of result.plan.assumptions) console.log(`assumption: ${assumption}`);
  if (result.plan.unsupported) {
    console.log(`UNSUPPORTED [${result.plan.unsupported.intent}]: ${result.plan.unsupported.detail}`);
    return;
  }
  console.log(`timings: parser ${result.execution.timings.parserMs}ms · semantic ${result.execution.timings.semanticMs ?? "—"} · market ${result.execution.timings.marketMs ?? "—"} · merge ${result.execution.timings.mergeMs ?? "—"} · total ${result.execution.timings.totalMs}ms`);
  if (!result.results.length) {
    console.log("没有结果。");
    return;
  }
  for (const [at, row] of result.results.entries()) {
    const hero = row.hero ? heroText(row.hero) : row.probability !== null ? `语义 ${row.probability.toFixed(2)}` : "语义 —";
    const facts = row.semantic?.matchedFacts?.length ? ` · 事实: ${row.semantic.matchedFacts.slice(0, 3).join("、")}` : "";
    console.log(`${String(at + 1).padStart(2)}. ${row.code} ${row.name} · ${hero}${facts}`);
  }
}

if (args.includes("--vocab")) {
  console.log(JSON.stringify({ ...SUPPORTED_VOCAB, v2Grammar: grammarSummary() }, null, 2));
  process.exit(0);
}

async function main(): Promise<void> {
  if (suite) {
    const started = performance.now();
    for (const [key, query] of Object.entries(HYBRID_PRESETS)) {
      const at = performance.now();
      const result = await runHybridQuery(query, { log: false });
      const rows = result.results.slice(0, 3).map((row, rank) => `${rank + 1}. ${row.code} ${row.name} ${row.hero ? heroText(row.hero) : ""}`);
      console.log(
        `\n${key}「${query}」 order=${result.execution.order} degraded=${result.execution.degraded} total=${result.execution.timings.totalMs}ms (wall ${Math.round(performance.now() - at)}ms)`,
      );
      console.log(rows.join("\n") || (result.plan.unsupported ? `unsupported: ${result.plan.unsupported.intent}` : "无结果"));
    }
    console.log(`\nsuite wall: ${Math.round(performance.now() - started)}ms`);
    return;
  }

  let query: string | undefined;
  if (presetIdx >= 0) {
    const key = (args[presetIdx + 1] ?? "").toUpperCase();
    query = PRESETS[key];
    if (!query) {
      console.error(`unknown preset ${key} — known: ${Object.keys(PRESETS).join(", ")}`);
      process.exit(1);
    }
  } else if (raw !== undefined) {
    query = raw;
  } else {
    console.error('usage: npm run hybrid:query -- [--explain|--json] "query" | --preset H1..H10|P1..P22 | --suite | --vocab');
    process.exit(1);
  }

  await printResult(query);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
