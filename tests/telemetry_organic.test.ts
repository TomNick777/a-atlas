import { describe, expect, it } from "vitest";
import { editDistance, normalizeOrigin, organicEligibilityFor, queryHash16, reformulationLink } from "../lib/telemetry/organic";

describe("organic eligibility mapping (§31)", () => {
  it("normal UI usage is a CANDIDATE without asking the user", () => {
    expect(organicEligibilityFor("organic_ui")).toBe("CANDIDATE");
  });

  it("developer / smoke / benchmark / replay / api map to the pre-registered exclusions", () => {
    expect(organicEligibilityFor("developer")).toBe("EXCLUDED_DEVELOPER");
    expect(organicEligibilityFor("smoke")).toBe("EXCLUDED_SMOKE");
    expect(organicEligibilityFor("benchmark")).toBe("EXCLUDED_SYSTEM_TEST");
    expect(organicEligibilityFor("replay")).toBe("EXCLUDED_REPLAY");
    expect(organicEligibilityFor("api")).toBe("EXCLUDED_DEVELOPER");
  });

  it("cache hits and corrupt captures override the origin", () => {
    expect(organicEligibilityFor("organic_ui", { cached: true })).toBe("EXCLUDED_CACHE");
    expect(organicEligibilityFor("organic_ui", { corrupt: true })).toBe("EXCLUDED_CORRUPT");
    expect(organicEligibilityFor("developer", { cached: true })).toBe("EXCLUDED_CACHE");
  });

  it("unknown declared origins fall back to organic_ui but are recorded", () => {
    expect(normalizeOrigin("hacker")).toEqual({ origin: "organic_ui", invalidProvided: "hacker" });
    expect(normalizeOrigin(undefined)).toEqual({ origin: "organic_ui", invalidProvided: null });
    expect(normalizeOrigin("smoke")).toEqual({ origin: "smoke", invalidProvided: null });
  });
});

describe("reformulation grouping (§26)", () => {
  it("links consecutive same-session queries within the window", () => {
    const now = Date.now();
    const first = reformulationLink(undefined, now, "铜资源", "s_aaa_000001");
    expect(first.groupId).toBeNull();
    const second = reformulationLink(first.nextState, now + 20_000, "有铜矿的公司", "s_bbb_000002");
    expect(second.groupId).toBe("rg_s_aaa_000001");
    expect(second.previousSearchId).toBe("s_aaa_000001");
    expect(second.editDistance).toBeGreaterThan(0);
    expect(second.timeDeltaMs).toBe(20_000);
    const third = reformulationLink(second.nextState, now + 30_000, "不要铜加工", "s_ccc_000003");
    expect(third.groupId).toBe("rg_s_aaa_000001"); // same chain
  });

  it("does not link across a long gap", () => {
    const now = Date.now();
    const first = reformulationLink(undefined, now, "光刻胶", "s_aaa_000001");
    const second = reformulationLink(first.nextState, now + 10 * 60_000, "光刻胶树脂", "s_bbb_000002");
    expect(second.groupId).toBeNull();
    expect(second.previousSearchId).toBeNull();
  });

  it("editDistance is zero on equality and one on a single insert", () => {
    expect(editDistance("铜资源", "铜资源")).toBe(0);
    expect(editDistance("铜资源", "铜矿资源")).toBe(1);
    expect(editDistance("铜资源", "有铜矿的公司")).toBeGreaterThanOrEqual(4);
  });

  it("queryHash is stable and does not contain the query text", () => {
    expect(queryHash16("铜资源公司")).toBe(queryHash16("铜资源公司"));
    expect(queryHash16("铜资源公司")).not.toContain("铜");
    expect(queryHash16("a")).not.toBe(queryHash16("b"));
  });
});
