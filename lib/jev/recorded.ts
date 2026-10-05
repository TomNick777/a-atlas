/**
 * Recorded Jev transport — the fixture seam between Atlas and the cloud
 * (Phase 2.1 §8/§11/§12).
 *
 * Two halves, one module so capture and replay can never diverge:
 *
 *   TeeJudgeProvider    wraps the REAL cloud provider and records every ask()
 *                       body + response while the real call happens. Used only
 *                       by `npm run semantic:fixtures:refresh` to capture.
 *
 *   RecordedJudgeProvider answers ask() from recorded payloads. A request that
 *                       does not byte-match a recording throws — a missing or
 *                       drifted fixture is a FAIL, never a silent live call
 *                       (§8). The error message names the refresh command.
 *
 * Neither is ever on a production path; both exist so tests can drive the real
 * Jev adapter (askNoul parsing, score conversion, evidence contract) offline.
 */
import type { JevCall, JudgeProvider, ProviderStats, ProviderStatus } from "./provider";

/** Canonical JSON: stable key order so recorded bodies byte-match replays. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((row) => canonicalJson(row)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(",")}}`;
}

/** One recorded ask(): the exact request body and the exact cloud answer. */
export type RecordedCall = {
  kind: "rerank" | "classify";
  /** The request body exactly as askNoul/classify built it (pre-model merge). */
  request: Record<string, unknown>;
  /** The parsed SystemOneResponse the cloud answered with (ok calls only). */
  response: { model: string | null; answers: unknown; usage: { input_tokens: number; output_tokens: number } };
  /** Wire metadata kept for provenance, replayed verbatim. */
  meta: { latencyMs: number; inputTokens: number; outputTokens: number };
};

/**
 * Forwards every call to the real provider while recording ok answers.
 * Failures are forwarded untouched — capture only ever records healthy wire
 * shapes; fault shapes are synthesized in tests from real 200-responses.
 */
export class TeeJudgeProvider implements JudgeProvider {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly inner: JudgeProvider) {}

  readonly id = "jev" as const;
  get model(): string {
    return this.inner.model;
  }
  configured(): boolean {
    return this.inner.configured();
  }
  status(): ProviderStatus {
    return this.inner.status();
  }
  stats(): ProviderStats {
    return this.inner.stats();
  }

  async ask<T>(body: Record<string, unknown>, kind: "rerank" | "classify", options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<JevCall<T>> {
    const call = await this.inner.ask<T>(body, kind, options);
    if (call.ok) {
      const data = call.data as { model?: string | null; answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
      this.calls.push({
        kind,
        request: body,
        response: { model: call.model, answers: data.answers ?? {}, usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 } },
        meta: { latencyMs: call.latencyMs, inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens },
      });
    }
    return call;
  }
}

export type RecordedProviderOptions = { /** Diagnostic label used in mismatch errors. */ label?: string };

/**
 * Answers ask() from recordings. The judge adapter above this seam (askNoul's
 * parsing, conversion, chunk handling) is the REAL production code — only the
 * network is recorded. Any request that is not in the recording throws with
 * the refresh command (§8: fixture missing must FAIL, never fall through).
 */
export class RecordedJudgeProvider implements JudgeProvider {
  readonly id = "jev" as const;
  readonly model: string;
  private readonly byKey = new Map<string, RecordedCall>();

  constructor(recordings: RecordedCall[], options: RecordedProviderOptions = {}) {
    this.model = recordings[0]?.response.model ?? "jev-recorded";
    for (const call of recordings) {
      const key = `${call.kind}:${canonicalJson(call.request)}`;
      if (this.byKey.has(key)) throw new Error(`[jev-recorded] duplicate recording for one request (${options.label ?? "?"}) — recordings must be deduplicated`);
      this.byKey.set(key, call);
    }
  }

  configured(): boolean {
    return true;
  }

  status(): ProviderStatus {
    return {
      provider: "jev",
      configured: true,
      model: this.model,
      endpoint: "recorded-fixture",
      breaker: { state: "closed", consecutiveFailures: 0, openedAt: null, openUntil: null, trips: 0, lastTripReason: null },
      lastAnsweredModel: this.model,
      inFlight: 0,
    };
  }

  stats(): ProviderStats {
    const zero = { p50: null, p95: null, max: null } as const;
    return { calls: this.byKey.size, ok: this.byKey.size, retries: 0, timeouts: 0, rateLimited: 0, serverErrors: 0, networkErrors: 0, unauthorized: 0, breakerRejected: 0, budgetExhausted: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, latencyMs: zero };
  }

  async ask<T>(body: Record<string, unknown>, kind: "rerank" | "classify"): Promise<JevCall<T>> {
    const key = `${kind}:${canonicalJson(body)}`;
    const recorded = this.byKey.get(key);
    if (!recorded) {
      throw new Error(
        `[jev-recorded] no fixture covers this ${kind} request (${this.label ?? "unnamed"}). ` +
          `Unexpected Jev API access is forbidden in deterministic tests (§8/§14). ` +
          `Refresh committed fixtures with: npm run semantic:fixtures:refresh -- --query "<查询>" — or inject a FixtureSemanticProvider.`,
      );
    }
    return {
      ok: true,
      data: { model: recorded.response.model, answers: recorded.response.answers, usage: recorded.response.usage } as T,
      outcome: "ok",
      model: recorded.response.model,
      attempt: 1,
      latencyMs: recorded.meta.latencyMs,
      usage: { inputTokens: recorded.meta.inputTokens, outputTokens: recorded.meta.outputTokens },
    };
  }

  private label?: string;
  withLabel(label: string): this {
    this.label = label;
    return this;
  }
}
