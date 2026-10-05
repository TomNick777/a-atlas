import Link from "next/link";
import { defaultStore } from "@/lib/telemetry/store";
import { buildUsageSummary } from "@/lib/telemetry/usage";

/**
 * Usage dashboard (usage spec §13) — internal development entry, not a product
 * surface. Plain tables over lib/telemetry/usage's one definition of each
 * number; no visual engineering. The product has no first-level navigation, so
 * this page is reachable by URL only.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Usage · A-Atlas（内部）" };

function Row({ label, value, hint }: { label: string; value: string | number | null; hint?: string }) {
  return (
    <tr className="border-b border-white/[0.06]">
      <td className="py-1.5 pr-4 text-[#8d887c]">{label}</td>
      <td className="py-1.5 pr-4 text-[#f4f1ea]">{value === null ? "—" : String(value)}</td>
      <td className="py-1.5 text-[12px] text-[#57534a]">{hint ?? ""}</td>
    </tr>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-[0.14em] text-[#8d887c]">{title}</h2>
      <table className="w-full max-w-3xl text-[13px]">
        <tbody>{children}</tbody>
      </table>
    </section>
  );
}

const pct = (value: number | null) => (value === null ? null : `${Math.round(value * 1000) / 10}%`);

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ days?: string | string[] }> }) {
  const params = await searchParams;
  const rawDays = typeof params.days === "string" ? Number(params.days) : NaN;
  const days = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 90 ? Math.floor(rawDays) : 7;
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 3600_000);
  const summary = await buildUsageSummary(defaultStore, { since: since.toISOString(), until: until.toISOString() });
  const { search, latency, jev, interaction } = summary;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <p className="mb-1 text-[12px] text-[#57534a]">内部开发入口 · 数据只来自本机 data/telemetry · 不进入产品导航</p>
      <h1 className="mb-1 text-[18px] text-[#f4f1ea]">Usage</h1>
      <p className="mb-6 text-[13px] text-[#8d887c]">
        最近 {days} 天（{since.toISOString().slice(0, 10)} → {until.toISOString().slice(0, 10)}）·
        换窗口：<Link className="underline hover:text-[#d9d4c8]" href="/usage?days=1">1 天</Link> ·{" "}
        <Link className="underline hover:text-[#d9d4c8]" href="/usage?days=30">30 天</Link> ·{" "}
        <Link className="hover:text-[#d9d4c8]" href="/">← 回发现页</Link>
      </p>

      <Section title="Search">
        <Row label="searches" value={search.searches} hint="全部 DISCOVER 请求（含缓存命中与非 organic）" />
        <Row label="organic" value={search.organic} hint="organic_ui 且未排除" />
        <Row label="cache hits" value={search.cacheHits} hint="发现答案缓存重放（未重跑、未再问 Jev）" />
        <Row label="no-result rate" value={pct(search.noResultRate)} hint="organic 且 0 结果" />
        <Row label="reformulation rate" value={pct(search.reformulationRate)} hint="120 秒窗口内同会话连续搜索（possible_reformulation，非失败判定）" />
        <Row label="degraded" value={search.degraded} hint="Jev 不可用 → 确定性排序如实标注" />
        <Row label="unsupported" value={search.unsupported} hint="诚实拒绝的意图" />
      </Section>

      <Section title="Latency">
        <Row label="server p50 / p95 / max" value={`${latency.serverMs.p50 ?? "—"} / ${latency.serverMs.p95 ?? "—"} / ${latency.serverMs.max ?? "—"} ms`} />
        <Row label="client visible p50 / p95" value={`${latency.clientVisibleMs.p50 ?? "—"} / ${latency.clientVisibleMs.p95 ?? "—"} ms`} hint="浏览器到结果可见（SEARCH_RESULTS_VISIBLE）" />
        <Row
          label="stage medians"
          value={`parser ${latency.stageMedianMs.parser ?? "—"} · semantic ${latency.stageMedianMs.semantic ?? "—"} · market ${latency.stageMedianMs.market ?? "—"} · merge ${latency.stageMedianMs.merge ?? "—"} ms`}
        />
        <Row
          label="semantic pipeline medians"
          value={`parse ${latency.pipelineMedianMs.parse ?? "—"} · retrieval ${latency.pipelineMedianMs.retrieval ?? "—"} · rerank ${latency.pipelineMedianMs.rerank ?? "—"} · total ${latency.pipelineMedianMs.total ?? "—"} ms`}
          hint="仅走 runSearch 的查询（semantic / semantic-first）"
        />
      </Section>

      <Section title="Jev">
        <Row label="calls / search" value={jev.callsPerSearch ?? "—"} hint={`共 ${jev.calls} 次 capability 调用`} />
        <Row label="tokens / search" value={jev.tokensPerSearch ?? "—"} hint={`共 ${jev.tokensTotal} tokens`} />
        <Row label="cost / search" value={jev.costPerSearchUsd === null ? "—" : `$${jev.costPerSearchUsd}`} hint={`共 $${jev.costTotalUsd}（estimated，按价格表折算，非账单）`} />
        <Row label="zero-Jev organic searches" value={jev.zeroJevOrganicSearches} hint="这些搜索完全没问 Jev（缓存命中 / market-only / degraded）" />
        <Row label="Jev cache hits" value={jev.cacheHits} hint="A-Atlas 没有结果级 Jev 缓存——该值应恒为 0" />
        {Object.keys(jev.byCapability).length > 0 && (
          <tr className="border-b border-white/[0.06]">
            <td className="py-1.5 pr-4 align-top text-[#8d887c]">by capability</td>
            <td className="py-1.5 text-[12.5px] text-[#d9d4c8]" colSpan={2}>
              {Object.entries(jev.byCapability).map(([capability, row]) => (
                <span key={capability} className="mr-4 inline-block">
                  {capability}: {row.calls} calls · {row.tokens} tok · ${Math.round(row.costUsd * 1e6) / 1e6}
                  {row.degraded > 0 && <span className="text-[#c2803f]"> · {row.degraded} degraded</span>}
                </span>
              ))}
            </td>
          </tr>
        )}
      </Section>

      <Section title="Result interaction">
        <Row label="result opens" value={interaction.openDetail} hint="点公司牌进公司页（RESULT_OPEN_DETAIL）" />
        <Row label="click rate" value={pct(interaction.clickRate)} hint="有点击的 organic 搜索占比" />
        <Row label="avg clicked rank" value={interaction.avgClickedRank ?? "—"} hint="被点击结果的平均排名（对本次快照回查）" />
        <Row label="top1 / top3 clicks" value={`${interaction.top1Clicks} / ${interaction.top3Clicks}`} />
        <Row label="requeries" value={interaction.requeries} hint="结果可见后再次搜索（含改写）" />
      </Section>

      <Section title="Feedback">
        <Row label="好 / 一般 / 差" value={`${interaction.feedback.good} / ${interaction.feedback.neutral} / ${interaction.feedback.bad}`} hint="每个 searchId 计最新一次评分" />
        {Object.keys(interaction.feedback.reasons).length > 0 && (
          <tr className="border-b border-white/[0.06]">
            <td className="py-1.5 pr-4 align-top text-[#8d887c]">原因</td>
            <td className="py-1.5 text-[12.5px] text-[#d9d4c8]" colSpan={2}>
              {Object.entries(interaction.feedback.reasons).map(([reason, count]) => (
                <span key={reason} className="mr-4 inline-block">
                  {reason}: {count}
                </span>
              ))}
            </td>
          </tr>
        )}
      </Section>

      <p className="mt-8 text-[12px] text-[#57534a]">
        单次搜索全过程：访问 <code className="text-[#8d887c]">/usage/trace/&lt;search_trace_id&gt;</code>，或{" "}
        <code className="text-[#8d887c]">npm run telemetry:inspect -- &lt;searchId&gt;</code>。
      </p>
    </main>
  );
}
