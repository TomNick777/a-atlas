import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  key: vi.fn(), execute: vi.fn(), received: vi.fn(), failed: vi.fn(), completed: vi.fn(), lookup: vi.fn(), record: vi.fn(), store: vi.fn(),
}));
vi.mock("../lib/discovery/query", () => ({ runCompanyDiscovery: mocks.execute }));
vi.mock("../lib/atlas/discoverCache", () => ({ discoverCacheKey: mocks.key, lookupDiscover: mocks.lookup, storeDiscover: mocks.store, recordDiscoverAnswer: mocks.record }));
vi.mock("../lib/atlas/evidence", () => ({ presentDiscoverResult: (result: unknown) => result }));
vi.mock("../lib/telemetry/organic", () => ({ normalizeOrigin: () => ({ origin: "smoke", invalidProvided: null }) }));
vi.mock("../lib/telemetry/ids", () => ({ newSearchId: () => "s_test_abc123", isValidSessionId: () => false }));
vi.mock("../lib/telemetry/search", () => ({ corruptCapture: vi.fn() }));
vi.mock("../lib/telemetry/discover", () => ({ discoverReceived: mocks.received, discoverFailed: mocks.failed, discoverCompleted: mocks.completed }));
vi.mock("../lib/atlas/runtime", () => ({ noteSearch: vi.fn() }));
vi.mock("../lib/market/refresh", () => { throw new Error("Discover route must not load market refresh"); });
import { POST } from "../app/api/discover/route";
import { POST as searchAlias } from "../app/api/search/route";

const request = (query = "做芯片的公司") => new Request("http://localhost/api/discover", { method: "POST", body: JSON.stringify({ query, origin: "smoke" }) });
const answer = () => ({ query: "做芯片的公司", results: [], execution: { order: "semantic-only", degraded: false }, searchId: "s_original_trace", intelligence: null });

beforeEach(() => { vi.resetAllMocks(); mocks.key.mockReturnValue("company-key"); mocks.execute.mockResolvedValue(answer()); });

describe("company discover route", () => {
  it.each(["cache", "execute"])("records a traced error when %s fails", async stage => {
    const message = "Local search input unavailable";
    if (stage === "cache") mocks.key.mockImplementation(() => { throw new Error(message); });
    else mocks.execute.mockRejectedValue(new Error(message));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: message, searchId: "s_test_abc123" });
    expect(mocks.received).toHaveBeenCalledTimes(1);
    expect(mocks.failed).toHaveBeenCalledExactlyOnceWith({ searchId: "s_test_abc123", sessionId: null, message });
    expect(mocks.completed).not.toHaveBeenCalled();
  });

  it("records a new trace for a replay without re-executing or judging", async () => {
    const original = answer();
    mocks.lookup.mockReturnValue(original);
    const response = await POST(request());
    expect(await response.json()).toMatchObject({ cached: true, searchId: "s_test_abc123" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith("s_test_abc123", original);
    expect(mocks.completed).toHaveBeenCalledWith(expect.objectContaining({ cached: true, replayOfSearchId: "s_original_trace" }));
  });

  it("returns and records honest refusals through the search alias as well", async () => {
    mocks.execute.mockResolvedValue({ ...answer(), execution: { order: "unsupported", degraded: false }, plan: { unsupported: { intent: "company-discovery-only" } } });
    const response = await searchAlias(request("今天涨幅前10的公司"));
    expect(await response.json()).toMatchObject({ searchId: "s_test_abc123", results: [], hits: [], execution: { order: "unsupported" } });
    expect(mocks.received).toHaveBeenCalledTimes(1);
    expect(mocks.completed).toHaveBeenCalledTimes(1);
    expect(mocks.store).not.toHaveBeenCalled();
  });
});
