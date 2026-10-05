import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { datasetGeneratedAt, findCompany } from "@/lib/atlas/company";
import { stockIdentity } from "@/lib/atlas/stockIdentity";
import { judgeProfileEvidenceView } from "@/lib/atlas/evidence";
import { EvidenceSection } from "@/components/evidence/EvidenceSection";
import { EvidenceWhy } from "@/components/evidence/EvidenceWhy";
import { CompanyDataSections } from "@/components/CompanyDataSections";

/** 公司页按请求渲染：URL 直接访问/刷新都恢复同一家公司（§十二.6）。 */
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ q?: string | string[]; m?: string | string[]; c?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { symbol } = await params;
  const company = findCompany(symbol);
  return { title: company ? `${company.name}（${company.code}）· A-Atlas｜A股星图` : "公司 · A-Atlas｜A股星图" };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[5px] border border-white/10 bg-[#12140f]">
      <h2 className="border-b border-white/[0.07] px-4 py-2.5 text-[12px] font-medium uppercase tracking-[0.14em] text-[#8d887c]">
        {title}
      </h2>
      <div className="px-4 py-3.5">{children}</div>
    </section>
  );
}

export default async function StockPage({ params, searchParams }: Props) {
  const { symbol } = await params;
  const identity = stockIdentity(decodeURIComponent(symbol));
  // 非法形态（不是 6 位代码）按 404 处理；合法但不在池内的代码给出如实说明。
  if (!identity) notFound();
  const company = findCompany(identity.symbol);
  if (!company) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 pb-16 pt-16">
        <p className="text-[15px] text-[#f4f1ea]">公司池中没有 {identity.symbol}。</p>
        <p className="mt-2 text-[13px] leading-5 text-[#8d887c]">
          池内共 5,567 家 A 股公司（数据截至 {datasetGeneratedAt()?.slice(0, 10) ?? "—"}）。代码写法正确但公司不在池内，可能是退市、代码变更或数据快照之外的公司。
        </p>
        <Link href="/" className="mt-6 inline-block text-[13px] text-[#d9d4c8] underline decoration-white/25 hover:text-[#f4f1ea]">
          ← 回到发现，用一句话描述你要找的公司
        </Link>
      </main>
    );
  }

  const search = await searchParams;
  const query = typeof search.q === "string" ? search.q : "";
  const matchValue = typeof search.m === "string" ? Number.parseFloat(search.m) : NaN;
  const matchPct = Number.isFinite(matchValue) && matchValue >= 0 && matchValue <= 1 ? Math.round(matchValue * 100) : null;
  // Which capability judged this hit rides in the URL (match|relation): the
  // relation label shown is the judged phrase itself, verbatim from the query.
  const isRelation = search.c === "relation";
  const capabilityLabel = isRelation ? "关系匹配" : "语义匹配";
  const generatedAt = datasetGeneratedAt()?.slice(0, 10) ?? null;
  // Level 3 — Evidence Inspector facts (server-resolved, always the text Jev
  // judged on). Surfaced only behind a real judgement from the URL; without
  // one there is no claim to ground and the page keeps the plain query line.
  const evidenceViews = query && matchPct !== null ? [judgeProfileEvidenceView(company.code)].filter((view): view is NonNullable<typeof view> => view !== null) : [];

  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-16 pt-16">
      <nav className="text-[12px] text-[#8d887c]">
        <Link href="/" className="transition-colors duration-200 hover:text-[#d9d4c8]">
          ← 发现
        </Link>
        <span className="mx-2">/</span>
        <span>{company.code}</span>
      </nav>

      <header className="mt-4">
        <h1 className="text-[24px] font-medium tracking-wide text-[#f4f1ea]">
          {company.name}
          <span className="ml-3 text-[15px] text-[#8d887c]">{company.code}</span>
        </h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px]">
          {[identity.exchange, company.board, company.swLevel1Industry].map((tag) => (
            <span key={tag} className="rounded-[4px] border border-white/12 px-2 py-0.5 text-[#d9d4c8]">
              {tag}
            </span>
          ))}
          {company.region.province && (
            <span className="rounded-[4px] border border-white/12 px-2 py-0.5 text-[#d9d4c8]">
              {company.region.province}
              {company.region.city ? ` · ${company.region.city}` : ""}
            </span>
          )}
        </div>
      </header>

      {query && matchPct !== null && (
        <EvidenceSection
          query={query}
          capabilityLabel={capabilityLabel}
          relationLabel={isRelation ? query : null}
          scorePct={matchPct}
          views={evidenceViews}
        >
          {evidenceViews.length > 0 && <EvidenceWhy q={query} code={company.code} />}
        </EvidenceSection>
      )}
      {query && matchPct === null && (
        <div className="mt-5 rounded-[5px] border border-[#ecb03433] bg-[#ecb0340d] px-4 py-3">
          <p className="text-[12px] uppercase tracking-[0.14em] text-[#b9954a]">为什么匹配本次搜索</p>
          <p className="mt-1.5 text-[13.5px] leading-5 text-[#f4f1ea]">
            来自发现页搜索「{query}」，本次结果由基础检索排序（无语义判断可依据）。
          </p>
        </div>
      )}

      {/* 公司卡展开：单页纵向阅读，无 Tab。市场快照/基础财务/公告/研报等数据块
          由数据底座（services/stock-data）提供，在后续提交接入。 */}
      <div className="mt-8 flex flex-col gap-4">
        {company.companyDescription && (
          <Card title="公司简介">
            <p className="text-[13.5px] leading-6 text-[#d9d4c8]">{company.companyDescription}</p>
          </Card>
        )}

        <Card title="主营业务">
          <p className="text-[13.5px] leading-6 text-[#d9d4c8]">{company.businessDescription}</p>
          {company.mainProducts.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5 border-t border-white/[0.07] pt-3">
              {company.mainProducts.map((product) => (
                <li key={product.name} className="flex items-baseline justify-between gap-4 text-[13px]">
                  <span className="text-[#f4f1ea]">{product.name}</span>
                  {typeof product.revenueShare === "number" && (
                    <span className="shrink-0 tabular-nums text-[#8d887c]">营收占比 {(product.revenueShare * 100).toFixed(1)}%</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 数据底座四块（refocus §七）：市场快照/基础财务/最近公告/最近研报，
            分块如实降级，provenance 轻量可见。 */}
        <CompanyDataSections symbol={company.code} />

        {company.concepts.length > 0 && (
          <Card title={`概念（${company.concepts.length}）`}>
            <div className="flex flex-wrap gap-1.5">
              {company.concepts.slice(0, 12).map((concept) => (
                <span key={concept} className="rounded-[4px] bg-white/[0.06] px-2 py-0.5 text-[11.5px] text-[#d9d4c8]">
                  {concept}
                </span>
              ))}
              {company.concepts.length > 12 && (
                <span className="px-1 py-0.5 text-[11.5px] text-[#8d887c]">等 {company.concepts.length} 个</span>
              )}
            </div>
          </Card>
        )}

        <p className="text-[11.5px] leading-4 text-[#6f6a5f]">
          公司资料来自公司池快照{generatedAt ? `（数据截至 ${generatedAt}）` : ""}；行情/财务/公告/研报来自数据底座（a-stock-data，分源标注、如实降级）。
          公司发现不是投资建议。
        </p>
      </div>
    </main>
  );
}
