/**
 * Jev Cloud provider contract (Phase 4 §6).
 *
 * A-Atlas has exactly one judgement provider: the Jev cloud. There is no local
 * fallback and there must never be one — a silent second judge is how a
 * degraded search starts looking healthy. When Jev cannot answer, the search
 * answers from deterministic retrieval and says so (§10/§11).
 *
 * Every number in JEV_TIMING comes from `npm run jev:baseline`
 * (reports/acceptance/jev_baseline.json), not from a guess.
 */

export type JevOutcome =
  | "ok"
  /** The caller deliberately did not ask (retrieval-only benchmark runs). */
  | "not_requested"
  | "no_config"
  | "breaker_open"
  | "budget_exhausted"
  | "admission_timeout"
  | "connect_timeout"
  | "timeout"
  | "network_error"
  | "unauthorized"
  | "rate_limited"
  | "server_error"
  | "client_error"
  | "bad_response"
  | "aborted";

/** Read-only judgement calls may be retried; a 401 or a 422 will never change its mind. */
export const RETRYABLE_OUTCOMES: ReadonlySet<JevOutcome> = new Set(["timeout", "connect_timeout", "network_error", "rate_limited", "server_error"]);

export type JevUsage = { inputTokens: number; outputTokens: number };

export type JevCall<T> =
  | { ok: true; data: T; outcome: "ok"; model: string | null; attempt: number; latencyMs: number; usage: JevUsage }
  | { ok: false; outcome: JevOutcome; status: number | null; attempt: number; latencyMs: number; usage: JevUsage };

export type BudgetKind = "rerank" | "classify";

export type BreakerSnapshot = {
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAt: number | null;
  openUntil: number | null;
  trips: number;
  lastTripReason: string | null;
};

export type ProviderStatus = {
  provider: "jev";
  configured: boolean;
  model: string;
  endpoint: string;
  breaker: BreakerSnapshot;
  /** Model the cloud last answered with, from the response body — never inferred from config. */
  lastAnsweredModel: string | null;
  inFlight: number;
};

export type ProviderStats = {
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
  estimatedCostUsd: number;
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
};

export type JudgeProvider = {
  readonly id: "jev";
  readonly model: string;
  configured(): boolean;
  status(): ProviderStatus;
  stats(): ProviderStats;
  /**
   * Ask the judge. Never throws for provider-side reasons: an unavailable Jev
   * comes back as `{ok:false, outcome}` so the caller can degrade the search.
   * `budgetKind` picks the measured timeout pair; `deadlineAt` is the overall
   * search budget so one slow call cannot starve the rest of the request.
   */
  ask<T>(body: Record<string, unknown>, kind: BudgetKind, options?: { deadlineAt?: number; signal?: AbortSignal }): Promise<JevCall<T>>;
};

/**
 * Measured on 2026-09-28 against jev-1.13.0 with real Top-200 production pools:
 *   single batch   10 cand p50 271ms · 25 cand 301ms · 50 cand 338ms · 100 cand 370ms
 *                  (latency is dominated by fixed overhead — batch size barely matters)
 *   production 200 candidates = 2 chunks fired together: p50 539ms, p95/max 1358ms
 *   concurrency    4 in flight -> 2 fast + 2 queued at ~1080ms; 8 -> four at ~370ms and
 *                  four at ~1100ms; zero 429 at width 8. So the useful ceiling is ~4.
 *   failure paths  401 in 228ms, 422 in 222ms (both fast — no long timeout to hide behind)
 */
