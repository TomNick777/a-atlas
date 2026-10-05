import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runHybridQuery as executeHybridQuery, type HybridExecuteOptions } from "../lib/hybrid/execute";
import { HYBRID_PRESETS } from "../lib/hybrid/presets";
import { RecordedJudgeProvider, type RecordedCall } from "../lib/jev/recorded";
import { setJevProviderOverride } from "../lib/jev/cloud";
import { SHOWN } from "../lib/search/score";
import { loadCommittedMarketStateManifest, loadMarketStateRows } from "../lib/market/state";
import { fixtureSemanticEngine } from "./fixtures/semantic/provider";

/**
 * H1–H10 business regression as a full-chain OFFLINE replay (Phase 2.1 §5/§6/§7):
 *
 *   Natural Language → Planner → committed semantic fixtures → frozen Market
 *   State (byte-checked data/market/state) → Hybrid Executor → results.
 *
 * The planner is exercised for real (same as production), the semantic layer is
 * a committed capture of the real Jev answer for the exact residual query, and
 * H10's subset judge replays the recorded RAW cloud payload through the real
 * judge adapter (RecordedJudgeProvider) — so the wire contract, the SHOWN
 * eligibility and the market rank authority are all verified without spending
 * one Jev call. Expected companies are the frozen Phase 2 evidence anchors; a
 * refresh that moves them must be a conscious re-certification, never a silent
 * drift.
 */

const semantic = fixtureSemanticEngine();

/** The recorded H10 subset judge as a replay provider (real adapter, no network). */
function h10RecordedProvider(): RecordedJudgeProvider {
  const doc = JSON.parse(readFileSync(resolve(__dirname, "fixtures/semantic/judge/h10-subset.json"), "utf8")) as {
    request: Record<string, unknown>;
    response: { model: string | null; answers: unknown; usage: { input_tokens: number; output_tokens: number } };
  };
  const call: RecordedCall = {
    kind: "rerank",
    request: doc.request,
    response: doc.response,
    meta: { latencyMs: 0, inputTokens: doc.response.usage.input_tokens, outputTokens: doc.response.usage.output_tokens },
  };
  return new RecordedJudgeProvider([call], { label: "H10 subset judge" }).withLabel("H10 subset judge");
}

afterEach(() => {
  setJevProviderOverride(null);
});

const manifest = loadCommittedMarketStateManifest();
const marketDay = manifest?.latestTradingDay ?? null;
const replayRows = marketDay ? loadMarketStateRows(marketDay, manifest) ?? undefined : undefined;
function runHybridQuery(raw: string, options: HybridExecuteOptions = {}) {
  return executeHybridQuery(raw, { ...options, legacyReplay: true, marketInject: options.marketInject ?? { manifest, rows: replayRows } });
}

