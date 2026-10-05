"use client";

import type { EvidenceView } from "@/lib/atlas/evidence";
import type { ResultJudgement } from "@/lib/types";
import { EvidenceList } from "./EvidenceList";

/**
 * Level 2 — Evidence Peek. A pointer-events-none card that follows the cursor
 * over a held result plate: score, and 1–2 verbatim evidence excerpts with
 * their source labels. The second act of the search experience; it never
 * blocks the physics and never calls Jev (explanation is Level 3 only).
 */
export type PeekState = {
  plate: { code: string; name: string; probability: number | null };
  at: { x: number; y: number };
  judgement: ResultJudgement | null;
  evidence: EvidenceView[] | null;
};

const PEEK_WIDTH = 304;

export function EvidencePeek({ peek }: { peek: PeekState | null }) {
  if (!peek) return null;
  const { plate, at, judgement, evidence } = peek;
  // No live judgement behind this row (degraded / market-only): nothing to peek.
  if (!judgement) return null;
  const left = Math.min(at.x + 18, window.innerWidth - PEEK_WIDTH - 12);
  const top = Math.min(at.y + 18, window.innerHeight - 200);
  const scorePct = Math.round(judgement.score * 100);
  const isRelation = judgement.capability === "semantic_relation";
  const label = isRelation ? "关系匹配" : "语义匹配";
  return (
    <div
      className="pointer-events-none fixed z-30 rounded-[5px] border border-white/15 bg-[#12140f]/95 px-3.5 py-3 shadow-lg shadow-black/40"
      style={{ left, top, width: PEEK_WIDTH }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="truncate text-[13.5px] text-[#f4f1ea]">
          {plate.name}
          <span className="ml-2 text-[11px] tabular-nums text-[#8d887c]">{plate.code}</span>
        </p>
        <p className="shrink-0 text-[11px] tabular-nums text-[#ecb034]">{label} {scorePct}</p>
      </div>
      {isRelation && judgement.relationLabel && (
        <p className="mt-0.5 text-[11px] text-[#8d887c]">判断的关系：「{judgement.relationLabel}」</p>
      )}
      <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[#8d887c]">匹配依据</p>
      <div className="mt-1.5">
        {evidence === null ? (
          <p className="text-[12px] text-[#c2803f]">证据暂不可用</p>
        ) : evidence.length === 0 ? (
          <p className="text-[12px] text-[#c2803f]">证据暂不可用</p>
        ) : (
          <EvidenceList views={evidence} mode="excerpt" limit={2} />
        )}
      </div>
      <p className="mt-2 border-t border-white/[0.06] pt-1.5 text-[10.5px] text-[#6f6a5f]">点击卡片查看公司与完整依据</p>
    </div>
  );
}
