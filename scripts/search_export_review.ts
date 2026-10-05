import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exportReviewRuns } from "../lib/search/log";
import { readManifest } from "../lib/search/edition";

/**
 * Review export (规格第十九/二十节): self-contained JSON + readable MD under
 * reports/search-review/. The JSON is the primary audit artifact — an external
 * auditor needs no access to this repo: every run carries the raw query,
 * QuerySpec, Top-200 with per-layer scores, Top-20, timings and system versions.
 *
 * Usage: npm run search:export-review [--last 50|100] [--all]
 */

async function main() {
  const argv = process.argv.slice(2);
  const lastIdx = argv.indexOf("--last");
  const limit = lastIdx >= 0 ? parseInt(argv[lastIdx + 1], 10) : undefined;
  const runs = await exportReviewRuns(Number.isFinite(limit) ? limit : undefined);
  if (!runs.length) {
    console.log("search log is empty — nothing to export");
    return;
  }

  const manifest = readManifest();
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const dir = path.join(process.cwd(), "reports", "search-review");
  mkdirSync(dir, { recursive: true });

  const jsonPath = path.join(dir, `search_review_${date}.json`);
  const payload = {
    exportedAt: new Date().toISOString(),
    runCount: runs.length,
    systemVersions: {
      note: "版本信息同时冗余记录在每条 run.versions 里(自包含要求)",
      currentManifest: manifest,
    },
    runs,
  };
  writeFileSync(jsonPath, JSON.stringify(payload, null, 1));

  const mdPath = path.join(dir, `SEARCH_REVIEW_${date}.md`);
  const lines = [
    `# Search Review ${date}`,
    "",
    `导出 ${runs.length} 条真实搜索。主审计文件:search_review_${date}.json(自包含,含 QuerySpec/Top200/Top20/逐层分数/耗时/版本)。`,
    "",
    "| searchId | 时间 | Query | Top1 | 匹配数 | degraded | rerank耗时 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const run of runs) {
    const top1 = run.result.top20[0];
    lines.push(
      `| ${run.searchId} | ${run.timestamp.slice(0, 16).replace("T", " ")} | ${run.query.raw} | ` +
      `${top1 ? `${top1.name}(${Math.round(top1.score * 100)}%)` : "-"} | ${run.result.matches} | ${run.versions.degraded} | ${run.timing.rerankMs}ms |`,
    );
  }
  lines.push("", "逐题审计请用 JSON:每条 run.candidates 是完整 Top-200 逐层分数,run.retrieval.excludedByHardFilter 是被硬过滤挡掉的候选。", "");
  writeFileSync(mdPath, lines.join("\n"));

  console.log(`exported ${runs.length} runs -> ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`                            ${path.relative(process.cwd(), mdPath)}`);
}

main();
