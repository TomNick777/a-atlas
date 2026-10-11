import { trainingJudgeIntent } from "@/lib/intelligence/capabilities";
export async function GET() {
  return Response.json({ intent: trainingJudgeIntent() }, { headers: { "cache-control": "no-store" } });
}
