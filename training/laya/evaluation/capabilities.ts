/** Independent frozen cases execute the actual capability seam, without a second judge. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { installCloudBudget } from "../../../quality/discovery/runner/cloud-budget";
import { createHash } from "node:crypto";
import { loadLocalEnv } from "../../../scripts/load-env";
import { withJudgeProvider, jevJudgeRuntime, runSemanticMatch, runSemanticRelation, runSemanticComparison, runEvidenceExplanation, runMarketEligibility, type JudgementSubject } from "../../../lib/intelligence/capabilities";

type Case = { id: string; groupId: string; capability: string; query: string; subjects: JudgementSubject[]; expected: boolean | number; boundary?: string };
type Manifest = { schemaVersion: number; corpusSha256: string; cases: Case[]; labelPolicy: string; purpose: string };
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

async function main() {
  const file = arg("--manifest"), output = arg("--output"), provider = arg("--provider");
  if (!file || !output || !provider || existsSync(output)) throw new Error("Explicit manifest/provider and a new output path required");
  const bytes = readFileSync(file);
  const manifest = JSON.parse(bytes.toString()) as Manifest;
  if (manifest.schemaVersion !== 1 || !manifest.cases.length || hash(readFileSync("data/company-corpus/companies.jsonl")) !== manifest.corpusSha256) throw new Error("Frozen evaluation manifest/corpus mismatch");
  loadLocalEnv();
  const records: Record<string, unknown>[] = [];
  const budget = arg("--acceptance-budget");
  if (provider === "jev" && !budget) throw new Error("Cloud acceptance requires a preregistered budget");
  const ledger = budget ? resolve(dirname(budget), "cloud-budget.json") : null;
  const prereg = budget ? JSON.parse(readFileSync(budget, "utf8")) : null;
  const restore = provider === "jev" ? installCloudBudget(ledger!, prereg.quality.cloudMaxCalls, prereg.quality.cloudMaxCostUsd) : null;
  try { await withJudgeProvider(provider, async () => {
    const save = (complete: boolean) => writeFileSync(output, JSON.stringify({ schemaVersion: 1, complete, manifestSha256: hash(bytes), corpusSha256: manifest.corpusSha256, provider, runtime: jevJudgeRuntime().status, labelPolicy: manifest.labelPolicy, purpose: manifest.purpose, records }, null, 2));
    for (const c of manifest.cases) {
      if (ledger && JSON.parse(readFileSync(ledger, "utf8")).exhausted) throw new Error("Preregistered cloud budget exhausted; partial records retained");
      const options = { deadlineAt: Date.now() + 30000 };
      let result: unknown, actual: boolean | number | null = null, contractValid = false, model: string | null = null;
      if (c.capability === "semantic_match" || c.capability === "semantic_relation") {
        const r = c.capability === "semantic_match" ? await runSemanticMatch({ query: c.query, subjects: c.subjects }, options) : await runSemanticRelation({ relationQuery: c.query, subjects: c.subjects }, options);
        result = r; model = r.runtimeModel;
        contractValid = r.status === "ok" && r.unexpectedAnswers === 0 && r.decisions.every(d => d.known && Number.isFinite(d.score) && d.score >= 0 && d.score <= 1 && d.evidenceRefs.length > 0);
        actual = contractValid ? r.decisions[0]?.matched ?? null : null;
      } else if (c.capability === "semantic_comparison") {
        const r = await runSemanticComparison({ comparisonQuery: c.query, subjects: c.subjects }, options);
        result = r; model = r.runtimeModel;
        contractValid = r.status === "ok" && r.unexpectedAnswers === 0 && r.decisions.every(d => Number.isFinite(d.score) && d.score >= 0 && d.score <= 1 && d.grade >= 0 && d.grade <= 3 && d.evidenceRefs.length > 0);
        actual = contractValid ? r.decisions[0]?.grade ?? null : null;
      } else if (c.capability === "evidence_explanation") {
        const subject = c.subjects[0];
        const r = await runEvidenceExplanation({ userQuery: c.query, judgement: { capability: "semantic_relation", query: c.query, companyId: subject.companyId, companyName: subject.name, matched: true, score: 0.9 }, evidence: subject.evidence }, options);
        result = r; model = r.runtimeModel;
        contractValid = r.status === "ok" && r.unexpectedAnswers === 0 && r.lines.every(line => subject.evidence.some(e => e.ref === line.ref && e.text === line.quote));
        actual = contractValid ? r.lines.length > 0 : null;
      } else if (c.capability === "market_eligibility") {
        const r = await runMarketEligibility(c.query, c.subjects, { ...options, remainingEstimatedCostUsd: 0.1, corpusDigest: manifest.corpusSha256 });
        result = r; model = r.intelligence?.runtimeModel ?? null;
        contractValid = !r.stopped && r.decisions.every(d => d.state !== "unknown" && d.judgement && d.judgement.evidenceRefs.length > 0);
        actual = contractValid ? r.decisions[0]?.state === "confirmed" : null;
      } else throw new Error(`Unknown capability ${c.capability}`);
      records.push({ id: c.id, groupId: c.groupId, capability: c.capability, boundary: c.boundary ?? null, expected: c.expected, actual, contractValid, passed: contractValid && actual === c.expected, runtimeModel: model, result });
      save(false);
      console.log(`${c.id}: ${contractValid ? actual === c.expected ? "PASS" : "QUALITY_FAILURE" : "CONTRACT_OR_AVAILABILITY_FAILURE"}`);
    }
    save(true);
  }); } finally { restore?.(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
