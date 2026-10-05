/**
 * 卡面视觉抽检：headless Edge 对两个牌堆卡面各截一张（brand 是举牌专用面，
 * 单卡形态由 export_faces.mjs 导出），顺带收集控制台错误。
 *   node scripts/face_check.mjs
 * 环境变量 FACE_URL（默认 http://localhost:3000；别用 127.0.0.1——Next 16 开发资源
 * 跨域保护会挡掉 hydrate，见 measure_pile.mjs 同注）。
 */
import { chromium } from "playwright-core";

const url = process.env.FACE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text().slice(0, 160));
});
page.on("pageerror", (err) => errors.push(String(err).slice(0, 160)));

// 文字面基线（默认态回归）
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__floor?.apex, null, { timeout: 30000 });
await page.waitForTimeout(5000);
await page.screenshot({ path: "reports/ui_preview/face-text.png" });

// LOGO 面（URL 参数即卡面覆盖；等浇注与 logo 到达）
await page.goto(`${url}/?face=logo`, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__floor?.apex, null, { timeout: 30000 });
await page.waitForTimeout(9000);
await page.screenshot({ path: "reports/ui_preview/face-logo.png" });

await browser.close();
console.log(errors.length ? `CONSOLE ERRORS (${errors.length}):\n${errors.join("\n")}` : "no console errors");
