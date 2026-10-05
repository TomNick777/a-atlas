import Link from "next/link";
import { notFound } from "next/navigation";
import { defaultStore } from "@/lib/telemetry/store";
import { buildTraceView } from "@/lib/telemetry/usage";
import { isValidSearchId } from "@/lib/telemetry/ids";

/**
 * Trace Inspector (usage spec §14) — one search, rebuilt end to end from the
 * telemetry stream + the search log. Internal development entry: 数据正确优先，
 * 渲染是 <pre> 级别的。
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Trace · A-Atlas（内部）" };

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-[0.14em] text-[#8d887c]">{title}</h2>
      {children}
    </section>
  );
}

function Pre({ data }: { data: unknown }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-[5px] border border-white/10 bg-[#12140f] p-3 text-[12px] leading-relaxed text-[#d9d4c8]">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

const timeOf = (iso: string) => iso.slice(11, 23);

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidSearchId(id)) notFound();
  const view = await buildTraceView(defaultStore, id);
  if (!view) notFound();

  const ready = view.ready;
  const snapshot = (ready?.payload.snapshot as { rank: number; code: string; name: string; probability: number | null; hero: string | null }[] | undefined) ?? [];
  const execution = ready?.payload.execution as { order?: string; degraded?: boolean; degradedReason?: string | null; timings?: Record<string, unknown> } | undefined;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <p className="mb-1 text-[12px] text-[#57534a]">内部开发入口 · 单次搜索重建</p>
      <h1 className="mb-1 text-[16px] text-[#f4f1ea]">trace {view.searchId}</h1>
      <p className="mb-6 text-[13px] text-[#8d887c]">
        <Link className="underline hover:text-[#d9d4c8]" href="/usage">← Usage</Link>
        {view.received && <> · 收到时间 {view.received.timestamp}</>}
        {execution?.order && <> · order {execution.order}</>}
        {execution?.degraded && <span className="text-[#c2803f]"> · DEGRADED {execution.degradedReason ?? ""}</span>}
      </p>

      {view.ready && (
        <Block title="Query → plan → execution">
          <Pre
            data={{
              query: view.received?.payload.rawQuery ?? null,
              plan: ready?.payload.plan,
              parser: ready?.payload.parser,
              execution,
              planCaption: ready?.payload.planCaption,
            }}
          />
        </Block>
      )}

      {snapshot.length > 0 && (
        <Block title={`Result snapshot（用户所见，前 ${snapshot.length} 行）`}>
          <table className="w-full max-w-3xl text-[13px]">
            <thead>
              <tr className="border-b border-white/10 text-left text-[12px] text-[#8d887c]">
                <th className="py-1.5 pr-3">#</th>
                <th className="py-1.5 pr-3">code</th>
                <th className="py-1.5 pr-3">name</th>
                <th className="py-1.5 pr-3">score</th>
                <th className="py-1.5">hero</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.map((row) => (
                <tr key={row.code} className="border-b border-white/[0.06]">
                  <td className="py-1 pr-3 text-[#8d887c]">{row.rank}</td>
                  <td className="py-1 pr-3">{row.code}</td>
                  <td className="py-1 pr-3">{row.name}</td>
                  <td className="py-1 pr-3">{row.probability ?? "—"}</td>
                  <td className="py-1">{row.hero ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="mt-2">
            <summary className="cursor-pointer text-[12px] text-[#8d887c]">完整快照（含 judgement/evidenceRefs/matchedFacts）</summary>
            <Pre data={ready?.payload.snapshot} />
          </details>
        </Block>
      )}

      {view.jevCalls.length > 0 && (
        <Block title={`Jev calls（${view.jevCalls.length}）`}>
          {view.jevCalls.map((call) => (
            <Pre key={String(call.payload.callId ?? call.eventId)} data={call.payload} />
          ))}
        </Block>
      )}

      {ready?.payload.jevValue != null && (
        <Block title="Jev value（排名是否被改变）">
          <Pre data={ready.payload.jevValue} />
        </Block>
      )}

      <Block title="Pipeline timeline">
        {view.pipeline.length ? (
          <div className="text-[12.5px]">
            {view.pipeline.map((event) => (
              <div key={event.eventId} className="border-b border-white/[0.06] py-1.5">
                <span className="mr-3 text-[#57534a]">{timeOf(event.timestamp)}</span>
                <span className="mr-3 text-[#f4f1ea]">{event.eventType}</span>
                <span className="text-[#8d887c]">{JSON.stringify(event.payload).slice(0, 220)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-[#57534a]">该 order 不经过 runSearch（market-only / unsupported）——无 pipeline 事件。</p>
        )}
      </Block>

      {view.interactions.length > 0 && (
        <Block title={`Interactions（${view.interactions.length}）`}>
          {view.interactions.map((event) => (
            <div key={event.eventId} className="border-b border-white/[0.06] py-1.5 text-[12.5px]">
              <span className="mr-3 text-[#57534a]">{timeOf(event.timestamp)}</span>
              <span className="mr-3 text-[#f4f1ea]">{event.eventType}</span>
              <span className="text-[#8d887c]">{JSON.stringify(event.payload).slice(0, 200)}</span>
            </div>
          ))}
        </Block>
      )}

      {view.incidents.length > 0 && (
        <Block title={`Incidents（${view.incidents.length}）`}>
          {view.incidents.map((event) => (
            <Pre key={event.eventId} data={{ eventType: event.eventType, timestamp: event.timestamp, payload: event.payload }} />
          ))}
        </Block>
      )}

      {view.searchLogRun && (
        <Block title="search_log row（v3：含 jev 成本与价值）">
          <Pre data={view.searchLogRun} />
        </Block>
      )}
    </main>
  );
}
