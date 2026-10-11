import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A directive created only by the user's explicit Jev-and-train operation. */
export function trainingJudgeIntent(): { provider: "jev"; revision: string; run: string } | null {
  try {
    const intent = JSON.parse(readFileSync(join(process.cwd(), ".local/runtime/judge-intent.json"), "utf8"));
    return intent.provider === "jev" && typeof intent.revision === "string" && typeof intent.run === "string" ? { provider: "jev", revision: intent.revision, run: intent.run } : null;
  } catch { return null; }
}
