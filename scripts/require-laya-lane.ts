/** Historical experiments require an explicit local provider; environment bypass removed. */
import { currentJudgeId } from "../lib/intelligence/capabilities";
export function requireLayaLane(script: string): void {
  if (currentJudgeId() === "laya") return;
  throw new Error(`${script}: historical Laya experiment requires ATLAS_JUDGE_PROVIDER=laya; cloud execution is forbidden`);
}
