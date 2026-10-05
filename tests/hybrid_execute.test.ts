import { describe, expect, it } from "vitest";
import { runHybridQuery as runCurrentHybridQuery, type HybridExecuteOptions } from "../lib/hybrid/execute";
const runHybridQuery = (raw: string, options: HybridExecuteOptions = {}) => runCurrentHybridQuery(raw, { ...options, legacyReplay: true });
import type { SemanticOutcome, SubsetScores } from "../lib/hybrid/execute";
import { LATEST, TRADING_DAYS, deriveFixture, fixtureManifest } from "./fixtures/market_fixture";
import type { MarketStateRow } from "../lib/market/contracts";

/**
 * Execution modes (Phase 2 §E) on the shared deterministic market fixture, with
 * the semantic layer injected (§17 offline replay). Expected orders are
 * hand-computed from the fixture table; rank authority is asserted per mode —
 * market sorts are never silently reordered by semantic scores.
 */

const manifest = fixtureManifest();
const { rows } = deriveFixture();
const rowOf = (code: string): MarketStateRow => rows.find((row) => row.code === code)!;

/** Minimal company stand-ins for the fixture codes — the executor reads only
 * identity + text fields for evidence and constraint zeroing. */
const fakeCompanies = rows.map((row) => ({
  code: row.code,
  name: row.code,
  fullName: row.code,
  exchange: row.code.startsWith("6") ? "SH" : /^(4|8|9)/.test(row.code) ? "BJ" : "SZ",
  board: "main",
  industry: "测试行业",
  swLevel1Industry: "测试SW",
  businessDescription: `${row.code}的主营业务`,
  mainProducts: [],
  concepts: [],
  region: { province: "测试省", city: "" },
  companyDescription: "",
  searchableText: `${row.code} ${row.code}的主营业务 光模块 储能`,
  judgeText: `${row.code} 测试 judge text`,
  marketCap: 100,
})) as unknown as import("../lib/types").Company[];

const marketInject = { manifest, rows, companies: fakeCompanies };

function engine(hits: Array<[string, number]>, matches = hits.length, extra: Partial<SemanticOutcome> = {}) {
  const names: Record<string, string> = Object.fromEntries(rows.map((row) => [row.code, row.code]));
  return (): SemanticOutcome => ({
    hits: hits.map(([code, probability]) => ({
      code,
      name: names[code] ?? code,
      probability,
      industry: "t",
      swLevel1Industry: "t",
      province: "t",
      business: "t",
    })),
    matches,
    searchId: "test-search",
    degraded: false,
    decidedBy: "jev",
    judgeOutcome: "ok",
    ...extra,
  });
}

const scorer =
  (scores: Array<[string, number]>, live = true): ((query: string) => SubsetScores) =>
  () => ({ scores: scores.map(([, score]) => score), live, model: live ? "test-model" : null, outcome: live ? "ok" : "no_config" });

describe("hybrid execution — semantic-only", () => {
  it("passes the raw query through unchanged and attaches no market data", async () => {
    const result = await runHybridQuery("做伺服电机的公司", {
      semanticEngine: engine(
        [
          ["600001", 0.9],
          ["600002", 0.8],
          ["000010", 0.2],
        ],
        2,
      ),
    });
    expect(result.plan.execution.order).toBe("semantic-only");
    expect(result.results.map((row) => row.code)).toEqual(["600001", "600002"]);
    expect(result.results.every((row) => row.market === null && row.hero === null)).toBe(true);
    expect(result.planCaption).toBe("");
    expect(result.searchId).toBe("test-search");
  });

  it("eligibility follows the existing matchCount contract (hits beyond matches are dropped)", async () => {
    const result = await runHybridQuery("做伺服电机的公司", { semanticEngine: engine([["600001", 0.9], ["600002", 0.5], ["000010", 0.2]], 2) });
    expect(result.results).toHaveLength(2);
  });
});

