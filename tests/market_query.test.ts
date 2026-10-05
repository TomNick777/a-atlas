import { describe, expect, it } from "vitest";
import { parseMarketQuerySpec, runMarketQuery } from "../lib/market/query";
import { LATEST, TRADING_DAYS, deriveFixture, fixtureManifest } from "./fixtures/market_fixture";

/**
 * Market Query semantics + the seven canonical Phase 1 queries, answered from
 * the shared deterministic fixture (derive → query integration, no fs).
 * Expected orders are hand-computed; ties break by canonical code ascending,
 * nulls sort last in both directions and are excluded by comparisons.
 */

const manifest = fixtureManifest();
const { rows } = deriveFixture();
const inject = { manifest, rows };

function codes(result: Extract<ReturnType<typeof runMarketQuery>, { available: true }>): string[] {
  return result.rows.map((r) => r.code);
}

describe("market query — date resolution", () => {
  it("LATEST_TRADING_DAY resolves to the manifest's latest trading day, never the system date", () => {
    const result = runMarketQuery({ sort: { field: "pctChange", direction: "desc" } }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.date).toEqual({ requested: "LATEST_TRADING_DAY", resolved: LATEST });
    expect(result.latestTradingDay).toBe(LATEST); // a Monday after a weekend + fake holiday
  });

  it("an unmaterialized date is unavailable with the reason stated", () => {
    const result = runMarketQuery({ date: TRADING_DAYS[0] }, inject);
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain("未物化");
  });

  it("a missing state layer is unavailable, never falls back to live vendor calls", () => {
    const result = runMarketQuery({}, { manifest: null, rows: undefined });
    expect(result.available).toBe(false);
  });
});

