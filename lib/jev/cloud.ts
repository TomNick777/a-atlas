/**
 * JevCloudProvider — the only judgement provider A-Atlas has (Phase 4 §6).
 *
 * Responsibilities the raw fetch did not have before this file:
 *   §8  the key is read server-side and never leaves this module;
 *   §12 a connect budget, a per-request budget and an overall search budget;
 *   §13 bounded, jittered retry for read-only judgement, only inside the budget;
 *   §14 a circuit breaker so one cloud outage costs one timeout, not one per search;
 *   §15 admission control, because the measured cloud queues past ~4 in-flight;
 *   §17 telemetry observations for every attempt;
 *   §18 aggregate cost counters.
 */
import { jevBaseUrl, jevModel, typesafeKey } from "../env";
import {
  CircuitBreaker,
  JEV_PRICE_PER_TOKEN,
  JEV_TIMING,
  RETRYABLE_OUTCOMES,
  isProviderFailure,
  outcomeForStatus,
  type BudgetKind,
  type BreakerSnapshot,
  type JevCall,
  type JevOutcome,
  type JevUsage,
  type JudgeProvider,
  type ProviderStats,
  type ProviderStatus,
} from "./provider";

export type SystemOneResponse<TAnswers> = {
  model?: string;
  answers?: TAnswers;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/** Telemetry observation of one attempt (规格 §17/§19: timeouts, retries, errors). */
export type SystemOneObservation = {
  outcome: JevOutcome;
  status: number | null;
  attempt: number;
  durationMs: number;
  kind: BudgetKind;
  at: number;
};

const observationStore = globalThis as unknown as { __systemOneLog?: SystemOneObservation[] };

/**
 * Ring buffer of recent attempt observations. The pipeline drains the window
 * that overlaps its own rerank, so concurrent searches only ever see
 * observations that landed inside their own timing window.
 */
export function drainSystemOneObservations(sinceEpochMs: number): SystemOneObservation[] {
  const log = (observationStore.__systemOneLog ??= []);
  const taken: SystemOneObservation[] = [];
  const kept: SystemOneObservation[] = [];
  for (const row of log) (row.at >= sinceEpochMs ? taken : kept).push(row);
  observationStore.__systemOneLog = kept;
  return taken;
}

function recordObservation(observation: Omit<SystemOneObservation, "at">): void {
  const log = (observationStore.__systemOneLog ??= []);
  log.push({ ...observation, at: Date.now() });
  if (log.length > 200) log.splice(0, log.length - 200);
}

const NO_USAGE: JevUsage = { inputTokens: 0, outputTokens: 0 };

/** Bounded in-flight gate: past this the cloud starts queueing our requests anyway. */
class Admission {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  /** Resolves with a release function, or rejects once the search budget is spent. */
  acquire(deadlineAt: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return Promise.reject(new Error("admission_deadline"));
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          this.active += 1;
          resolve(() => this.release());
        },
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new Error("admission_deadline"));
        }, remaining),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    }
  }
}

type Counters = {
  calls: number;
  ok: number;
  retries: number;
  timeouts: number;
  rateLimited: number;
  serverErrors: number;
  networkErrors: number;
  unauthorized: number;
  breakerRejected: number;
  budgetExhausted: number;
  inputTokens: number;
  outputTokens: number;
};

const freshCounters = (): Counters => ({
  calls: 0,
  ok: 0,
  retries: 0,
  timeouts: 0,
  rateLimited: 0,
  serverErrors: 0,
  networkErrors: 0,
  unauthorized: 0,
  breakerRejected: 0,
  budgetExhausted: 0,
  inputTokens: 0,
  outputTokens: 0,
});

export type JevTimingOverrides = Partial<{
  connectMs: number;
  requestMs: number;
  rerankBudgetMs: number;
  classifyBudgetMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryCapMs: number;
  maxInFlight: number;
  failureThreshold: number;
  breakerCooldownMs: number;
  authCooldownMs: number;
  halfOpenProbes: number;
}>;

/** The measured defaults, or a test's fast clock. Same shape either way. */
type Timing = Required<JevTimingOverrides>;

export class JevCloudProvider implements JudgeProvider {
  readonly id = "jev" as const;
  readonly model: string;

