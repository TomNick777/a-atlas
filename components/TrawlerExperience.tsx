"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { ResultJudgement, SearchTrace } from "@/lib/types";
import type { EvidenceView, HybridDiscoverPresented } from "@/lib/atlas/evidence";
import { getSessionId, trackClientEvent } from "@/lib/telemetry/client";

const sessionIdHeader = () => getSessionId();
import { CompanyFloor, type FloorApi, type Plate, type PlateHover, type PlateOpen } from "./CompanyFloor";
import { EvidencePeek, type PeekState } from "./evidence/EvidencePeek";
import { Inspector } from "./debug/Inspector";
import { SearchComposer } from "./SearchComposer";
import { SearchFeedback } from "./SearchFeedback";
import { SettingsPanel } from "./SettingsPanel";
import {
  DEFAULT_CARD_FACE,
  DEFAULT_CARD_THEME,
  readCardFace,
  readCardTheme,
  subscribeCardFace,
  subscribeCardTheme,
  writeCardFace,
  writeCardTheme,
  type CardFace,
  type CardTheme,
} from "./floor/theme";

export function TrawlerExperience({ plates, universeCount }: { plates: Plate[]; universeCount: number }) {
  const floor = useRef<FloorApi | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [judgeDegraded, setJudgeDegraded] = useState<string | null>(null);
  // Phase 2: the machine-parsed plan caption ("why this rank") rides under the composer.
  const [planCaption, setPlanCaption] = useState<string | null>(null);
  const [trace, setTrace] = useState<SearchTrace | null>(null);
  // Phase 3.4 evidence UX: judgement + resolved evidence per result code, and
  // the hover peek state (Level 2). Facts ride from the presented response;
  // the UI never derives or selects evidence itself.
  const [evidenceByCode, setEvidenceByCode] = useState<Map<string, { judgement: ResultJudgement | null; evidence: EvidenceView[] | null }>>(new Map());
  const [peek, setPeek] = useState<PeekState | null>(null);
  // §10: the judge being unavailable is a fact the user is told, not a silent fallback.
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Server snapshot is the classic default; the client snapshot reads localStorage.
  const theme = useSyncExternalStore(subscribeCardTheme, readCardTheme, () => DEFAULT_CARD_THEME);
  const face = useSyncExternalStore(subscribeCardFace, readCardFace, () => DEFAULT_CARD_FACE);
  const request = useRef<AbortController | null>(null);
  const lastQuery = useRef("");
  const lastKey = useRef(0);
  const lastSearchId = useRef<string | null>(null);
  // §8 反馈行按渲染读取（refs 不能在渲染期读）：最近一次完成搜索的 id 与 query。
  const [lastDone, setLastDone] = useState<{ searchId: string | null; query: string } | null>(null);

  const setTheme = useCallback((next: CardTheme) => {
    writeCardTheme(next);
  }, []);

  const setFace = useCallback((next: CardFace) => {
    writeCardFace(next);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((text: string, tone: "ok" | "error") => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2_000);
  }, []);

  const anchor = useCallback(() => {
    const box = bar.current?.getBoundingClientRect();
    return { x: (box?.left ?? 0) + (box?.width ?? window.innerWidth) / 2, above: box?.top ?? window.innerHeight / 2 };
  }, []);

  const run = useCallback(
    async (raw: string) => {
      const query = raw.trim();
      if (query.length < 2) return;
      if (query === lastQuery.current && phase === "done") return;
      const resultsWereVisible = phase === "done";
      lastQuery.current = query;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setPhase("searching");
      setNotice(null);
      setJudgeDegraded(null);
      setPlanCaption(null);
      setPeek(null);
      const searchStart = performance.now();
      try {
        const response = await fetch("/api/discover", {
          method: "POST",
          headers: { "content-type": "application/json", "x-session-id": sessionIdHeader() },
          body: JSON.stringify({ query, sessionId: sessionIdHeader() }),
          signal: controller.signal,
        });
        const data = (await response.json()) as HybridDiscoverPresented & { error?: string; ms?: number };
        if (!response.ok) throw new Error(data.error || "搜索失败");
        lastSearchId.current = data.searchId ?? null;
        setLastDone({ searchId: data.searchId ?? null, query });
        if (resultsWereVisible) trackClientEvent("SEARCH_REQUERY", { query }, data.searchId);
        setTrace((data as unknown as { trace?: SearchTrace }).trace ?? null);
        setPeek(null);
        // Evidence index (Phase 3.4): verbatim, backend-resolved — the UI only
        // looks it up, never selects or summarizes.
        setEvidenceByCode(new Map(data.results.map((row) => [row.code, { judgement: row.judgement ?? null, evidence: row.evidence ?? null }])));
        // §10/§11: a degraded answer (judge unavailable) is labelled, never hidden.
        if (data.execution.degraded && data.execution.degradedReason && (data.intelligence?.degraded || data.execution.decidedBy === "retrieval")) setJudgeDegraded(data.execution.degradedReason);
        // The plan caption is the rank authority in words ("why this rank").
        if (data.planCaption) setPlanCaption(data.planCaption);
        if (data.plan.unsupported) {
          floor.current?.release();
          setNotice(data.planCaption || "这个查询超出了当前能力。");
          setPhase("done");
          return;
        }
        // Pure discovery keeps its client contract; hybrid results arrive in
        // final server order (the market metric decides the rank) and carry
        // the plan's hero metric for the card. The Level-1 hint line shows
        // only on judgement-backed rows: deterministic term hits from the
        // judge profile, verbatim — never Jev prose, never a degraded row.
        const hintOf = (row: (typeof data.results)[number]): string | null => {
          if (!row.judgement || row.hero?.formatted) return null;
          const terms = (row.semantic?.matchedFacts ?? []).slice(0, 2);
          return terms.length ? terms.join(" · ") : null;
        };
        const matches =
          data.execution.order === "semantic-only"
            ? [...data.results]
                .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))
                .map((row) => ({ code: row.code, name: row.name, probability: row.probability, industry: row.swLevel1Industry ?? row.industry ?? undefined, hint: hintOf(row) }))
            : data.results.map((row, rank) => ({
                code: row.code,
                name: row.name,
                probability: row.probability,
                industry: row.swLevel1Industry ?? row.industry ?? undefined,
                hero: row.hero ? `#${row.rank ?? rank + 1} ${row.hero.label} ${row.hero.formatted}` : `#${row.rank ?? rank + 1}`,
                hint: hintOf(row),
              }));
        const clientTotalMs = Math.round(performance.now() - searchStart);
        // Time To Visible Results (§22): measured at the paint after state applied.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            trackClientEvent(
              matches.length ? "SEARCH_RESULTS_VISIBLE" : "SEARCH_RENDERED",
              {
                serverMs: data.ms ?? null,
                clientTotalMs,
                timeToVisibleResultsMs: Math.round(performance.now() - searchStart),
                matches: matches.length,
                executionOrder: data.execution.order,
              },
              data.searchId,
            );
            if (matches.length)
              trackClientEvent(
                "SEARCH_RENDERED",
                { serverMs: data.ms ?? null, clientTotalMs, matches: matches.length, executionOrder: data.execution.order },
                data.searchId,
              );
          }),
        );
        if (!matches.length) {
          floor.current?.release();
          setNotice(data.planCaption || "没有足够接近的公司。");
          setPhase("done");
          return;
        }
        floor.current?.select(matches, anchor);
        setPhase("done");
      } catch (error) {
        if (controller.signal.aborted) return;
        setPhase("error");
        setNotice(error instanceof Error ? error.message : "搜索失败");
      }
    },
    [anchor, phase],
  );

  const onType = useCallback(
    (value: string) => {
      if (phase !== "idle") {
        if (value && lastSearchId.current) trackClientEvent("SEARCH_EDIT_AFTER_RESULTS", { query: value }, lastSearchId.current);
        floor.current?.release();
        request.current?.abort();
        lastQuery.current = "";
        setPhase("idle");
        setNotice(null);
        setJudgeDegraded(null);
        setPlanCaption(null);
        setPeek(null);
      }
      setText(value);
      const now = performance.now();
      const gap = now - lastKey.current;
      lastKey.current = now;
      if (gap < 1200) floor.current?.shake(Math.min(1, 90 / Math.max(gap, 50)));
    },
    [phase],
  );

  const onClear = useCallback(() => {
    if (lastSearchId.current) trackClientEvent("SEARCH_CLEAR", {}, lastSearchId.current);
    onType("");
  }, [onType]);

  // 停止键：abort 让 run() 走 aborted 分支静默返回，这里负责把界面拉回空闲。
  const stop = useCallback(() => {
    request.current?.abort();
    floor.current?.release();
    setPhase("idle");
    setNotice(null);
    setJudgeDegraded(null);
    setPlanCaption(null);
    setPeek(null);
    if (lastSearchId.current) trackClientEvent("SEARCH_STOP", {}, lastSearchId.current);
  }, []);

  /** 点公司牌进公司页；带着来源查询、匹配度与能力种类，URL 可刷新恢复（§十二.6）。 */
  const onPlateOpen = useCallback(
    (plate: PlateOpen) => {
      trackClientEvent(
        "RESULT_OPEN_DETAIL",
        { code: plate.code, name: plate.name, query: lastQuery.current || null, probability: plate.probability },
        lastSearchId.current,
      );
      const context = new URLSearchParams();
      if (lastQuery.current) context.set("q", lastQuery.current);
      if (plate.probability !== null) context.set("m", plate.probability.toFixed(4));
      // The capability rides along so the company page labels the judgement
      // honestly (match vs relation) without re-deriving it.
      const capability = evidenceByCode.get(plate.code)?.judgement?.capability;
      if (capability === "semantic_relation") context.set("c", "relation");
      const suffix = context.toString() ? `?${context.toString()}` : "";
      router.push(`/stock/${plate.code}${suffix}`);
    },
    [router, evidenceByCode],
  );

  /** Level-2 peek: hover 事件只带身份与坐标，证据从本次响应的索引里取。 */
  const onPlateHover = useCallback(
    (plate: PlateHover | null) => {
      if (!plate) return setPeek(null);
      const info = evidenceByCode.get(plate.code);
      setPeek({ plate, at: plate.at, judgement: info?.judgement ?? null, evidence: info?.evidence ?? null });
    },
    [evidenceByCode],
  );

  return (
    <>
      <CompanyFloor
        plates={plates}
        theme={theme}
        face={face}
        apiRef={floor}
        onPlateOpen={onPlateOpen}
        onPlateHover={onPlateHover}
      />
      <EvidencePeek peek={peek} />
      <div className="pointer-events-none fixed inset-0 z-10">
        <div ref={bar} className="pointer-events-auto absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <SearchComposer value={text} busy={phase === "searching"} onChange={onType} onSubmit={run} onClear={onClear} onStop={stop} />
          {/* §8 轻量反馈：一行文字，只读者主动点才发送，不打扰搜索。 */}
          <SearchFeedback searchId={phase === "done" ? lastDone?.searchId ?? null : null} query={lastDone?.query ?? ""} />
          <p className="pointer-events-none absolute top-full right-1 mt-2 w-[min(90vw,620px)] text-right text-[12px] leading-5 text-[#8d887c]">
            {planCaption && <span className="mt-0.5 block text-[#a8a294]">{planCaption}</span>}
            {universeCount.toLocaleString()} 家 A 股公司
            <span className="mt-0.5 block">公司发现，不是投资建议</span>
            {judgeDegraded && <span className="mt-0.5 block text-[#c2803f]">语义判断服务暂不可用，当前结果使用基础检索排序</span>}
          </p>
        </div>
        {notice && (
          <p className="absolute top-[calc(50%+64px)] left-1/2 -translate-x-1/2 rounded-[5px] border border-white/15 bg-[#12140f] px-4 py-2 text-[13px] text-[#d9d4c8]">
            {notice}
          </p>
        )}
        {toast && (
          <p
            className={`absolute bottom-8 left-1/2 -translate-x-1/2 rounded-[5px] border px-4 py-2 text-[13px] ${
              toast.tone === "ok"
                ? "border-white/15 bg-[#12140f] text-[#d9d4c8]"
                : "border-[#c2803f]/50 bg-[#12140f] text-[#c2803f]"
            }`}
          >
            {toast.text}
          </p>
        )}
        <SettingsPanel theme={theme} onSelectTheme={setTheme} face={face} onSelectFace={setFace} />
      </div>
      <Inspector trace={trace} />
    </>
  );
}
