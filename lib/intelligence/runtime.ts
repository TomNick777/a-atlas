import { cloudProvider, drainSystemOneObservations as cloudObservations } from "./providers/jev/cloud";
import { LayaProvider } from "./providers/laya/provider";
import { judgeContext, currentJudgeContext, judgeAttemptObservations, type JudgeObservation, type ProviderId } from "./context";
import { JEV_PRICE_PER_TOKEN, JEV_TIMING, type BudgetKind, type JudgeProvider } from "./contracts";
export { JevCloudProvider, getJevCloudProvider, setJevProviderOverride } from "./providers/jev/cloud";
export type { SystemOneResponse, SystemOneObservation, JevTimingOverrides } from "./providers/jev/cloud";
const state = globalThis as unknown as { __atlasLaya?: LayaProvider };
export const getLayaProvider = () => state.__atlasLaya ??= new LayaProvider();
export function parseProvider(value: unknown): ProviderId {
  const id = value ?? process.env.ATLAS_JUDGE_PROVIDER ?? "jev";
  if (id !== "jev" && id !== "laya") throw new Error("provider must be jev or laya");
  return id;
}
function baseProvider(id: ProviderId): JudgeProvider { return id === "laya" ? getLayaProvider() : cloudProvider(); }
export async function withJudgeProvider<T>(id: unknown, operation: () => Promise<T>, expectedIdentity?: string): Promise<T> {
  const provider = baseProvider(parseProvider(id));
  if (provider.id === "laya") await getLayaProvider().refreshIdentity(true);
  const status = provider.status();
  const identity = status.lastAnsweredModel;
  if (expectedIdentity && identity !== expectedIdentity) throw new Error("original judge identity is unavailable");
  return judgeContext.run({ provider, identity: expectedIdentity ?? identity, requestedModel: status.model, artifactSha: status.artifactSha ?? null, observations: [] }, operation);
}
export function currentJudgeId(): ProviderId { return jevProvider().id; }
export function jevProvider(): JudgeProvider {
  const context = currentJudgeContext();
  const provider = context?.provider ?? baseProvider(parseProvider(undefined));
  if (!context) return provider;
  return { id: provider.id, get model() { return context.requestedModel; }, configured: () => provider.configured(), status: () => ({ ...provider.status(), model: context.requestedModel, lastAnsweredModel: context.identity, artifactSha: context.artifactSha }), stats: () => provider.stats(), async ask<T>(body: Record<string, unknown>, kind: BudgetKind, options?: { deadlineAt?: number; signal?: AbortSignal }) {
    const attempts: JudgeObservation[] = [];
    const call = await judgeAttemptObservations.run(attempts, () => provider.ask<T>(body, kind, options));
    context.observations.push(...(attempts.length ? attempts : [{ outcome: call.outcome, status: call.ok ? 200 : call.status, attempt: call.attempt, durationMs: call.latencyMs, kind, at: Date.now() }]));
    if (call.ok) {
      if (!call.model || (context.identity && context.identity !== call.model)) return { ok: false, outcome: "bad_response", status: 200, attempt: call.attempt, latencyMs: call.latencyMs, usage: call.usage };
      context.identity ??= call.model;
    }
    return call;
  } };
}
export function judgeCacheIdentity(): string {
  const status = jevProvider().status();
  return status.configured ? `judge:${status.provider}:${status.model}:${status.lastAnsweredModel ?? "unanswered"}:${status.artifactSha ?? "cloud"}:${status.endpoint}:adapter-1` : `judge:${status.provider}:unavailable`;
}
export function drainSystemOneObservations(since: number) {
  const context = currentJudgeContext();
  if (!context) return cloudObservations(since);
  const rows = context.observations.filter(row => row.at >= since); context.observations.splice(0); return rows;
}
export const judgeCost = (tokens: number): number | null => currentJudgeId() === "laya" || !tokens ? null : Math.round(tokens * JEV_PRICE_PER_TOKEN * 1e6) / 1e6;
export const judgeTiming = () => currentJudgeId() === "laya" ? { ...JEV_TIMING, rerankBudgetMs: 12000, classifyBudgetMs: 6000 } : JEV_TIMING;
export async function judgeProviders() {
  await getLayaProvider().refreshIdentity();
  return [cloudProvider(), getLayaProvider()].map(provider => { const s = provider.status(); return { id: provider.id, configured: s.configured, model: s.lastAnsweredModel, artifactSha: s.artifactSha ?? null, breaker: s.breaker.state, localResources: s.localResources ?? null, localTiming: provider.stats().localTiming ?? null }; });
}
