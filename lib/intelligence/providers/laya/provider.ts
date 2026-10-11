import { CircuitBreaker, JEV_TIMING, type BudgetKind, type JevCall, type JudgeProvider, type ProviderStats, type ProviderStatus } from "../../contracts";

type Health = { ok: boolean; service?: string; lane?: string; model?: string; sha16?: string; checkpointPath?: string; pid?: number; device?: string; cuda?: boolean; vram?: { usedMb: number; totalMb: number; peakAllocMb: number } };
const blank = (): ProviderStats => ({ calls: 0, ok: 0, retries: 0, timeouts: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, unauthorized: 0, breakerRejected: 0, budgetExhausted: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: { p50: null, p95: null, max: null } });

/** A local endpoint is explicit; absence or failure never calls another judge. */
export class LayaProvider implements JudgeProvider {
  readonly id = "laya" as const;
  private health: Health | null = null;
  private checkedAt = 0;
  private healthCall: Promise<void> | null = null;
  private active = 0;
  private counters: ProviderStats = { ...blank(), localTiming: { admittedCalls: 0, queueMs: 0, executionMs: 0 } };
  private readonly breaker = new CircuitBreaker(JEV_TIMING.breaker);
  private readonly latencies: number[] = [];
  readonly endpoint: string;
  private readonly validEndpoint: boolean;
  constructor(endpoint = process.env.LAYA_URL?.trim() || "http://127.0.0.1:8787") {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid local endpoint");
      this.endpoint = url.origin; this.validEndpoint = true;
    } catch { this.endpoint = "invalid-local-endpoint"; this.validEndpoint = false; }
  }
  get model(): string { return this.health?.model ?? "laya:unverified"; }
  configured() { return this.health?.ok === true && Boolean(this.health.sha16 && this.health.model); }
  async refreshIdentity(force = false): Promise<void> {
    if (!this.validEndpoint) { this.health = null; return; }
    if (!force && Date.now() - this.checkedAt < 2000) return;
    if (this.healthCall) return this.healthCall;
    this.healthCall = (async () => {
      try {
        const response = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
        const health = response.ok ? await response.json() as Health : null;
        const allowedLane = health?.lane === "production" || health?.lane === "evaluation" && process.env.ATLAS_LAYA_EVALUATION === "1";
        this.health = health?.service === "a-atlas-laya" && allowedLane && health.ok && /^[a-f0-9]{16}$/.test(health.sha16 ?? "") && typeof health.model === "string" ? health : null;
      } catch { this.health = null; }
      this.checkedAt = Date.now();
    })();
    try { await this.healthCall; } finally { this.healthCall = null; }
  }
  status(): ProviderStatus { return { provider: this.id, configured: this.configured(), model: this.model, endpoint: this.endpoint, breaker: this.breaker.snapshot(), lastAnsweredModel: this.health?.model ?? null, inFlight: this.active, artifactSha: this.health?.sha16 ?? null, localResources: { device: this.health?.device ?? null, cuda: this.health?.cuda ?? null, vram: this.health?.vram ?? null } }; }
  stats(): ProviderStats { return { ...this.counters, latencyMs: { ...this.counters.latencyMs } }; }
  async ask<T>(body: Record<string, unknown>, kind: BudgetKind, options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<JevCall<T>> {
    const started = Date.now();
    const fail = (outcome: Exclude<JevCall<T>, { ok: true }>["outcome"], status: number | null = null): JevCall<T> => ({ ok: false, outcome, status, attempt: 1, latencyMs: Date.now() - started, usage: { inputTokens: 0, outputTokens: 0 } });
    await this.refreshIdentity();
    if (!this.configured()) return fail("no_config");
    if (!this.breaker.allow()) return fail("breaker_open");
    const expected = this.model;
    const deadline = Math.min(options.deadlineAt ?? Infinity, started + (kind === "rerank" ? 12000 : 6000));
    // Only one GPU batch enters at a time. Queued work has the same deadline.
    while (this.active) {
      if (options.signal?.aborted) return fail("aborted");
      if (Date.now() >= deadline) return fail("admission_timeout");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail("budget_exhausted");
    this.active++; this.counters.calls++;
    const admittedAt = Date.now();
    this.counters.localTiming!.admittedCalls++;
    this.counters.localTiming!.queueMs += admittedAt - started;
    try {
      const response = await fetch(`${this.endpoint}/v1/systemone`, { method: "POST", headers: { "content-type": "application/json", "x-deadline-at": String(deadline), ...(process.env.ATLAS_LAYA_EVALUATION === "1" ? { "x-atlas-laya-purpose": "evaluation" } : {}) }, body: JSON.stringify({ ...body, model: expected }), signal: AbortSignal.any([AbortSignal.timeout(remaining), ...(options.signal ? [options.signal] : [])]) });
      if (!response.ok) { this.breaker.recordFailure("server_error"); this.counters.serverErrors++; return fail(response.status >= 500 ? "server_error" : "client_error", response.status); }
      const data = await response.json() as { model?: string; answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
      if (!data.answers || data.model !== expected) { this.health = null; return fail("bad_response"); }
      const usage = { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 };
      if (![usage.inputTokens, usage.outputTokens].every(value => Number.isInteger(value) && value >= 0)) return fail("bad_response");
      this.counters.ok++; this.counters.inputTokens += usage.inputTokens; this.breaker.recordSuccess();
      this.latencies.push(Date.now() - started); if (this.latencies.length > 200) this.latencies.shift();
      const sorted = [...this.latencies].sort((a,b) => a-b);
      this.counters.latencyMs = { p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.min(sorted.length-1, Math.floor(sorted.length*.95))], max: sorted.at(-1)! };
      return { ok: true, data: data as T, model: expected, outcome: "ok", attempt: 1, latencyMs: Date.now() - started, usage };
    } catch (error) {
      if (options.signal?.aborted) return fail("aborted");
      const outcome = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error";
      this.counters[outcome === "timeout" ? "timeouts" : "networkErrors"]++; this.breaker.recordFailure(outcome); return fail(outcome);
    } finally { this.counters.localTiming!.executionMs += Date.now() - admittedAt; this.active--; }
  }
}
