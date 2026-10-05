import { afterEach, describe, expect, it, vi } from "vitest";
const snapshot = vi.hoisted(() => ({ date: "2026-09-30", digest: "snapshot-a" }));
vi.mock("../lib/companies", () => ({ loadDataset: () => ({ version: "corpus-fixture" }) }));
vi.mock("../lib/jev/capabilities", () => ({ judgeCacheIdentity: () => "judge-fixture", MARKET_ELIGIBILITY_VERSION: "market-eligibility-1" }));
vi.mock("../lib/market/state", () => ({ loadMarketStateManifest: () => ({ latestTradingDay: snapshot.date, contentDigest: { value: snapshot.digest } }) }));
import { discoverCacheKey } from "../lib/atlas/discoverCache";

describe("market answer cache invalidation", () => {
  afterEach(() => { vi.useRealTimers(); snapshot.digest = "snapshot-a"; });
  it("invalidates a same-day answer when content changes", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T04:00:00Z"));
    const before = discoverCacheKey("今天领涨的公司");
    snapshot.digest = "snapshot-b";
    expect(discoverCacheKey("今天领涨的公司")).not.toBe(before);
  });
  it("does not invalidate pure company discovery when only market content changes", () => {
    const before = discoverCacheKey("做伺服电机的公司");
    snapshot.digest = "snapshot-b";
    expect(discoverCacheKey("做伺服电机的公司")).toBe(before);
  });
  it("does not reuse a preopen or holiday answer after the market opens or closes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T01:14:00Z"));
    const preopen = discoverCacheKey("今天领涨的公司");
    vi.setSystemTime(new Date("2026-10-08T01:15:00Z"));
    const intraday = discoverCacheKey("今天领涨的公司");
    expect(intraday).not.toBe(preopen);
    vi.setSystemTime(new Date("2026-10-08T07:00:00Z"));
    expect(discoverCacheKey("今天领涨的公司")).not.toBe(intraday);
  });
});
