import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { exec, execSync } from "node:child_process";
import path from "node:path";
import { ensureContext, setContext } from "./context";
import { PRODUCTION_CONTRACT, manifestIsStale, manifestStampOf, verifyJudgeIdentity } from "./contract";
import { getJevCloudProvider, identityProbe } from "../jev/capabilities";
import type { ProviderStats, ProviderStatus } from "../jev/capabilities";
import { emit, emitIncident, buildEnvelope, currentRuntime } from "./emit";
import { newAppRunId } from "./ids";
import { defaultStore, type TelemetryStore } from "./store";
import type { TelemetryEnvelope } from "./types";

/**
 * Runtime evidence (规格 §5-§11, §45-§46; Phase 4 §22-§24): startup self-check
 * sequence, drift detection, heartbeat, crash recovery. Everything is best-effort —
 * the app must start and serve even when every probe below fails.
 *
 * A-Atlas' core runtime is Web + Data (refocus 后 Vibe Research 已退役；
 * 数据底座是 services/stock-data 上的 a-atlas-data，:8920)。Jev is a remote dependency:
 * probed, reported and incident-producing, never a boot gate and never a hard health edge.
 */

export type RuntimeState = {
  profileSha16: string | null;
  vectorsSha16: string | null;
  profileFile: string | null;
  vectorsFile: string | null;
  profileStamp: { size: number; mtimeMs: number } | null;
  vectorsStamp: { size: number; mtimeMs: number } | null;
  lastStaleManifestFor: string | null;
  lastJevIncidentAt: number;
  heartbeatTimer: NodeJS.Timeout | null;
};

const state: RuntimeState = {
  profileSha16: null,
  vectorsSha16: null,
  profileFile: null,
  vectorsFile: null,
  profileStamp: null,
  vectorsStamp: null,
  lastStaleManifestFor: null,
  lastJevIncidentAt: 0,
  heartbeatTimer: null,
};

export const runtimeState = state;

function sha16OfFile(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function stampOfFile(file: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Port of the data component, read from the one env var that names it. */
function dataPortOf(): number | null {
  const url = process.env.ATLAS_DATA_URL?.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

/**
 * Data component reachability (a-atlas-data on :8920). Deliberately short: a boot
 * that waits 15s on a dead python process is worse than a recorded "not reachable
 * yet" (§23: web and data are probed independently).
 */
export async function probeDataServiceHealth(timeoutMs = 1_500): Promise<{ ok: boolean; version: string | null; latencyMs: number; error: string | null }> {
  const base = (process.env.ATLAS_DATA_URL?.trim() || "http://127.0.0.1:8920").replace(/\/+$/, "");
  const started = Date.now();
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, version: null, latencyMs: Date.now() - started, error: `http ${response.status}` };
    const body = (await response.json().catch(() => null)) as { ok?: boolean; service?: string; version?: string } | null;
    const right = body?.service === "a-atlas-data";
    return { ok: Boolean(body?.ok) && right, version: body?.version ?? null, latencyMs: Date.now() - started, error: right ? null : `foreign service ${body?.service ?? "none"}` };
  } catch (error) {
    return { ok: false, version: null, latencyMs: Date.now() - started, error: error instanceof Error ? error.name : String(error) };
  }
}

function gitHead(): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

/** App version straight from package.json (§2 identity); null-safe by contract. */
function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Port ownership (规格 §8) — netstat -ano parse, Windows-native, best effort.
// ---------------------------------------------------------------------------

export type PortListener = { pid: number; localAddress: string };

/** Parse `netstat -ano` output for LISTENING sockets on the given port. */
export function parseNetstatListeners(output: string, port: number): PortListener[] {
  const listeners: PortListener[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!/TCP/i.test(line) || !/LISTENING/i.test(line)) continue;
    const columns = line.split(/\s+/);
    // tcp, local, foreign, state, pid
    const local = columns[1];
    const pid = Number(columns[columns.length - 1]);
    if (!local || !Number.isInteger(pid) || pid <= 0) continue;
    const match = new RegExp(`[:.]${port}$`, "i").exec(local);
    if (match) listeners.push({ pid, localAddress: local });
  }
  return listeners;
}

