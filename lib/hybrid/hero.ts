/**
 * Hero metric formatting (§9) — one formatter per market field, shared by the
 * CLI, the API and the card canvas. Labels and units follow the Market State
 * contract: amount in 元, volume in 股, marketCapYi already in 亿元.
 */

import type { MarketField } from "../market/contracts";
import type { HeroMetric } from "./contracts";

export const HERO_LABELS: Record<MarketField, string> = {
  pctChange: "涨跌幅",
  close: "价格",
  volume: "成交量",
  amount: "成交额",
  turnoverRate: "换手率",
  marketCapYi: "总市值",
  isLimitUp: "涨停",
  isLimitDown: "跌停",
  limitUpStreak: "连板",
  return5d: "5日涨幅",
  return20d: "20日涨幅",
  avgVolume20d: "20日均量",
  avgAmount20d: "20日均额",
  volumeRatio20d: "20日相对成交量",
  limitUpPrice: "涨停价",
  limitDownPrice: "跌停价",
};

const signedPct = (v: number): string => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

export function formatHeroValue(key: MarketField, value: number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  switch (key) {
    case "pctChange":
    case "return5d":
    case "return20d":
      return signedPct(value);
    case "turnoverRate":
      return `${value.toFixed(2)}%`;
    case "volumeRatio20d":
      return `${value.toFixed(2)}倍`;
    case "limitUpStreak":
      return `${value}连板`;
    case "amount":
      return value >= 1e8 ? `${(value / 1e8).toFixed(2)}亿` : `${(value / 1e4).toFixed(0)}万`;
    case "volume":
      return value >= 1e8 ? `${(value / 1e8).toFixed(2)}亿股` : value >= 1e4 ? `${(value / 1e4).toFixed(0)}万股` : `${value}股`;
    case "marketCapYi":
      return `${value.toFixed(value >= 100 ? 0 : 1)}亿`;
    case "close":
    case "limitUpPrice":
    case "limitDownPrice":
      return `${value.toFixed(2)}元`;
    default:
      return String(value);
  }
}

export function heroMetricOf(key: MarketField, value: number | boolean | null): HeroMetric {
  return { key, label: HERO_LABELS[key], value, formatted: formatHeroValue(key, value) };
}

/** One-line display: avoid the「连板5连板」double-unit when the formatted value
 * already embeds the label's word. */
export function heroText(hero: HeroMetric | null | undefined): string {
  if (!hero) return "";
  if (hero.formatted.includes(hero.label) || hero.label.includes(hero.formatted)) return hero.formatted;
  return `${hero.label}${hero.formatted}`;
}
