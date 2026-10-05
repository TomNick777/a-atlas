/**
 * 设置面板抽检：点开左下角齿轮，截图确认「牌堆卡面」两档(文字卡/LOGO 卡)、
 * 「卡片配色」两档(经典米白/申万行业)。
 *   node scripts/settings_check.mjs
 */
import { chromium } from "playwright-core";

const url = process.env.FACE_URL ?? "http://localhost:3000";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__floor?.apex, null, { timeout: 30000 });
await page.getByRole("button", { name: "设置" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "reports/ui_preview/settings-panel.png" });
await browser.close();
console.log("settings panel captured");