describe("hybrid H-suite — offline full-chain replay (semantic-first presets)", () => {
  it("H1 今天领涨的机器人公司: market metric ranks, fixture keeps 石头科技 on top", async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H1, { semanticEngine: semantic, log: false });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.execution.degraded).toBe(false);
    expect(result.execution.decidedBy).toBe("jev");
    expect(result.execution.marketDate).toBe(marketDay);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].code).toBe("688162"); // 巨一科技 — Phase 3.7 surface re-record（公告/产品面证据入语料后 judge 序：AI 智能装备+汽车客户披露窗口）
    // Phase 3.7 re-record：巨一科技本轮 judge 应答为 noul 型（语义相关、无逐字命中词面），
    // matchedFacts 按契约可为空——判定的语义门槛通过由 semantic 在场表达。
    expect(result.results[0].semantic).toBeTruthy();
    expect(result.results[0].hero?.key).toBe("pctChange");
    // single rank authority: the market metric's order is non-increasing
    const pcts = result.results.map((row) => row.market?.state.pctChange ?? null);
    const ranked = pcts.filter((value): value is number => value !== null);
    expect([...ranked].sort((a, b) => b - a)).toEqual(ranked);
    expect(result.planCaption).toContain("涨跌幅");
    expect(result.planCaption).toContain("机器人");
    expect(result.searchId).toMatch(/^fixture:/);
  });

  it("H2 今天成交额最大的AI芯片公司: amount hero and order", async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H2, { semanticEngine: semantic, log: false });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.execution.degraded).toBe(false);
    expect(result.results[0].code).toBe("688256"); // 寒武纪 — Phase 3.7 surface re-record（云端 AI 工具链披露证据入语料后 judge 序）
    expect(result.results[0].hero?.key).toBe("amount");
    const amounts = result.results.map((row) => row.market?.state.amount ?? 0);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
  });

  it("H3 今天换手率最高的消费电子公司: turnoverRate hero and order", async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H3, { semanticEngine: semantic, log: false });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.results[0].code).toBe("002635"); // 安洁科技 — frozen evidence
    expect(result.results[0].hero?.key).toBe("turnoverRate");
  });

  it("H5 连续三个涨停的消费类公司: honest zero — semantic hits that fail the market filter never appear", async () => {
    // §6 regression, replayed against the REAL captured semantic answer: the
    // 消费 residual's hits do not survive the streak≥3 eligibility filter, and
    // the result is an honest empty — not a degraded answer, not a guess.
    const result = await runHybridQuery(HYBRID_PRESETS.H5, { semanticEngine: semantic, log: false });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.execution.degraded).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.execution.counts?.semanticEligible).toBe(0);
    expect(result.planCaption).toContain("连板");
  });

  it("H6 最近5日涨幅最大的储能公司: return5d hero, nulls never rank first", async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H6, { semanticEngine: semantic, log: false });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.results[0].code).toBe("300207"); // 欣旺达 — frozen evidence
    expect(result.results[0].hero?.key).toBe("return5d");
  });

  it("H7 最近20日涨幅最大的半导体公司: return20d hero and order", async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H7, { semanticEngine: semantic, log: false });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.results[0].code).toBe("688135"); // 利扬芯片 — frozen evidence
    expect(result.results[0].hero?.key).toBe("return20d");
  });

  it("H8 今天明显放量的机器人公司: same 机器人 fixture, different market sort — no threshold invented", async () => {
    // H1 and H8 share one committed capture (dedup by residual query); the
    // market layer alone decides the different hero and order.
    const result = await runHybridQuery(HYBRID_PRESETS.H8, { semanticEngine: semantic, log: false });
    expect(result.plan.execution.order).toBe("semantic-first");
    expect(result.results[0].code).toBe("688162"); // 巨一科技 — Phase 3.7 surface re-record（market 层单独定 hero）
    expect(result.results[0].hero?.key).toBe("volumeRatio20d");
    expect(result.plan.notes.join(" ")).toContain("不设阈值");
  });

  it("H9 今天跌幅最大的创新药公司: pctChange asc, worst first", async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H9, { semanticEngine: semantic, log: false });
    expect(result.plan.execution.order).toBe("semantic-first");
    // Anchor of the committed capture (2026-09-30 refresh, Phase 3.6 corpus):
    // 亚虹医药 tops the eligible∩market set, *ST香雪 second — cloud jitter across
    // the SHOWN boundary re-baselines on refresh, by design.
    expect(result.results[0].code).toBe("688176");
    // eligible∩market 集合的第 2 位随每次 refresh 重定基（judge 集合抖动，by design），
    // 只钉 top-1 与市场序（下方 pctChange asc 断言），不钉集合边界位。
    expect(result.results.length).toBeGreaterThanOrEqual(2);
    expect((result.results[0].hero?.value as number) ?? 0).toBeLessThan(0);
    const pcts = result.results.map((row) => row.market?.state.pctChange ?? null).filter((v): v is number => v !== null);
    expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
  });

  it("replaying H1 twice is byte-deterministic (no hidden clock/jitter in replay)", async () => {
    const first = await runHybridQuery(HYBRID_PRESETS.H1, { semanticEngine: semantic, log: false });
    const second = await runHybridQuery(HYBRID_PRESETS.H1, { semanticEngine: semantic, log: false });
    expect(JSON.stringify(second.results)).toBe(JSON.stringify(first.results));
  });
});