async function owningProcess(pid: number): Promise<{ processName: string | null; commandLine: string | null }> {
  const run = async (cmd: string): Promise<string | null> => {
    try {
      return await new Promise((resolve) => {
        exec(cmd, { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? null : stdout.toString().trim()));
      });
    } catch {
      return null;
    }
  };
  const nameRow = await run(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).ProcessName"`);
  const commandLine =
    (await run(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\").CommandLine"`)) ??
    (await run(`wmic process where processid=${pid} get commandline /value`));
  const commandLineClean = commandLine && commandLine.includes("=") ? commandLine.split("=").slice(1).join("=").trim() || null : commandLine;
  return { processName: nameRow || null, commandLine: commandLineClean };
}

async function portListeners(port: number): Promise<PortListener[]> {
  try {
    const output = await new Promise<string>((resolve) => {
      exec("netstat -ano", { windowsHide: true, timeout: 8000 }, (error, stdout) => resolve(error ? "" : stdout.toString()));
    });
    return parseNetstatListeners(output, port);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Judge identity probing (§47: an identity claim must come from the answering party)
// ---------------------------------------------------------------------------

export type JudgeProbeOutcome = {
  verdict: ReturnType<typeof verifyJudgeIdentity>;
  status: ProviderStatus;
  stats: ProviderStats;
};

/**
 * One real call against the configured Jev endpoint with two candidates, to learn
 * which cloud model actually answers. This is the cloud analogue of the sidecar's
 * SHA self-report: `JEV_MODEL=jev-latest` is an alias, and only a response body can
 * say what is behind it. Best-effort — startup never waits on it, and a failure is
 * a degraded Discover, not a failed boot (§22).
 */
export async function probeJudgeIdentity(): Promise<JudgeProbeOutcome> {
  const provider = getJevCloudProvider();
  await identityProbe();
  return {
    verdict: verifyJudgeIdentity(provider.status().lastAnsweredModel, provider.configured()),
    status: provider.status(),
    stats: provider.stats(),
  };
}

// ---------------------------------------------------------------------------
// Crash recovery (规格 §45)
// ---------------------------------------------------------------------------

/** Runs from previous events that have APP_START but no APP_STOP/APP_CRASH. */
export async function detectUncleanPreviousRuns(store: TelemetryStore = defaultStore, currentAppRunId: string): Promise<TelemetryEnvelope[]> {
  const { events } = await store.readEvents({ eventTypes: ["APP_START", "APP_READY", "APP_STOP", "APP_CRASH"] });
  const byRun = new Map<string, { started: boolean; closed: boolean }>();
  for (const event of events) {
    const row = byRun.get(event.appRunId) ?? { started: false, closed: false };
    if (event.eventType === "APP_START") row.started = true;
    if (event.eventType === "APP_STOP" || event.eventType === "APP_CRASH") row.closed = true;
    byRun.set(event.appRunId, row);
  }
  const unclean: TelemetryEnvelope[] = [];
  for (const [appRunId, row] of byRun) {
    if (appRunId !== currentAppRunId && row.started && !row.closed) {
      const start = events.find((event) => event.appRunId === appRunId && event.eventType === "APP_START");
      if (start) unclean.push(start);
    }
  }
  return unclean;
}

// ---------------------------------------------------------------------------
// Startup sequence (规格 §46)
// ---------------------------------------------------------------------------

export async function initRuntime(store: TelemetryStore = defaultStore): Promise<void> {
  const ctx = ensureContext();
  const appRunId = newAppRunId("next");
  const startedAt = Date.now();
  setContext({
    ...ctx,
    appRunId,
    component: "next",
    startedAt,
    gitHead: gitHead(),
    // §2 identity: the app version is the package's, not a second number that
    // drifts from it.
    buildVersion: appVersion(),
    port: Number(process.env.PORT ?? 3000) || 3000,
  });

  // 0. telemetry writable — before anything claims to be recorded (§46 step 7 pulled ahead of APP_START).
  await store.probeWritable().then((ok) => {
    if (!ok) void emitIncident("TELEMETRY_UNWRITABLE", { baseDir: store.baseDir, reason: "probe write failed" }, { severity: "error" });
  });

  // 1. APP_START (§5).
  void (await emit("APP_START", "runtime", {
    timestamp: new Date().toISOString(),
    gitHead: ensureContext().gitHead,
    buildVersion: ensureContext().buildVersion,
    pid: process.pid,
    parentPid: process.ppid,
    port: ensureContext().port,
    cwd: process.cwd(),
    nodeVersion: process.versions.node,
    platform: process.platform,
    uptimeStartMs: 0,
  }));

  // 2. Port ownership (§8): who is on the Next port and on the data port.
  //    Phase 4: the old local judge port is gone from this list on purpose. Refocus:
  //    the Vibe research port is gone too — the only local peer A-Atlas owns is the
  //    stock-data service.
  const dataPort = dataPortOf();
  const nextPort = ensureContext().port ?? 3000;
  const nextListeners = await portListeners(nextPort).then((rows) => rows.filter((row) => row.pid !== process.pid));
  for (const listener of nextListeners) {
    const owner = await owningProcess(listener.pid);
    void (await emit("PORT_ALREADY_BOUND", "runtime", { port: nextPort, owningPid: listener.pid, processName: owner.processName, commandLine: owner.commandLine, kind: "next" }));
  }
  const dataListeners = dataPort ? await portListeners(dataPort) : [];
  for (const listener of dataListeners) {
    const owner = await owningProcess(listener.pid);
    void (await emit("PORT_ALREADY_BOUND", "runtime", { port: dataPort, owningPid: listener.pid, processName: owner.processName, commandLine: owner.commandLine, kind: "data" }));
  }

  // 3. Crash recovery + restart marker (§45).
  const unclean = await detectUncleanPreviousRuns(store, appRunId);
  for (const start of unclean) {
    void (await emitIncident("PREVIOUS_RUN_UNCLEAN_EXIT", { previousAppRunId: start.appRunId, previousStartedAt: start.timestamp }, { severity: "warning" }));
  }
  const stopEvents = (await store.readEvents({ eventTypes: ["APP_STOP"] })).events;
  const lastStop = stopEvents[stopEvents.length - 1];
  if (lastStop && Date.now() - Date.parse(lastStop.timestamp) < 30 * 60_000 && lastStop.appRunId !== appRunId) {
    void (await emit("NEXT_RESTART", "runtime", { previousAppRunId: lastStop.appRunId, previousStoppedAt: lastStop.timestamp, gapMs: Date.now() - Date.parse(lastStop.timestamp) }));
  }

  // 4. Knowledge manifest on disk + force-load dataset, then loaded-vs-disk compare (§10).
  const companies = await import("../companies");
  companies.loadDataset();
  const diskManifest = manifestStampOf(readManifestSafe());
  const loadedStamp = companies.loadedManifestStamp();
  if (manifestIsStale(loadedStamp, diskManifest)) {
    state.lastStaleManifestFor = diskManifest.builtAt;
    void (await emitIncident("STALE_RUNTIME_DATASET", { loaded: loadedStamp, disk: diskManifest }, { severity: "error" }));
  }

  // 5. Profile + vectors identity (§6: profileSha, vectorsSha — computed once, stat-checked in heartbeats).
  const edition = (await import("../search/edition")).profileEdition();
  const profileFile = path.join(process.cwd(), (await import("../search/edition")).profileFileFor(edition));
  const vectorsFile = path.join(process.cwd(), (await import("../search/edition")).vectorsFileFor(edition));
  state.profileSha16 = sha16OfFile(profileFile);
  state.vectorsSha16 = sha16OfFile(vectorsFile);
  state.profileFile = profileFile;
  state.vectorsFile = vectorsFile;
  state.profileStamp = stampOfFile(profileFile);
  state.vectorsStamp = stampOfFile(vectorsFile);

  // 6. Judge identity (§47 in the cloud era): ask the endpoint once and record what
  //    actually answered, instead of trusting the alias in config. This is never a
  //    boot gate — no key means a DEGRADED Discover, not a failed start (§22/§24).
  let jev: JudgeProbeOutcome | null = null;
  try {
    jev = await probeJudgeIdentity();
  } catch (error) {
    void emitIncident("JEV_UNAVAILABLE", { reason: "startup_identity_probe_failed", message: error instanceof Error ? error.message : String(error) }, { severity: "warning" });
  }
  ensureContext().judge = {
    provider: jev?.status.configured ? "jev" : "none",
    model: jev?.status.lastAnsweredModel ?? null,
    configured: jev?.status.configured ?? false,
    breaker: jev?.status.breaker.state ?? "closed",
    healthy: jev?.verdict.status === "verified",
  };
  if (jev?.verdict.status === "drift") {
    void (await emitIncident(
      "MODEL_IDENTITY_MISMATCH",
      {
        reason: "jev_answered_with_unexpected_model",
        expectedModel: jev.verdict.expectedModel,
        actualModel: jev.verdict.actualModel,
        endpoint: jev.status.endpoint,
        detectedAt: new Date().toISOString(),
      },
      { severity: "error" },
    ));
  } else if (jev?.verdict.status === "verified") {
    void (await emit("JEV_IDENTITY_VERIFIED", "runtime", {
      expectedModel: jev.verdict.expectedModel,
      actualModel: jev.verdict.actualModel,
      alias: jev.status.model,
      endpoint: jev.status.endpoint,
      latencyMs: jev.stats.latencyMs.p50,
      calls: jev.stats.calls,
    }, {}));
  } else {
    void (await emit("JEV_UNAVAILABLE", "runtime", { status: jev?.verdict.status ?? "unknown", reason: jev?.verdict.reason ?? "probe failed", configured: jev?.status.configured ?? false }));
  }

  // 6b. Data component reachability. Recorded, not required to boot: web can
  //     come up before the python service and Harbor will probe both separately.
  const data = await probeDataServiceHealth();

  // 7. APP_READY (§46 step 8) — with the production tuple as actually observed.
  void (await emit("APP_READY", "runtime", {
    startupToReadyMs: Date.now() - startedAt,
    judgeIdentity: jev?.verdict.status ?? "unknown",
    actualJudgeModel: jev?.verdict.actualModel ?? null,
    expectedJudgeModel: jev?.verdict.expectedModel ?? PRODUCTION_CONTRACT.judgeModel,
    judgeProvider: jev?.status.configured ? "jev" : "none",
    breakerState: jev?.status.breaker.state ?? "closed",
    dataReachable: data.ok,
    dataVersion: data.version,
    knowledgeTuple: diskManifest,
    profileSha16: state.profileSha16,
    vectorsSha16: state.vectorsSha16,
    profileEdition: edition,
    telemetryWritable: true,
  }));

  startHeartbeat(store);
  installExitHooks(store);
}

function readManifestSafe(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "data", "search_index_manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heartbeat (§11): every 5 minutes while active, paused when idle > 30min.
// ---------------------------------------------------------------------------

export function startHeartbeat(store: TelemetryStore = defaultStore, intervalMs = 5 * 60_000, idlePauseMs = 30 * 60_000): void {
  if (state.heartbeatTimer) return;
  const timer = setInterval(() => {
    void beat(store, idlePauseMs);
  }, intervalMs);
  timer.unref?.();
  state.heartbeatTimer = timer;
}

export async function beat(store: TelemetryStore = defaultStore, idlePauseMs = 30 * 60_000): Promise<TelemetryEnvelope | null> {
  const ctx = ensureContext();
  if (ctx.lastHeartbeatAt === 0) ctx.lastHeartbeatAt = Date.now();
  const idleMs = Date.now() - Math.max(ctx.lastActivityAt, ctx.startedAt);
  if (idleMs > idlePauseMs) return null; // long-idle: pause heartbeat (§11)

  const diskManifest = manifestStampOf(readManifestSafe());
  const [{ loadedManifestStamp }] = await Promise.all([import("../companies")]);
  const loadedStamp = loadedManifestStamp();
  const stale = manifestIsStale(loadedStamp, diskManifest);
  if (stale && state.lastStaleManifestFor !== diskManifest.builtAt) {
    state.lastStaleManifestFor = diskManifest.builtAt;
    void (await emitIncident("STALE_RUNTIME_DATASET", { loaded: loadedStamp, disk: diskManifest, detectedBy: "heartbeat" }, { severity: "error", store }));
  }

  // Remote + component status. Jev is a remote dependency: its failure is an
  // incident and a DEGRADED Discover, never a reason to call the web unhealthy.
  const jevStatus = getJevCloudProvider().status();
  const data = await probeDataServiceHealth();
  const jevHealthy = jevStatus.configured && jevStatus.breaker.state !== "open";
  if (ctx.jevHealthy && !jevHealthy) {
    void (await emitIncident("SERVICE_FAILURE", { component: "jev", reason: jevStatus.breaker.state === "open" ? "breaker_open" : "not_configured", breaker: jevStatus.breaker }, { severity: "warning", store }));
  } else if (!ctx.jevHealthy && jevHealthy) {
    void (await emitIncident("RECOVERED", { component: "jev", model: jevStatus.lastAnsweredModel }, { severity: "info", store }));
  }
  if (data.ok !== ctx.dataHealthy) {
    void (await emitIncident(data.ok ? "RECOVERED" : "SERVICE_FAILURE", { component: "data", reachable: data.ok, detail: data.error, latencyMs: data.latencyMs }, { severity: data.ok ? "info" : "error", store }));
  }
  ctx.jevHealthy = jevHealthy;
  ctx.dataHealthy = data.ok;
  ctx.judge = { provider: jevStatus.configured ? "jev" : "none", model: jevStatus.lastAnsweredModel, configured: jevStatus.configured, breaker: jevStatus.breaker.state, healthy: jevHealthy };

  const profileStamp = state.profileFile ? stampOfFile(state.profileFile) : null;
  const vectorsStamp = state.vectorsFile ? stampOfFile(state.vectorsFile) : null;

  const event = await emit("RUNTIME_HEARTBEAT", "runtime", {
    nextPid: process.pid,
    ports: { next: ctx.port, data: dataPortOf() },
    uptimeMs: Date.now() - ctx.startedAt,
    memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    judge: ctx.judge,
    jevInFlight: jevStatus.inFlight,
    dataHealthy: data.ok,
    dataVersion: data.version,
    dataLatencyMs: data.latencyMs,
    actualJudgeModel: jevStatus.lastAnsweredModel,
    expectedJudgeModel: PRODUCTION_CONTRACT.judgeModel,
    knowledgeVersion: diskManifest.knowledgeVersions,
    profileSha16: state.profileSha16,
    vectorsSha16: state.vectorsSha16,
    profileChangedSinceStart: profileStamp != null && state.profileStamp != null && (profileStamp.mtimeMs !== state.profileStamp.mtimeMs || profileStamp.size !== state.profileStamp.size),
    vectorsChangedSinceStart: vectorsStamp != null && state.vectorsStamp != null && (vectorsStamp.mtimeMs !== state.vectorsStamp.mtimeMs || vectorsStamp.size !== state.vectorsStamp.size),
    manifestStale: stale,
    searchesSinceLastHeartbeat: ctx.searchesSinceHeartbeat,
    errorsSinceLastHeartbeat: ctx.errorsSinceHeartbeat,
  }, { store });
  ctx.searchesSinceHeartbeat = 0;
  ctx.errorsSinceHeartbeat = 0;
  ctx.lastHeartbeatAt = Date.now();
  return event;
}

// ---------------------------------------------------------------------------
// Exit + crash hooks (§45) — sync writes only, exit handlers never flush async.
// ---------------------------------------------------------------------------

export function installExitHooks(store: TelemetryStore = defaultStore): void {
  const writeStop = (reason: string) => {
    store.appendSync(
      buildEnvelope("APP_STOP", "runtime", { reason, uptimeMs: Date.now() - ensureContext().startedAt, runtime: currentRuntime() }),
    );
  };
  const stopHandler = (signal: string) => {
    try {
      writeStop(signal);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => stopHandler("SIGINT"));
  process.on("SIGTERM", () => stopHandler("SIGTERM"));
  process.on("exit", (code) => {
    if (code === 0) return; // stop handler already wrote APP_STOP for clean exits
    store.appendSync(buildEnvelope("APP_STOP", "runtime", { reason: `exit:${code}`, uptimeMs: Date.now() - ensureContext().startedAt }));
  });
  const crash = (kind: string, error: unknown) => {
    store.appendSync(
      buildEnvelope("APP_CRASH", "runtime", {
        kind,
        message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.slice(0, 4000) : String(error),
      }),
    );
  };
  process.on("uncaughtException", (error) => {
    crash("uncaughtException", error);
    if (process.listenerCount("uncaughtException") === 1) throw error; // keep default crash semantics
  });
  process.on("unhandledRejection", (reason) => {
    crash("unhandledRejection", reason);
    if (process.listenerCount("unhandledRejection") === 1) throw reason instanceof Error ? reason : new Error(String(reason));
  });
}