describe("market query — canonical Phase 1 queries", () => {
  it("Q1 今天领涨: sort pctChange desc", () => {
    const result = runMarketQuery({ sort: { field: "pctChange", direction: "desc" }, limit: 20 }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    // +30 BSE, +20 STAR, +10 mainboard group (code tie-break), 9.9727, +5 group, +1.6529,
    // flat group, then the BSE limit-down (−29.91), then the null-pct row last.
    expect(codes(result)).toEqual([
      "920001", "688001", "000018", "000019", "600001", "600002",
      "000010", "000017", "600182", "600003", "000020", "000022", "300001", "920002", "000021",
    ]);
    const top = result.rows[0];
    expect(top.sortValue).toBe(30);
    expect(top.isLimitUp).toBe(true);
    expect(result.rows.find((r) => r.code === "000010")?.isLimitUp).toBe(false); // ST +5% is not a limit-up
  });

  it("Q2 今天成交额: sort amount desc", () => {
    const result = runMarketQuery({ sort: { field: "amount", direction: "desc" }, limit: 5 }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    // Fixture amounts: 000022's volume surge (8e8 × 7) tops the flat 1e6-lot stocks:
    // 688001: 1e6×60, 300001: 1e6×33, 600002: 1e6×16.1 …
    expect(codes(result)).toEqual(["000022", "688001", "300001", "920001", "600002"]);
    for (let i = 1; i < result.rows.length; i += 1) {
      expect(result.rows[i - 1].amount).toBeGreaterThanOrEqual(result.rows[i].amount);
    }
  });

  it("Q3 今天成交量: sort volume desc", () => {
    const result = runMarketQuery({ sort: { field: "volume", direction: "desc" }, limit: 3 }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(codes(result)).toEqual(["000022", "000010", "000017"]); // surge, then the 1e6 tie by code
    expect(result.rows[0].volume).toBe(800_000_000);
  });

  it("Q4 今天换手率: sort turnoverRate desc — snapshot values first, nulls last", () => {
    const result = runMarketQuery({ sort: { field: "turnoverRate", direction: "desc" }, limit: 20 }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.rows[0]).toMatchObject({ code: "600001", sortValue: 5.5 });
    expect(result.rows[1]).toMatchObject({ code: "600002", sortValue: 2.0 });
    const tail = result.rows.slice(2);
    expect(tail).toHaveLength(13); // 15 stocks − 2 with turnover
    expect(tail.every((r) => r.sortValue === null)).toBe(true);
    expect(tail.map((r) => r.code)).toEqual([...tail.map((r) => r.code)].sort()); // deterministic tie order
  });

  it("Q5 连续三个涨停: filter limitUpStreak >= 3, sort streak desc", () => {
    const result = runMarketQuery(
      {
        filters: [{ field: "limitUpStreak", op: ">=", value: 3 }],
        sort: { field: "limitUpStreak", direction: "desc" },
      },
      inject,
    );
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.total).toBe(2);
    expect(codes(result)).toEqual(["600002", "600001"]);
    expect(result.rows[0].limitUpStreak).toBe(5);
    expect(result.rows[1].limitUpStreak).toBe(3);
  });

  it("Q6 最近五个交易日涨幅: sort return5d desc", () => {
    const result = runMarketQuery({ sort: { field: "return5d", direction: "desc" }, limit: 20 }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(codes(result)).toEqual([
      "600002", "600001", "920001", "600003", "000018", "000019", "688001",
      "000010", "000017", "600182", "000020", "000021", "000022", "920002", "300001",
    ]);
    expect(result.rows[0].sortValue).toBeCloseTo(61.0, 4);
    // Insufficient history (in-window listing) sorts last, not 0.
    expect(result.rows[result.rows.length - 1].return5d).toBeNull();
  });

  it("Q7 最近二十个交易日涨幅: sort return20d desc", () => {
    const result = runMarketQuery({ sort: { field: "return20d", direction: "desc" }, limit: 20 }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(codes(result)).toEqual([
      "600002", "600001", "920001", "600003", "000018", "000019", "688001",
      "000010", "000017", "600182", "000020", "000021", "000022", "920002", "300001",
    ]);
  });
});

describe("market query — filters and honesty rules", () => {
  it("comparison filters exclude null rows (unknown is never compared)", () => {
    const result = runMarketQuery({ filters: [{ field: "pctChange", op: ">=", value: 10 }] }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.total).toBe(5);
    // 000021's pctChange is null (prevClose unusable) — excluded, not treated as 0.
    expect(result.rows.map((r) => r.code).sort()).toEqual(["000018", "000019", "600001", "688001", "920001"]);
  });

  it("boolean filters match only true; null and false are excluded", () => {
    const result = runMarketQuery({ filters: [{ field: "isLimitUp", op: "==", value: true }] }, inject);
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.total).toBe(7); // 5 limit-ups + 600002's 5-streak members… precisely: 600001/600002/920001/688001/600182/000018/000019
    expect(result.rows.every((r) => r.isLimitUp === true)).toBe(true);
  });

  it("sorting carries the real value on every row and is deterministic across runs", () => {
    const a = runMarketQuery({ sort: { field: "return5d", direction: "asc" } }, inject);
    const b = runMarketQuery({ sort: { field: "return5d", direction: "asc" } }, inject);
    expect(a).toEqual(b);
    if (!a.available) return;
    expect(a.rows[0].sortValue).toBe(a.rows[0].return5d);
    // asc: nulls still last
    expect(a.rows[a.rows.length - 1].return5d).toBeNull();
  });

  it("spec parsing rejects unknown fields, bad ops and out-of-range limits", () => {
    expect(parseMarketQuerySpec({ sort: { field: "kdj" } })).toHaveProperty("error");
    expect(parseMarketQuerySpec({ filters: [{ field: "pctChange", op: "~", value: 1 }] })).toHaveProperty("error");
    expect(parseMarketQuerySpec({ limit: 0 })).toHaveProperty("error");
    expect(parseMarketQuerySpec({ limit: 1000 })).toHaveProperty("error");
    expect(parseMarketQuerySpec({ date: "tomorrow" })).toHaveProperty("error");
    // snake_case aliases are accepted at the API boundary too
    expect(parseMarketQuerySpec({ sort: { field: "limit_up_streak", direction: "desc" } })).toHaveProperty("spec");
  });
});
