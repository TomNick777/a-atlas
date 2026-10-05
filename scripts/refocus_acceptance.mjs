/**
 * Refocus 浏览器验收（refocus §四十）：两条核心旅程。
 *
 * Journey A  打开 → 搜索「光刻胶」→ 公司上浮 → 点公司 → 为什么匹配 →
 *            公司简介/主营业务/市场快照/基础财务/最近公告/最近研报 → 返回 → 再搜索
 * Journey B  Jev 不可用（无 key + 死端点，:3411 实例）→ 确定性降级结果 →
 *            公司页仍可打开（数据块如实降级）
 *
 * Journey B 由本脚本自行拉起 :3411 实例（env 注入），退出时清理。
 * 用法: node scripts/refocus_acceptance.mjs   （需要 :3400 生产栈 + :8920 在跑）
 */

import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright-core";

const BASE = process.env.ATLAS_BASE ?? "http://127.0.0.1:3400";
const B_PORT = 3411;
const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) throw new Error("system Edge not found");

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

mkdirSync("reports/REFOCUS", { recursive: true });
const browser = await chromium.launch({ executablePath: EDGE, headless: true });

// ---------------------------------------------------------------------------
// Journey A
// ---------------------------------------------------------------------------
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shot = (n) => page.screenshot({ path: `reports/REFOCUS/${n}.png` });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 30_000 });
  ok("A1 物理堆渲染", true);

  // UI 真实输入搜索；响应从网络层截取（decidedBy/命中数），牌面点击在验收里以
  // 应用自身生成的同形 URL 导航近似（window.__floor 是调试统计面，不暴露牌坐标）。
  const searchResp = page.waitForResponse((r) => r.url().includes("/api/search") && r.request().method() === "POST", { timeout: 60_000 });
  const box = page.locator("input").first();
  await box.click();
  await box.fill("光刻胶");
  await box.press("Enter");
  const searchJson = await (await searchResp).json();
  ok("A2 搜索「光刻胶」decidedBy=jev 且有命中", searchJson.decidedBy === "jev" && searchJson.hits?.length > 0, `decidedBy=${searchJson.decidedBy} hits=${searchJson.hits?.length}`);
  await page.waitForTimeout(6_000); // 分批上浮动画
  await shot("journeyA-1-search");

  const top = searchJson.hits[0];
  const target = `/stock/${top.code}?q=${encodeURIComponent("光刻胶")}&m=${top.probability.toFixed(4)}`;
  await page.goto(`${BASE}${target}`, { waitUntil: "domcontentloaded" });
  ok("A3 为什么匹配可见", await page.getByText("为什么匹配本次搜索").first().isVisible().catch(() => false));
  for (const section of ["公司简介", "主营业务", "市场快照", "基础财务", "最近公告", "最近研报"]) {
    ok(`A4 段落可见：${section}`, await page.getByText(section, { exact: true }).first().isVisible().catch(() => false));
  }
  await shot("journeyA-2-company");

  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 15_000 });
  const searchResp2 = page.waitForResponse((r) => r.url().includes("/api/search") && r.request().method() === "POST", { timeout: 60_000 });
  const box2 = page.locator("input").first();
  await box2.click();
  await box2.fill("热管理");
  await box2.press("Enter");
  const searchJson2 = await (await searchResp2).json();
  ok("A5 返回后可再搜索", searchJson2.decidedBy === "jev" && searchJson2.hits?.length > 0, `decidedBy=${searchJson2.decidedBy} hits=${searchJson2.hits?.length}`);
  await shot("journeyA-3-again");

  await page.close();
} catch (err) {
  ok("Journey A 流程", false, String(err).slice(0, 160));
}

// ---------------------------------------------------------------------------
// Journey B — 无 Jev（:3411 独立实例，死端点 + 空 key）
// ---------------------------------------------------------------------------
let child = null;
try {
  child = spawn(process.platform === "win32" ? "node" : "node", ["node_modules/next/dist/bin/next", "start", "--port", String(B_PORT)], {
    env: { ...process.env, NODE_ENV: "production", TYPESAFE_API_KEY: "", JEV_BASE_URL: "http://127.0.0.1:9", ATLAS_DATA_URL: "http://127.0.0.1:8920" },
    stdio: "ignore",
    detached: false,
  });
  // wait for readiness
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      const res = await fetch(`http://127.0.0.1:${B_PORT}/api/health`);
      if (res.ok) { ready = true; break; }
    } catch {}
  }
  ok("B0 :3411 无 key 实例就绪", ready);

  const body = JSON.stringify({ query: "光刻胶", origin: "acceptance" });
  const res = await fetch(`http://127.0.0.1:${B_PORT}/api/search`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-session-id": "journey-b" }, body,
  });
  const data = await res.json();
  ok("B1 降级为确定性检索（decidedBy=retrieval, degraded=true）", data.decidedBy === "retrieval" && data.degraded === true, JSON.stringify({ decidedBy: data.decidedBy, degraded: data.degraded }));
  ok("B2 降级仍有结果", Array.isArray(data.hits) && data.hits.length > 0, `hits=${data.hits?.length}`);

  const pageB = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const top = data.hits[0];
  await pageB.goto(`http://127.0.0.1:${B_PORT}/stock/${top.code}?q=${encodeURIComponent("光刻胶")}&m=${top.probability.toFixed(4)}`, { waitUntil: "domcontentloaded" });
  const sections = ["为什么匹配本次搜索", "公司简介", "主营业务"];
  for (const section of sections) {
    ok(`B3 降级下可见：${section}`, await pageB.getByText(section).first().isVisible().catch(() => false));
  }
  const snapshotOk = await pageB.getByText("市场快照").first().isVisible().catch(() => false);
  const snapshotState = await pageB.getByText(/数据源暂时不可用|暂无行情|数据源不覆盖/).first().isVisible().catch(() => false);
  ok("B4 数据块存在且如实降级", snapshotOk, snapshotState ? "降级文案可见" : "（数据服务在跑则显示真数据）");
  await pageB.screenshot({ path: "reports/REFOCUS/journeyB-degraded.png" });
  await pageB.close();
} catch (err) {
  ok("Journey B 流程", false, String(err).slice(0, 160));
} finally {
  if (child) {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
  }
}

await browser.close();
const failed = results.filter((r) => !r.pass);
writeFileSync("reports/REFOCUS/journeys.json", JSON.stringify({ results }, null, 2));
console.log(failed.length === 0 ? `\nREFOCUS JOURNEYS ALL PASS (${results.length})` : `\n${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
