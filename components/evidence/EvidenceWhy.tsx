"use client";

import { useState } from "react";
import type { EvidenceView } from "@/lib/atlas/evidence";

/**
 * The grounded-explanation island (Level 3, on demand). Renders lines from
 * `/api/explain` — each line is a Jev-selected evidence quote, verbatim. The
 * island never composes explanation text itself: the states it can show are
 * the capability's own (ok / insufficient_evidence / unavailable) plus honest
 * transport failure. Copy says Jev 解释, never "AI 认为".
 */
export function EvidenceWhy({ q, code }: { q: string; code: string }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "unavailable" | "error">("idle");
  const [payload, setPayload] = useState<ExplainPayload | null>(null);

  const ask = async () => {
    setState("loading");
    try {
      const response = await fetch("/api/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q, code }),
      });
      const data = (await response.json()) as ExplainPayload & { error?: string };
      if (!response.ok) throw new Error(data.error || "解释暂不可用");
      setPayload(data);
      setState(data.explanation.status === "unavailable" ? "unavailable" : "ready");
    } catch {
      setState("error");
    }
  };

  if (state === "idle") {
    return (
      <button
        type="button"
        onClick={ask}
        className="mt-3 rounded-[4px] border border-[#ecb03444] px-2.5 py-1 text-[12px] text-[#b9954a] transition-colors duration-200 hover:border-[#ecb03488] hover:text-[#ecb034]"
      >
        为什么
      </button>
    );
  }

  return (
    <div className="mt-3 border-t border-[#ecb03422] pt-2.5">
      <p className="text-[11px] uppercase tracking-[0.14em] text-[#8d887c]">Jev 解释（逐字引用所选证据）</p>
      {state === "loading" && <p className="mt-2 text-[12.5px] text-[#8d887c]">正在向 Jev 求证……</p>}
      {state === "error" && <p className="mt-2 text-[12.5px] text-[#c2803f]">解释暂不可用。依据见上方资料。</p>}
      {state === "unavailable" && (
        <p className="mt-2 text-[12.5px] text-[#c2803f]">解释暂不可用（{unavailableReason(payload)}）。依据见上方资料。</p>
      )}
      {state === "ready" && payload && (
        <>
          {payload.explanation.status === "insufficient_evidence" ? (
            <p className="mt-2 text-[12.5px] leading-5 text-[#c2803f]">证据不足：所给资料不足以支持这个判断。</p>
          ) : (
            <ol className="mt-2 flex flex-col gap-2">
              {payload.explanation.lines.map((line) => (
                <li key={line.ref} className="text-[12.5px] leading-5 text-[#f4f1ea]">
                  「{line.quote}」
                </li>
              ))}
            </ol>
          )}
          <details className="mt-2.5 text-[10.5px] text-[#6f6a5f]">
            <summary className="cursor-pointer select-none">技术细节</summary>
            <p className="mt-1 leading-4">
              contract {payload.explanation.contractVersion ?? "—"} · runtime {payload.explanation.runtimeModel ?? "—"}
            </p>
          </details>
        </>
      )}
    </div>
  );
}

function unavailableReason(payload: ExplainPayload | null): string {
  if (!payload) return "未知原因";
  const reason = payload.explanation.reason;
  if (reason === "not_judged") return "本次搜索没有留下 Jev 判断";
  if (reason === "search_expired") return "搜索结果已过期，重新搜索后再试";
  if (reason === "not_in_answer") return "这家公司不在本次搜索结果里";
  if (reason) return `Jev 未应答（${reason}）`;
  return "Jev 未应答";
}

type ExplainPayload = {
  code: string;
  name: string;
  judgement: {
    capability: "semantic_match" | "semantic_relation";
    query: string;
    score: number;
    matched: boolean;
    relationLabel: string | null;
  } | null;
  evidence: EvidenceView[] | null;
  explanation: {
    status: "ok" | "insufficient_evidence" | "unavailable";
    lines: { ref: string; quote: string }[];
    contractVersion: string | null;
    runtimeModel: string | null;
    reason: string | null;
  };
};
