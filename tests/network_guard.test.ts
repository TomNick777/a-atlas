import { afterAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

/**
 * Guard self-test (Phase 2.1 §14): the offline guard must stay sharp. A Jev
 * cloud attempt inside the deterministic suite rejects loudly with the §14
 * hint; localhost (the stub surface) still passes through.
 */

describe("deterministic-suite network guard", () => {
  it("a real Jev cloud attempt fails fast with the §14 hint — never a silent spend", async () => {
    // Jev Cloud is the only cloud consumer; the hint names the sanctioned suites.
    await expect(fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", body: "{}" })).rejects.toThrow(/Unexpected cloud API access(.|\n)*test:jev-live/);
  });

  it("any other remote host is equally refused — the offline layer stays offline", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/Unexpected outbound network access/);
  });

  it("localhost still reaches a local listener (stub endpoint surface stays available)", async () => {
    const server: Server = createServer((_request, response) => response.end("local-ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/probe`);
      expect(await response.text()).toBe("local-ok");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("a test that stubs fetch replaces the guard wholesale (stubbed suites are unaffected)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("stubbed")));
    try {
      const response = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
      expect(await response.text()).toBe("stubbed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  afterAll(() => {
    // unstub restores the guard; prove it is back on duty after this file.
    void expect(fetch("https://api.typesafe.ai/v1/systemone")).rejects.toThrow(/Unexpected cloud API access/);
  });
});
