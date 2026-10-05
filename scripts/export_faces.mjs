/**
 * 三种卡面各导出一张单卡大图（走页面里真实的 renderPlate，与游戏内渲染同源）。
 *   node scripts/export_faces.mjs
 * 环境变量 FACE_URL（默认 http://localhost:3000；别用 127.0.0.1，见 face_check.mjs 同注）。
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const url = process.env.FACE_URL ?? "http://localhost:3000";
const code = process.env.FACE_CODE ?? "";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${url}/?face=logo`, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__floor?.card, null, { timeout: 30000 });

// 牌面名字取自物理池，选码必须在池内：优先指定码，否则按 600519/000001/池首兜底
const pooled = await page.evaluate(() => window.__floor.sampleCodes());
const picked = code && pooled.includes(code) ? code : ["600519", "000001"].find((c) => pooled.includes(c)) ?? pooled[0];
console.log(`export card for ${picked} (pool ${pooled.length} sampled)`);

for (const [face, file] of [
  ["text", "card-text"],
  ["logo", "card-logo"],
  ["brand", "card-brand"],
]) {
  const dataUrl = await page.evaluate(({ c, f }) => window.__floor.card(c, f, 320), { c: picked, f: face });
  if (!dataUrl) {
    console.error(`${file}: FAIL`);
    continue;
  }
  writeFileSync(`reports/ui_preview/${file}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`${file}.png written`);
}
await browser.close();
