import { defaultStore } from "@/lib/telemetry/store";
import { probeDataServiceHealth } from "@/lib/telemetry/runtime";
import { runtimeSnapshot } from "@/lib/atlas/runtime";

export const dynamic = "force-dynamic";

/**
 * Runtime snapshot (Phase 4 §33/§34): one endpoint that answers
 * 「现在健康吗 / 刚才为什么坏了 / 现在慢不慢」 without a monitoring stack.
 *
 * Read-only, local-only, and it carries no payload: request counts, latency
 * percentiles, judge provider state and the recent incident records the telemetry
 * layer already keeps.
 */
export async function GET() {
  const data = await probeDataServiceHealth();
  const incidents = (await defaultStore.readIncidents()).slice(-20).reverse();
  return Response.json(
    {
      ...runtimeSnapshot({ dataReachable: data.ok, dataVersion: data.version, dataError: data.error }),
      incidents: incidents.map((row) => ({
        at: row.timestamp,
        kind: row.eventType,
        severity: (row.payload?.severity as string | undefined) ?? null,
        reason: (row.payload?.reason as string | undefined) ?? (row.payload?.degradedReason as string | undefined) ?? null,
        component: (row.payload?.component as string | undefined) ?? null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