  private readonly timing: Timing;
  private readonly breaker: CircuitBreaker;
  private readonly admission: Admission;
  private counters = freshCounters();
  private readonly latencies: number[] = [];
  private lastAnsweredModel: string | null = null;

  constructor(overrides: JevTimingOverrides = {}) {
    this.model = jevModel();
    this.timing = {
      connectMs: overrides.connectMs ?? JEV_TIMING.connectMs,
      requestMs: overrides.requestMs ?? JEV_TIMING.requestMs,
      rerankBudgetMs: overrides.rerankBudgetMs ?? JEV_TIMING.rerankBudgetMs,
      classifyBudgetMs: overrides.classifyBudgetMs ?? JEV_TIMING.classifyBudgetMs,
      maxAttempts: overrides.maxAttempts ?? JEV_TIMING.maxAttempts,
      retryBaseMs: overrides.retryBaseMs ?? JEV_TIMING.retryBaseMs,
      retryCapMs: overrides.retryCapMs ?? JEV_TIMING.retryCapMs,
      maxInFlight: overrides.maxInFlight ?? JEV_TIMING.maxInFlight,
      failureThreshold: overrides.failureThreshold ?? JEV_TIMING.breaker.failureThreshold,
      breakerCooldownMs: overrides.breakerCooldownMs ?? JEV_TIMING.breaker.cooldownMs,
      authCooldownMs: overrides.authCooldownMs ?? JEV_TIMING.breaker.authCooldownMs,
      halfOpenProbes: overrides.halfOpenProbes ?? JEV_TIMING.breaker.halfOpenProbes,
    };
    this.breaker = new CircuitBreaker({
      failureThreshold: this.timing.failureThreshold,
      cooldownMs: this.timing.breakerCooldownMs,
      authCooldownMs: this.timing.authCooldownMs,
      halfOpenProbes: this.timing.halfOpenProbes,
    });
    this.admission = new Admission(this.timing.maxInFlight);
  }

  configured(): boolean {
    return typesafeKey() !== null;
  }

