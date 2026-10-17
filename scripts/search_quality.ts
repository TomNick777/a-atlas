/** Explicit offline-only measurement for the company discovery mainline. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectCoordinates, privatePath } from "./search-quality/coordinates";
import { measureRetrievalCase, measureSavedBoundary, parseCases } from "./search-quality/offline";

async function main() {
  const args = process.argv.slice(2);
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--input", "--output", "--mode"].includes(args[i]) || !args[i + 1] || values[args[i]]) throw new Error("Usage: search:quality -- --input <private.json> --output <new-private-directory> --mode retrieval-only|saved-boundary-replay");
    values[args[i]] = args[i + 1];
  }
  if (!values["--input"] || !values["--output"] || !["retrieval-only", "saved-boundary-replay"].includes(values["--mode"])) throw new Error("Explicit input, output and offline mode required; LIVE is not supported by this command");
  const inputPath = privatePath(values["--input"]), output = privatePath(values["--output"]);
  if (existsSync(output)) throw new Error("Measurement observations cannot be overwritten");
  const input = readFileSync(inputPath), cases = parseCases(JSON.parse(input.toString("utf8")));
  if (values["--mode"] === "saved-boundary-replay" && cases.some(row => !row.traceId)) throw new Error("Every saved replay case requires its original traceId");
  // No .env load, identity probe, Laya runtime refresh, judge or remote model download.
  let attemptedNetworkCalls = 0;
  globalThis.fetch = async () => { attemptedNetworkCalls++; throw new Error("Network is disabled for company offline measurement"); };
  const { env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  const coordinates = collectCoordinates(input);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output, { recursive: false });
  const write = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  write("environment.json", coordinates);
  write("input.json", JSON.parse(input.toString("utf8")));
  const summaries: { id: string; status: string }[] = [];
  for (const row of cases) {
    try {
      const result = values["--mode"] === "retrieval-only" ? await measureRetrievalCase(row) : await measureSavedBoundary(row);
      appendFileSync(join(output, "results.jsonl"), JSON.stringify({ status: "observed", ...result }) + "\n");
      summaries.push({ id: row.id, status: "observed" });
      console.log(`${row.id}: observed (${values["--mode"]})`);
    } catch (error) {
      appendFileSync(join(output, "results.jsonl"), JSON.stringify({ id: row.id, status: "error", error: error instanceof Error ? error.message : String(error) }) + "\n");
      summaries.push({ id: row.id, status: "error" });
    }
  }
  const complete = attemptedNetworkCalls === 0 && summaries.every(row => row.status === "observed");
  write("run.json", { schemaVersion: 1, entry: "runCompanyDiscovery", mode: values["--mode"], cloudCalls: 0,
    attemptedNetworkCalls, cases: summaries, complete, qualityAccepted: false,
    note: "Offline observation only. Not a judge measurement, product browser acceptance or complete recall evaluation." });
  console.log(JSON.stringify({ output, complete, attemptedNetworkCalls, cloudCalls: 0, qualityAccepted: false }));
  if (!complete) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
