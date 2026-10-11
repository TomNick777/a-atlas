import { AsyncLocalStorage } from "node:async_hooks";
import type { JudgeProvider, JevOutcome } from "./contracts";

export type ProviderId = "jev" | "laya";
export type JudgeObservation = { outcome: JevOutcome; status: number | null; attempt: number; durationMs: number; kind: "rerank" | "classify"; at: number };
export type JudgeContext = { provider: JudgeProvider; identity: string | null; requestedModel: string; artifactSha: string | null; observations: JudgeObservation[] };
const state = globalThis as unknown as { __atlasJudgeContext?: AsyncLocalStorage<JudgeContext> };
export const judgeContext = state.__atlasJudgeContext ??= new AsyncLocalStorage<JudgeContext>();
export const currentJudgeContext = () => judgeContext.getStore();
const attempts = globalThis as unknown as { __atlasJudgeAttempts?: AsyncLocalStorage<JudgeObservation[]> };
export const judgeAttemptObservations = attempts.__atlasJudgeAttempts ??= new AsyncLocalStorage<JudgeObservation[]>();
