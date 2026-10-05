import type { Company, MainProduct } from "./types";
import { provinceInText } from "./search/constraints";

export type RawCompany = {
  code: string;
  name: string;
  marketCap?: number | null;
  profile?: Record<string, unknown> | null;
  zyjs?: Record<string, unknown> | null;
  zygc?: Record<string, unknown>[] | null;
  concepts?: string[] | null;
  industryBoard?: string | null;
  /** From data/raw/sw/level1_map.json, merged in by build_profiles. */
  swLevel1Industry?: string | null;
};

const NOISE_CONCEPTS = /融资融券|沪股通|深股通|港股通|MSCI|富时|标普|证金持股|机构重仓|昨日|涨停|跌停|转融|融券|QFII|社保重仓|基金重仓|创业板综|央视50|HS300|中证500|上证50|深成500|百元股|低价股|高送转|股权转让|参股券商|参股银行|参股保险|壳资源/;

const OVERSEAS = /境外|海外|国外|出口|国际|欧美|美洲|欧洲|亚洲其他|港澳台/;

function text(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Filings come back either as YYYY-MM-DD or as epoch milliseconds. */
function dateKey(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n) && n > 1e11) return new Date(n).toISOString().slice(0, 10);
  return text({ v: value }, "v");
}

export function exchangeOf(code: string): Company["exchange"] {
  if (code.startsWith(("92")) || code.startsWith(("43")) || code.startsWith(("8"))) return "BJ";
  if (code.startsWith("6")) return "SH";
  return "SZ";
}

export function boardOf(code: string): string {
  if (code.startsWith("688") || code.startsWith("689")) return "科创板";
  if (code.startsWith("300") || code.startsWith("301") || code.startsWith("302")) return "创业板";
  if (code.startsWith("43") || code.startsWith("83") || code.startsWith("87") || code.startsWith("88") || code.startsWith("92")) return "北交所";
  return "主板";
}

function cityAfter(address: string, province: string): string {
  const at = province ? address.indexOf(province) : -1;
  const rest = (at >= 0 ? address.slice(at + province.length) : address).replace(/^省|^市/, "");
  const city = rest.match(/^([\u4e00-\u9fff]{2,8}市)/);
  return city?.[1] ?? "";
}

function latestProducts(rows: Record<string, unknown>[]): MainProduct[] {
  const products = rows.filter((row) => text(row, "分类类型") === "按产品分类");
  if (!products.length) return [];
  const dates = products.map((row) => dateKey(row["报告日期"])).filter(Boolean).sort();
  const latest = dates[dates.length - 1];
  return products
    .filter((row) => !latest || dateKey(row["报告日期"]) === latest)
    .map((row) => {
      const share = num(row["收入比例"]);
      const item: MainProduct = { name: text(row, "主营构成") };
      if (share != null && share > 0 && share <= 1.5) item.revenueShare = Math.round(share * 1000) / 1000;
      return item;
    })
    .filter((item) => item.name && item.name !== "其他" && item.name !== "合计")
    .sort((a, b) => (b.revenueShare ?? 0) - (a.revenueShare ?? 0))
    .slice(0, 5);
}

export function overseasShare(rows: Record<string, unknown>[]): number | null {
  const regions = rows.filter((row) => text(row, "分类类型") === "按地区分类");
  if (!regions.length) return null;
  const dates = regions.map((row) => dateKey(row["报告日期"])).filter(Boolean).sort();
  const latest = dates[dates.length - 1];
  const slice = regions.filter((row) => !latest || dateKey(row["报告日期"]) === latest);
  let total = 0;
  let abroad = 0;
  for (const row of slice) {
    const income = num(row["主营收入"]) ?? 0;
    if (income <= 0) continue;
    total += income;
    if (OVERSEAS.test(text(row, "主营构成"))) abroad += income;
  }
  if (total <= 0) return null;
  return Math.round((abroad / total) * 1000) / 1000;
}

export function cleanConcepts(concepts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const concept of concepts) {
    const name = concept.trim();
    if (!name || NOISE_CONCEPTS.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 12) break;
  }
  return out;
}

export function buildSearchableText(company: Omit<Company, "searchableText" | "judgeText" | "judgeTextEn">): string {
  const products = company.mainProducts
    .slice(0, 3)
    .map((item) => (item.revenueShare != null ? `${item.name}(${Math.round(item.revenueShare * 100)}%)` : item.name))
    .join("、");
  const parts = [
    company.name,
    company.fullName,
    company.industry,
    company.swLevel1Industry !== "unknown" && company.swLevel1Industry,
    company.businessDescription,
    products && `主营产品：${products}`,
    company.concepts.length && `概念：${company.concepts.join("、")}`,
    company.region.province && `地区：${company.region.province}${company.region.city}`,
    company.overseasRevenueShare != null && company.overseasRevenueShare >= 0.2 && `境外收入占比${Math.round(company.overseasRevenueShare * 100)}%`,
    company.companyDescription.slice(0, 180),
  ];
  return parts.filter(Boolean).join("。");
}

export function buildJudgeText(company: Omit<Company, "judgeText" | "judgeTextEn">, detail: number): string {
  const sw = company.swLevel1Industry !== "unknown" ? company.swLevel1Industry : "";
  const line = [
    `${company.name}（${company.code}，${company.exchange}）`,
    (company.industry || sw) && `行业：${[company.industry, sw].filter(Boolean).join("/")}`,
    company.region.province && `注册地：${company.region.province}${company.region.city}`,
    company.businessDescription && `主营：${company.businessDescription}`,
    company.mainProducts.length && `产品：${company.mainProducts.map((item) => item.name).slice(0, 4).join("、")}`,
    company.concepts.length && `概念：${company.concepts.slice(0, 8).join("、")}`,
    company.overseasRevenueShare != null && `境外收入占比约${Math.round(company.overseasRevenueShare * 100)}%`,
  ]
    .filter(Boolean)
    .join(" | ");
  return line.slice(0, detail);
}

export function normalizeCompany(raw: RawCompany, detail = 420): Company {
  const profile = raw.profile ?? {};
  const zyjs = raw.zyjs ?? {};
  const address = text(profile, "办公地址") || text(profile, "注册地址");
  const province = provinceInText(address);
  const products = latestProducts(raw.zygc ?? []);
  const business = text(zyjs, "主营业务") || text(profile, "主营业务");
  const base = {
    code: raw.code.padStart(6, "0"),
    name: (raw.name || text(profile, "A股简称") || text(profile, "证券简称")).replace(/\s+/g, ""),
    fullName: text(profile, "公司名称"),
    exchange: exchangeOf(raw.code),
    board: boardOf(raw.code),
    listedAt: text(profile, "上市日期") || undefined,
    industry: text(profile, "所属行业") || raw.industryBoard || "",
    swLevel1Industry: raw.swLevel1Industry?.trim() || "unknown",
    businessDescription: business,
    mainProducts: products,
    concepts: cleanConcepts(raw.concepts ?? []),
    region: { province, city: cityAfter(address, province) },
    companyDescription: text(profile, "机构简介"),
    marketCap: raw.marketCap ?? null,
    overseasRevenueShare: overseasShare(raw.zygc ?? []),
  };
  const searchableText = buildSearchableText(base);
  return {
    ...base,
    searchableText,
    judgeText: buildJudgeText({ ...base, searchableText }, detail),
    judgeTextEn: null,
  };
}
