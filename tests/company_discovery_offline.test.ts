import { expect, it, vi } from "vitest";

vi.mock("../lib/market/state", () => { throw new Error("Company mainline imported market state"); });
vi.mock("../lib/market/refresh", () => { throw new Error("Company mainline imported market refresh"); });
import { runCompanyDiscovery } from "../lib/discovery/query";

it("runs the real corpus retrieval pipeline offline without a judge or market service", async () => {
  // Query embedding comes from the pre-existing recorded local-model fixture.
  const answer = await runCompanyDiscovery("做伺服电机的公司", { skipJev: true, log: false, origin: "smoke", traceId: "s_test_offline" });
  expect(answer.results.length).toBeGreaterThan(0);
  expect(answer.results.every(row => /^\d{6}$/.test(row.code) && row.market === null && row.hero === null && row.judgement === null)).toBe(true);
  expect(answer.execution).toMatchObject({ order: "semantic-only", decidedBy: "retrieval", degraded: true, marketDate: null, stateDigest16: null });
  expect(answer.plan.semantic?.query).toBe("做伺服电机的公司");
  expect(answer.searchId).toBe("s_test_offline");
});
