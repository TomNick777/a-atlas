import { NextResponse, type NextRequest } from "next/server";
import { normalizeSymbol } from "@/lib/atlas/stockIdentity";

export const dynamic = "force-dynamic";

/**
 * Legacy 兼容（§20）：Vibe 的 `/stock-data?symbol=688017` → A-Atlas `/stock/688017`。
 * 一对一安全映射；带锚点/未知参数时丢弃（只迁移 symbol 语义）。
 */
export function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("symbol") ?? "";
  const symbol = normalizeSymbol(raw);
  if (!symbol) {
    return NextResponse.redirect(new URL("/", request.url), 308);
  }
  return NextResponse.redirect(new URL(`/stock/${symbol}`, request.url), 308);
}