export const JEV_TIMING = {
  /** Headers must arrive by here. Covers TLS+edge handshake; error paths answer in <250ms. */
  connectMs: 2_500,
  /** One attempt, whole call. Observed max healthy 1356ms — ~3x headroom. */
  requestMs: 4_000,
  /** All rerank chunks + their retries together. Observed production p95 was 1358ms. */
  rerankBudgetMs: 6_000,
  /** Query understanding is one small call; same ceiling as a single batch. */
  classifyBudgetMs: 3_500,
  maxAttempts: 2,
  retryBaseMs: 180,
  retryCapMs: 600,
  /** Admission control: past ~4 in-flight the cloud queues us and latency triples. */
  maxInFlight: 4,
  breaker: {
    failureThreshold: 3,
    cooldownMs: 20_000,
    /** A bad key will not fix itself between searches: stay open longer. */
    authCooldownMs: 60_000,
    halfOpenProbes: 1,
  },
} as const;

/** USD per token, from the TypeSafe price sheet the pre-cloud baseline used. */
export const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

/**
 * The cloud model version A-Atlas production is certified against. `JEV_MODEL`
 * is an alias; this is the identity we expect to see come back in responses, so
 * a silent move under the alias becomes a nameable incident instead of a mystery.
 * Measured on 2026-09-28: `jev-latest` answered `jev-1.13.0` on 45/45 calls.
 */
export const JEV_PRODUCTION_MODEL = "jev-1.13.0";

export function expectedCloudModel(): string {
  return JEV_PRODUCTION_MODEL;
}

export type BreakerConfig = {
  failureThreshold: number;
  cooldownMs: number;
  authCooldownMs: number;
  halfOpenProbes: number;
};

export class CircuitBreaker {
  private state: BreakerSnapshot["state"] = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private openUntil: number | null = null;
  private trips = 0;
  private lastTripReason: string | null = null;
  private probesInFlight = 0;

  constructor(private readonly config: BreakerConfig) {}

  /** True when the call may go out. HALF_OPEN admits a bounded number of probes. */
  allow(now = Date.now()): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.openUntil !== null && now < this.openUntil) return false;
      this.state = "half_open";
      this.probesInFlight = 0;
    }
    if (this.probesInFlight >= this.config.halfOpenProbes) return false;
    this.probesInFlight += 1;
    return true;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.openUntil = null;
    this.probesInFlight = 0;
  }

  recordFailure(reason: string, now = Date.now()): void {
    if (this.state === "half_open") {
      this.trip(reason, this.config.cooldownMs, now);
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.config.failureThreshold) return;
    this.trip(reason, this.config.cooldownMs, now);
  }

  /** Misconfiguration is not a blip: one 401 opens the breaker for the long cooldown. */
  recordAuthFailure(reason: string, now = Date.now()): void {
    this.consecutiveFailures = this.config.failureThreshold;
    this.trip(reason, this.config.authCooldownMs, now);
  }

  private trip(reason: string, cooldownMs: number, now: number): void {
    this.state = "open";
    this.openedAt = now;
    this.openUntil = now + cooldownMs;
    this.trips += 1;
    this.lastTripReason = reason;
    this.probesInFlight = 0;
  }

  snapshot(now = Date.now()): BreakerSnapshot {
    // A pure read: an expired open window reads as half_open without consuming a probe slot.
    const state = this.state === "open" && this.openUntil !== null && now >= this.openUntil ? "half_open" : this.state;
    return {
      state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      openUntil: this.openUntil,
      trips: this.trips,
      lastTripReason: this.lastTripReason,
    };
  }

  /** Test seam: put the breaker in a known state without waiting out a cooldown. */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.openUntil = null;
    this.trips = 0;
    this.lastTripReason = null;
    this.probesInFlight = 0;
  }
}

/** Outcome from an HTTP status. 429/5xx are retryable inside the budget; 401 is not. */
export function outcomeForStatus(status: number): JevOutcome {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

/** Outcomes that mean "the cloud is hurt" and feed the breaker. */
const BREAKER_FAILURES: ReadonlySet<JevOutcome> = new Set(["timeout", "connect_timeout", "network_error", "server_error", "rate_limited"]);

export function isProviderFailure(outcome: JevOutcome): boolean {
  return BREAKER_FAILURES.has(outcome);
}
