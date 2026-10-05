/** Exchange calendar, independent of which vendor files happen to exist. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MarketStateManifest } from "./contracts";

export type TradingCalendar = {
  year: number;
  validFrom: string;
  validThrough: string;
  sources: Record<"SH" | "SZ" | "BJ", string>;
  closedRanges: [string, string][];
  weekendsClosed: boolean;
};

export type DailyMarketSession = {
  calendarDate: string;
  phase: "closed" | "preopen" | "intraday" | "afterclose";
  targetDate: string | null;
  reason: string | null;
};

export function loadTradingCalendar(year: number): TradingCalendar | null {
  const file = path.join(process.cwd(), "data", "market-calendar", `${year}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as TradingCalendar;
}

export function dailyMarketSession(now = new Date(), calendar?: TradingCalendar | null): DailyMarketSession {
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const date = local.toISOString().slice(0, 10);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const cal = calendar === undefined ? loadTradingCalendar(local.getUTCFullYear()) : calendar;
  const unknown = { calendarDate: date, phase: "closed" as const, targetDate: null, reason: `交易日历未覆盖 ${date}，不能确定目标交易日。` };
  if (!cal || date < cal.validFrom || date > cal.validThrough || !cal.sources.SH || !cal.sources.SZ || !cal.sources.BJ) return unknown;
  const isTrading = (day: string) => {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    return !(cal.weekendsClosed && (weekday === 0 || weekday === 6)) && !cal.closedRanges.some(([start, end]) => day >= start && day <= end);
  };
  const trading = isTrading(date);
  const phase = !trading ? "closed" : minutes < 555 ? "preopen" : minutes < 900 ? "intraday" : "afterclose";
  let target = date;
  if (!trading || phase === "preopen") {
    do {
      target = new Date(new Date(`${target}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
      // Never infer holidays across an unverified year boundary.
      if (target < cal.validFrom) return unknown;
    } while (!isTrading(target));
  }
  return { calendarDate: date, phase, targetDate: target, reason: null };
}

/** M1 provides EOD facts only. Intraday queries must wait for M2, never reuse yesterday. */
export function dailyMarketAvailability(latest: string, now = new Date(), calendar?: TradingCalendar | null): { session: DailyMarketSession; reason: string | null } {
  const session = dailyMarketSession(now, calendar);
  const reason = session.reason ?? (session.phase === "intraday"
    ? `目标交易日 ${session.targetDate} 正在交易；当前仅有盘后行情，尚不能提供当天排行（已有 ${latest}）。`
    : latest !== session.targetDate
      ? `目标交易日 ${session.targetDate} 的收盘行情尚未更新（已有 ${latest}）。请运行 npm run market:refresh。`
      : null);
  return { session, reason };
}

export function dailyMarketCaption(date: string): string {
  const session = dailyMarketSession();
  if (session.targetDate !== date) return `交易日 ${date}`;
  return session.phase === "closed" ? `今日休市 · ${date} 收盘` : session.phase === "preopen" ? `尚未开盘 · ${date} 收盘` : `${date} 收盘`;
}

export function marketAvailability(manifest: MarketStateManifest, now = new Date()): { reason: string | null } {
  if (!manifest.runtime) return dailyMarketAvailability(manifest.latestTradingDay, now);
  const current = dailyMarketSession(now);
  const runtime = manifest.runtime;
  if (current.reason) return {reason: current.reason};
  if (runtime.tradeDate !== current.targetDate) return {reason: `目标交易日 ${current.targetDate} 的行情快照尚未就绪（已有 ${runtime.tradeDate}）。`};
  const stamp = runtime.sourceTimeMin;
  if (!/^\d{14}$/.test(stamp)) return {reason: "行情源端时间缺失，不能提供排行。"};
  const sourceTime = new Date(`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}+08:00`);
  if (!Number.isFinite(sourceTime.getTime()) || stamp.slice(0,8) !== runtime.tradeDate.replaceAll("-", "")) return {reason: "行情源端日期不一致，不能提供排行。"};
  const local = new Date(now.getTime() + 8*3600000);
  const minute = local.getUTCHours()*60 + local.getUTCMinutes();
  if (current.phase !== "intraday") {
    if (Number(stamp.slice(8,10))*60 + Number(stamp.slice(10,12)) < 900) return {reason: "当前快照尚未达到收盘时点，收盘榜单未就绪。"};
  } else {
    let anchor = now.getTime();
    if (minute >= 690 && minute < 780) anchor -= ((minute - 690)*60 + local.getUTCSeconds())*1000;
    if (minute >= 565 && minute < 570) anchor -= ((minute - 565)*60 + local.getUTCSeconds())*1000;
    if (anchor - sourceTime.getTime() > runtime.policy.maxSourceAgeSeconds*1000) return {reason: "行情源端时间已过期，正在等待有效快照；不使用旧榜单。"};
  }
  return {reason: null};
}

export function marketSnapshotCaption(manifest: MarketStateManifest): string {
  const runtime = manifest.runtime;
  const rows = manifest.perDate[manifest.latestTradingDay]?.rows ?? 0;
  const count = manifest.inputs.universeCount;
  if (!runtime) return `${dailyMarketCaption(manifest.latestTradingDay)} · 可用行情 ${rows}/${count}`;
  const current = dailyMarketSession();
  const hhmmss = (s: string) => `${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}`;
  const label = current.phase === "closed" ? "今日休市" : current.phase === "preopen" ? "尚未开盘" : current.phase === "afterclose" ? "收盘" : "日内快照";
  const noTrades = runtime.counts.NO_TRADES ?? 0;
  const missing = count - rows - noTrades;
  return `${label} · ${runtime.tradeDate} · 源端 ${hhmmss(runtime.sourceTimeMin)}–${hhmmss(runtime.sourceTimeMax)} · 采集 ${runtime.collectionSeconds.toFixed(1)}秒 · 可排行 ${rows}/${count} · 无成交 ${noTrades}${missing ? ` · 缺失/异常 ${missing}` : ""} · ${runtime.source}`;
}
