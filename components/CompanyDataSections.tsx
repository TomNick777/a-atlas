import type { DataAvailability, DataProvenance, StockAnnouncements, StockFundamentals, StockQuote, StockResearchReports } from "@/lib/stockdata/contracts";
import { fetchStockAnnouncements, fetchStockFundamentals, fetchStockQuote, fetchStockResearchReports } from "@/lib/stockdata/client";

/**
 * 公司页数据段（refocus §七/§二十六/§三十二）：市场快照 / 基础财务 / 最近公告 /
 * 最近研报。Server component——渲染期由 a-atlas-data（:8920）取得契约 JSON。
 *
 * 三态如实渲染（§二十四）：empty=「暂无」、unavailable=「数据源不覆盖」、
 * error=「数据源暂时不可用」。把 error 渲染成「这家公司没有研报」是实现 bug。
 * provenance 以一行极轻的「腾讯 · 14:56」出现在每个数据块底部。
 */

function Card({ title, children, provenance }: { title: string; children: React.ReactNode; provenance?: DataProvenance }) {
  const at = provenance?.fetchedAt ? new Date(provenance.fetchedAt) : null;
  const hhmm = at && !Number.isNaN(at.getTime()) ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : null;
  return (
    <section className="overflow-hidden rounded-[5px] border border-white/10 bg-[#12140f]">
      <h2 className="border-b border-white/[0.07] px-4 py-2.5 text-[12px] font-medium uppercase tracking-[0.14em] text-[#8d887c]">{title}</h2>
      <div className="px-4 py-3.5">
        {children}
        {provenance && (
          <p className="mt-3 border-t border-white/[0.05] pt-2 text-[10.5px] text-[#5f5a50]">
            {provenance.source}
            {hhmm ? ` · ${hhmm}` : ""}
          </p>
        )}
      </div>
    </section>
  );
}

function HonestState({ block, empty }: { block: { available: DataAvailability; error?: string | null }; empty: string }) {
  if (block.available === "empty") return <p className="text-[13px] text-[#8d887c]">{empty}</p>;
  if (block.available === "unavailable") return <p className="text-[13px] text-[#8d887c]">数据源不覆盖该标的。</p>;
  return <p className="text-[13px] text-[#8d887c]">数据源暂时不可用，稍后刷新可能恢复。</p>;
}

