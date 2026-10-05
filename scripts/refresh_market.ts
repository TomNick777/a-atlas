/** Request/CLI refresh: isolated capture, deterministic build, atomic publication. */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dailyMarketSession, loadTradingCalendar } from "../lib/market/session";
import { marketDataDirectory, marketHistoryDirectory, loadMarketStateManifest } from "../lib/market/state";
import type { MarketStateManifest } from "../lib/market/contracts";
import { pruneMarketSnapshots } from "../lib/market/retention";

const repo = path.resolve(__dirname, "..");
const runtime = path.join(repo, "data", "market-runtime");
const lock = path.join(runtime, "refresh.lock");
const session = dailyMarketSession();
const throughIndex = process.argv.indexOf("--through");
if (throughIndex >= 0) {
  const through = process.argv[throughIndex + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || !session.targetDate || through >= session.targetDate) throw new Error("--through must precede the current target trading day");
  session.targetDate = through;
  session.phase = "afterclose";
}
if (!session.targetDate || session.reason) throw new Error(session.reason ?? "Unknown trading day");
if (session.phase === "intraday") throw new Error("盘中行情尚待 M2 接入；盘后更新请在收盘后执行。");
mkdirSync(runtime, { recursive: true });
try { mkdirSync(lock); } catch { throw new Error("已有行情更新正在执行；若上次进程被强制终止，请先检查 data/market-runtime/refresh.lock。"); }

const snapshotId = `${session.targetDate}_${randomUUID()}`;
const staging = path.join(runtime, "snapshots", snapshotId);
let published = false;
try {
  const current = marketDataDirectory();
  const existingManifest = path.join(current, "state", "manifest.json");
  if (existsSync(existingManifest) && current !== path.join(repo, "data", "market")) {
    const manifest = JSON.parse(readFileSync(existingManifest, "utf8")) as MarketStateManifest;
    if (manifest.latestTradingDay === session.targetDate && !process.argv.includes("--force")) {
      console.log(`market runtime already current: ${session.targetDate}, ${manifest.contentDigest.value.slice(0, 16)}`);
      process.exitCode = 0;
    } else refresh();
  } else refresh();
} finally {
  if (!published && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  rmSync(lock, { recursive: true });
}
if (published) {
  try { console.log(JSON.stringify(pruneMarketSnapshots({ apply: true, runtime }))); }
  catch (error) { console.warn("Snapshot published; retention deferred:", error instanceof Error ? error.message : String(error)); }
}

function run(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { cwd: repo, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status}); current snapshot was not changed`);
}

function refresh() {
  mkdirSync(staging, { recursive: true });
  for (const sub of ["daily", "quote"]) {
    const manifest = loadMarketStateManifest();
    const previous = path.join(manifest ? marketHistoryDirectory(manifest) : marketDataDirectory(), sub);
    if (existsSync(previous)) cpSync(previous, path.join(staging, sub), { recursive: true });
  }
  const calendar = loadTradingCalendar(Number(session.targetDate!.slice(0, 4)))!;
  const dates: string[] = [];
  let day = session.targetDate!;
  while (dates.length < 60 && day >= calendar.validFrom) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !calendar.closedRanges.some(([start, end]) => day >= start && day <= end)) dates.push(day);
    day = new Date(new Date(`${day}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  }
  if (dates.length < 60) throw new Error("已核验日历不足 60 个交易日；先补齐上一年度日历。");
  const datesFile = path.join(staging, "trading-dates.json");
  writeFileSync(datesFile, JSON.stringify(dates));
  run("python", ["-u", "scripts/market_fetch.py", "--data-dir", staging, "--dates-file", datesFile, ...(process.argv.includes("--force") ? ["--force", "--force-quote"] : [])]);
  const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
  run(process.execPath, [tsx, "scripts/build_market_state.ts", "--data-dir", staging]);
  run(process.execPath, [tsx, "scripts/build_market_state.ts", "--data-dir", staging, "--check"]);
  const manifest = JSON.parse(readFileSync(path.join(staging, "state", "manifest.json"), "utf8")) as MarketStateManifest;
  if (manifest.latestTradingDay !== session.targetDate) throw new Error("Capture did not reach the target trading day");
  const pointer = path.join(runtime, "current.json.tmp");
  writeFileSync(pointer, JSON.stringify({ snapshotId, tradeDate: session.targetDate, digest: manifest.contentDigest.value, publishedAt: new Date().toISOString() }) + "\n");
  renameSync(pointer, path.join(runtime, "current.json"));
  published = true;
  console.log(`published market snapshot ${snapshotId}; Web reloads without restart`);
}
