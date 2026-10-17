/** Local measurement coordinates. No market, provider probe or secret values. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, join, sep, isAbsolute } from "node:path";
import { loadDataset } from "../../lib/companies";
import { COMPANY_DISCOVERY_VERSION } from "../../lib/discovery/contracts";
import { PARSER_V2_VERSION } from "../../lib/planner/contracts";
import { QUERY_GRAMMAR_REGISTRY_VERSION } from "../../lib/planner/grammar";
import { JEV_CAPABILITY_CONTRACT_VERSIONS } from "../../lib/intelligence/capabilities";
import { DIM, MODEL } from "../../lib/text/embed";

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function privatePath(value: string): string {
  const target = resolve(value);
  if (!["reports", ".local"].some(root => {
    const child = relative(resolve(root), target);
    return child !== "" && child !== ".." && !isAbsolute(child) && !child.startsWith(`..${sep}`);
  })) throw new Error("Measurement files must stay in reports/ or .local/");
  return target;
}

export function collectCoordinates(input: Buffer) {
  const dataset = loadDataset();
  if (!dataset.corpus || !dataset.companies.length) throw new Error("Aligned corpus and vectors are required; legacy fallback cannot be measured as company mainline");
  const git = (args: string[]) => execFileSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean).sort();
  const sources = [...new Set(files)].map(file => ({ file, sha256: existsSync(file) ? sha256(readFileSync(file)) : null }));
  const inputFiles = ["data/companies.json", "data/source_facts/facts.jsonl", "data/company-corpus/companies.jsonl", "data/company-corpus/manifest.json", "data/vectors_corpus.f32"];
  const cache = resolve(".cache", "huggingface", MODEL);
  if (!existsSync(cache)) throw new Error("A warmed local embedding cache is required; downloads are disabled");
  const modelFiles: { file: string; sha256: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) modelFiles.push({ file: relative(cache, file).replaceAll("\\", "/"), sha256: sha256(readFileSync(file)) });
    }
  };
  walk(cache);
  return {
    schemaVersion: 1, at: new Date().toISOString(), entry: "runCompanyDiscovery", contract: COMPANY_DISCOVERY_VERSION,
    gitHead: git(["rev-parse", "HEAD"]).toString().trim(),
    trackedDiffSha256: sha256(git(["diff", "HEAD", "--binary"])), sourceTreeSha256: sha256(JSON.stringify(sources)), sources,
    inputSha256: sha256(input), inputFiles: inputFiles.map(file => ({ file, sha256: sha256(readFileSync(file)) })),
    corpus: dataset.corpus,
    embedding: { model: MODEL, dimension: DIM, modelFiles, modelFilesSha256: sha256(JSON.stringify(modelFiles)) },
    parser: PARSER_V2_VERSION, grammar: QUERY_GRAMMAR_REGISTRY_VERSION,
    capabilityContracts: JEV_CAPABILITY_CONTRACT_VERSIONS,
    node: process.version, platform: `${process.platform}-${process.arch}`,
  };
}
