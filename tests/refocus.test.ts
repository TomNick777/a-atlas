import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Refocus §四十一 — Vibe removal verification, as a durable invariant.
 *
 * The current runtime (app / lib / components / scripts / CI / env) must contain
 * zero references to the retired Vibe research stack. Historical evidence lives in
 * docs/ and reports/ and is allowed; this scan never looks there.
 */

const ROOT = path.resolve(__dirname, "..");

const RUNTIME_DIRS = ["app", "lib", "components", "scripts", ".github"];
const RUNTIME_FILES = ["package.json", "instrumentation.ts", "vitest.config.ts", "next.config.ts", ".env.example", ".gitignore", "requirements.txt"];

/** Tokens that only the retired stack used. Jev's own "admission control" is a
 * different concept (cloud request admission) and is NOT on this list. */
const BANNED = [
  /vibe[-_]?(research|astock|port)/i,
  /a-atlas-research/i,
  /ATLAS_RESEARCH_URL/i,
  /ATLAS_DEEPDIVE/i,
  /duanxian/i,
  /review_agent/i,
  /deepdive/i,
  /daily[-_]?review/i,
  /backtest/i,
  /\bmyreports\b/i,
  /mode[-_]?card/i,
  /watchlist/i,
  /\bjournal\b/i,
  /\bportfolio\b/i,
  /askai/i,
  /VR_API_KEY/i,
  /VIBE_PORT/i,
  /\b8910\b/,
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === "__pycache__" || entry === "laya_lab") continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

describe("refocus — vibe removal invariant (§四十一)", () => {
  it("current runtime carries zero references to the retired research stack", () => {
    const offenders: string[] = [];
    const files: string[] = [];
    for (const dir of RUNTIME_DIRS) {
      const full = path.join(ROOT, dir);
      try {
        statSync(full).isDirectory();
        files.push(...walk(full));
      } catch {
        // dir absent — fine
      }
    }
    files.push(...RUNTIME_FILES.map((f) => path.join(ROOT, f)));
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const pattern of BANNED) {
        if (pattern.test(text)) {
          offenders.push(`${file} :: ${pattern}`);
          break;
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("lib/atlas keeps only its frozen core modules", () => {
    // Phase 3.4 (Jev Evidence UX) added two Atlas-domain modules: the UI
    // evidence contract (evidence.ts) and the discover answer cache
    // (discoverCache.ts). The set stays closed — new modules need a phase
    // decision and this list to move.
    const files = readdirSync(path.join(ROOT, "lib", "atlas")).sort();
    expect(files).toEqual(["company.ts", "discoverCache.ts", "evidence.ts", "runtime.ts", "stockIdentity.ts"]);
  });

  it("health contract answers as a-atlas-web with web+data components", async () => {
    const source = readFileSync(path.join(ROOT, "app", "api", "health", "route.ts"), "utf8");
    expect(source).toContain('"a-atlas-web"');
    expect(source).toContain("probeDataServiceHealth");
    expect(source).not.toMatch(/a-atlas-research/i);
  });

  it("search acceptance cases survive as data (six-topic regression basis)", async () => {
    const { CASES } = await import("@/scripts/search_cases");
    expect(CASES.length).toBeGreaterThanOrEqual(6);
    expect(CASES.map((c: { query: string }) => c.query).join("|")).toMatch(/光刻胶/);
    expect(CASES.map((c: { query: string }) => c.query).join("|")).toMatch(/机器人|谐波减速器/);
  });
});
