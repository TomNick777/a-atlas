import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ version: "corpus-a", judge: "jev-fixture" }));
vi.mock("../lib/companies", () => ({ loadDataset: () => ({ version: state.version }) }));
vi.mock("../lib/intelligence/capabilities", () => ({ judgeCacheIdentity: () => state.judge }));
vi.mock("../lib/market/state", () => { throw new Error("Product cache must not import market state"); });
import { discoverCacheKey } from "../lib/atlas/discoverCache";
import { marketIdentity } from "../lib/telemetry/discover";

describe("company discovery cache", () => {
  it("invalidates by corpus and selected judge, without a market or calendar dependency", () => {
    const key = discoverCacheKey("合成产品");
    state.version = "corpus-b";
    expect(discoverCacheKey("合成产品")).not.toBe(key);
    state.version = "corpus-a";
    state.judge = "drex-fixture";
    expect(discoverCacheKey("合成产品")).not.toBe(key);
    state.judge = "jev-fixture";
    expect(discoverCacheKey("合成产品")).toBe(key);
    expect(key).toContain("company-discovery-1");
  });
  it("does not conflate differently cased original queries", () => {
    expect(discoverCacheKey("ESP32")).not.toBe(discoverCacheKey("esp32"));
  });
  it("keeps the historical telemetry field null without importing a market adapter", () => {
    expect(marketIdentity()).toEqual({ marketDate: null, stateDigest16: null });
  });
});