describe("hybrid execution — market-only", () => {
  it("今天成交额最大的公司 matches Phase 1 runMarketQuery byte for byte in ordering", async () => {
    const result = await runHybridQuery("今天成交额最大的公司", { marketInject });
    expect(result.plan.execution.order).toBe("market-only");
    expect(result.execution.decidedBy).toBe("market");
    expect(result.execution.marketDate).toBe(LATEST);
    const expected = [...rows].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0) || (a.code < b.code ? -1 : 1)).slice(0, 20).map((row) => row.code);
    expect(result.results.map((row) => row.code)).toEqual(expected);
    expect(result.results[0].hero?.key).toBe("amount");
    expect(result.results[0].hero?.formatted).not.toBe("—");
    // market-only identity comes from the slim universe — no semantic layer claims
    expect(result.results[0].swLevel1Industry).toBeNull();
    expect(result.results[0].semantic).toBeNull();
    expect(result.planCaption).toContain("全市场");
  });

  it("Q5-style streak query keeps the streak hero and streak order", async () => {
    const result = await runHybridQuery("连续三个涨停的公司", { marketInject });
    expect(result.results[0].code).toBe("600002"); // 5-day streak tops the 3-day ones
    expect(result.results[0].hero).toMatchObject({ key: "limitUpStreak", value: 5, formatted: "5连板" });
  });

  it("a missing state layer answers unavailable instead of guessing", async () => {
    const result = await runHybridQuery("今天成交额最大的公司", { marketInject: { manifest: null, rows: undefined } });
    expect(result.execution.degraded).toBe(true);
    expect(result.execution.degradedReason).toContain("尚未构建");
    expect(result.results).toEqual([]);
  });
});

describe("hybrid execution — semantic-first", () => {
  it("今天领涨的机器人公司: market metric ranks, semantic score only breaks ties", async () => {
    const result = await runHybridQuery("今天领涨的机器人公司", {
      marketInject,
      // 920001 +30% (BSE limit-up), 600001 +9.97%, 000010 +5% — semantic order deliberately reversed
      semanticEngine: engine([["600001", 0.9], ["920001", 0.85], ["000010", 0.8]]),
    });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.results.map((row) => row.code)).toEqual(["920001", "600001", "000010"]);
    expect(result.results[0].hero).toMatchObject({ key: "pctChange", value: 30, formatted: "+30.00%" });
    expect(result.results[0].market?.tradeDate).toBe(LATEST);
    expect(result.planCaption).toContain("涨跌幅");
    expect(result.planCaption).toContain("机器人");
  });

  it("null metric rows sort last in both directions (Phase 1 nulls semantics)", async () => {
    // 000021 辰数据 has pctChange null on the latest day (unusable prevClose)
    const result = await runHybridQuery("今天领涨的机器人公司", {
      marketInject,
      semanticEngine: engine([["000021", 0.95], ["600001", 0.5]]),
    });
    expect(result.results.map((row) => row.code)).toEqual(["600001", "000021"]);
    expect(result.results[1].hero?.value).toBeNull();
    expect(result.results[1].hero?.formatted).toBe("—");
  });

  it("20日跌幅 asc ranks the worst first and keeps nulls last", async () => {
    const result = await runHybridQuery("最近20日跌幅最大的机器人公司", {
      marketInject,
      semanticEngine: engine([["920002", 0.9], ["600002", 0.6], ["300001", 0.5]]),
    });
    // 920002 庚农业 10.03 → 7.03 (−29.9% over the window) is the worst;
    // 300001 辛生物 listed 4 days ago — return20d is null and sorts last.
    expect(result.results[0].code).toBe("920002");
    expect(result.results[0].hero?.key).toBe("return20d");
    expect(result.results[result.results.length - 1].hero?.value).toBeNull();
  });

  it("semantic-first + streak filter DROPS hits that fail the market filter (eligibility, not nulls-last)", async () => {
    // 600002 streak 5, 600001 streak 3, 300001 streak 0 — the last must not appear.
    const result = await runHybridQuery("连续三个涨停的机器人公司", {
      marketInject,
      semanticEngine: engine([["300001", 0.95], ["600002", 0.8], ["600001", 0.7]]),
    });
    expect(result.results.map((row) => row.code)).toEqual(["600002", "600001"]);
    expect(result.execution.counts?.semanticEligible).toBe(2);
    expect(result.results.every((row) => row.hero?.key === "limitUpStreak")).toBe(true);
  });

  it("ties on the market metric break by semantic score, then canonical code", async () => {
    // 000010 and 600182 both close +5% (ST and S-share regimes)
    const result = await runHybridQuery("今天领涨的机器人公司", {
      marketInject,
      semanticEngine: engine([["000010", 0.4], ["600182", 0.9]]),
    });
    expect(result.results.map((row) => row.code)).toEqual(["600182", "000010"]);
    const same = await runHybridQuery("今天领涨的机器人公司", {
      marketInject,
      semanticEngine: engine([["000010", 0.4], ["600182", 0.9]]),
    });
    expect(JSON.stringify(same.results)).toBe(JSON.stringify(result.results)); // deterministic replay
  });
});

