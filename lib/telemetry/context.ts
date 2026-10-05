import { newAppRunId } from "./ids";
import type { TelemetryComponent } from "./types";

/**
 * Per-process telemetry context: the appRunId side of the envelope plus the
 * activity counters the heartbeat reports. Set once by runtime.init for the
 * Next server; CLI scripts and tests can install their own context.
 *
 * Backed by globalThis on purpose: Next dev compiles instrumentation and route
 * handlers into separate bundles, so a module-level `let` would give each
 * bundle its own context and the search events would lose the appRunId.
 */

export type TelemetryContext = {
  appRunId: string;
  component: TelemetryComponent;
  startedAt: number;
  gitHead: string | null;
  buildVersion: string;
  port: number | null;
  /** Activity tracking: searches and errors since the last heartbeat. */
  searchesSinceHeartbeat: number;
  errorsSinceHeartbeat: number;
  lastActivityAt: number;
  lastHeartbeatAt: number;
  /** Judge as last seen (§23: a remote dependency, reported but never a boot gate). */
  judge: { provider: "jev" | "none"; model: string | null; configured: boolean; breaker: string; healthy: boolean };
  /** Last observed health of each runtime element (refocus 后 = Jev + 数据服务）。 */
  jevHealthy: boolean;
  dataHealthy: boolean;
};

const store = globalThis as unknown as { __telemetryContext?: TelemetryContext };

export function ensureContext(): TelemetryContext {
  if (!store.__telemetryContext) {
    store.__telemetryContext = {
      appRunId: newAppRunId("cli"),
      component: "cli",
      startedAt: Date.now(),
      gitHead: null,
      buildVersion: "unknown",
      port: null,
      searchesSinceHeartbeat: 0,
      errorsSinceHeartbeat: 0,
      lastActivityAt: Date.now(),
      lastHeartbeatAt: 0,
      judge: { provider: "none", model: null, configured: false, breaker: "closed", healthy: false },
      jevHealthy: false,
      dataHealthy: false,
    };
  }
  return store.__telemetryContext;
}

export function setContext(next: TelemetryContext): void {
  store.__telemetryContext = next;
}

export function getContext(): TelemetryContext | null {
  return store.__telemetryContext ?? null;
}

export function noteSearchActivity(): void {
  const ctx = ensureContext();
  ctx.searchesSinceHeartbeat += 1;
  ctx.lastActivityAt = Date.now();
}

export function noteError(): void {
  const ctx = ensureContext();
  ctx.errorsSinceHeartbeat += 1;
  ctx.lastActivityAt = Date.now();
}
