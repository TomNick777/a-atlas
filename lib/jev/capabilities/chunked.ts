/**
 * Shared chunk mechanics for capability calls (Phase 3.3).
 *
 * The two batching invariants the production judge has always had, kept
 * verbatim as capabilities moved in:
 *
 *   - chunks of ≤100 subjects fire together inside one shared budget;
 *   - a chunk that fails takes the median of the chunks that answered and the
 *     run is `live:false` — the caller degrades honestly, never silently.
 */
import type { JevOutcome } from "../provider";

export type ChunkResult = {
  ok: boolean;
  scores: number[] | null;
  tokens: number;
  model: string | null;
  outcome: JevOutcome;
  /** Answers missing/unusable for known subjects (diagnostics §13). */
  unexpected?: number;
  known?: boolean[];
};

export type ChunkedVerdict = {
  scores: number[];
  tokens: number;
  live: boolean;
  outcome: JevOutcome;
  model: string | null;
  chunks: number;
  answeredChunks: number;
  unexpected: number;
  /** Wall clock of the judgement calls (spec §17: never merged with prepare). */
  judgeMs: number;
  known: boolean[];
};

export async function runChunked<T>(
  subjects: T[],
  chunkSize: number,
  ask: (chunk: T[], options: { signal?: AbortSignal; deadlineAt?: number }) => Promise<ChunkResult>,
  options: { signal?: AbortSignal; deadlineAt?: number },
): Promise<ChunkedVerdict> {
  if (!subjects.length) return { scores: [], tokens: 0, live: true, outcome: "ok", model: null, chunks: 0, answeredChunks: 0, unexpected: 0, judgeMs: 0, known: [] };
  const parts: T[][] = [];
  for (let at = 0; at < subjects.length; at += chunkSize) parts.push(subjects.slice(at, at + chunkSize));
  const judgeStarted = performance.now();
  const verdicts = await Promise.all(parts.map((part) => ask(part, options)));
  const judgeMs = performance.now() - judgeStarted;
  const answered = verdicts.filter((verdict) => verdict.ok && verdict.scores);
  const got = answered.flatMap((verdict) => verdict.scores ?? []).sort((a, b) => a - b);
  const middle = got.length ? got[Math.floor(got.length / 2)] : 0.5;
  const failed = verdicts.find((verdict) => !verdict.ok);
  return {
    known: verdicts.flatMap((v, i) => parts[i].map((_, j) => Boolean(v.ok && v.scores && (v.known?.[j] ?? true)))),
    scores: verdicts.flatMap((verdict, index) => (verdict.ok && verdict.scores ? verdict.scores : parts[index].map(() => middle))),
    tokens: verdicts.reduce((sum, verdict) => sum + verdict.tokens, 0),
    live: answered.length === verdicts.length,
    outcome: answered.length === verdicts.length ? "ok" : (failed?.outcome ?? "network_error"),
    model: answered[0]?.model ?? null,
    chunks: verdicts.length,
    answeredChunks: answered.length,
    unexpected: verdicts.reduce((sum, verdict) => sum + (verdict.unexpected ?? 0), 0),
    judgeMs,
  };
}