describe("hybrid execution — market-first", () => {
  it("今天成交额前20中有哪些光模块公司: market picks the set, judge filters, market keeps order", async () => {
    const result = await runHybridQuery("今天成交额前20中有哪些光模块公司", {
      marketInject,
      subsetScorer: scorer([
        ["000022", 0.9],
        ["600001", 0.1],
      ]),
    });
    expect(result.plan.execution.order).toBe("market-first");
    expect(result.execution.counts).toMatchObject({ marketSetSize: 15, semanticEligible: 1 });
    expect(result.results.map((row) => row.code)).toEqual(["000022"]);
    expect(result.results[0].semantic?.score).toBe(0.9);
    expect(result.results[0].hero?.key).toBe("amount");
    // market order, not judge order: the row's amount is the rank evidence
    expect(result.results[0].market?.state.amount).toBe(rowOf("000022").amount);
    expect(result.planCaption).toContain("前20");
    expect(result.planCaption).toContain("光模块");
  });

  it("multiple matches stay in market order even when the judge ranks them differently", async () => {
    const result = await runHybridQuery("今天成交额前20中有哪些光模块公司", {
      marketInject,
      subsetScorer: scorer([
        ["600001", 0.5],
        ["000022", 0.9],
      ]),
    });
    const amounts = result.results.map((row) => row.market?.state.amount ?? 0);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(result.execution.counts?.semanticEligible).toBe(2);
  });

  it("below-SHOWN scores are ineligible — no FEWEST clamp on a filter question", async () => {
    const result = await runHybridQuery("今天成交额前20中有哪些光模块公司", {
      marketInject,
      subsetScorer: scorer([["000022", 0.2]]),
    });
    expect(result.results).toEqual([]);
    expect(result.execution.counts?.semanticEligible).toBe(0);
  });

  it("a judge outage degrades honestly onto the deterministic blend, never a second judge", async () => {
    const result = await runHybridQuery("今天成交额前20中有哪些光模块公司", {
      marketInject,
      subsetScorer: scorer([["000022", 0.9]], false),
    });
    expect(result.execution.degraded).toBe(true);
    expect(result.execution.degradedReason).toBe("no_config");
    expect(result.execution.decidedBy).toBe("retrieval");
  });

  it("an unmaterialized date in the market layer answers unavailable", async () => {
    const result = await runHybridQuery("今天成交额前20中有哪些光模块公司", {
      marketInject: { manifest: { ...manifest, latestTradingDay: TRADING_DAYS[0], materializedDates: [] }, rows: [] },
    });
    expect(result.execution.degraded).toBe(true);
    expect(result.results).toEqual([]);
  });
});

describe("hybrid execution — unsupported intent", () => {
  it("nothing executes and the reason is carried back", async () => {
    const result = await runHybridQuery("明天最可能涨停的机器人公司", {});
    expect(result.execution.order).toBe("unsupported");
    expect(result.results).toEqual([]);
    expect(result.planCaption).toContain("future_market_prediction");
    expect(result.searchId).toBeNull();
  });
});

describe("hybrid execution — timings (§19)", () => {
  it("reports parser/semantic/market/merge/total segments", async () => {
    const result = await runHybridQuery("今天领涨的机器人公司", { marketInject, semanticEngine: engine([["920001", 0.9]]) });
    expect(result.execution.timings.parserMs).toBeGreaterThanOrEqual(0);
    expect(result.execution.timings.semanticMs).toBeGreaterThanOrEqual(0);
    expect(result.execution.timings.marketMs).toBeNull(); // semantic-first joins the committed state lazily
    expect(result.execution.timings.mergeMs).toBeGreaterThanOrEqual(0);
    expect(result.execution.timings.totalMs).toBeGreaterThanOrEqual(result.execution.timings.parserMs);
  });
});
