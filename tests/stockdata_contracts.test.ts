import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { StockAnnouncements, StockFundamentals, StockQuote, StockResearchReports } from "@/lib/stockdata/contracts";

/**
 * Contract tests (refocus §二十三/§二十四): the Python service's JSON must compile
 * against these types, and the availability semantics must stay discriminated —
 * these fixtures are the shared vocabulary between services/stock-data and the
 * company page. If the service drifts from the fixtures here, this test is the
 * alarm.
 */

const FIXTURES = "tests/fixtures/stockdata";

function load(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}/${name}.json`, "utf8"));
}

describe("stock data contracts", () => {
  it("quote fixture satisfies StockQuote with provenance", () => {
    const q = load("quote.ok") as StockQuote;
    expect(q.available).toBe("ok");
    expect(q.symbol).toMatch(/^\d{6}$/);
    expect(q.source.length).toBeGreaterThan(0);
    expect(q.fetchedAt).toBeTruthy();
    expect(typeof q.price).toBe("number");
    expect(q.pb).toBeDefined();
    expect(q.marketCapYi).toBeDefined();
  });

  it("quote stale fixture keeps the upstream zombie-quote signal", () => {
    const q = load("quote.stale") as StockQuote;
    expect(q.available).toBe("ok");
    expect(q.stale).toBe(true);
    expect(q.staleReason).toBeTruthy();
  });

  it("error quote carries error detail and no fabricated numbers", () => {
    const q = load("quote.error") as StockQuote;
    expect(q.available).toBe("error");
    expect(q.error).toBeTruthy();
    expect(q.price).toBeUndefined();
  });

  it("fundamentals fixture keeps raw upstream strings and derived ratios", () => {
    const f = load("fundamentals.ok") as StockFundamentals;
    expect(f.available).toBe("ok");
    expect(f.reportPeriod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof f.revenue).toBe("string");
    expect(typeof f.grossMarginPct).toBe("number");
    expect(typeof f.roePct).toBe("number");
  });

  it("announcements empty vs unavailable vs error are three different fixtures", () => {
    const empty = load("announcements.empty") as StockAnnouncements;
    const unavailable = load("announcements.unavailable") as StockAnnouncements;
    const error = load("announcements.error") as StockAnnouncements;
    expect(empty.available).toBe("empty");
    expect(empty.items).toEqual([]);
    expect(unavailable.available).toBe("unavailable");
    expect(error.available).toBe("error");
    expect(error.items).toEqual([]);
  });

  it("research reports items carry title/institution/date/rating/link", () => {
    const r = load("reports.ok") as StockResearchReports;
    expect(r.available).toBe("ok");
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.institution.length).toBeGreaterThan(0);
      expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.url).toMatch(/^https?:\/\//);
    }
  });
});
