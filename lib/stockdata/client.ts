import { noteUpstream } from "@/lib/atlas/runtime";
import type { StockAnnouncements, StockFundamentals, StockQuote, StockResearchReports } from "@/lib/stockdata/contracts";

/**
 * Server-side client for the a-atlas-data service (:8920). Company pages are
 * server components, so this is called during render — every call is short-timeout,
 * recorded in the runtime counters (source health), and on any failure returns a
 * contract-shaped `error` block instead of throwing: the page must render the
 * honest state, never fall over because a data source is down.
 */

const BASE = (process.env.ATLAS_DATA_URL?.trim() || "http://127.0.0.1:8920").replace(/\/+$/, "");

const TIMEOUT_MS: Record<string, number> = {
  quote: 2_500,
  fundamentals: 4_000,
  announcements: 5_000,
  reports: 6_000,
};

async function fetchBlock<T>(kind: string, symbol: string, fallbackSource: string): Promise<T> {
  const started = Date.now();
  let ok = false;
  let code: string | null = null;
  try {
    const response = await fetch(`${BASE}/${kind}?symbol=${encodeURIComponent(symbol)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS[kind] ?? 4_000),
      headers: { accept: "application/json" },
    });
    code = String(response.status);
    if (!response.ok) throw new Error(`data service http ${response.status}`);
    const body = (await response.json()) as T;
    ok = true;
    return body;
  } catch (error) {
    code = error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : code ?? "NETWORK";
    return {
      symbol,
      available: "error",
      source: fallbackSource,
      fetchedAt: new Date().toISOString(),
      asOf: null,
      items: undefined,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    } as unknown as T;
  } finally {
    noteUpstream({ path: `data/${kind}`, ms: Date.now() - started, ok, code, layer: "service" });
  }
}

export function fetchStockQuote(symbol: string): Promise<StockQuote> {
  return fetchBlock<StockQuote>("quote", symbol, "数据服务");
}

export function fetchStockFundamentals(symbol: string): Promise<StockFundamentals> {
  return fetchBlock<StockFundamentals>("fundamentals", symbol, "数据服务");
}

export function fetchStockAnnouncements(symbol: string): Promise<StockAnnouncements> {
  return fetchBlock<StockAnnouncements>("announcements", symbol, "数据服务");
}

export function fetchStockResearchReports(symbol: string): Promise<StockResearchReports> {
  return fetchBlock<StockResearchReports>("reports", symbol, "数据服务");
}
