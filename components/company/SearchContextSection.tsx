import type { SearchContext } from "@/lib/atlas/searchContext";
import { sourceTimeLabel } from "@/lib/atlas/searchContext";

export function SearchContextSection({ context }: { context: SearchContext }) {
  if (context.status === "none") return null;
  return (
    <section className="mt-5 rounded-[5px] border border-white/10 bg-[#12140f] px-4 py-3">
      <h2 className="text-[12px] text-[#8d887c]">本次搜索记录</h2>
      {context.query && <p className="mt-1.5 break-words text-[13.5px] text-[#f4f1ea]">「{context.query}」</p>}
      {context.status === "unavailable" ? (
        <p className="mt-2 text-[12px] leading-5 text-[#b9954a]">无法恢复这次搜索中该公司的结果。原排名与判断依据暂不可用。</p>
      ) : (
        <>
          <p className="mt-2 text-[13px] text-[#f4f1ea]">
            {context.rank === null ? "原名次未记录" : `原结果第 ${context.rank} 名`}
            {context.metric && <> · {context.metric.label} {context.metric.formatted}</>}
          </p>
          {context.caption && <p className="mt-1 break-words text-[12px] leading-5 text-[#8d887c]">{context.caption}</p>}
          <p className="mt-1 break-words text-[12px] leading-5 text-[#8d887c]">
            {context.basis === "market" ? "按原搜索的行情条件排序。" : context.basis === "judgement" ? "保留原搜索的语义判断。" : context.basis === "retrieval" ? "本次由基础检索排序，无语义判断可依据。" : "原排序依据未记录。"}
            {context.judgement && <> 判断模型：{context.provider} · {context.runtimeModel ?? "实际身份未记录"}。</>}
          </p>
          {context.degraded && <p className="mt-1 text-[12px] text-[#b9954a]">该次搜索处于降级状态。</p>}
          {context.selection && !context.selection.complete && (
            <p className="mt-1 text-[12px] text-[#b9954a]">原扫描未完成：已扫描 {context.selection.scanned}/{context.selection.pool} 家，未决 {context.selection.unknown} 家；不代表完整排行。</p>
          )}
          {context.marketDate && (
            <p className="mt-2 break-words border-t border-white/[0.06] pt-2 text-[11.5px] leading-5 text-[#8d887c]">
              搜索行情日期：{context.marketDate}
              {context.marketSnapshot ? <>
                <br />来源：{context.marketSnapshot.source} · 源端时点（北京时间）：{sourceTimeLabel(context.marketSnapshot.sourceTimeMin)} 至 {sourceTimeLabel(context.marketSnapshot.sourceTimeMax)}
                <br />原快照有效覆盖：{(context.marketSnapshot.coverage * 100).toFixed(2)}%
              </> : <> · 源端时点范围未记录</>}
            </p>
          )}
        </>
      )}
    </section>
  );
}
