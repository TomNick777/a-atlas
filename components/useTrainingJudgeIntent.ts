"use client";
import { useEffect } from "react";
import { consumeTrainingJudgeIntent } from "./judgePreference";

/** Consume each explicit CLI training directive once; existing requests retain identity. */
export function useTrainingJudgeIntent() {
  useEffect(() => {
    const abort = new AbortController();
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/judge/intent", { signal: abort.signal, cache: "no-store" });
        const { intent } = await response.json();
        if (!abort.signal.aborted && response.ok) consumeTrainingJudgeIntent(intent);
      } catch { /* A missed control notification cannot break search. */ }
      finally { pending = false; }
    }
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { abort.abort(); clearInterval(timer); };
  }, []);
}
