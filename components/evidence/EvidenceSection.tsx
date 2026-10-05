import type { ReactNode } from "react";
import type { EvidenceView } from "@/lib/atlas/evidence";
import { EvidenceList } from "./EvidenceList";

/**
 * Level 3 — the unified Evidence Inspector shell (company page). One shell for
 * every capability: the judgement line (score, capability label), the verbatim
 * evidence list (facts), and a slot for the grounded explanation island. Match
 * and relation differ only in labels; the shell is the same.
 *
 * Facts and judgement are visibly distinct here: evidence is introduced as
 * 资料 (Atlas facts, verbatim), the score as the semantic judgement, and any
 * explanation is Jev's, quoted from selected evidence — never mixed.
 */
export function EvidenceSection({
  query,
  capabilityLabel,
  relationLabel,
  scorePct,
  views,
  children,
}: {
  query: string;
  capabilityLabel: string;
  /** semantic_relation only: the Atlas-provided relation phrase, verbatim. */
  relationLabel: string | null;
  scorePct: number | null;
  views: EvidenceView[];
  /** The client island that can fetch the grounded explanation on demand. */
  children?: ReactNode;
}) {
  return (
    <div className="mt-5 rounded-[5px] border border-[#ecb03433] bg-[#ecb0340d] px-4 py-3">
      <p className="text-[12px] uppercase tracking-[0.14em] text-[#b9954a]">为什么匹配本次搜索</p>
      <p className="mt-1.5 text-[13.5px] leading-5 text-[#f4f1ea]">
        来自发现页搜索「{query}」
        {scorePct !== null && (
          <>
            ，<span className="text-[#ecb034]">{capabilityLabel} {scorePct}</span>
          </>
        )}
        {relationLabel && <>，判断的关系：「{relationLabel}」</>}。
        <span className="ml-1 text-[11.5px] text-[#8d887c]">语义相关度，不是概率。</span>
      </p>
      {views.length > 0 && (
        <div className="mt-3 border-t border-[#ecb03422] pt-2.5">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[#8d887c]">资料依据（逐字）</p>
          <div className="mt-2">
            <EvidenceList views={views} />
          </div>
        </div>
      )}
      {views.length === 0 && (
        <p className="mt-3 border-t border-[#ecb03422] pt-2.5 text-[12px] text-[#c2803f]">证据暂不可用。</p>
      )}
      {children}
    </div>
  );
}
