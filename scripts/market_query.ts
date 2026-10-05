/**
 * Market Query CLI — structured queries over the committed Market State.
 *
 * Usage:
 *   npm run market:query -- '<spec-json>'          e.g. '{"sort":{"field":"pct_change"}}'
 *   npm run market:query -- --preset Q1            canonical queries Q1–Q7
 *   npm run market:query -- --info                 layer status (no query)
 *   npm run market:query -- --json '<spec>'        machine-readable output
 *
 * Field names accept the task-sheet snake_case (pct_change / turnover_rate /
 * limit_up_streak / return_5d / return_20d / volume_ratio_20d …) as well as
 * the internal camelCase — aliasing lives in parseMarketQuerySpec. No LLM
 * anywhere: language understanding belongs to a later phase; this is the
 * deterministic fact layer it will call.
 */

import { parseMarketQuerySpec, runMarketQuery } from "../lib/market/query";
import { MARKET_FIELDS } from "../lib/market/contracts";
import type { MarketQuerySpec } from "../lib/market/contracts";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const info = args.includes("--info");
const presetIdx = args.indexOf("--preset");
const raw = args.find((a) => !a.startsWith("--"));

/** Canonical Phase 1 queries (task sheet §9), snake_case as specified. */
const PRESETS: Record<string, { text: string; spec: Record<string, unknown> }> = {
  Q1: { text: "今天领涨的公司", spec: { date: "LATEST_TRADING_DAY", sort: { field: "pct_change", direction: "desc" }, limit: 20 } },
  Q2: { text: "今天成交额最大的公司", spec: { date: "LATEST_TRADING_DAY", sort: { field: "amount", direction: "desc" }, limit: 20 } },
  Q3: { text: "今天成交量最大的公司", spec: { date: "LATEST_TRADING_DAY", sort: { field: "volume", direction: "desc" }, limit: 20 } },
  Q4: { text: "今天换手率最高的公司", spec: { date: "LATEST_TRADING_DAY", sort: { field: "turnover_rate", direction: "desc" }, limit: 20 } },
  Q5: {
    text: "连续三个涨停的公司",
    spec: {
      date: "LATEST_TRADING_DAY",
      filters: [{ field: "limit_up_streak", op: ">=", value: 3 }],
      sort: { field: "limit_up_streak", direction: "desc" },
      limit: 20,
    },
  },
  Q6: { text: "最近五个交易日涨幅最大的公司", spec: { date: "LATEST_TRADING_DAY", sort: { field: "return_5d", direction: "desc" }, limit: 20 } },
  Q7: { text: "最近二十个交易日涨幅最大的公司", spec: { date: "LATEST_TRADING_DAY", sort: { field: "return_20d", direction: "desc" }, limit: 20 } },
};

function printResult(result: ReturnType<typeof runMarketQuery>, label: string): void {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`\n== ${label} ==`);
  if (!result.available) {
    console.log(`UNAVAILABLE: ${result.reason}`);
    return;
  }
  console.log(
    `交易日 ${result.date.resolved}${result.date.requested === "LATEST_TRADING_DAY" ? " (LATEST_TRADING_DAY)" : ""} · 命中 ${result.count}/${result.total} · state ${result.provenance.stateDigest16}`,
  );
  const fmt = (v: number | boolean | null, digits = 2): string =>
    v === null ? "—" : typeof v === "boolean" ? (v ? "✓" : "·") : typeof v === "number" ? v.toFixed(digits) : String(v);
  const header = ["代码", "名称", "涨跌幅%", "收盘", "成交量(股)", "成交额(元)", "换手%", "涨停", "连板", "5d%", "20d%"];
  console.log(header.join(" | "));
  for (const r of result.rows) {
    console.log(
      [
        r.code,
        r.name,
        fmt(r.pctChange),
        fmt(r.close),
        String(r.volume),
        r.amount.toFixed(0),
        fmt(r.turnoverRate),
        fmt(r.isLimitUp),
        fmt(r.limitUpStreak, 0),
        fmt(r.return5d),
        fmt(r.return20d),
      ].join(" | "),
    );
  }
}

if (info) {
  const result = runMarketQuery({ sort: { field: "amount", direction: "desc" }, limit: 1 });
  if (result.available) {
    console.log(
      JSON.stringify(
        {
          latestTradingDay: result.latestTradingDay,
          tradingDays: result.provenance.tradingDays,
          stateDigest16: result.provenance.stateDigest16,
          dailySource: result.provenance.dailySource,
          quoteSource: result.provenance.quoteSource,
          fields: MARKET_FIELDS,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`UNAVAILABLE: ${result.reason}`);
  }
  process.exit(0);
}

let specInput: unknown;
let label = "Market Query";
if (presetIdx >= 0) {
  const key = args[presetIdx + 1]?.toUpperCase() ?? "";
  const preset = PRESETS[key];
  if (!preset) {
    console.error(`unknown preset ${key} — known: ${Object.keys(PRESETS).join(", ")}`);
    process.exit(1);
  }
  specInput = preset.spec;
  label = `${key} ${preset.text}`;
} else if (raw !== undefined) {
  try {
    specInput = JSON.parse(raw);
  } catch {
    console.error("spec is not valid JSON");
    process.exit(1);
  }
} else {
  specInput = {};
}

const parsed = parseMarketQuerySpec(specInput);
if ("error" in parsed) {
  console.error(`bad spec: ${parsed.error}`);
  process.exit(1);
}
printResult(runMarketQuery(parsed.spec as MarketQuerySpec), label);