  status(): ProviderStatus {
    return {
      provider: "jev",
      configured: this.configured(),
      model: this.model,
      endpoint: jevBaseUrl().replace(/^https:\/\//, ""),
      breaker: this.breaker.snapshot(),
      lastAnsweredModel: this.lastAnsweredModel,
      inFlight: this.admission.inFlight,
    };
  }

  stats(): ProviderStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (f: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] : null);
    return {
      ...this.counters,
      estimatedCostUsd: Math.round((this.counters.inputTokens + this.counters.outputTokens) * JEV_PRICE_PER_TOKEN * 1e6) / 1e6,
      latencyMs: { p50: at(0.5), p95: at(0.95), max: sorted.length ? sorted[sorted.length - 1] : null },
    };
  }

  /** Test seam: drop every counter and breaker state without rebuilding the singleton. */
  resetStats(): void {
    this.counters = freshCounters();
    this.latencies.length = 0;
    this.breaker.reset();
    this.lastAnsweredModel = null;
  }

  breakerSnapshot(): BreakerSnapshot {
    return this.breaker.snapshot();
  }

  async ask<T>(body: Record<string, unknown>, kind: BudgetKind, options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<JevCall<T>> {
    const startedOverall = Date.now();
    if (!this.configured()) return this.finish({ ok: false, outcome: "no_config", status: null, attempt: 0, latencyMs: 0, usage: NO_USAGE });

    const budgetMs = kind === "rerank" ? this.timing.rerankBudgetMs : this.timing.classifyBudgetMs;
    const deadlineAt = Math.min(options.deadlineAt ?? Number.POSITIVE_INFINITY, startedOverall + budgetMs);
    if (!this.breaker.allow()) {
      return this.finish({ ok: false, outcome: "breaker_open", status: null, attempt: 0, latencyMs: Date.now() - startedOverall, usage: NO_USAGE });
    }

    let release: () => void;
    try {
      release = await this.admission.acquire(deadlineAt);
    } catch {
      return this.finish({ ok: false, outcome: "admission_timeout", status: null, attempt: 0, latencyMs: Date.now() - startedOverall, usage: NO_USAGE });
    }

    try {
      let attempt = 0;
      let last: JevCall<T> = { ok: false, outcome: "network_error", status: null, attempt: 0, latencyMs: 0, usage: NO_USAGE };
      while (attempt < this.timing.maxAttempts) {
        attempt += 1;
        if (options.signal?.aborted) {
          return this.finish({ ok: false, outcome: "aborted", status: null, attempt, latencyMs: Date.now() - startedOverall, usage: NO_USAGE });
        }
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          last = { ok: false, outcome: "budget_exhausted", status: null, attempt, latencyMs: Date.now() - startedOverall, usage: NO_USAGE };
          break;
        }
        last = await this.attemptOnce<T>(body, kind, Math.min(this.timing.requestMs, remaining), Math.min(this.timing.connectMs, remaining), attempt, options.signal);
        if (last.ok) return this.finish(last);
        if (options.signal?.aborted) return this.finish({ ...last, outcome: "aborted" });
        if (!RETRYABLE_OUTCOMES.has(last.outcome)) break;
        if (attempt >= this.timing.maxAttempts) break;
        const wait = this.backoffMs(last.outcome, last, remaining);
        if (wait === null) break;
        this.counters.retries += 1;
        await sleep(wait);
      }
      return this.finish({ ...last, attempt });
    } finally {
      release();
    }
  }

  /** A 429 hint is honoured but never allowed to outlive the search budget. */
  private backoffMs(outcome: JevOutcome, call: JevCall<unknown>, remainingMs: number): number | null {
    void outcome;
    const exponential = Math.min(this.timing.retryCapMs, this.timing.retryBaseMs * 2 ** (Math.max(1, call.attempt) - 1));
    const jittered = Math.round(exponential * (0.75 + Math.random() * 0.5));
    const hint = "retryAfterMs" in call ? (call as { retryAfterMs?: number | null }).retryAfterMs ?? null : null;
    const wait = hint === null ? jittered : Math.max(jittered, hint);
    // Leave enough budget to actually use the retry; otherwise degrade now.
    if (remainingMs - wait < 400) return null;
    return wait;
  }

  private async attemptOnce<T>(
    body: Record<string, unknown>,
    kind: BudgetKind,
    requestMs: number,
    connectMs: number,
    attempt: number,
    parentSignal?: AbortSignal,
  ): Promise<JevCall<T>> {
    const key = typesafeKey();
    if (!key) return { ok: false, outcome: "no_config", status: null, attempt, latencyMs: 0, usage: NO_USAGE };
    const controller = new AbortController();
    let stage: "connect" | "request" = "connect";
    const connectTimer = setTimeout(() => {
      stage = "connect";
      controller.abort();
    }, Math.max(1, connectMs));
    const requestTimer = setTimeout(() => {
      stage = "request";
      controller.abort();
    }, Math.max(1, requestMs));
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const started = Date.now();
    try {
      const response = await fetch(jevBaseUrl(), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, ...body }),
        signal,
      });
      clearTimeout(connectTimer);
      if (!response.ok) {
        const latencyMs = Date.now() - started;
        const outcome = outcomeForStatus(response.status);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        // The provider's error text is never carried forward: it is untrusted and
        // §8 keeps secrets out of responses, telemetry and screenshots.
        await response.body?.cancel().catch(() => undefined);
        recordObservation({ outcome, status: response.status, attempt, durationMs: latencyMs, kind });
        return { ok: false, outcome, status: response.status, attempt, latencyMs, usage: NO_USAGE, ...(retryAfterMs !== null ? { retryAfterMs } : {}) } as JevCall<T>;
      }
      let parsed: SystemOneResponse<unknown>;
      try {
        parsed = (await response.json()) as SystemOneResponse<unknown>;
      } catch {
        const latencyMs = Date.now() - started;
        recordObservation({ outcome: "bad_response", status: response.status, attempt, durationMs: latencyMs, kind });
        return { ok: false, outcome: "bad_response", status: response.status, attempt, latencyMs, usage: NO_USAGE };
      }
      const latencyMs = Date.now() - started;
      const usage: JevUsage = { inputTokens: parsed.usage?.input_tokens ?? 0, outputTokens: parsed.usage?.output_tokens ?? 0 };
      this.lastAnsweredModel = parsed.model ?? this.lastAnsweredModel;
      recordObservation({ outcome: "ok", status: response.status, attempt, durationMs: latencyMs, kind });
      return { ok: true, data: parsed as T, outcome: "ok", model: parsed.model ?? null, attempt, latencyMs, usage };
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (parentSignal?.aborted) {
        recordObservation({ outcome: "aborted", status: null, attempt, durationMs: latencyMs, kind });
        return { ok: false, outcome: "aborted", status: null, attempt, latencyMs, usage: NO_USAGE };
      }
      // A refused host never got a connection, so it is not a timeout — the
      // distinction is what makes §20's DNS case nameable in the incident log.
      const transportFailure = isTransportError(error);
      const outcome: JevOutcome = transportFailure ? "network_error" : stage === "connect" ? "connect_timeout" : "timeout";
      recordObservation({ outcome, status: null, attempt, durationMs: latencyMs, kind });
      return { ok: false, outcome, status: null, attempt, latencyMs, usage: NO_USAGE };
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
    }
  }

  private finish<T>(call: JevCall<T>): JevCall<T> {
    this.counters.calls += 1;
    if (call.ok) {
      this.counters.ok += 1;
      this.counters.inputTokens += call.usage.inputTokens;
      this.counters.outputTokens += call.usage.outputTokens;
      this.latencies.push(call.latencyMs);
      if (this.latencies.length > 200) this.latencies.shift();
      this.breaker.recordSuccess();
      return call;
    }
    if (call.outcome === "timeout" || call.outcome === "connect_timeout") this.counters.timeouts += 1;
    if (call.outcome === "rate_limited") this.counters.rateLimited += 1;
    if (call.outcome === "server_error") this.counters.serverErrors += 1;
    if (call.outcome === "network_error") this.counters.networkErrors += 1;
    if (call.outcome === "unauthorized") this.counters.unauthorized += 1;
    if (call.outcome === "breaker_open") this.counters.breakerRejected += 1;
    if (call.outcome === "budget_exhausted" || call.outcome === "admission_timeout") this.counters.budgetExhausted += 1;
    if (call.outcome === "unauthorized") this.breaker.recordAuthFailure("unauthorized");
    else if (isProviderFailure(call.outcome)) this.breaker.recordFailure(call.outcome);
    return call;
  }
}

