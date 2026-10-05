/**
 * CI 活栈 smoke（Refocus 形态）：headless Edge + deterministic stub provider。
 *
 * 只断言【不依赖真实云端 Jev / 真实公网数据源】的两条产品旅程：
 * Journey A 骨架——发现物理堆、自然语言搜索、公司页单页纵向阅读；
 * Journey B 骨架——公司页在数据服务降级时仍如实可开（数据块断言在
 * 数据接入提交后扩展）。
 * 由 .github/workflows/windows-runtime.yml 的 live-stack job 编排服务。
 */

import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.ATLAS_BASE ?? "http://127.0.0.1:3400";
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) throw new Error("system Edge not found");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
mkdirSync("reports/CI_RUNTIME", { recursive: true });
const shot = (n) => page.screenshot({ path: `reports/CI_RUNTIME/${n}.png` });

try {
  // 1. Discover 物理堆：canvas + 睡稳标记 + 唯一一级入口（无 市场/研究/我的）
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 30_000 });
  const settled = await page.waitForFunction(() => {
    const api = window.__floor;
    return typeof api?.settled === "function" ? api.settled() === true : false;
  }, null, { timeout: 60_000 }).then(() => true).catch(() => false);
  ok("discover 物理堆睡稳（window.__floor.settled()）", settled);
  for (const retired of ["市场", "研究", "我的"]) {
    ok(`首页无一级入口：${retired}`, !(await page.getByRole("link", { name: retired, exact: true }).isVisible().catch(() => false)));
  }
  await shot("01-discover");

  // 2. 公司页：单页纵向阅读（无 Tab、无 AI研究），数据块骨架如实降级
  await page.goto(`${BASE}/stock/688138`, { waitUntil: "domcontentloaded" });
  ok("公司页渲染", await page.getByText("清溢光电", { exact: false }).first().isVisible().catch(() => false));
  ok("公司页无 Tab：AI研究", !(await page.getByText("AI研究", { exact: true }).first().isVisible().catch(() => false)));
  ok("公司页有简介/主营业务", await page.getByText("主营业务", { exact: false }).first().isVisible().catch(() => false));
  await shot("02-company");

  // 3. 旧 URL 如实 404（不保留半死页面）
  for (const retired of ["/market", "/research", "/my"]) {
    const res = await fetch(`${BASE}${retired}`);
    ok(`旧 URL 404：${retired}`, res.status === 404, `status=${res.status}`);
  }

  await browser.close();
} catch (err) {
  await browser.close().catch(() => {});
  console.error("ci_smoke crashed:", err);
  process.exit(1);
}

const failed = results.filter((r) => !r.pass);
writeFileSync("reports/CI_RUNTIME/summary.json", JSON.stringify({ results }, null, 2));
console.log(failed.length === 0 ? `\nCI SMOKE ALL PASS (${results.length})` : `\n${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
