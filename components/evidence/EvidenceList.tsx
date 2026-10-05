import type { EvidenceView } from "@/lib/atlas/evidence";

/**
 * Evidence rendering, Level 2 and Level 3 — presentation only: verbatim
 * evidence text plus its source label. No deriving, no selecting, no rewording
 * (the evidence list order is the backend's, never re-ranked here). Shared by
 * the discovery hover peek and the company-page evidence section, so both
 * surfaces render evidence identically.
 */

const EXCERPT_CHARS = 110;

export function excerptOf(text: string, chars = EXCERPT_CHARS): string {
  return text.length > chars ? `${text.slice(0, chars)}……` : text;
}

export function EvidenceList({
  views,
  mode = "full",
  limit,
  excerptChars,
}: {
  views: EvidenceView[];
  mode?: "excerpt" | "full";
  limit?: number;
  excerptChars?: number;
}) {
  const shown = limit ? views.slice(0, limit) : views;
  return (
    <ol className="flex flex-col gap-2.5">
      {shown.map((view, index) => (
        <li key={view.ref} className="flex flex-col gap-1">
          <p className="text-[12.5px] leading-5 text-[#d9d4c8]">
            <span className="mr-1.5 text-[#8d887c]">{index + 1}.</span>「{mode === "excerpt" ? excerptOf(view.text, excerptChars) : view.text}」
          </p>
          <p className="text-[11px] text-[#8d887c]">来源：{view.label}</p>
        </li>
      ))}
      {views.length > shown.length && <li className="text-[11px] text-[#6f6a5f]">等 {views.length} 条证据</li>}
    </ol>
  );
}
