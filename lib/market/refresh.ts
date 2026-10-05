import { compileHybridQuery } from "../hybrid/compile";

/** Uses the existing Data component's single-flight refresh; no vendor calls in Web. */
export async function prepareMarketForQuery(query: string): Promise<void> {
  const plan = compileHybridQuery(query).plan;
  if (!plan.market || plan.execution.order === "unsupported") return;
  return prepareMarketSnapshot();
}

export async function prepareMarketSnapshot(): Promise<void> {
  const base = (process.env.ATLAS_DATA_URL?.trim() || "http://127.0.0.1:8920").replace(/\/+$/, "");
  try {
    await fetch(`${base}/market-snapshot`, { cache: "no-store", signal: AbortSignal.timeout(42000) });
  } catch {
    // Availability is checked against the actual published source timestamp.
    // A healthy EOD snapshot may survive a service outage; stale facts cannot.
  }
}
