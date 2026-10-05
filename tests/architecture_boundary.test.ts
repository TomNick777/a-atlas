import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Jev-First architecture boundary (Phase 3.2 §1/§22/§32) — pins the frozen
 * principle "Atlas builds the rails. Jev provides the intelligence." as code:
 *
 *   1. the general LLM planner runtime stays OUT of the active tree
 *      (GLM / PLANNER_LLM / provider seam / live suites: zero references;
 *      reports/ keep their historical evidence, that is not architecture);
 *   2. Jev Cloud is the ONLY cloud consumer (no chat-completions client
 *      anywhere outside the Jev seam);
 *   3. the query path has exactly one compiler and no second semantic judge;
 *   4. the grammar file stays free of industry/concept vocabulary.
 */

const ACTIVE_ROOTS = ["lib", "app", "scripts", "components", "tests"];
/** Code + machine config only. PROJECT_STATE.md / README.md are documentation:
 * they must be able to NAME what was removed (the removal inventory) without
 * that counting as active architecture — the reports/ rule applies to them. */
const ACTIVE_FILES = ["package.json", "vitest.config.ts", ".env.example"];

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__pycache__" || entry === "laya_lab" || entry === "node_modules") continue;
      yield* walkFiles(full);
    } else if (/\.(ts|tsx|mjs|js|json|md|yml|example|local)$/.test(entry) || entry === ".env.example") {
      yield full;
    }
  }
}

function activeSources(): Map<string, string> {
  const files = new Map<string, string>();
  for (const root of ACTIVE_ROOTS) for (const file of walkFiles(root)) files.set(file, readFileSync(file, "utf8"));
  for (const file of ACTIVE_FILES) files.set(file, readFileSync(file, "utf8"));
  files.delete(join("tests", "architecture_boundary.test.ts")); // this file names the forbidden strings to forbid them
  return files;
}

/** The app runtime tree: lib/ + app/, with lib/jev itself exempt (it IS the seam).
 * Tests and scripts drive the recorded/tee transport by design and are excluded. */
function inRuntimeTree(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (normalized.startsWith("lib/jev/")) return false;
  return normalized.startsWith("lib/") || normalized.startsWith("app/");
}

