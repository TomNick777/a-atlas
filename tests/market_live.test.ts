import { describe, expect, it } from "vitest";
import { marketAvailability } from "../lib/market/session";
import { fixtureManifest } from "./fixtures/market_fixture";
import type { MarketStateManifest } from "../lib/market/contracts";
import { runHybridQuery } from "../lib/hybrid/execute";

function live(stamp = "20261008100000"): MarketStateManifest {
  return {...fixtureManifest(), latestTradingDay: "2026-10-08", runtime: {
    mode: "quote", snapshotId: "fixture-live", historySnapshotId: null,
    source: "fixture", tradeDate: "2026-10-08", phase: "morning", startedAt: "2026-10-08T10:00:00+08:00", endedAt: "2026-10-08T10:00:01+08:00",
    sourceTimeMin: stamp, sourceTimeMax: stamp, collectionSeconds: 1, counts: {VALID: 2}, coverage: 1, policy: {maxSourceAgeSeconds: 120, refreshSeconds: 60},
  }};
}
const at = (s: string) => new Date(`2026-10-08T${s}+08:00`);
describe("source-clock safety at the Web boundary", () => {
  it("does not substitute 20-day relative volume for an unverified native volume ratio", async () => {
    const answer = await runHybridQuery("今天量比最高的公司", {skipJev: true, log: false});
    expect(answer.results).toEqual([]);
    expect(answer.execution.degradedReason).toContain("基准尚未核验");
    expect(answer.intelligence).toBeNull();
  });
  it("accepts current quotes but refuses expired quotes even if file was just fetched", () => {
    expect(marketAvailability(live(), at("10:01:00")).reason).toBeNull();
    expect(marketAvailability(live(), at("10:02:01")).reason).toContain("过期");
  });
  it("holds lunch and auction pause clocks, and requires source time after close", () => {
    expect(marketAvailability(live("20261008113000"), at("12:45:00")).reason).toBeNull();
    expect(marketAvailability(live("20261008092500"), at("09:29:00")).reason).toBeNull();
    expect(marketAvailability(live("20261008145900"), at("15:30:00")).reason).toContain("收盘");
    expect(marketAvailability(live("20261008150000"), at("15:30:00")).reason).toBeNull();
  });
  it("rejects a source date mismatch and missing time", () => {
    expect(marketAvailability(live("20260930161500"), at("10:00:00")).reason).toContain("不一致");
    expect(marketAvailability(live(""), at("10:00:00")).reason).toContain("缺失");
  });
});
