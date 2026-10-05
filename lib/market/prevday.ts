/**
 * Prev Trading Day snapshot (Phase 3 §10) — the deterministic data behind
 * day-over-day comparison eligibility (今天成交额比昨天高).
 *
 * Phase 3 must not touch the Market State artifact (its bytes are digest-pinned),
 * so the comparison reads the OBJECTIVE Market Data rows directly
 * (data/market/daily/<prev>.jsonl — vendor rows, never derived). The previous
 * trading day resolves from the state manifest's own tradingDays list, so
 * weekends and holidays are handled by construction.
 *
 * Isolation: read-only, cached per process, injectable for tests. A missing
 * previous day is an honest unavailability — never an approximation.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MarketStateManifest } from "./contracts";
import { loadMarketStateManifest, marketHistoryDirectory } from "./state";

/** The fields a day-over-day comparison may reference (capability registry). */
export type PrevDayRow = { amount: number; volume: number; close: number };

export type PrevDaySnapshot = {
  available: true;
  /** The trading day the comparison baseline resolves to. */
  date: string;
  byCode: Map<string, PrevDayRow>;
};

export type PrevDayOutcome = PrevDaySnapshot | { available: false; reason: string };

function loadDailyRows(date: string, manifest: MarketStateManifest): Map<string, PrevDayRow> | null {
  const file = path.join(marketHistoryDirectory(manifest), "daily", `${date}.jsonl`);
  if (!existsSync(file)) return null;
  const byCode = new Map<string, PrevDayRow>();
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as { code: string; amount: number; volume: number; close: number };
    byCode.set(row.code, { amount: row.amount, volume: row.volume, close: row.close });
  }
  return byCode;
}

/**
 * Resolve the previous trading day snapshot. `inject` replaces the committed
 * artifacts for deterministic tests (same shape as runMarketQuery's inject).
 */
export function loadPrevTradingDaySnapshot(
  inject?: { manifest?: MarketStateManifest | null; byCode?: Map<string, PrevDayRow> },
): PrevDayOutcome {
  if (inject?.byCode) {
    const date = inject.manifest?.latestTradingDay ?? "injected";
    const days = inject.manifest?.tradingDays ?? [];
    const idx = days.lastIndexOf(inject.manifest?.latestTradingDay ?? "");
    return { available: true, date: idx > 0 ? days[idx - 1] : date, byCode: inject.byCode };
  }
  const manifest = inject?.manifest !== undefined ? inject.manifest : loadMarketStateManifest();
  if (!manifest) return { available: false, reason: "Market State 尚未构建，无法解析上一交易日。" };
  const days = manifest.tradingDays;
  const idx = days.lastIndexOf(manifest.latestTradingDay);
  if (idx <= 0) return { available: false, reason: `交易日清单中没有 ${manifest.latestTradingDay} 的前一交易日，日环比不可用。` };
  const prev = days[idx - 1];
  const byCode = loadDailyRows(prev, manifest);
  if (!byCode) return { available: false, reason: `上一交易日 ${prev} 的 daily 盘后包缺失，日环比不可用。` };
  return { available: true, date: prev, byCode };
}

/** Deterministic comparison (§10): today.field op prev.field. Unknown on either
 * side never compares, never guesses — the row fails eligibility honestly. */
export function passesDayComparison(
  today: { amount: number; volume: number; close: number },
  comparison: { field: "amount" | "volume" | "close"; op: ">" | ">=" | "<" | "<=" },
  prev: PrevDayRow | undefined,
): boolean {
  if (!prev) return false;
  const left = today[comparison.field];
  const right = prev[comparison.field];
  switch (comparison.op) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
  }
}
