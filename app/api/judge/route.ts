import { judgeProviders, parseProvider, ensureLayaRuntime } from "@/lib/intelligence/capabilities";
export async function GET() { return Response.json({ providers: await judgeProviders() }, { headers: { "cache-control": "no-store" } }); }

/** A user choosing Laya explicitly authorizes starting its fixed local service. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  // Next may use its bind hostname in request.url; Host names the browser's origin.
  const url = new URL(request.url);
  const expectedOrigin = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  if (origin && expectedOrigin !== origin) return Response.json({ error: "来源不匹配。" }, { status: 403 });
  const body = await request.json().catch(() => null);
  let provider;
  try { provider = parseProvider(body?.provider); } catch { return Response.json({ error: "请选择 Jev、Drex 或 Laya。" }, { status: 400 }); }
  try {
    if (provider === "laya") await ensureLayaRuntime();
    return Response.json({ providers: await judgeProviders() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Laya 未能启动：请检查 CUDA、训练占用和本地运行日志。", providers: await judgeProviders() }, { status: 503 });
  }
}
