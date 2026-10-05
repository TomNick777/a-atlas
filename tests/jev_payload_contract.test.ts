import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { judge } from "../lib/jev/judge";
import { RecordedJudgeProvider, type RecordedCall } from "../lib/jev/recorded";
import { setJevProviderOverride } from "../lib/jev/cloud";
import { loadDataset } from "../lib/companies";
import type { Company } from "../lib/types";

/**
 * Recorded payload contract tests (Phase 2.1 §11): the committed fixtures keep
 * the RAW SystemOne wire shapes, so the real adapter (askNoul's request build,
 * score extraction, missing-field behaviour, usage accounting) is verified
 * offline — FixtureSemanticProvider alone would bypass exactly this seam.
 */

type PayloadDoc = {
  fixtureSchema: string;
  query: string;
  operation: string;
  responseContract: string;
  provenance: { candidateCount: number; jevModelAnswered: string | string[]; [key: string]: unknown };
  request: { state: { looking_for: string; how_to_judge: string }; questions: Record<string, { type: string; instructions: { company: { name: string; code: string; profile: string } } }> };
  response: { model: string | null; answers: Record<string, { noul?: number }>; usage: { input_tokens: number; output_tokens: number } };
};

const loadDoc = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "fixtures/semantic/judge", name), "utf8")) as PayloadDoc;

function providerFor(doc: PayloadDoc): RecordedJudgeProvider {
  const call: RecordedCall = {
    kind: "rerank",
    request: doc.request as unknown as Record<string, unknown>,
    response: doc.response,
    meta: { latencyMs: 1, inputTokens: doc.response.usage.input_tokens, outputTokens: doc.response.usage.output_tokens },
  };
  return new RecordedJudgeProvider([call], { label: doc.query }).withLabel(doc.query);
}

/** Dataset companies in the exact recorded candidate order (identity + profile). */
function recordedCompanies(doc: PayloadDoc): Company[] {
  const universe = new Map(loadDataset().companies.map((company) => [company.code, company] as const));
  return Object.values(doc.request.questions).map((question) => {
    const company = universe.get(question.instructions.company.code);
    if (!company) throw new Error(`fixture candidate ${question.instructions.company.code} not in dataset — corpus moved, refresh fixtures`);
    return company;
  });
}

afterEach(() => setJevProviderOverride(null));

describe("recorded raw payload → judge adapter (H10 market-first subset)", () => {
  const doc = loadDoc("h10-subset.json");

  it("the recording is the real wire shape: 20 noul questions, jev-1.13.0 answers", () => {
    expect(doc.fixtureSchema).toBe("atlas-jev-judge-payload-fixture/1");
    expect(doc.responseContract).toBe("systemone-noul-v1");
    expect(Object.keys(doc.request.questions)).toHaveLength(20);
    expect(doc.provenance.candidateCount).toBe(20);
    // market-first wire order = market amount order (中际旭创, 新易盛 lead)
    const codes = Object.values(doc.request.questions).map((q) => q.instructions.company.code);
    expect(codes.slice(0, 2)).toEqual(["300308", "300502"]);
    expect(doc.response.model).toBe("jev-1.13.0");
    expect(doc.request.state.looking_for).toBe("光模块");
  });

  it("the adapter parses the recorded answers into the score contract, verbatim", async () => {
    setJevProviderOverride(providerFor(doc));
    const companies = recordedCompanies(doc);
    const verdict = await judge(doc.request.state.looking_for, companies);
    expect(verdict.live).toBe(true);
    expect(verdict.outcome).toBe("ok");
    expect(verdict.model).toBe("jev-1.13.0");
    expect(verdict.chunks).toBe(1);
    expect(verdict.scores).toHaveLength(20);
    for (const [index, question] of Object.values(doc.request.questions).entries()) {
      expect(verdict.scores[index]).toBe(doc.response.answers[`c${index}`]?.noul);
      expect(verdict.scores[index]).toBeGreaterThanOrEqual(0);
      expect(verdict.scores[index]).toBeLessThanOrEqual(1);
    }
    expect(verdict.tokens).toBe(doc.response.usage.input_tokens + doc.response.usage.output_tokens);
  });

  it("a missing answer degrades to the 0.5 neutral fill, never a fabricated score", async () => {
    const mutated: PayloadDoc = { ...doc, response: { ...doc.response, answers: Object.fromEntries(Object.entries(doc.response.answers).filter(([key]) => key !== "c3")) } };
    setJevProviderOverride(providerFor(mutated));
    const verdict = await judge(doc.request.state.looking_for, recordedCompanies(doc));
    expect(verdict.scores[3]).toBe(0.5);
    expect(verdict.scores[0]).toBe(doc.response.answers.c0?.noul);
  });

  it("an answer object without a noul value is the same neutral fill, never a fabricated score", async () => {
    // JSON-realistic drift only: a numeric wire cannot carry NaN, but an empty
    // answer object can arrive. The adapter's `?? 0.5` must catch it.
    const mutated: PayloadDoc = { ...doc, response: { ...doc.response, answers: { ...doc.response.answers, c5: {} } } };
    setJevProviderOverride(providerFor(mutated));
    const verdict = await judge(doc.request.state.looking_for, recordedCompanies(doc));
    expect(verdict.scores[5]).toBe(0.5);
    expect(verdict.scores[0]).toBe(doc.response.answers.c0?.noul);
  });
});

describe("recorded raw payload → judge adapter (H1 semantic rerank first chunk)", () => {
  const doc = loadDoc("h1-chunk1.json");

  it("the recording is a full 100-candidate rerank chunk of the real 机器人 query", () => {
    expect(Object.keys(doc.request.questions)).toHaveLength(100);
    expect(doc.provenance.candidateCount).toBe(100);
    expect(doc.request.state.looking_for).toBe("机器人");
    expect(doc.response.model).toBe("jev-1.13.0");
  });

  it("the adapter replays the whole chunk through the real parsing path", async () => {
    setJevProviderOverride(providerFor(doc));
    const verdict = await judge(doc.request.state.looking_for, recordedCompanies(doc));
    expect(verdict.live).toBe(true);
    expect(verdict.scores).toHaveLength(100);
    expect(Math.min(...verdict.scores)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...verdict.scores)).toBeLessThanOrEqual(1);
  });

  it("every recorded candidate still resolves in the committed dataset (corpus↔fixture coherence)", () => {
    expect(recordedCompanies(doc)).toHaveLength(100);
  });
});
