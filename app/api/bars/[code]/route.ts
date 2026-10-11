import { fetchStockBars } from "@/lib/stockdata/client";
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params; if (!/^\d{6}$/.test(code)) return Response.json({ error: "BAD_CODE" }, { status: 400 });
  return Response.json(await fetchStockBars(code), { headers: { "cache-control": "no-store" } });
}