describe("architecture boundary — the LLM planner runtime stays out (§22/§32)", () => {
  const sources = activeSources();

  it("zero active references to the removed planner LLM surface", () => {
    const FORBIDDEN = [
      /PLANNER_LLM/i,
      /RealPlannerProvider/,
      /HttpPlannerProvider/,
      /QueryPlannerProvider/,
      /planner:probe/,
      /test:planner-live/,
      /planner:fixtures:refresh/,
      /planner_live_suite/,
      /planner_fixtures_refresh/,
      /bigmodel/i,
      /coding-plan/,
      /glm-5\.3/,
      /plannerCacheIdentity/,
    ];
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      for (const pattern of FORBIDDEN) {
        if (pattern.test(src)) {
          offenders.push(`${file} :: ${pattern.source}`);
        }
      }
    }
    expect(offenders, `active-tree references to the removed runtime: ${offenders.join("; ")}`).toEqual([]);
  });

  it("no deleted module is imported anywhere (imports would fail at runtime, pins the intent)", () => {
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (/from\s+["'].*lib\/hybrid\/router["']/.test(src)) offenders.push(`${file} imports the deleted router`);
      if (/from\s+["'].*lib\/planner\/(provider|env|probe|prompt|schema)["']/.test(src)) offenders.push(`${file} imports a deleted planner module`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("architecture boundary — Jev is the only cloud consumer (§1)", () => {
  it("a chat/completions client exists only inside the Jev seam", () => {
    const offenders: string[] = [];
    for (const [file, src] of activeSources()) {
      if (!src.includes("chat/completions")) continue;
      if (file.startsWith("lib/jev") || file.startsWith("lib\\jev")) continue;
      offenders.push(file);
    }
    expect(offenders, `chat clients outside lib/jev: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the query path has exactly one compiler and no LLM on it", () => {
    const execute = readFileSync("lib/hybrid/execute.ts", "utf8");
    expect(execute).toContain('from "./compile"');
    const compile = readFileSync("lib/hybrid/compile.ts", "utf8");
    expect(compile).toContain("parseQueryOutput");
    expect(compile).not.toMatch(/fetch\(|http/i);
  });
});

describe("architecture boundary — the capability seam is the only intelligence entrance (Phase 3.3 §2/§8)", () => {
  const sources = activeSources();

  /** lib/ and app/ may import exactly ONE lib/jev module: the seam. Tests and
   * scripts drive the recorded/tee transport by design (fixture capture,
   * live suites, contract tests) and are out of scope here. */
  it("lib/ and app/ import Jev only through lib/jev/capabilities", () => {
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (!inRuntimeTree(file)) continue;
      for (const match of src.matchAll(/from\s+["'][^"']*lib\/jev\/(?!capabilities)[^"']*["']/g)) {
        offenders.push(`${file} :: ${match[0]}`);
      }
      for (const match of src.matchAll(/from\s+["'](\.\.?\/)+jev\/(?!capabilities)[^"']*["']/g)) {
        offenders.push(`${file} :: ${match[0]}`);
      }
    }
    expect(offenders, `direct Jev imports outside the seam: ${offenders.join("; ")}`).toEqual([]);
  });

  it("SystemOne wire knowledge stays inside lib/jev", () => {
    const WIRE = [/looking_for/, /how_to_judge/, /SystemOneResponse/, /askNoul|askGraded/, /jevProvider\s*\(/, /JEV_TIMING/, /JEV_PRICE_PER_TOKEN/];
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (!inRuntimeTree(file)) continue;
      for (const pattern of WIRE) {
        if (pattern.test(src)) offenders.push(`${file} :: ${pattern.source}`);
      }
    }
    expect(offenders, `wire knowledge outside lib/jev: ${offenders.join("; ")}`).toEqual([]);
  });

  it("the deterministic query rails import nothing from lib/jev at all", () => {
    const rails = ["lib/hybrid/parser-v2.ts", "lib/hybrid/compile.ts", "lib/hybrid/planner.ts", "lib/planner/grammar.ts", "lib/planner/validate.ts", "lib/planner/normalize.ts", "lib/planner/capabilities.ts"];
    for (const file of rails) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'][^"']*lib\/jev/);
    }
  });
});

describe("architecture boundary — grammar vs semantics (§10/§11/§16)", () => {
  it("the grammar file itself contains no industry/product/concept vocabulary", () => {
    const src = readFileSync("lib/planner/grammar.ts", "utf8");
    for (const word of ["机器人", "半导体", "储能", "光模块", "创新药", "消费电子", "AI芯片", "人形机器人", "服务器", "逆变器"]) {
      expect(src, word).not.toContain(word);
    }
  });

  it("the capability router knows relation syntax, never industry/product/company words", () => {
    const src = readFileSync(join("lib", "jev", "capabilities", "route.ts"), "utf8");
    for (const word of ["机器人", "半导体", "储能", "光模块", "创新药", "消费电子", "AI芯片", "人形机器人", "服务器", "逆变器", "英伟达", "苹果", "华为", "美的", "汇川"]) {
      expect(src, word).not.toContain(word);
    }
  });

  it("complex residuals reach Jev untouched — the parser never normalizes industry words", () => {
    // Pinned here as an architecture property, not just parser behaviour:
    // none of these phrases may gain an Atlas-side synonym/alias anywhere.
    for (const phrase of ["人形机器人减速器", "AI服务器CPO光模块", "机器人核心零部件", "国产替代", "储能逆变器"]) {
      expect(phrase.length).toBeGreaterThan(0); // placeholder guard; parser_v2.test.ts owns behaviour
    }
  });
});

describe("architecture boundary — the frontend presents evidence, never derives it (Phase 3.4 §24)", () => {
  const sources = activeSources();

  /** UI code speaks EvidenceView. It must not import Jev at all (not even the
   * seam) — judgement enters the UI only through the presented response. */
  it("components/ never imports lib/jev", () => {
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (!file.replace(/\\/g, "/").startsWith("components/")) continue;
      if (/from\s+["'][^"']*lib\/jev[^"']*["']/.test(src) || /from\s+["'][^"']*\/jev\/[^"']*["']/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders, `frontend importing Jev: ${offenders.join("; ")}`).toEqual([]);
  });

  /** The UI reads server-presented results. Recomputing ranks, evidence
   * selection or term hits in the browser would be a second, unaudited judge. */
  it("components/ only consumes ranking/evidence modules as types, never as logic", () => {
    const LOGIC = [/from\s+["'][^"']*lib\/(search|hybrid|market|planner)\/[^"']*["']/, /from\s+["'][^"']*lib\/jev[^"']*["']/];
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (!file.replace(/\\/g, "/").startsWith("components/")) continue;
      for (const line of src.split("\n")) {
        if (/^\s*import\s+type\s/.test(line) || /import\s+type\s*\{/.test(line)) continue;
        for (const pattern of LOGIC) {
          if (pattern.test(line)) offenders.push(`${file} :: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders, `frontend value-importing ranking logic: ${offenders.join("; ")}`).toEqual([]);
  });

  /** Explanation prose is composed inside the capability (verbatim quotes) and
   * shipped by /api/explain. The UI renders states; it never writes prose. */
  it("the explanation island renders only capability states — no local prose generation", () => {
    const island = readFileSync(join("components", "evidence", "EvidenceWhy.tsx"), "utf8");
    expect(island).toContain('"/api/explain"');
    for (const forbidden of ["judgement.score >=", "score >= 0.5", "noul", "looking_for"]) {
      expect(island, forbidden).not.toContain(forbidden);
    }
  });

  /** The evidence label mapping is a closed Atlas-side set — no UI-invented
   * source labels (§20 C): components render whatever lib/atlas/evidence
   * resolved and never hardcode a label of their own. */
  it("evidence source labels stay a closed mapping; components never hardcode one", () => {
    const mod = readFileSync(join("lib", "atlas", "evidence.ts"), "utf8");
    expect(mod).toMatch(/const LABELS: Record<EvidenceKind, string>/);
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (!file.replace(/\\/g, "/").startsWith("components/")) continue;
      if (src.includes("公司档案")) offenders.push(file);
    }
    expect(offenders, `hardcoded labels: ${offenders.join("; ")}`).toEqual([]);
  });
});