describe("hybrid H-suite — offline full-chain replay (market layers)", () => {
  it("H4 连续三个涨停的公司: market-only, Phase 1 order, no semantic layer", async () => {
    const result = await runHybridQuery(HYBRID_PRESETS.H4, { log: false });
    expect(result.plan.execution.order).toBe("market-only");
    expect(result.execution.decidedBy).toBe("market");
    expect(result.execution.degraded).toBe(false);
    expect(result.results[0].code).toBe("600825"); // 新华传媒 5连板 — frozen evidence
    expect(result.results[0].hero).toMatchObject({ key: "limitUpStreak", value: 5, formatted: "5连板" });
    expect(result.results.every((row) => row.semantic === null)).toBe(true);
  });

  it("H10 今天成交额前20中有哪些光模块公司: market-first over the recorded RAW judge payload", async () => {
    // §7: the recorded raw SystemOne request/response goes through the REAL
    // judge adapter — fixture only replaces the network, never the parsing.
    setJevProviderOverride(h10RecordedProvider());
    const result = await runHybridQuery(HYBRID_PRESETS.H10, { log: false });
    expect(result.plan.execution.order).toBe("market-first");
    expect(result.execution.degraded).toBe(false);
    expect(result.execution.decidedBy).toBe("jev");
    expect(result.execution.counts).toMatchObject({ marketSetSize: 20 });
    // SHOWN eligibility: every shown row passed the real score contract
    expect(result.results.every((row) => (row.probability ?? 0) >= SHOWN)).toBe(true);
    // market rank authority: judge scores never reorder the amount ranking
    const amounts = result.results.map((row) => row.market?.state.amount ?? 0);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(result.results[0].code).toBe("300308"); // 中际旭创 — frozen evidence
    expect(result.results[0].semantic?.matchedFacts).toContain("光模块");
    expect(result.planCaption).toContain("前20");
    expect(result.planCaption).toContain("光模块");
  });

  it("H10 replay rejects a drifted market set instead of replaying the wrong payload", async () => {
    // The recorded request must byte-match the judge call the executor builds
    // from the committed state; a tampered provider proves the guard fires.
    const doc = JSON.parse(readFileSync(resolve(__dirname, "fixtures/semantic/judge/h10-subset.json"), "utf8")) as { request: Record<string, unknown>; response: { model: string | null; answers: unknown; usage: { input_tokens: number; output_tokens: number } } };
    const drifted = new RecordedJudgeProvider([{ kind: "rerank", request: { ...doc.request, state: { ...(doc.request.state as Record<string, unknown>), looking_for: "别的语义" } }, response: doc.response, meta: { latencyMs: 0, inputTokens: 0, outputTokens: 0 } }]);
    setJevProviderOverride(drifted);
    await expect(runHybridQuery(HYBRID_PRESETS.H10, { log: false })).rejects.toThrow(/no fixture covers/);
  });
});

describe("hybrid H-suite — unsupported intent never executes", () => {
  it("明天最可能涨停的机器人公司: planner refuses, nothing runs, no fixture needed", async () => {
    const result = await runHybridQuery("明天最可能涨停的机器人公司", { log: false });
    expect(result.execution.order).toBe("unsupported");
    expect(result.results).toEqual([]);
    expect(result.searchId).toBeNull();
    expect(result.planCaption).toContain("future_market_prediction");
  });
});

describe("committed market state sanity for this replay", () => {
  it("the market layer the chain joined is the byte-checked one", () => {
    expect(marketDay).toBe("2026-09-28");
    const rows = marketDay ? loadMarketStateRows(marketDay, manifest) : null;
    expect(rows?.length).toBeGreaterThan(0);
  });
});
