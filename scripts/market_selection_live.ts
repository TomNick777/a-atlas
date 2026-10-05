/** Targeted M3 wire/quality observation, not an organic usage trace or a
 * replacement for the frozen discovery benchmark. Each cold repetition pins
 * the same corpus and market artifact, saves full inspectable evidence, and
 * deliberately clears the eligibility cache before measuring stability. */
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadLocalEnv } from "./load-env";
import { loadDataset } from "../lib/companies";
import { loadMarketStateManifest, loadMarketStateRows } from "../lib/market/state";
import { identityProbe, resetMarketEligibilityCache, MARKET_ELIGIBILITY_VERSION } from "../lib/jev/capabilities";
import { runHybridQuery } from "../lib/hybrid/execute";
import { presentDiscoverResult } from "../lib/atlas/evidence";
import { MARKET_SELECTION_VERSION } from "../lib/hybrid/contracts";

loadLocalEnv();
async function main() {
  const identity = await identityProbe();
  if (!identity.ok) throw Error(`identity probe failed: ${JSON.stringify(identity)}`);
  const manifest = loadMarketStateManifest();
  if (!manifest) throw Error("no pinned market");
  const rows = loadMarketStateRows(manifest.latestTradingDay, manifest);
  if (!rows) throw Error("no pinned rows");
  const queries = ["今天涨幅最高的5家机器人公司", "全市场成交额前20中有哪些机器人公司", "今天明显放量的机器人公司"];
  const report = { runAt: new Date().toISOString(), head: execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(), corpus: loadDataset().version, market: manifest.contentDigest, snapshotId: manifest.runtime?.snapshotId, identity, selectionVersion: MARKET_SELECTION_VERSION, eligibilityVersion: MARKET_ELIGIBILITY_VERSION, results: [] as unknown[] };
  mkdirSync(".local", { recursive: true });
  for (let repetition = 1; repetition <= 2; repetition++) {
    for (const query of queries) {
      resetMarketEligibilityCache();
      const result = await runHybridQuery(query, { log: false, marketInject: { manifest, rows } });
      const warm = await runHybridQuery(query, { log: false, marketInject: { manifest, rows } });
      report.results.push({ repetition, query, cold: presentDiscoverResult(result), warm: { execution: warm.execution, jevSummary: warm.jevSummary, codes: warm.results.map(r => r.code) } });
      writeFileSync(".local/m3-live.json", JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ repetition, query, selection: result.execution.selection, jev: result.jevSummary, codes: result.results.map(r => r.code), warm: warm.jevSummary }));
      if (result.results.some(r => !r.judgement?.matched || !r.judgement.evidenceRefs.length)) throw Error("unconfirmed member surfaced");
      if (result.execution.selection?.complete && warm.jevSummary?.calls !== 0) throw Error("complete cached scan unexpectedly called Jev");
      for (let i = 1; i < result.results.length; i++) {
        const a = result.results[i - 1], b = result.results[i];
        if (Number(a.hero?.value) < Number(b.hero?.value)) throw Error("market order violated");
      }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
