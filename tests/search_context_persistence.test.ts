import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AnswerRecord } from "../lib/atlas/discoverCache";
import { recordedSearchContext } from "../lib/atlas/searchContext";

// Reading a historical answer must not consult the current model/corpus/market.
vi.mock("../lib/companies", () => ({ loadDataset: () => { throw new Error("current corpus read"); } }));
vi.mock("../lib/atlas/evidence", () => ({ evidenceViewsFor: () => { throw new Error("current evidence read"); } }));
vi.mock("../lib/intelligence/capabilities", () => ({ MARKET_ELIGIBILITY_VERSION: "test", currentJudgeId: () => { throw new Error("current judge read"); }, judgeCacheIdentity: () => { throw new Error("current judge identity read"); } }));
vi.mock("../lib/market/state", () => ({ loadMarketStateManifest: () => { throw new Error("current market read"); } }));

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("atlas-m5-")) throw new Error("unexpected cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});

it("restores exact records after a cold module load, including cache-alias trace ids, without current state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "atlas-m5-"));
  roots.push(root);
  vi.stubEnv("ATLAS_ANSWER_ROOT", root);
  const ids = ["s_m5old_aaaaaa", "s_m5new_bbbbbb"];
  const records = ids.map((id, index) => ({
    provider: index === 0 ? "jev" : "drex", runtimeModel: `recorded-${index}`, evidence: {},
    answer: { searchId: "original-cache-trace", query: "同一句查询", planCaption: `原榜单${index}`, execution: { degraded: false, decidedBy: "market" }, results: [{ code: "000001", rank: 7 + index, market: { tradeDate: `2026-10-${10 + index}` }, hero: null, judgement: null }] },
  } as unknown as AnswerRecord));
  records.forEach((record, index) => {
    const payload = JSON.stringify(record);
    writeFileSync(path.join(root, `${ids[index]}.json`), JSON.stringify({ schemaVersion: 1, id: ids[index], sha256: createHash("sha256").update(payload).digest("hex"), payload }));
  });
  vi.resetModules();
  const { lookupAnswerRecord } = await import("../lib/atlas/discoverCache");
  for (const [index, id] of ids.entries()) {
    const record = lookupAnswerRecord(id, "同一句查询");
    expect(record).toEqual(records[index]);
    expect(recordedSearchContext({ searchId: id, query: "同一句查询", code: "000001", record })).toMatchObject({ status: "available", rank: 7 + index, marketDate: `2026-10-${10 + index}` });
  }
  expect(lookupAnswerRecord(ids[0], "篡改查询")).toBeUndefined();
  const corruptId = "s_m5bad_cccccc";
  writeFileSync(path.join(root, `${corruptId}.json`), JSON.stringify({ schemaVersion: 1, id: corruptId, sha256: "bad", payload: JSON.stringify(records[0]) }));
  expect(lookupAnswerRecord(corruptId, "同一句查询")).toBeUndefined();
  expect(lookupAnswerRecord("s_missing_dddddd", "同一句查询")).toBeUndefined();
});
