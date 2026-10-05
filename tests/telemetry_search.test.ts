import type { JudgeReport } from "../lib/types";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beginSearch, searchResponseReady, snapshotHash } from "../lib/telemetry/search";
import { detectSuspects, type SnapshotRow } from "../lib/telemetry/detectors";
import { TelemetryStore } from "../lib/telemetry/store";
import type { TelemetryEnvelope } from "../lib/telemetry/types";

function tmpStore(): TelemetryStore {
  return new TelemetryStore(mkdtempSync(path.join(tmpdir(), "telemetry-sr-")));
}

const row = (rank: number, code: string, grade: number | null, roles: string[] = [], matchedExclusionTypes: string[] = []): SnapshotRow => ({
  rank,
  code,
  name: `公司${code}`,
  grade,
  rerankerScore: (grade ?? 0) / 3,
  roles,
  matchedExclusionTypes,
});

function responseInput(overrides: Partial<Parameters<typeof searchResponseReady>[0]> = {}) {
  return {
    searchId: "s_test_000001",
    sessionId: "sess_test0000001",
    serverTotalMs: 300,
    queryParseMs: 1,
    retrievalMs: 20,
    rerankMs: 200,
    fusionMs: 1,
    degraded: false,
    degradedReason: null,
    fallbackUsed: null,
    decidedBy: "jev",
    judge: { provider: "jev", model: "jev-1.13.0", outcome: "ok" } as JudgeReport,
    matches: 8,
    actualJudgeModel: "jev-1.13.0",
    expectedJudgeModel: "jev-1.13.0",
    rerankRateLimited: 0,
    answeredChunks: 2,
    chunkCount: 2,
    breakerState: "closed",
    knowledgeVersion: "residual-knowledge-pass-v1.1",
    retrievalVersion: "v3-rrf60-profile-v3",
    organicEligibility: "CANDIDATE" as const,
    candidateCount: 200,
    fusedBeforeCap: 210,
    droppedByHardFilter: 10,
    bm25TopN: 200,
    vectorTopN: 200,
    vectorsFilePresent: true,
    exclusionTypes: [],
    normalizedQuery: "光刻胶材料公司",
    rerankTimeouts: 0,
    rerankErrors: 0,
    rerankRetries: 0,
    top: Array.from({ length: 10 }, (_, at) => row(at + 1, `00${at + 1}`, 3)),
    top200Hash: "abc123",
    jevSummary: { calls: 1, tokens: 1200, costUsd: 0.00005, latencyMs: 200 },
    jevValue: null,
    judgedByCode: null,
    ...overrides,
  };
}

async function readAll(store: TelemetryStore): Promise<TelemetryEnvelope[]> {
  const { events } = await store.readEvents();
  return events;
}

