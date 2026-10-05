/**
 * Market State derivation — pure, deterministic, replayable.
 *
 * Everything here is a pure function of (trading-day window, day files, quote
 * file, company listing dates). No wall clock, no network: the same inputs
 * rebuild byte-identical state, which is what build_market_state.ts --check
 * pins. Unknown stays null; no field is ever interpolated or filled in.
 *
 * Definitions (pinned here and in the Phase 1 report §E):
 *   pctChange      (close/prevClose − 1)×100 on the package's own prevClose
 *   is_limit_up    traded (volume>0) and closed exactly at the computed limit
 *   limit_up_streak  consecutive market trading days ending at the target day
 *                  whose classification is is_limit_up === true; any missing
 *                  row, suspension (volume 0) or unknown-basis day stops the
 *                  chain; 0 when the target day itself is not limit-up
 *   return_5d/20d  close(target)/close(exactly 5/20 market trading days
 *                  earlier) − 1; null when either day has no row for the stock
 *   avg_volume_20d mean volume over the previous 20 *traded* rows (volume>0);
 *                  null when fewer than 20 exist in the window
 *   volume_ratio_20d  today's volume / avg_volume_20d; null when today did not
 *                  trade or the base is insufficient
 */

import type {
  LimitBasis,
  MarketDataRow,
  MarketQuoteFile,
  MarketStateRow,
} from "./contracts";
import { classifyLimit } from "./rules";

export type DeriveInput = {
  /** Ascending market trading days (the authoritative captured window). */
  tradingDays: string[];
  /** date → code → row, from data/market/daily/<date>.jsonl. */
  dayRows: Map<string, Map<string, MarketDataRow>>;
  /** Coherence-audited Tencent snapshot for the target date (turnover / mcap), or null. */
  quote: MarketQuoteFile | null;
  targetDate: string;
  /** code → listedAt (YYYY-MM-DD) from the company universe. */
  listedAt: Map<string, string | undefined>;
};

export type DeriveAudit = {
  limitBasisCounts: Record<string, number>;
  isLimitUpCount: number;
  isLimitDownCount: number;
  turnoverCoverage: number;
  snapshotLimitCrossCheck: {
    checked: number;
    limitUpMatchRate: number | null;
    limitDownMatchRate: number | null;
    mismatches: { code: string; kind: "up" | "down"; computed: number; snapshot: number }[];
  };
};