function fmt(n: number | null | undefined, digits = 2): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function QuoteSection({ quote }: { quote: StockQuote }) {
  const up = (quote.changePct ?? 0) > 0;
  const down = (quote.changePct ?? 0) < 0;
  return (
    <Card title="市场快照" provenance={quote}>
      {quote.available !== "ok" ? (
        <HonestState block={quote} empty="暂无行情。" />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[22px] tabular-nums text-[#f4f1ea]">{fmt(quote.price)}</span>
            {(up || down) && (
              <span className={`text-[13px] tabular-nums ${up ? "text-[#d6725c]" : "text-[#6f9f77]"}`}>
                {up ? "+" : ""}
                {fmt(quote.changePct)}%
              </span>
            )}
            {quote.stale && <span className="text-[11px] text-[#b9954a]">停牌/非当日成交</span>}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-3">
            {[
              ["市盈率 TTM", fmt(quote.peTtm)],
              ["市净率", fmt(quote.pb)],
              ["总市值", quote.marketCapYi != null ? `${fmt(quote.marketCapYi, 1)} 亿` : "—"],
              ["换手率", quote.turnoverPct != null ? `${fmt(quote.turnoverPct)}%` : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2 border-b border-white/[0.04] pb-1">
                <dt className="text-[#8d887c]">{k}</dt>
                <dd className="tabular-nums text-[#d9d4c8]">{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Card>
  );
}

function FundamentalsSection({ f }: { f: StockFundamentals }) {
  return (
    <Card title="基础财务" provenance={f}>
      {f.available !== "ok" ? (
        <HonestState block={f} empty="暂无已披露财报。" />
      ) : (
        <>
          <p className="text-[11.5px] text-[#8d887c]">报告期 {f.reportPeriod ?? "—"}</p>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
            {[
              ["营业收入", f.revenue, f.revenueYoY],
              ["净利润", f.netProfit, f.netProfitYoY],
            ].map(([k, v, yoy]) => (
              <div key={k as string} className="flex items-baseline justify-between gap-2 border-b border-white/[0.04] pb-1">
                <dt className="text-[#8d887c]">{k}</dt>
                <dd className="tabular-nums text-[#d9d4c8]">
                  {v ?? "—"}
                  {typeof yoy === "string" && yoy !== "" && <span className="ml-1.5 text-[11px] text-[#8d887c]">同比 {Number(yoy).toFixed(1)}%</span>}
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-2 border-b border-white/[0.04] pb-1">
              <dt className="text-[#8d887c]">基本每股收益</dt>
              <dd className="tabular-nums text-[#d9d4c8]">{f.eps ?? "—"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2 border-b border-white/[0.04] pb-1">
              <dt className="text-[#8d887c]">毛利率</dt>
              <dd className="tabular-nums text-[#d9d4c8]">{f.grossMarginPct != null ? `${fmt(f.grossMarginPct)}%` : "—"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2 border-b border-white/[0.04] pb-1">
              <dt className="text-[#8d887c]">ROE</dt>
              <dd className="tabular-nums text-[#d9d4c8]">{f.roePct != null ? `${fmt(f.roePct)}%` : "—"}</dd>
            </div>
          </dl>
        </>
      )}
    </Card>
  );
}

function AnnouncementsSection({ a }: { a: StockAnnouncements }) {
  return (
    <Card title="最近公告" provenance={a}>
      {a.available !== "ok" ? (
        <HonestState block={a} empty="暂无公告。" />
      ) : a.items.length === 0 ? (
        <p className="text-[13px] text-[#8d887c]">暂无公告。</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {a.items.map((item, i) => (
            <li key={`${item.url}-${i}`} className="flex items-baseline justify-between gap-4 text-[13px]">
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-[#d9d4c8] underline decoration-white/15 decoration-dotted underline-offset-2 transition-colors duration-200 hover:text-[#f4f1ea]"
                title={item.title}
              >
                {item.title}
              </a>
              <span className="shrink-0 tabular-nums text-[11.5px] text-[#8d887c]">{item.date}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReportsSection({ r }: { r: StockResearchReports }) {
  return (
    <Card title="最近研报" provenance={r}>
      {r.available !== "ok" ? (
        <HonestState block={r} empty="暂无研报覆盖。" />
      ) : r.items.length === 0 ? (
        <p className="text-[13px] text-[#8d887c]">暂无研报覆盖。</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {r.items.map((item, i) => (
            <li key={`${item.url}-${i}`} className="flex flex-col gap-0.5 border-b border-white/[0.04] pb-2 last:border-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-4">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-[13px] text-[#d9d4c8] underline decoration-white/15 decoration-dotted underline-offset-2 transition-colors duration-200 hover:text-[#f4f1ea]"
                  title={item.title}
                >
                  {item.title}
                </a>
                {item.rating && <span className="shrink-0 rounded-[3px] bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] text-[#d9d4c8]">{item.rating}</span>}
              </div>
              <p className="text-[11.5px] text-[#8d887c]">
                {item.institution}
                {item.analyst ? ` · ${item.analyst}` : ""} · {item.date}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export async function CompanyDataSections({ symbol }: { symbol: string }) {
  const [quote, fundamentals, announcements, reports] = await Promise.all([
    fetchStockQuote(symbol),
    fetchStockFundamentals(symbol),
    fetchStockAnnouncements(symbol),
    fetchStockResearchReports(symbol),
  ]);
  return (
    <div className="flex flex-col gap-4">
      <QuoteSection quote={quote} />
      <FundamentalsSection f={fundamentals} />
      <AnnouncementsSection a={announcements} />
      <ReportsSection r={reports} />
    </div>
  );
}
