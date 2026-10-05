import { ensureContext } from "./context";
import { newEventId } from "./ids";
import { defaultStore, type TelemetryStore } from "./store";
import type { EventCategory, TelemetryComponent, TelemetryEnvelope, TelemetryRuntime, TelemetryVersions } from "./types";

/**
 * emit() — the only way events leave a process. Never rejects, never blocks a
 * search longer than the fire-and-forget append itself; failures are counted
 * in the store and reported to stderr (规格 §1, §44).
 */

export type EmitOptions = {
  searchId?: string | null;
  sessionId?: string | null;
  component?: TelemetryComponent;
  runtime?: Partial<TelemetryRuntime>;
  versions?: TelemetryVersions;
  store?: TelemetryStore;
};

export function currentRuntime(extra: Partial<TelemetryRuntime> = {}): TelemetryRuntime {
  const ctx = ensureContext();
  return {
    pid: process.pid,
    port: ctx.port,
    platform: process.platform,
    nodeVersion: process.versions.node,
    uptimeMs: Date.now() - ctx.startedAt,
    cwd: process.cwd(),
    ...extra,
  };
}

export function buildEnvelope(eventType: string, category: EventCategory, payload: Record<string, unknown>, options: EmitOptions = {}): TelemetryEnvelope {
  const ctx = ensureContext();
  return {
    telemetrySchemaVersion: 1,
    eventId: newEventId(),
    eventType,
    category,
    timestamp: new Date().toISOString(),
    appRunId: ctx.appRunId,
    sessionId: options.sessionId ?? null,
    searchId: options.searchId ?? null,
    gitHead: ctx.gitHead,
    component: options.component ?? ctx.component,
    runtime: currentRuntime(options.runtime),
    versions: options.versions ?? {},
    payload,
  };
}

/** Fire-and-forget append. Returns a promise only so tests can await it. */
export async function emit(eventType: string, category: EventCategory, payload: Record<string, unknown> = {}, options: EmitOptions = {}): Promise<TelemetryEnvelope | null> {
  const store = options.store ?? defaultStore;
  const event = buildEnvelope(eventType, category, payload, options);
  try {
    const ok = await store.append(event);
    return ok ? event : null;
  } catch {
    return null;
  }
}

/** Incident: mirrored into events/YYYY-MM-DD.jsonl AND incidents/incidents.jsonl. */
export async function emitIncident(incidentType: string, payload: Record<string, unknown> = {}, options: EmitOptions & { severity?: "info" | "warning" | "error" } = {}): Promise<TelemetryEnvelope | null> {
  const store = options.store ?? defaultStore;
  const event = buildEnvelope(incidentType, "incident", { severity: options.severity ?? "warning", ...payload }, options);
  try {
    return (await store.appendIncident(event)) ? event : null;
  } catch {
    return null;
  }
}
