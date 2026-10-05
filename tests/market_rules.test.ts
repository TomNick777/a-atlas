import { describe, expect, it } from "vitest";
import type { MarketDataRow } from "../lib/market/contracts";
import { boardOf, classifyLimit, limitPricesFor, limitRuleFor } from "../lib/market/rules";

/**
 * Limit classification tests. Every expected price below is hand-computed with
 * exact decimal arithmetic, and the calibrated cases (ST=10% on mainboard, BSE
 * inward rounding, HALF-UP edges) come from the 60-day real-window calibration
 * documented in reports/MARKET_STATE_PHASE1/REPORT.md §E.
 */

function row(overrides: Partial<MarketDataRow> & { code: string; market: MarketDataRow["market"] }): MarketDataRow {
  return {
    date: "2026-09-28",
    name: "测试股",
    prevClose: 10,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: 1000,
    amount: 10000,
    ...overrides,
  };
}

describe("market rules — board detection", () => {
  it("maps code prefix + market to the four boards", () => {
    expect(boardOf("sh", "600519")).toBe("mainboard");
    expect(boardOf("sh", "688981")).toBe("star");
    expect(boardOf("sz", "000001")).toBe("mainboard");
    expect(boardOf("sz", "300750")).toBe("chinext");
    expect(boardOf("bj", "920885")).toBe("bj");
  });
});

describe("market rules — HALF-UP limit prices (mainboard / chinext / star)", () => {
  it("mainboard 10%: matches exchange rounding on real calibrated prices", () => {
    // 深物业A 2026-09-28: prev 9.20 → limit 10.12 (sealed at +10.02%)
    expect(limitPricesFor(limitRuleFor(row({ code: "000011", market: "sz", prevClose: 9.2 }), null), 9.2).up).toBe(10.12);
    // HALF-UP edge the banker's rounding would get wrong: 124.05 × 1.1 = 136.455
    expect(limitPricesFor(limitRuleFor(row({ code: "002463", market: "sz", prevClose: 124.05 }), null), 124.05).up).toBe(136.46);
    // 贵州茅台-scale price: 1243.88 × 1.1 = 1368.268 → 1368.27
    expect(limitPricesFor(limitRuleFor(row({ code: "600519", market: "sh", prevClose: 1243.88 }), null), 1243.88).up).toBe(1368.27);
    expect(limitPricesFor(limitRuleFor(row({ code: "600519", market: "sh", prevClose: 1243.88 }), null), 1243.88).down).toBe(1119.49); // 1119.492
  });

  it("chinext/star 20%: +20.01% sealed closes prove HALF-UP", () => {
    const rule = limitRuleFor(row({ code: "301190", market: "sz", prevClose: 20.79 }), null);
    expect(rule).toMatchObject({ known: true, basis: "chinext20", ratioUpPct: 20 });
    expect(limitPricesFor(rule, 20.79).up).toBe(24.95); // 20.79 × 1.2 = 24.948 → 24.95 (pct = +20.01%)
    const star = limitRuleFor(row({ code: "688244", market: "sh", prevClose: 16.5 }), null);
    expect(limitPricesFor(star, 16.5).up).toBe(19.8);
  });

  it("S-share (未股改) mainboard carries 5%", () => {
    const rule = limitRuleFor(row({ code: "600182", market: "sh", name: "S佳通", prevClose: 12.59 }), null);
    expect(rule).toMatchObject({ known: true, basis: "s_mainboard5", ratioUpPct: 5 });
    expect(limitPricesFor(rule, 12.59).up).toBe(13.22);
  });
});

describe("market rules — BSE inward rounding", () => {
  it("limit-up is floor(prev×1.3), limit-down is ceil(prev×0.7)", () => {
    const rule = limitRuleFor(row({ code: "920885", market: "bj", prevClose: 12.26 }), null);
    expect(rule).toMatchObject({ known: true, basis: "bj30", ratioUpPct: 30 });
    // 12.26 × 1.3 = 15.938 → floor 15.93 (HALF-UP would wrongly give 15.94)
    expect(limitPricesFor(rule, 12.26).up).toBe(15.93);
    // 12.26 × 0.7 = 8.582 → ceil 8.59 (HALF-UP would wrongly give 8.58)
    expect(limitPricesFor(rule, 12.26).down).toBe(8.59);
    // exact products round exactly
    expect(limitPricesFor(limitRuleFor(row({ code: "920001", market: "bj", prevClose: 20 }), null), 20).up).toBe(26);
  });
});

