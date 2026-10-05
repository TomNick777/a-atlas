import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  key: vi.fn(), prepare: vi.fn(), execute: vi.fn(), received: vi.fn(), failed: vi.fn(), completed: vi.fn(), lookup: vi.fn(),
}));
vi.mock("../lib/hybrid/execute", () => ({ runHybridQuery: mocks.execute }));
vi.mock("../lib/atlas/discoverCache", () => ({ discoverCacheKey: mocks.key, lookupDiscover: mocks.lookup, storeDiscover: vi.fn() }));
vi.mock("../lib/atlas/evidence", () => ({ presentDiscoverResult: vi.fn() }));
vi.mock("../lib/telemetry/organic", () => ({ normalizeOrigin: () => ({ origin: "smoke", invalidProvided: null }) }));
vi.mock("../lib/telemetry/ids", () => ({ newSearchId: () => "s_test_abc123", isValidSessionId: () => false }));
vi.mock("../lib/telemetry/search", () => ({ corruptCapture: vi.fn() }));
vi.mock("../lib/telemetry/discover", () => ({ discoverReceived: mocks.received, discoverFailed: mocks.failed, discoverCompleted: mocks.completed }));
vi.mock("../lib/atlas/runtime", () => ({ noteSearch: vi.fn() }));
vi.mock("../lib/market/refresh", () => ({ prepareMarketForQuery: mocks.prepare }));
import { POST } from "../app/api/discover/route";

beforeEach(() => { vi.resetAllMocks(); mocks.prepare.mockResolvedValue(undefined); mocks.key.mockReturnValue("key"); });

it.each(["cache", "refresh"])("records one traced 503 when %s fails before query execution", async stage => {
  const message = "Market snapshot maintenance in progress; retry";
  if (stage === "cache") mocks.key.mockImplementation(() => { throw new Error(message); });
  else mocks.prepare.mockRejectedValue(new Error(message));
  const request = new Request("http://localhost/api/discover", { method: "POST", body: JSON.stringify({ query: "今天涨幅前10的公司", origin: "smoke" }) });
  const response = await POST(request);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: message, searchId: "s_test_abc123" });
  expect(mocks.received).toHaveBeenCalledTimes(1);
  expect(mocks.failed).toHaveBeenCalledExactlyOnceWith({ searchId: "s_test_abc123", sessionId: null, message });
  expect(mocks.received.mock.calls[0][0]).toMatchObject({ searchId: "s_test_abc123", cached: false });
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(mocks.completed).not.toHaveBeenCalled();
});
