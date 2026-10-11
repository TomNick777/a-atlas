import { POST as discover } from "../discover/route";

/** Historical result aliases over the one discovery pipeline. */
export async function POST(request: Request) {
  const response = await discover(request);
  if (!response.ok) return response;
  const answer = await response.json();
  return Response.json({
    ...answer,
    hits: answer.results,
    matches: answer.results.filter((row: { judgement?: { matched?: boolean } }) => row.judgement?.matched).length,
    degraded: answer.execution.degraded,
    decidedBy: answer.execution.decidedBy,
    judge: { provider: answer.intelligence?.provider ?? "none", model: answer.intelligence?.runtimeModel ?? null, outcome: answer.execution.degradedReason ?? (answer.intelligence ? "ok" : "not_requested") },
    tokens: answer.jevSummary?.tokens ?? null,
    costUsd: answer.jevSummary?.costUsd ?? null,
  }, { status: response.status, headers: response.headers });
}
