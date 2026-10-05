/**
 * Limit-up / limit-down classification — deterministic exchange rules, never a
 * pct_change threshold.
 *
 * Price limit = prevClose × (1 ± ratio), rounded to 0.01 元 with the rounding
 * mode the exchange regime actually applies. Both the mode and the ratios were
 * calibrated against this dataset's own closes over the captured window (see
 * reports/MARKET_STATE_PHASE1/REPORT.md §E — calibration evidence, not
 * convention):
 *
 *   mainboard (60x/00x, ST/*ST included)  10%  HALF-UP
 *     ST/*ST on mainboard carry the same 10% in this regime: 158 in-window
 *     closes sit exactly on the 10% limit and none beyond it (max +10.465%
 *     close proves HALF-UP); the historical 5% ST rule does NOT apply here.
 *   S-prefixed mainboard (未股改, S佳通 600182)  5%  HALF-UP
 *   ChiNext (30x) / STAR (68x)            20%  HALF-UP (+20.01% sealed closes)
 *   BSE (92x)                             30%  rounded INWARD: limit-up =
 *     floor(prev×1.3), limit-down = ceil(prev×0.7) — both sides match the
 *     snapshot on 345/345 BSE rows and no close ever exceeds the exact product
 *
 * All arithmetic is integer-cents: float multiplication like 124.05 × 1.1 =
 * 136.45500000000001 would make rounding decisions float-dependent.
 *
 * Special listing phases (no reliable limit → unknown, never guessed):
 *   STAR / ChiNext: first 5 listing days no limit
 *   mainboard since 2023-04-10 (registration regime): first 5 days no limit;
 *     before that, day 1 carried +44% / −36% vs the issue price
 *   BSE: day 1 no limit, day 2 onwards 30%
 *   delisting-period names (退): arrangements differ → unknown
 */

import type { LimitRule, MarketDataRow } from "./contracts";

/** 2023-04-10: first mainboard registration-regime listings (5 no-limit days). */
const MAINBOARD_REGISTRATION_START = "2023-04-10";

type Board = "mainboard" | "star" | "chinext" | "bj";

export function boardOf(market: MarketDataRow["market"], code: string): Board {
  if (market === "bj") return "bj";
  if (market === "sh") return code.startsWith("68") ? "star" : "mainboard";
  return code.startsWith("30") ? "chinext" : "mainboard";
}

/** 未股改 S-share (S佳通-style): mainboard names starting with a bare "S". */
export function isUnreformedSName(name: string): boolean {
  return name.startsWith("S") && !name.includes("ST");
}

export function isDelistingName(name: string): boolean {
  return name.includes("退");
}

/** Exact HALF-UP round of (cents × num / den) to an integer cent. */
function mulHalfUp(cents: number, num: number, den: number): number {
  const n = cents * num;
  return Math.floor((2 * n + den) / (2 * den));
}

/** Exact TRUNCATE (toward zero) of (cents × num / den) to an integer cent. */
function mulTruncate(cents: number, num: number, den: number): number {
  return Math.floor((cents * num) / den);
}

/** Exact CEILING of (cents × num / den) to an integer cent. */
function mulCeil(cents: number, num: number, den: number): number {
  const n = cents * num;
  return Math.floor((n + den - 1) / den);
}

function toCents(price: number): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.round(price * 100);
}

/**
 * Limit rule for one stock-day.
 *
 * @param row            the day's own package row (name = day-of-truth)
 * @param listingDayIndex 1-based index of this day among the stock's listing
 *                       window days (counted from listedAt; null when the
 *                       stock predates the data window)
 */
export function limitRuleFor(row: MarketDataRow, listingDayIndex: number | null): LimitRule {
  if (!(row.prevClose > 0)) return { known: false, basis: "unknown_no_prev_close" };
  if (isDelistingName(row.name)) return { known: false, basis: "unknown_delisting_period" };

  const board = boardOf(row.market, row.code);

  // No-limit listing windows first — they override every board ratio.
  if (listingDayIndex !== null && listingDayIndex <= 5 && listingDayIndex >= 1) {
    if (board === "star" || board === "chinext") {
      return { known: false, basis: "unknown_no_limit_first_days" };
    }
    if (board === "mainboard" && row.date >= MAINBOARD_REGISTRATION_START) {
      return { known: false, basis: "unknown_no_limit_first_days" };
    }
    if (board === "bj" && listingDayIndex === 1) {
      return { known: false, basis: "unknown_no_limit_first_day" };
    }
  }
  if (board === "mainboard" && listingDayIndex === 1 && row.date < MAINBOARD_REGISTRATION_START) {
    return { known: true, basis: "mainboard_ipo_d1", ratioUpPct: 44, ratioDownPct: 36 };
  }

  if (board === "mainboard") {
    if (isUnreformedSName(row.name)) {
      return { known: true, basis: "s_mainboard5", ratioUpPct: 5, ratioDownPct: 5 };
    }
    return { known: true, basis: "mainboard10", ratioUpPct: 10, ratioDownPct: 10 };
  }
  if (board === "star") return { known: true, basis: "star20", ratioUpPct: 20, ratioDownPct: 20 };
  if (board === "chinext") return { known: true, basis: "chinext20", ratioUpPct: 20, ratioDownPct: 20 };
  return { known: true, basis: "bj30", ratioUpPct: 30, ratioDownPct: 30 };
}

/** Exact limit prices (2-decimal 元) for a known rule, else nulls.
 * limit = prevClose × (1 ± pct/100) in integer cents. BSE rounds inward
 * (up: floor, down: ceil); every other board rounds HALF-UP both sides. */
export function limitPricesFor(rule: LimitRule, prevClose: number): { up: number | null; down: number | null } {
  const cents = toCents(prevClose);
  if (!rule.known || cents === null) return { up: null, down: null };
  if (rule.basis === "bj30") {
    const up = mulTruncate(cents, 100 + rule.ratioUpPct, 100);
    const down = mulCeil(cents, 100 - rule.ratioDownPct, 100);
    return { up: up / 100, down: down / 100 };
  }
  const up = mulHalfUp(cents, 100 + rule.ratioUpPct, 100);
  const down = mulHalfUp(cents, 100 - rule.ratioDownPct, 100);
  return { up: up / 100, down: down / 100 };
}

/** is_limit_up / is_limit_down for one stock-day: traded today (volume>0) and
 * closed exactly at the computed limit. A known rule always yields a boolean —
 * a suspended day (volume 0) did not close at the limit, which is false, not
 * unknown. Unknown stays reserved for regimes the rules cannot classify. */
export function classifyLimit(
  row: MarketDataRow,
  listingDayIndex: number | null,
): { rule: LimitRule; limitUpPrice: number | null; limitDownPrice: number | null; isLimitUp: boolean | null; isLimitDown: boolean | null } {
  const rule = limitRuleFor(row, listingDayIndex);
  const prices = limitPricesFor(rule, row.prevClose);
  const traded = row.volume > 0;
  const up = rule.known && prices.up !== null ? traded && row.close === prices.up : null;
  const down = rule.known && prices.down !== null ? traded && row.close === prices.down : null;
  return { rule, limitUpPrice: prices.up, limitDownPrice: prices.down, isLimitUp: up, isLimitDown: down };
}
