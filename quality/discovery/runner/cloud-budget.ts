/** Shared private ledger across the preregistered acceptance runs. No extra calls. */
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { estimateJudgeCost } from "../../../lib/intelligence/capabilities";
import { isAccountedCloudUrl } from "./accounting";
type Ledger = { schemaVersion: number; maxCalls: number; maxCostUsd: number; calls: number; costUsd: number; reservedUsd: number; exhausted: boolean; events: { at: string; estimatedUsd: number; actualUsd: number | null }[] };
export function installCloudBudget(file: string, maxCalls: number, maxCostUsd: number): () => void {
  if (!Number.isSafeInteger(maxCalls) || maxCalls <= 0 || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error("Cloud budget requires positive finite call and cost limits");
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const handle = openSync(lock, "wx");
  closeSync(handle);
  const release = () => { unlinkSync(lock); };
  let ledger: Ledger;
  try { ledger = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { release(); throw error; }
    ledger = { schemaVersion: 1, maxCalls, maxCostUsd, calls: 0, costUsd: 0, reservedUsd: 0, exhausted: false, events: [] };
  }
  if (ledger.maxCalls !== maxCalls || ledger.maxCostUsd !== maxCostUsd || !Number.isFinite(ledger.costUsd) || !Number.isFinite(ledger.reservedUsd)) { release(); throw new Error("Acceptance budget changed or ledger is invalid"); }
  const save = () => { mkdirSync(dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(ledger, null, 2)); renameSync(temporary, file); };
  save();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isAccountedCloudUrl(url)) return original(input, init);
    const body = String(init?.body ?? "");
    const estimate = estimateJudgeCost(body.length * 4 + 5000);
    if (estimate === null) throw new Error("Cloud budget cannot run in a local judge context");
    if (ledger.calls >= maxCalls || ledger.costUsd + ledger.reservedUsd + estimate > maxCostUsd) { ledger.exhausted = true; save(); throw new Error("Preregistered cloud budget exhausted"); }
    const event = { at: new Date().toISOString(), estimatedUsd: estimate, actualUsd: null as number | null };
    ledger.events.push(event); ledger.calls++; ledger.reservedUsd += estimate; save();
    try {
      const response = await original(input, init);
      const data = await response.clone().json().catch(() => null);
      const usage = data?.usage;
      const tokens = Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens) && usage.input_tokens >= 0 && usage.output_tokens >= 0 ? usage.input_tokens : null;
      event.actualUsd = response.ok ? tokens === null || typeof data?.model !== "string" ? null : estimateJudgeCost(tokens, data.model) : 0;
      // Unknown billing keeps the conservative reservation charged, never assumes zero.
      ledger.costUsd += event.actualUsd ?? estimate;
      return response;
    } catch (error) { ledger.costUsd += estimate; throw error; }
    finally { ledger.reservedUsd -= estimate; save(); }
  }) as typeof fetch;
  return () => { globalThis.fetch = original; release(); };
}
