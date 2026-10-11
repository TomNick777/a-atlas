"use client";

import { useEffect, useRef, useState } from "react";
import type { Vela } from "@luxalgo/vela";

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
type BarsFile = { available?: "ok" | "empty" | "unavailable" | "error"; error?: string; source?: string; asOf?: string; fetchedAt?: string; currency?: string; volumeUnit?: string; code: string; name?: string; adjust?: string; timeframe?: string; start?: string; end?: string; count?: number; bars?: Bar[] };

/** 暗底贴主界面；A 股口径红涨绿跌。 */
const VELA_THEME = {
  background: "#0c0e0a",
  textColor: "#f4f1ea",
  gridColor: "#1d2019",
  borderColor: "#2b2f27",
  upColor: "#e5484d",
  downColor: "#30a46c",
  fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
};

/** 公司页日 K：Vela headless，静态前复权日线（fetch_daily_bars.py 产出）。 */
export function DailyChart({ code }: { code: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "gap">("loading");
  const [hint, setHint] = useState("");
  const [provenance, setProvenance] = useState("");

  useEffect(() => {

    let dead = false;
    let chart: Vela | null = null;
    (async () => {
      await Promise.resolve();
      if (dead) return;
      setStatus("loading"); setHint(""); setProvenance("");
      const res = await fetch(`/api/bars/${code}`);
      if (!res.ok) {
        if (dead) return;
        try {
          setHint((await res.json()).error ?? "日线服务暂不可用");
        } catch {
          setHint("日线服务暂不可用");
        }
        setStatus("gap");
        return;
      }
      const file = (await res.json()) as BarsFile;
      if (!dead) setProvenance(`${file.source ?? "来源未确认"} · 交易日 ${file.asOf ?? "未提供"} · 抓取 ${file.fetchedAt ?? "未提供"} · ${file.currency ?? "币种未提供"} · 成交量：${file.volumeUnit ?? "单位未提供"}`);
      if (file.available && file.available !== "ok" && file.available !== "empty") throw new Error(file.available === "error" ? "日线数据源暂时不可用" : "该标的暂未覆盖日线数据");
      const bars = (file.bars ?? []).map((bar) => ({ time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }));
      if (dead) return;
      if (!bars.length) {
        setStatus("gap");
        return;
      }
      // 运行时才加载 Vela：库按 ESM 分发且操作 WebGL/DOM，不能进 SSR 包。
      const { Vela: VelaChart } = await import("@luxalgo/vela");
      if (dead || !hostRef.current) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      chart = new VelaChart(hostRef.current, {
        data: bars,
        timeframe: "1d",
        height: 420,
        theme: VELA_THEME,
        visibleRange: "1Y",
        drawings: { toolbar: false },
        animations: !reduced,
      });
      setStatus("ok");
    })().catch((error) => {
      if (!dead) { setStatus("gap"); setHint(error instanceof Error ? error.message : "日线暂不可用"); }
    });
    return () => {
      dead = true;
      chart?.destroy();
    };
  }, [code]);

  return (
    <section className="mt-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-[#d9d4c8]">日 K · 前复权</h2>
        <span className="text-xs text-[#8e8baa]">静态日线，不做实时行情</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-[#8e8baa40] bg-[#0c0e0a]">
        {status === "gap" ? (
          <div className="grid h-[420px] place-items-center px-6 text-center text-sm text-[#8e8baa]">
            <p>
              {hint || "这家公司没有日线记录。"}
            </p>
          </div>
        ) : (
          <div ref={hostRef} className={status === "loading" ? "h-[420px] animate-pulse" : "h-[420px]"} />
        )}
      </div>
      <p className="mt-2 text-xs text-[#8e8baa]">{provenance} · 图表 <a href="https://velacharts.dev" target="_blank" rel="noreferrer" className="underline">Vela / LuxAlgo</a></p>
    </section>
  );
}
