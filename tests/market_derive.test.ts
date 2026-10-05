import { describe, expect, it } from "vitest";
import type { MarketStateRow } from "../lib/market/contracts";
import { LATEST, QUOTE, STOCKS, TRADING_DAYS, deriveFixture } from "./fixtures/market_fixture";

/**
 * Deterministic derivation semantics over the shared synthetic market
 * (tests/fixtures/market_fixture.ts). Every expected number is hand-computed
 * from the fixture tables; nothing is derived at test time.
 */

function rowOf(rows: MarketStateRow[], code: string): MarketStateRow {
  const row = rows.find((r) => r.code === code);
  if (!row) throw new Error(`fixture row ${code} missing`);
  return row;
}

describe("market derive — limit-up streak", () => {
  const { rows } = deriveFixture();

  it("counts consecutive limit-ups across weekends and holidays", () => {
    // Days 25,26,27,28,29 with the 2026-09-02 holiday and two weekends inside.
    expect(rowOf(rows, "600002").limitUpStreak).toBe(5);
    expect(rowOf(rows, "600002").isLimitUp).toBe(true);
  });

  it("resets to 0 when the latest day is not a limit-up", () => {
    expect(rowOf(rows, "600003").limitUpStreak).toBe(0);
  });

  it("a suspension (volume 0) breaks the chain", () => {
    expect(rowOf(rows, "000018").limitUpStreak).toBe(1);
  });

  it("a missing row breaks the chain", () => {
    expect(rowOf(rows, "000019").limitUpStreak).toBe(1);
  });

  it("unknown limit state today → unknown streak, never 0", () => {
    expect(rowOf(rows, "300001").limitUpStreak).toBeNull();
    expect(rowOf(rows, "000017").limitUpStreak).toBeNull();
  });
});

describe("market derive — classification against the calibrated regime", () => {
  const { rows } = deriveFixture();

  it("ST mainboard at +5% is NOT a limit-up (10% regime)", () => {
    const r = rowOf(rows, "000010");
    expect(r.isLimitUp).toBe(false);
    expect(r.limitUpPrice).toBe(11);
    expect(r.limitBasis).toBe("mainboard10");
  });

  it("S-share 5% limit-up is recognized", () => {
    expect(rowOf(rows, "600182").isLimitUp).toBe(true);
  });

  it("BSE floor limit-up and ceil limit-down", () => {
    expect(rowOf(rows, "920001").isLimitUp).toBe(true);
    expect(rowOf(rows, "920001").limitUpPrice).toBe(26);
    expect(rowOf(rows, "920002").isLimitDown).toBe(true);
    expect(rowOf(rows, "920002").limitDownPrice).toBe(7.03); // ceil(10.03 × 0.7 = 7.021)
  });

  it("in-window ChiNext listing: first 5 days unknown, never guessed", () => {
    const r = rowOf(rows, "300001");
    expect(r.limitBasis).toBe("unknown_no_limit_first_days");
    expect(r.isLimitUp).toBeNull();
    expect(r.isLimitDown).toBeNull();
  });

  it("unusable prevClose → pctChange null and unknown limit", () => {
    const r = rowOf(rows, "000021");
    expect(r.pctChange).toBeNull();
    expect(r.limitBasis).toBe("unknown_no_prev_close");
    expect(r.limitUpStreak).toBeNull();
  });
});

describe("market derive — window returns", () => {
  const { rows } = deriveFixture();

  it("return_5d uses the close exactly 5 trading days earlier (not calendar days)", () => {
    // idx 29 − 5 = idx 24 ("2026-08-28"), close 10.00 for both stocks.
    expect(rowOf(rows, "600002").return5d).toBeCloseTo(61.0, 4);
    expect(rowOf(rows, "600001").return5d).toBeCloseTo(33.1, 4);
  });

  it("return_20d uses the close 20 trading days earlier", () => {
    expect(rowOf(rows, "600002").return20d).toBeCloseTo(61.0, 4);
    expect(rowOf(rows, "688001").return20d).toBeCloseTo(20.0, 4);
  });

  it("missing reference row → null (no interpolation)", () => {
    // 300001 listed at idx 25: no rows at idx 24 or idx 9.
    expect(rowOf(rows, "300001").return5d).toBeNull();
    expect(rowOf(rows, "300001").return20d).toBeNull();
  });
});

describe("market derive — traded-volume aggregates", () => {
  it("volume_ratio_20d skips zero-volume days in the base and needs 20 traded rows", () => {
    const latest = deriveFixture().rows;
    // Base: previous 20 traded rows (zero-volume idx 5-9 skipped, reaching back to idx 4), all volume 1000; today 3000.
    expect(rowOf(latest, "000020").avgVolume20d).toBe(1000);
    expect(rowOf(latest, "000020").volumeRatio20d).toBe(3);

    // At idx 24 only 19 traded rows precede (idx 23..10 = 14, idx 4..0 = 5) → null.
    const earlier = deriveFixture(TRADING_DAYS[24]).rows;
    expect(rowOf(earlier, "000020").volumeRatio20d).toBeNull();
    expect(rowOf(earlier, "000020").avgVolume20d).toBeNull();
  });

  it("in-window listing has fewer than 20 traded rows → null, never fabricated", () => {
    const { rows } = deriveFixture();
    expect(rowOf(rows, "300001").volumeRatio20d).toBeNull();
    expect(rowOf(rows, "300001").avgVolume20d).toBeNull();
  });

  it("suspended today (volume 0) → no ratio", () => {
    const stocks = STOCKS.map((s) => (s.code === "600003" ? { ...s, volumes: { 29: 0 } } : s));
    const { rows } = deriveFixture(LATEST, stocks);
    expect(rowOf(rows, "600003").volumeRatio20d).toBeNull();
  });
});

describe("market derive — quote enrichment and serialization", () => {
  it("turnover/market cap come only from the snapshot; missing rows stay null", () => {
    const { rows, audit } = deriveFixture();
    expect(rowOf(rows, "600001").turnoverRate).toBe(5.5);
    expect(rowOf(rows, "600001").marketCapYi).toBe(120.5);
    expect(rowOf(rows, "600002").turnoverRate).toBe(2.0);
    expect(rowOf(rows, "000020").turnoverRate).toBeNull();
    expect(audit.turnoverCoverage).toBe(2);
  });

  it("no snapshot (historical materialization) → turnover null everywhere", () => {
    const { rows } = deriveFixture(LATEST, STOCKS, null);
    expect(rows.every((r) => r.turnoverRate === null && r.marketCapYi === null)).toBe(true);
  });

  it("rows serialize deterministically: code-sorted JSONL with trailing newline", () => {
    const { jsonl } = deriveFixture();
    const lines = jsonl.split("\n");
    expect(lines[lines.length - 1]).toBe("");
    const codes = lines.slice(0, -1).map((l) => (JSON.parse(l) as MarketStateRow).code);
    expect(codes).toEqual([...codes].sort());
    expect(deriveFixture().jsonl).toBe(jsonl);
  });
});
