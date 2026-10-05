/**
 * 搜索排序与匹配度标签冒烟：
 *  1) 直接 POST /api/search 拿服务端原始顺序与概率；
 *  2) 页面里跑同一查询，等举牌停稳后读 __floor.where() 的前几名；
 *  3) 断言页面顺序 === 概率降序（服务端顺序不影响展示序），并截图确认无「匹配度」浮标。
 *   node scripts/search_smoke.mjs "光刻胶"
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const url = process.env.FACE_URL ?? "http://localhost:3000";
const query = process.argv[2] ?? "光刻胶";

// 1) 服务端原始顺序
const api = await fetch(`${url}/api/search`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query }),
});
const data = await api.json();
const rawTop = (data.hits ?? []).slice(0, 5).map((h) => ({ name: h.name, p: h.probability }));
const expected = [...(data.hits ?? [])]
  .sort((a, b) => b.probability - a.probability)
  .slice(0, 5)
  .map((h) => ({ name: h.name, p: h.probability }));
console.log("服务端前5:", JSON.stringify(rawTop));
console.log("期望前5(降序):", JSON.stringify(expected));

// 2) 页面内同一查询
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__floor?.apex, null, { timeout: 30000 });
await page.waitForTimeout(2500);
await page.getByRole("textbox").fill(query);
await page.keyboard.press("Enter");
await page.waitForTimeout(7000); // 举牌波浪 + 停稳
await page.screenshot({ path: "reports/ui_preview/search-no-matchdegree.png" });
const holds = await page.evaluate(() => window.__floor.where());
const shownNames = (holds.sample ?? []).map((row) => row.name);
console.log("页面举牌前5:", JSON.stringify(shownNames));
console.log("holds 总数:", holds.holds);

// 3) 断言：页面顺序 === 概率降序
const expectedNames = expected.map((row) => row.name);
const ok = expectedNames.every((name, rank) => shownNames[rank] === name);
console.log(ok ? `SORT PASS (前${expectedNames.length}名与概率降序一致)` : `SORT MISMATCH: 期望 ${JSON.stringify(expectedNames)} 实际 ${JSON.stringify(shownNames)}`);
writeFileSync("reports/ui_preview/search-smoke.json", JSON.stringify({ query, rawTop, expected, shownNames, ok }, null, 1));
await browser.close();
process.exitCode = ok ? 0 : 1;
