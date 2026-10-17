import { compileCompanyQuery, runCompanyDiscovery } from "../lib/discovery/query";
import { parseProvider, withJudgeProvider } from "../lib/intelligence/capabilities";

async function main() {
  const args = process.argv.slice(2);
  const providerIndex = args.indexOf("--provider");
  const provider = parseProvider(providerIndex < 0 ? undefined : args[providerIndex + 1]);
  const flags = new Set(["--json", "--explain", "--retrieval-only"]);
  const query = args.filter((arg, index) => !flags.has(arg) && (providerIndex < 0 || (index !== providerIndex && index !== providerIndex + 1))).join(" ").trim();
  if (query.length < 2) throw new Error('Usage: npm run search:query -- [--json] [--explain] [--retrieval-only] [--provider jev|drex|laya] "公司业务描述"');
  const answer = args.includes("--explain")
    ? compileCompanyQuery(query)
    : await withJudgeProvider(provider, () => runCompanyDiscovery(query, { log: false, skipJev: args.includes("--retrieval-only"), origin: "smoke" }));
  console.log(JSON.stringify(answer, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Company query failed"); process.exitCode = 1; });
