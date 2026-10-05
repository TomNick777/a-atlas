/**
 * 物理堆的定标与验收。起一个 dev server（PHYSICS_POOL_SIZE 决定堆里多少张牌），用系统 Edge
 * headless 打开页面，等整堆睡稳后读堆顶（window.__floor.apex）。净空线 = 视口高的一半 − 90px。
 *
 *   node scripts/measure_pile.mjs           # 定标扫描：每个视口扫几个牌高，给 PILE_CAP 定标
 *   node scripts/measure_pile.mjs --verify  # 验收：只测初始牌高，外加 governor 兜底（放大牌高制造越线）
 *
 * 环境变量：PILE_URL（默认 http://localhost:3100；别用 127.0.0.1——Next 16 的开发资源
 * 跨域保护会挡掉它的 HMR，页面永远不 hydrate）。
 */
import { chromium } from "playwright-core";

const url = process.env.PILE_URL ?? "http://localhost:3100";
const verify = process.argv.includes("--verify");
const viewports = [
  { w: 1920, h: 1080 },
  { w: 1366, h: 768 },
];
const sweep = [26, 22, 18];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
const lineY = (vh) => vh * 0.5 - 90;

/** 稳定不要求全部睡着——深堆里总有一两块牌长抖不睡。要求：awake 只剩零星，且堆顶两次读数（隔 2.5s）不再变化。 */
async function waitSettled(page) {
  let prev = null;
  for (let round = 0; round < 96; round++) {
    await page.waitForTimeout(2500);
    const at = await page.evaluate(() => ({ awake: window.__floor?.awake ?? -1, apex: window.__floor?.apex?.() ?? null }));
    if (
      at.apex &&
      at.awake >= 0 &&
      at.awake <= 2 &&
      prev?.apex &&
      Math.abs(prev.apex.y - at.apex.y) < 4 &&
      Math.abs(prev.apex.h - at.apex.h) < 0.2
    ) {
      return at.apex;
    }
    prev = at;
  }
  throw new Error(`pile never stabilized: ${JSON.stringify(prev)}`);
}

for (const { w, h } of viewports) {
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__floor?.apex, null, { timeout: 30000 });
  await waitSettled(page);
  const initial = await page.evaluate(() => window.__floor.apex());
  results.push({ viewport: `${w}x${h}`, case: "initial", ...initial, line: Math.round(lineY(h)), ok: initial.y >= lineY(h) - 10 });

  if (verify) {
    // governor 兜底：故意放大牌高制造越线。governor 每秒量一次，越线就缩牌并唤醒全堆重新压实。
    // 每轮等一个平台期——governor 想出手的话早就出手了；十轮还压不回线内就是兜底失败。
    await page.evaluate(() => window.__floor.setSize(26));
    let fixed = null;
    for (let round = 0; round < 10 && !fixed; round++) {
      const at = await waitSettled(page);
      if (at.y >= lineY(h) - 20) fixed = at;
    }
    results.push({
      viewport: `${w}x${h}`,
      case: "governor(setSize 26)",
      ...(fixed ?? (await page.evaluate(() => window.__floor.apex()))),
      line: Math.round(lineY(h)),
      ok: !!fixed,
    });
  } else {
    for (const side of sweep) {
      if (Math.abs(side - initial.h) < 0.5) continue;
      await page.evaluate((s) => window.__floor.setSize(s), side);
      await waitSettled(page);
      const at = await page.evaluate(() => window.__floor.apex());
      results.push({ viewport: `${w}x${h}`, case: `side=${side}`, ...at, line: Math.round(lineY(h)), ok: at.y >= lineY(h) });
    }
  }
  await context.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
if (verify) {
  const bad = results.filter((r) => !r.ok);
  console.error(bad.length ? `FAIL ${bad.length}/${results.length}` : `PASS ${results.length}/${results.length}`);
  process.exitCode = bad.length ? 1 : 0;
} else {
  console.error(`measured ${results.length} points`);
}
