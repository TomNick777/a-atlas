import { probeDataServiceHealth } from "@/lib/telemetry/runtime";
import { healthOf } from "@/lib/atlas/runtime";

export const dynamic = "force-dynamic";

// Harbor 受管应用的健康契约（ADR-006/008）：200 + service 身份字段，
// expectService 靠它区分「本项目在监听」和「端口被别的服务占了」。
//
// 因此本端点永远由 web 亲口回答「web 活着」，整体状态放在 status 字段里而不是状态码上：
// 把 503 用作「data 挂了」会让 Harbor 误判 web 失能并重启一个没坏的进程。
// Phase 4 §23/§24：Jev 是外部依赖，它故障只会让 Discover DEGRADED，永远不让产品 UNHEALTHY。
// Refocus：Vibe Research 已退役，核心运行时的另一个组件是 a-atlas-data（:8920）。
export async function GET() {
  const data = await probeDataServiceHealth();
  const health = healthOf({ dataReachable: data.ok, dataVersion: data.version, dataError: data.error });
  return Response.json(
    {
      service: "a-atlas-web",
      ok: health.ok,
      status: health.status,
      components: health.components,
      judge: health.judge,
      remote: { jev: health.remote.jev, sources: { failing: health.remote.sources.failing } },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