describe("search lifecycle events (§12)", () => {
  it("records SEARCH_RECEIVED for a normal organic search", async () => {
    const store = tmpStore();
    try {
      const { eligibility } = await beginSearch({
        searchId: "s_test_000002",
        rawQuery: "做光刻胶的公司",
        normalizedQuery: "做光刻胶的公司",
        origin: "organic_ui",
        sessionId: "sess_test0000001",
        cached: false,
        corrupt: false,
        store,
      });
      await store.flush();
      expect(eligibility).toBe("CANDIDATE");
      const events = await readAll(store);
      const received = events.find((event) => event.eventType === "SEARCH_RECEIVED");
      expect(received?.payload.requestOrigin).toBe("organic_ui");
      expect(received?.payload.queryHash).toBeTruthy();
      expect(received?.searchId).toBe("s_test_000002");
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });

  it("degraded Jev path writes JEV_UNAVAILABLE incident + retrieval fallback evidence", async () => {
    const store = tmpStore();
    try {
      await searchResponseReady(
        responseInput({ degraded: true, degradedReason: "server_error", fallbackUsed: "retrieval_blend", decidedBy: "retrieval", searchId: "s_test_000003", store }),
      );
      await store.flush();
      const events = await readAll(store);
      const response = events.find((event) => event.eventType === "SEARCH_RESPONSE_READY");
      expect(response?.payload.degraded).toBe(true);
      expect(response?.payload.degradedReason).toBe("server_error");
      expect(response?.payload.fallbackUsed).toBe("retrieval_blend");
      const incident = events.find((event) => event.eventType === "JEV_UNAVAILABLE");
      expect(incident).toBeTruthy();
      expect(incident?.payload.reason).toBe("server_error");
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });

  it("rerank timeouts write SEARCH_TIMEOUT incident + RERANK_TIMEOUT suspect", async () => {
    const store = tmpStore();
    try {
      await searchResponseReady(responseInput({ rerankTimeouts: 2, degraded: true, degradedReason: "timeout", fallbackUsed: "retrieval_blend", decidedBy: "retrieval", searchId: "s_test_000004", store }));
      await store.flush();
      const events = await readAll(store);
      expect(events.some((event) => event.eventType === "SEARCH_TIMEOUT")).toBe(true);
      const suspects = events.filter((event) => event.eventType === "SEARCH_QUALITY_SUSPECT");
      expect(suspects.map((event) => event.payload.kind)).toContain("RERANK_TIMEOUT");
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });

  it("a client-side 4xx degrades the search without calling it a service outage", async () => {
    const store = tmpStore();
    try {
      await searchResponseReady(
        responseInput({ degraded: true, degradedReason: "client_error", fallbackUsed: "retrieval_blend", decidedBy: "retrieval", searchId: "s_test_000005", store }),
      );
      await store.flush();
      const events = await readAll(store);
      expect(events.some((event) => event.eventType === "JEV_UNAVAILABLE")).toBe(false);
      expect(events.find((event) => event.eventType === "SEARCH_RESPONSE_READY")?.payload.degradedReason).toBe("client_error");
    } finally {
      rmSync(store.baseDir, { recursive: true, force: true });
    }
  });

  it("responds with a stable resultSnapshotHash for the same Top20", () => {
    const a = snapshotHash([row(1, "300001", 3), row(2, "300002", 2)]);
    const b = snapshotHash([row(1, "300001", 3), row(2, "300002", 2)]);
    const c = snapshotHash([row(1, "300001", 2), row(2, "300002", 2)]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("quality suspects (§29/§30) — observe only", () => {
  it("detects CMP device query flooded by material suppliers", () => {
    const suspects = detectSuspects({
      normalizedQuery: "CMP设备 化学机械抛光机厂商",
      exclusionTypes: [],
      candidateCount: 200,
      fusedBeforeCap: 210,
      droppedByHardFilter: 10,
      bm25TopN: 200,
      vectorTopN: 200,
      vectorsFilePresent: true,
      retrievalMs: 30,
      rerankMs: 200,
      rerankTimeouts: 0,
      rerankErrors: 0,
      rerankRetries: 0,
      graded: true,
      degraded: false,
      top: Array.from({ length: 10 }, (_, at) => row(at + 1, `00${at}`, 3, ["电子材料/抛光材料供应商"])),
    });
    expect(suspects.map((suspect) => suspect.kind)).toContain("CMP_DEVICE_MATERIAL_INTRUSION_SUSPECT");
  });

  it("detects family-noun supplier query flooded by design houses", () => {
    const suspects = detectSuspects({
      normalizedQuery: "芯片厂设备供应商",
      exclusionTypes: [],
      candidateCount: 200,
      fusedBeforeCap: 210,
      droppedByHardFilter: 10,
      bm25TopN: 200,
      vectorTopN: 200,
      vectorsFilePresent: true,
      retrievalMs: 30,
      rerankMs: 200,
      rerankTimeouts: 0,
      rerankErrors: 0,
      rerankRetries: 0,
      graded: true,
      degraded: false,
      top: Array.from({ length: 10 }, (_, at) => row(at + 1, `00${at}`, 3, ["芯片设计"])),
    });
    expect(suspects.map((suspect) => suspect.kind)).toContain("FAMILY_NOUN_ROLE_INTRUSION_SUSPECT");
  });

  it("stays silent when roles look right (no false yellow flag)", () => {
    const suspects = detectSuspects({
      normalizedQuery: "CMP设备 化学机械抛光机厂商",
      exclusionTypes: [],
      candidateCount: 200,
      fusedBeforeCap: 210,
      droppedByHardFilter: 10,
      bm25TopN: 200,
      vectorTopN: 200,
      vectorsFilePresent: true,
      retrievalMs: 30,
      rerankMs: 200,
      rerankTimeouts: 0,
      rerankErrors: 0,
      rerankRetries: 0,
      graded: true,
      degraded: false,
      top: Array.from({ length: 10 }, (_, at) => row(at + 1, `00${at}`, 3, ["半导体设备制造商"])),
    });
    expect(suspects.map((suspect) => suspect.kind)).not.toContain("CMP_DEVICE_MATERIAL_INTRUSION_SUSPECT");
  });

  it("flags retrieval health: empty, underfilled, filter overdrop, timeout, retry", () => {
    const base = {
      normalizedQuery: "铜资源公司",
      exclusionTypes: [],
      fusedBeforeCap: 0,
      droppedByHardFilter: 0,
      bm25TopN: 0,
      vectorTopN: 0,
      vectorsFilePresent: true,
      retrievalMs: 20,
      rerankMs: 100,
      rerankTimeouts: 0,
      rerankErrors: 0,
      rerankRetries: 0,
      graded: true,
      degraded: false,
      top: [] as SnapshotRow[],
    };
    const empty = detectSuspects({ ...base, candidateCount: 0 });
    expect(empty.map((suspect) => suspect.kind)).toContain("RETRIEVAL_EMPTY");
    expect(empty.map((suspect) => suspect.kind)).toContain("PROFILE_GAP_SUSPECT");

    const underfilled = detectSuspects({ ...base, candidateCount: 10, bm25TopN: 10, vectorTopN: 5, fusedBeforeCap: 12 });
    expect(underfilled.map((suspect) => suspect.kind)).toContain("RETRIEVAL_UNDERFILLED");

    const overdrop = detectSuspects({ ...base, candidateCount: 100, fusedBeforeCap: 5, droppedByHardFilter: 150, bm25TopN: 100, vectorTopN: 100 });
    expect(overdrop.map((suspect) => suspect.kind)).toContain("FILTER_OVERDROP");

    const latency = detectSuspects({ ...base, candidateCount: 200, bm25TopN: 200, vectorTopN: 200, fusedBeforeCap: 200, retrievalMs: 9000 });
    expect(latency.map((suspect) => suspect.kind)).toContain("RETRIEVAL_LATENCY_SPIKE");

    const retry = detectSuspects({ ...base, candidateCount: 200, bm25TopN: 200, vectorTopN: 200, fusedBeforeCap: 200, rerankRetries: 1 });
    expect(retry.map((suspect) => suspect.kind)).toContain("RERANK_RETRY");
  });

  it("flags exclusion failure when an excluded pattern reaches the top20", () => {
    const suspects = detectSuspects({
      normalizedQuery: "有铜矿的公司，不要铜加工",
      exclusionTypes: ["铜加工"],
      candidateCount: 200,
      fusedBeforeCap: 210,
      droppedByHardFilter: 10,
      bm25TopN: 200,
      vectorTopN: 200,
      vectorsFilePresent: true,
      retrievalMs: 20,
      rerankMs: 100,
      rerankTimeouts: 0,
      rerankErrors: 0,
      rerankRetries: 0,
      graded: true,
      degraded: false,
      top: [row(1, "300001", 3, [], ["铜加工"]), row(2, "300002", 3, [], [])],
    });
    expect(suspects.map((suspect) => suspect.kind)).toContain("EXCLUSION_FAILURE");
  });
});