function isTransportError(error: unknown): boolean {
  const chain: unknown[] = [error];
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    chain.push((current as Error & { cause?: unknown }).cause);
    current = (current as Error & { cause?: unknown }).cause;
  }
  const text = chain.map((row) => (row instanceof Error ? `${(row as Error & { code?: string }).code ?? ""} ${row.name} ${row.message}` : String(row ?? ""))).join(" ");
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT|fetch failed/i.test(text);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, Math.round(seconds * 1000)));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(30_000, Math.max(0, date - Date.now())) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const registry = globalThis as unknown as { __jevProvider?: JevCloudProvider; __jevProviderOverride?: JudgeProvider | null };

export function getJevCloudProvider(): JevCloudProvider {
  registry.__jevProvider ??= new JevCloudProvider();
  return registry.__jevProvider;
}

/** Test seam: a deterministic provider, never the network. */
export function setJevProviderOverride(provider: JudgeProvider | null): void {
  registry.__jevProviderOverride = provider;
}

export function jevProvider(): JudgeProvider {
  return registry.__jevProviderOverride ?? getJevCloudProvider();
}

/**
 * Cache identity for the judge (§16). A search cache keyed only on the dataset
 * version keeps serving rankings computed by a model that is no longer there —
 * the alias `jev-latest` makes that a real event, not a hypothetical. Once the
 * cloud has answered, its reported version is part of the key, so a move under
 * the alias invalidates instead of persisting.
 */
export function judgeCacheIdentity(): string {
  const provider = getJevCloudProvider();
  const status = provider.status();
  if (!status.configured) return "judge:none";
  return `judge:${status.model}:${status.lastAnsweredModel ?? "unanswered"}:${status.endpoint.replace(/\./g, "-")}`;
}
