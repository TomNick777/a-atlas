import { beforeEach, describe, expect, it, vi } from "vitest";
const start = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/intelligence/capabilities", () => ({
  ensureLayaRuntime: start,
  judgeProviders: async () => [],
  parseProvider: (id: unknown) => { if (id !== "jev" && id !== "laya") throw Error("invalid"); return id; },
}));
import { POST } from "../app/api/judge/route";
describe("fixed local judge startup", () => {
  beforeEach(() => start.mockClear());
  const request = (origin: string, provider = "laya") => new Request("http://localhost:3400/api/judge", { method: "POST", headers: { host: "127.0.0.1:3400", origin, "content-type": "application/json" }, body: JSON.stringify({ provider }) });
  it("accepts the browser Host even when Next uses a different bind hostname", async () => {
    expect((await POST(request("http://127.0.0.1:3400"))).status).toBe(200);
    expect(start).toHaveBeenCalledOnce();
  });
  it("rejects another origin before launching a service", async () => {
    expect((await POST(request("https://example.com"))).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });
  it("rejects unregistered provider input before launching a service", async () => {
    expect((await POST(request("http://127.0.0.1:3400", "../arbitrary"))).status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });
});