describe("market rules — classification", () => {
  it("marks limit-up only when traded and closed exactly at the computed limit", () => {
    const r = row({ code: "000011", market: "sz", prevClose: 9.2, close: 10.12, high: 10.12 });
    expect(classifyLimit(r, null).isLimitUp).toBe(true);
    expect(classifyLimit({ ...r, close: 10.11 }, null).isLimitUp).toBe(false);
    // suspended day: carried close below the limit anyway, but volume gate is explicit
    expect(classifyLimit({ ...r, volume: 0, close: 9.2 }, null).isLimitUp).toBe(false);
  });

  it("ST on mainboard carries 10% in this regime (60-day calibration)", () => {
    // Real calibration: ST海王 2026-07-06 prev 1.49 closed 1.64 = exactly ×1.1.
    const r = row({ code: "000078", market: "sz", name: "ST海王", prevClose: 1.49, close: 1.64 });
    const { rule, isLimitUp } = classifyLimit(r, null);
    expect(rule).toMatchObject({ known: true, basis: "mainboard10", ratioUpPct: 10 });
    expect(isLimitUp).toBe(true);
  });

  it("delisting-period names classify as unknown", () => {
    const { rule, isLimitUp } = classifyLimit(row({ code: "000017", market: "sz", name: "辛退", prevClose: 2, close: 2.2 }), null);
    expect(rule).toMatchObject({ known: false, basis: "unknown_delisting_period" });
    expect(isLimitUp).toBeNull();
  });

  it("unusable prevClose classifies as unknown, never 0%", () => {
    const { rule, isLimitUp, limitUpPrice } = classifyLimit(row({ code: "600001", market: "sh", prevClose: 0 }), null);
    expect(rule).toMatchObject({ known: false, basis: "unknown_no_prev_close" });
    expect(isLimitUp).toBeNull();
    expect(limitUpPrice).toBeNull();
  });
});

describe("market rules — special listing phases", () => {
  const listedRow = (day: number) => row({ code: "301001", market: "sz", date: `2026-09-${String(day).padStart(2, "0")}` });

  it("ChiNext/STAR first 5 listing days have no reliable limit → unknown", () => {
    for (const day of [1, 5]) {
      const { rule, isLimitUp } = classifyLimit(listedRow(day), day);
      expect(rule).toMatchObject({ known: false, basis: "unknown_no_limit_first_days" });
      expect(isLimitUp).toBeNull();
    }
    const day6 = classifyLimit(listedRow(6), 6);
    expect(day6.rule).toMatchObject({ known: true, basis: "chinext20" });
  });

  it("mainboard registration-regime listings (≥2023-04-10): first 5 days unknown", () => {
    const { rule } = classifyLimit(row({ code: "601091", market: "sh", date: "2026-09-22" }), 4);
    expect(rule).toMatchObject({ known: false, basis: "unknown_no_limit_first_days" });
  });

  it("pre-registration mainboard day 1 carried +44%/−36%, day 2+ normal", () => {
    const old = row({ code: "600001", market: "sh", date: "2023-03-01" });
    const d1 = classifyLimit(old, 1);
    expect(d1.rule).toMatchObject({ known: true, basis: "mainboard_ipo_d1", ratioUpPct: 44, ratioDownPct: 36 });
    expect(limitPricesFor(d1.rule, 10).up).toBe(14.4);
    expect(limitPricesFor(d1.rule, 10).down).toBe(6.4);
    const d2 = classifyLimit(old, 2);
    expect(d2.rule).toMatchObject({ known: true, basis: "mainboard10" });
  });

  it("BSE day 1 unknown, day 2+ 30%", () => {
    expect(classifyLimit(row({ code: "920100", market: "bj" }), 1).rule).toMatchObject({ known: false, basis: "unknown_no_limit_first_day" });
    expect(classifyLimit(row({ code: "920100", market: "bj" }), 2).rule).toMatchObject({ known: true, basis: "bj30" });
  });

  it("established stocks (null listing index) never enter a listing window", () => {
    expect(classifyLimit(row({ code: "600519", market: "sh" }), null).rule).toMatchObject({ known: true, basis: "mainboard10" });
  });
});
