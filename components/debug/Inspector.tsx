"use client";

import { useEffect, useState } from "react";
import type { SearchTrace } from "@/lib/types";

/** Dev-only. Backtick or ?debug=1. It does not sit in the layout of the pile. */
export function Inspector({ trace }: { trace: SearchTrace | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("debug")) setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "`" && !(event.target instanceof HTMLInputElement)) setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (process.env.NODE_ENV === "production" || !open) return null;

  return (
    <aside className="fixed top-3 right-3 z-30 max-h-[70vh] w-[360px] overflow-auto rounded-[5px] border border-white/15 bg-[#0c0e0b]/95 p-3 text-[12px] text-[#d9d4c8]">
      <div className="mb-2 flex items-center justify-between">
        <strong>检索轨迹</strong>
        <button type="button" onClick={() => setOpen(false)} className="text-[#8d887c]">
          关闭
        </button>
      </div>
      {!trace && <p className="text-[#8d887c]">还没有一次搜索。</p>}
      {trace && (
        <div className="space-y-3">
          <p>
            硬条件：{trace.constraints.province ?? "无地域"}
            {trace.constraints.dropIndustries.length ? `，排除 ${trace.constraints.dropIndustries.join("、")}` : ""}
          </p>
          {Object.entries(trace.channels).map(([name, rows]) => (
            <section key={name}>
              <h3 className="text-[#9ec2a0]">{name} 召回 {rows.length}</h3>
              <ol className="mt-1 space-y-0.5">
                {rows.slice(0, 8).map((row) => (
                  <li key={row.code}>
                    {row.name} {row.code} · {row.score.toFixed(3)}
                  </li>
                ))}
              </ol>
            </section>
          ))}
          <section>
            <h3 className="text-[#e2c27a]">{trace.decidedBy === "jev" ? "Jev 相对召回的升降" : "本地排序相对召回的升降"}</h3>
            <ol className="mt-1 space-y-0.5">
              {trace.judged.slice(0, 12).map((row) => (
                <li key={row.code}>
                  {row.name} · {trace.decidedBy === "jev" ? "jev" : "本地"} {row.jev.toFixed(2)} · 召回 #{row.recallRank} · Δ{row.delta}
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h3 className="text-[#f4f1ea]">最终浮起</h3>
            <ol className="mt-1 space-y-0.5">
              {trace.final.map((row) => (
                <li key={row.code}>
                  {row.name} · 匹配度 {Math.round(row.probability * 100)}%
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </aside>
  );
}
