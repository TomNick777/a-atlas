"use client";
import { useEffect, useState } from "react";
import type { JudgeChoice } from "./judgePreference";
type Status = { id: JudgeChoice; configured: boolean; model: string | null; artifactSha: string | null; breaker: string };
export function JudgeSelector({ value, onChange }: { value: JudgeChoice; onChange: (id: JudgeChoice) => void }) {
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  async function choose(id: JudgeChoice) {
    onChange(id);
    if (id !== "laya") { setMessage(null); return; }
    setStarting(true); setMessage("正在装载 Laya……");
    try {
      const response = await fetch("/api/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: id }) });
      const data = await response.json();
      if (data.providers) setStatuses(data.providers);
      setMessage(response.ok ? null : data.error ?? "Laya 暂不可用");
    } catch { setMessage("Laya 启动请求失败"); }
    finally { setStarting(false); }
  }
  useEffect(() => { const abort = new AbortController(); void fetch("/api/judge", { signal: abort.signal }).then(r => { if (!r.ok) throw new Error("unavailable"); return r.json(); }).then(data => setStatuses(data.providers)).catch(() => {}); return () => abort.abort(); }, []);
  return <div className="border-b border-black/10 px-3 py-3">
    <p className="text-[13px] font-medium text-[#1c1f18]">判断模型</p>
    <div className="mt-2 flex flex-wrap gap-2">{(["jev", "drex", "laya"] as const).map(id => <button key={id} type="button" disabled={starting} aria-pressed={value === id} onClick={() => void choose(id)} className={`rounded border px-3 py-1 text-xs ${value === id ? "border-[#a58d54] bg-[#ece3cc] text-[#1c1f18]" : "border-black/10 text-[#706b61]"}`}>{id === "jev" ? "Jev Cloud" : id === "drex" ? "Drex Cloud" : "Laya 本地"}</button>)}</div>
    {message && <p role="status" className="mt-2 text-[11px] text-[#706b61]">{message}</p>}
    <p className="mt-2 break-words text-[11px] leading-4 text-[#706b61]">{statuses.find(s => s.id === value)?.configured ? statuses.find(s => s.id === value)?.model ?? "已配置，等待应答核验" : statuses.length ? "当前不可用，搜索将如实降级" : "正在检查可用性……"}</p>
    <p className="mt-1 text-[11px] text-[#8d887c]">下一次搜索生效</p>
  </div>;
}
