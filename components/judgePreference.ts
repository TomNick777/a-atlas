"use client";
export type JudgeChoice = "jev" | "laya" | "drex";
const KEY = "atlas-judge-provider";
let sessionChoice: JudgeChoice = "jev";
let sessionManualAt = 0;
let sessionIntent: string | null = null;
export function readJudgeChoice(): JudgeChoice { try { const value = localStorage.getItem(KEY); return value === "laya" || value === "jev" || value === "drex" ? value : sessionChoice; } catch { return sessionChoice; } }
export function subscribeJudgeChoice(callback: () => void) { window.addEventListener("storage", callback); window.addEventListener(KEY, callback); return () => { window.removeEventListener("storage", callback); window.removeEventListener(KEY, callback); }; }
export function writeJudgeChoice(value: JudgeChoice, source: "manual" | "training" = "manual") {
  sessionChoice = value;
  if (source === "manual") sessionManualAt = Date.now();
  try { localStorage.setItem(KEY, value); if (source === "manual") localStorage.setItem("atlas-judge-manual-at", String(sessionManualAt)); } catch { /* Keep the session choice. */ }
  window.dispatchEvent(new Event(KEY));
}
export function consumeTrainingJudgeIntent(intent: { provider?: unknown; revision?: unknown } | null): boolean {
  if (intent?.provider !== "jev" || typeof intent.revision !== "string" || !/^\d{1,20}$/.test(intent.revision)) return false;
  let seen = sessionIntent, manualAt = sessionManualAt;
  try { seen = localStorage.getItem("atlas-training-intent") ?? seen; manualAt = Math.max(manualAt, Number(localStorage.getItem("atlas-judge-manual-at")) || 0); } catch { /* Use session state. */ }
  if (seen === intent.revision) return false;
  sessionIntent = intent.revision;
  try { localStorage.setItem("atlas-training-intent", intent.revision); } catch { /* Consume once in this session. */ }
  // A later manual selection wins over an older CLI notification.
  if (Math.floor(Number(intent.revision) / 1e6) <= manualAt) return false;
  writeJudgeChoice("jev", "training");
  return true;
}