const LIMIT_PRICE_TOL = 0.005; // both sides are 2-decimal prices

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function parseIsoDateOrNull(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

export function buildDerivedState(input: DeriveInput): {
  rows: MarketStateRow[];
  jsonl: string;
  audit: DeriveAudit;
} {
  const { tradingDays, dayRows, quote, targetDate, listedAt } = input;
  const index = tradingDays.indexOf(targetDate);
  if (index < 0) throw new Error(`targetDate ${targetDate} is not in the captured trading-day window`);
  const windowStart = tradingDays[0];
  const targetRows = dayRows.get(targetDate);
  if (!targetRows) throw new Error(`no day file rows for ${targetDate}`);

  // Listing-day index per (code, date): 1-based among the stock's rows on/after
  // its listing date; null = established (predates the window, normal rules).
  // A missing listing date with the first observed row after the window start
  // is treated as a window IPO (day 1 = first observed row) — the conservative
  // fallback, since "unknown" beats "wrong" for the first listing days.
  const firstRowDate = new Map<string, string>();
  for (const [date, rows] of dayRows) {
    for (const code of rows.keys()) {
      const known = firstRowDate.get(code);
      if (!known || date < known) firstRowDate.set(code, date);
    }
  }
  const listingIndexCache = new Map<string, number | null>();
  function listingDayIndexAt(code: string, date: string): number | null {
    if (date !== targetDate) {
      // cheap path: only the target date and streak walks need it; streaks walk
      // backwards through the window, so compute on demand via the same logic
    }
    const key = `${code}|${date}`;
    const hit = listingIndexCache.get(key);
    if (hit !== undefined) return hit;
    const listed = parseIsoDateOrNull(listedAt.get(code));
    let result: number | null;
    if (listed && listed < windowStart) {
      result = null; // established
    } else if (listed) {
      if (date < listed) {
        result = null; // data quirk (row before declared listing) — treat as established
      } else {
        let n = 0;
        for (const d of tradingDays) {
          if (d < listed) continue;
          if (d > date) break;
          if (dayRows.get(d)?.has(code)) n += 1;
        }
        result = n >= 1 ? n : null;
      }
    } else {
      const first = firstRowDate.get(code);
      if (first && first > windowStart) {
        let n = 0;
        for (const d of tradingDays) {
          if (d > date) break;
          if (dayRows.get(d)?.has(code)) n += 1;
        }
        result = n >= 1 ? n : null;
      } else {
        result = null; // at the universe boundary with no listing reference
      }
    }
    listingIndexCache.set(key, result);
    return result;
  }

  const rows: MarketStateRow[] = [];
  const audit: DeriveAudit = {
    limitBasisCounts: {},
    isLimitUpCount: 0,
    isLimitDownCount: 0,
    turnoverCoverage: 0,
    snapshotLimitCrossCheck: { checked: 0, limitUpMatchRate: null, limitDownMatchRate: null, mismatches: [] },
  };
  let upChecked = 0;
  let upMatched = 0;
  let downChecked = 0;
  let downMatched = 0;

  const codes = [...targetRows.keys()].sort();
  for (const code of codes) {
    const row = targetRows.get(code)!;
    const dayIndex = listingDayIndexAt(code, targetDate);
    const { rule, limitUpPrice, limitDownPrice, isLimitUp, isLimitDown } = classifyLimit(row, dayIndex);

    const prev = row.prevClose;
    const pctChange = prev > 0 && row.close > 0 ? round((row.close / prev - 1) * 100, 4) : null;

    // --- limit-up streak -------------------------------------------------
    let limitUpStreak: number | null;
    if (isLimitUp === null) {
      limitUpStreak = null;
    } else if (!isLimitUp) {
      limitUpStreak = 0;
    } else {
      limitUpStreak = 1;
      for (let j = index - 1; j >= 0; j -= 1) {
        const prior = dayRows.get(tradingDays[j])?.get(code);
        if (!prior) break;
        const priorClass = classifyLimit(prior, listingDayIndexAt(code, tradingDays[j]));
        if (priorClass.isLimitUp !== true) break;
        limitUpStreak += 1;
      }
    }

    // --- window returns ---------------------------------------------------
    const closeAt = (back: number): number | null => {
      const j = index - back;
      if (j < 0) return null;
      return dayRows.get(tradingDays[j])?.get(code)?.close ?? null;
    };
    const base5 = closeAt(5);
    const return5d = base5 && row.close > 0 ? round((row.close / base5 - 1) * 100, 4) : null;
    const base20 = closeAt(20);
    const return20d = base20 && row.close > 0 ? round((row.close / base20 - 1) * 100, 4) : null;

    // --- traded-volume aggregates (previous 20 traded rows) ---------------
    let avgVolume20d: number | null = null;
    let avgAmount20d: number | null = null;
    let volumeRatio20d: number | null = null;
    let vSum = 0;
    let aSum = 0;
    let n = 0;
    for (let j = index - 1; j >= 0 && n < 20; j -= 1) {
      const prior = dayRows.get(tradingDays[j])?.get(code);
      if (!prior || !(prior.volume > 0)) continue;
      vSum += prior.volume;
      aSum += prior.amount;
      n += 1;
    }
    if (n === 20) {
      avgVolume20d = round(vSum / 20, 2);
      avgAmount20d = round(aSum / 20, 2);
      if (row.volume > 0) volumeRatio20d = round(row.volume / (vSum / 20), 4);
    }

    const quoteRow = quote?.rows[code] ?? null;
    const turnoverRate = quoteRow?.turnoverPct ?? null;
    const marketCapYi = quoteRow?.marketCapYi ?? null;
    if (turnoverRate !== null) audit.turnoverCoverage += 1;

    // --- snapshot cross-check (audit only, never feeds classification) ----
    if (quoteRow && !quoteRow.stale) {
      if (limitUpPrice !== null && quoteRow.limitUp !== null) {
        upChecked += 1;
        if (Math.abs(limitUpPrice - quoteRow.limitUp) <= LIMIT_PRICE_TOL) upMatched += 1;
        else if (audit.snapshotLimitCrossCheck.mismatches.length < 20)
          audit.snapshotLimitCrossCheck.mismatches.push({ code, kind: "up", computed: limitUpPrice, snapshot: quoteRow.limitUp });
      }
      if (limitDownPrice !== null && quoteRow.limitDown !== null) {
        downChecked += 1;
        if (Math.abs(limitDownPrice - quoteRow.limitDown) <= LIMIT_PRICE_TOL) downMatched += 1;
        else if (audit.snapshotLimitCrossCheck.mismatches.length < 20)
          audit.snapshotLimitCrossCheck.mismatches.push({ code, kind: "down", computed: limitDownPrice, snapshot: quoteRow.limitDown });
      }
    }

    audit.limitBasisCounts[rule.basis] = (audit.limitBasisCounts[rule.basis] ?? 0) + 1;
    if (isLimitUp === true) audit.isLimitUpCount += 1;
    if (isLimitDown === true) audit.isLimitDownCount += 1;

    rows.push({
      code,
      close: row.close,
      volume: row.volume,
      amount: row.amount,
      pctChange,
      limitBasis: rule.basis as LimitBasis,
      limitUpPrice,
      limitDownPrice,
      isLimitUp,
      isLimitDown,
      limitUpStreak,
      return5d,
      return20d,
      avgVolume20d,
      avgAmount20d,
      volumeRatio20d,
      turnoverRate,
      marketCapYi,
    });
  }

  audit.snapshotLimitCrossCheck.checked = upChecked + downChecked;
  audit.snapshotLimitCrossCheck.limitUpMatchRate = upChecked ? round(upMatched / upChecked, 5) : null;
  audit.snapshotLimitCrossCheck.limitDownMatchRate = downChecked ? round(downMatched / downChecked, 5) : null;

  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  return { rows, jsonl, audit };
}
