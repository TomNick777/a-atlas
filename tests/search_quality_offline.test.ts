import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { measureSavedBoundary, parseCases, readSavedAnswer } from "../scripts/search-quality/offline";
import { privatePath } from "../scripts/search-quality/coordinates";

vi.mock("../lib/market/state", () => { throw new Error("Offline company measurement imported market state"); });
vi.mock("../lib/market/refresh", () => { throw new Error("Offline company measurement imported market refresh"); });

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function record(query = "合成产品", degraded = false) {
  const root = mkdtempSync(join(tmpdir(), "atlas-measure-")); directories.push(root);
  const id = "s_test_abcdef";
  const results = [true, false, true].map((matched, index) => ({
    code: `00000${index + 1}`, name: `合成公司${index + 1}`, probability: 0.9 - index * 0.1,
    industry: "合成业务", swLevel1Industry: "合成业务", province: "", business: "合成产品",
    judgement: { capability: "semantic_match", query, score: 0.9 - index * 0.1, matched, relationLabel: null,
      evidenceRefs: index === 2 ? [] : [{ companyId: `00000${index + 1}`, ref: `judge-profile:00000${index + 1}` }] },
  }));
  const payload = JSON.stringify({ answer: { query, searchId: id, results, execution: { degraded, decidedBy: degraded ? "retrieval" : "jev" } },
    runtimeModel: degraded ? null : "jev-1.13.0", corpusDigest: "synthetic-corpus", evidence: { "000001": [{ text: "历史合成原文" }] } });
  const file = join(root, `${id}.json`);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, id, payload, sha256: createHash("sha256").update(payload).digest("hex") }));
  return { root, id, query, file };
}

describe("offline mainline observation", () => {
  it("applies current eligibility to saved rows without re-judging or changing history", async () => {
    const row = record(); const before = readFileSync(row.file);
    const result = await measureSavedBoundary({ id: "synthetic", query: row.query, traceId: row.id }, row.root);
    expect(result).toMatchObject({ originalCount: 3, replayedCount: 1, removedCodes: ["000002", "000003"], replayedCodes: ["000001"], judgementMeasured: false });
    expect(result.originalEvidence).toEqual({ "000001": [{ text: "历史合成原文" }] });
    expect(readFileSync(row.file)).toEqual(before);
  });
  it("keeps saved degraded rows as retrieval observations without confirmed judgement", async () => {
    const row = record("合成产品", true);
    const result = await measureSavedBoundary({ id: "degraded", query: row.query, traceId: row.id }, row.root);
    expect(result.replayedCount).toBe(3);
    expect(result.judgementMeasured).toBe(false);
  });
  it("refuses the unchanged original market query at today's boundary", async () => {
    const row = record("今天涨幅前10的公司");
    const result = await measureSavedBoundary({ id: "scope", query: row.query, traceId: row.id }, row.root);
    expect(result.query).toBe(row.query);
    expect(result.replayedCount).toBe(0);
  });
  it("requires the exact original query, including case", () => {
    const row = record("SyntheticModel");
    expect(() => readSavedAnswer(row.id, "syntheticmodel", row.root)).toThrow("query/trace mismatch");
  });
  it("rejects corrupt saved evidence instead of regenerating it", () => {
    const row = record();
    const envelope = JSON.parse(readFileSync(row.file, "utf8")); envelope.payload += " ";
    writeFileSync(row.file, JSON.stringify(envelope));
    expect(() => readSavedAnswer(row.id, row.query, row.root)).toThrow("integrity");
  });
  it("preserves the computation id of a legitimate cached answer", async () => {
    const row = record(); const envelope = JSON.parse(readFileSync(row.file, "utf8")); const payload = JSON.parse(envelope.payload);
    payload.answer.searchId = "s_original_123abc";
    envelope.payload = JSON.stringify(payload); envelope.sha256 = createHash("sha256").update(envelope.payload).digest("hex");
    writeFileSync(row.file, JSON.stringify(envelope));
    const result = await measureSavedBoundary({ id: "cache", query: row.query, traceId: row.id }, row.root);
    expect(result).toMatchObject({ computedSearchId: "s_original_123abc", cacheReplay: true, judgementMeasured: false });
  });
  it("does not invent missing scores in a saved semantic answer", async () => {
    const row = record(); const envelope = JSON.parse(readFileSync(row.file, "utf8")); const payload = JSON.parse(envelope.payload);
    payload.answer.results[0].probability = null;
    envelope.payload = JSON.stringify(payload); envelope.sha256 = createHash("sha256").update(envelope.payload).digest("hex");
    writeFileSync(row.file, JSON.stringify(envelope));
    await expect(measureSavedBoundary({ id: "invalid", query: row.query, traceId: row.id }, row.root)).rejects.toThrow("original scores");
  });
  it.each(["../escape", "s_../../escape"])("rejects unsafe trace ids: %s", trace => {
    expect(() => readSavedAnswer(trace, "合成产品")).toThrow("trace id");
  });
  it("rejects private output paths outside allowed roots", () => {
    expect(() => privatePath("docs/results.json")).toThrow("reports/ or .local/");
    expect(() => privatePath("reports/../../outside.json")).toThrow();
    expect(privatePath("reports/quality/new-run")).toBe(resolve("reports/quality/new-run"));
  });
  it("keeps exact queries in case manifests", () => {
    expect(parseCases({ cases: [{ id: "case1", query: "SyntheticModel" }] })[0].query).toBe("SyntheticModel");
  });
  it.each([
    { cases: [] }, { cases: [{ id: "same", query: "合成产品" }, { id: "same", query: "合成产品" }] },
    { cases: [{ id: "query", query: " 合成产品 " }] }, { cases: [{ id: "target", query: "合成产品", targetCodes: ["SH000001"] }] },
  ])("refuses invalid or silently normalized manifests", input => {
    expect(() => parseCases(input)).toThrow();
  });
});
