/**
 * Jev capability diagnostics (Phase 3.3 §13).
 *
 * The question this answers: "Jev 升级后搜索质量变了" — which capability, on
 * which contract version, answered by which runtime model, what size of
 * request, how long, and how did it fail. What it never carries: API keys,
 * environment values, or request/answer payloads — counters and identities
 * only, mirroring the transport observation ring in cloud.ts.
 */
import type { CapabilityFailure, CapabilityStatus, CapabilityTimings, JevCapability } from "../capabilities/contracts";

export type CapabilityDiagnostic = {
  at: number;
  capability: JevCapability;
  contractVersion: string;
  runtimeModel: string | null;
  status: CapabilityStatus;
  failure: CapabilityFailure | null;
  outcome: string | null;
  subjectCount: number;
  evidenceCount: number;
  decisionCount: number;
  unexpectedAnswers: number;
  latencyMs: number;
  judgeMs: number;
  prepareMs: number;
  /** Rejected runs carry the precondition that failed; ok/degraded carry none. */
  detail: string | null;
};

export type CapabilityDiagnosticInput = Omit<CapabilityDiagnostic, "at">;

const store = globalThis as unknown as { __jevCapabilityDiagnostics?: CapabilityDiagnostic[] };
const RING = 500;

/** Never throws, never blocks a capability run. */
export function recordCapabilityRun(diagnostic: CapabilityDiagnosticInput): void {
  try {
    const log = (store.__jevCapabilityDiagnostics ??= []);
    log.push({ ...diagnostic, at: Date.now() });
    if (log.length > RING) log.splice(0, log.length - RING);
  } catch {
    // diagnostics must never break judgement
  }
}

/** Most recent runs, newest last. */
export function recentCapabilityDiagnostics(limit = 50): CapabilityDiagnostic[] {
  const log = store.__jevCapabilityDiagnostics ?? [];
  return log.slice(-limit);
}

/** Per-capability rollup over the retained window. */
export function capabilityDiagnosticTotals(): Record<string, { runs: number; ok: number; degraded: number; rejected: number; unexpectedAnswers: number }> {
  const totals: Record<string, { runs: number; ok: number; degraded: number; rejected: number; unexpectedAnswers: number }> = {};
  for (const row of store.__jevCapabilityDiagnostics ?? []) {
    const bucket = (totals[row.capability] ??= { runs: 0, ok: 0, degraded: 0, rejected: 0, unexpectedAnswers: 0 });
    bucket.runs += 1;
    if (row.status === "ok") bucket.ok += 1;
    if (row.status === "degraded") bucket.degraded += 1;
    if (row.status === "rejected") bucket.rejected += 1;
    bucket.unexpectedAnswers += row.unexpectedAnswers;
  }
  return totals;
}

/** Test seam: drop the ring without rebuilding modules. */
export function resetCapabilityDiagnostics(): void {
  store.__jevCapabilityDiagnostics = [];
}

export function timingsOf(timings: CapabilityTimings): Pick<CapabilityDiagnostic, "latencyMs" | "judgeMs" | "prepareMs"> {
  return { latencyMs: timings.totalMs, judgeMs: timings.judgeMs, prepareMs: timings.prepareMs };
}
