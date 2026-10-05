import { loadDataset } from "@/lib/companies";
import {
  isRegisteredJevCapability,
  JEV_CAPABILITY_REGISTRY,
  jevCapabilityDescriptor,
  runEvidenceExplanation,
  runSemanticComparison,
  runJevJudgement,
  subjectsOf,
  type EvidenceExplanationRequest,
  type JudgementSubject,
} from "@/lib/jev/capabilities";

/**
 * Internal Jev capability surface (Phase 3.3 §12) — NOT a product endpoint.
 *
 * The production search path (/api/discover, /api/search) keeps its exact
 * contract; this route is the internal/test surface where the relation,
 * comparison and explanation capabilities can be exercised without UI work.
 * It is a thin registry-gated dispatcher: an unregistered capability is a 400,
 * never an improvisation. Every call rides the same capability seam the
 * production path uses.
 *
 * Bodies:
 *   semantic_match / semantic_relation — routed deterministically:
 *     { query, codes?: string[] , subjects?: JudgementSubject[] }
 *   semantic_comparison:
 *     { comparisonQuery, codes?: string[] (≥2) | subjects?: JudgementSubject[] }
 *   evidence_explanation:
 *     { userQuery, judgement: JudgementRecord, evidence: [{ref, text}] }
 *
 * Degraded/rejected capability runs answer 200 with the honest status — this
 * surface reports states, it does not hide them.
 */

type Body = {
  capability?: unknown;
  query?: unknown;
  relationQuery?: unknown;
  comparisonQuery?: unknown;
  codes?: unknown;
  subjects?: unknown;
  userQuery?: unknown;
  judgement?: unknown;
  evidence?: unknown;
};

function subjectsFromBody(body: Body, codes: string[] | null): JudgementSubject[] | null {
  if (Array.isArray(body.subjects)) {
    const subjects: JudgementSubject[] = [];
    for (const row of body.subjects) {
      const item = row as { companyId?: unknown; name?: unknown; evidence?: unknown };
      if (typeof item?.companyId !== "string" || typeof item?.name !== "string" || !Array.isArray(item.evidence)) return null;
      const evidence = item.evidence
        .map((entry) => entry as { ref?: unknown; text?: unknown })
        .filter((entry): entry is { ref: string; text: string } => typeof entry?.ref === "string" && typeof entry?.text === "string");
      if (!evidence.length) return null;
      subjects.push({ companyId: item.companyId, name: item.name, evidence });
    }
    return subjects;
  }
  if (!codes) return null;
  const { companies } = loadDataset();
  const byCode = new Map(companies.map((company) => [company.code, company] as const));
  const subjects: JudgementSubject[] = [];
  for (const code of codes) {
    const company = byCode.get(code);
    if (!company) return null;
    subjects.push(subjectsOf([company])[0]);
  }
  return subjects;
}

export async function POST(request: Request) {
  const body = ((await request.json().catch(() => null)) as Body | null) ?? {};
  const capability = typeof body?.capability === "string" ? body.capability : "";
  if (!isRegisteredJevCapability(capability)) {
    return Response.json(
      {
        error: `未注册的 Jev capability：「${capability.slice(0, 40)}」。`,
        registry: JEV_CAPABILITY_REGISTRY,
      },
      { status: 400 },
    );
  }

  const codes = Array.isArray(body?.codes) ? body.codes.filter((code): code is string => typeof code === "string") : null;

  if (capability === "evidence_explanation") {
    const userQuery = typeof body?.userQuery === "string" ? body.userQuery : "";
    const judgement = body?.judgement as EvidenceExplanationRequest["judgement"] | undefined;
    const evidence = Array.isArray(body?.evidence)
      ? body.evidence
          .map((entry) => entry as { ref?: unknown; text?: unknown })
          .filter((entry): entry is { ref: string; text: string } => typeof entry?.ref === "string" && typeof entry?.text === "string")
      : [];
    if (!userQuery || !judgement?.companyId || !evidence.length) {
      return Response.json({ error: "evidence_explanation 需要 userQuery、judgement.companyId 与非空 evidence。" }, { status: 400 });
    }
    const result = await runEvidenceExplanation({ userQuery, judgement, evidence });
    return Response.json({ intelligence: { provider: result.status === "ok" ? "jev" : "none", capability, contractVersion: result.contractVersion, runtimeModel: result.runtimeModel }, result });
  }

  if (capability === "semantic_comparison") {
    const comparisonQuery = typeof body?.comparisonQuery === "string" ? body.comparisonQuery : "";
    const subjects = subjectsFromBody(body, codes);
    if (!comparisonQuery) return Response.json({ error: "semantic_comparison 需要 comparisonQuery。" }, { status: 400 });
    if (!subjects) return Response.json({ error: "semantic_comparison 需要 codes（≥2）或完整 subjects。" }, { status: 400 });
    if (subjects.length < 2) return Response.json({ error: "比较至少需要两个对象。" }, { status: 400 });
    const result = await runSemanticComparison({ comparisonQuery, subjects });
    return Response.json({ intelligence: { provider: result.status === "ok" ? "jev" : "none", capability, contractVersion: result.contractVersion, runtimeModel: result.runtimeModel }, result });
  }

  // semantic_match / semantic_relation — deterministically routed by the query.
  const query = typeof body?.query === "string" ? body.query : "";
  const subjects = subjectsFromBody(body, codes);
  if (!query) return Response.json({ error: "需要 query。" }, { status: 400 });
  if (!subjects) return Response.json({ error: "需要 codes 或完整 subjects。" }, { status: 400 });
  const result = await runJevJudgement(query, subjects);
  return Response.json({
    intelligence: {
      provider: result.status === "ok" ? "jev" : "none",
      capability: result.capability,
      contractVersion: result.contractVersion,
      runtimeModel: result.runtimeModel,
      routed: jevCapabilityDescriptor(result.capability)?.id,
    },
    result,
  });
}
