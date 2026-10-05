import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadDataset } from "../lib/companies";
import type { Company } from "../lib/types";
import { deriveProfile } from "../search/profile/derive";
import {
  CORPUS_BUILDER_VERSION,
  CORPUS_SCHEMA_VERSION,
  PROFILE_FIELD_CAP,
  SEARCHABLE_TEXT_CAP,
  validateCompanyKnowledgeDocument,
  type CompanyKnowledgeDocument,
  type CorpusManifest,
  type CorpusStats,
} from "../lib/corpus/contracts";
import { ONTOLOGY_VERSION } from "../search/ontology/index";
import { DERIVATION_VERSION, EMBEDDING_MODEL } from "../search/profile/schema";
import { SEMICONDUCTOR_ENRICHMENT_VERSION } from "../search/knowledge/semiconductor";
import { COMMODITY_ONTOLOGY_VERSION } from "../search/ontology/commodities";
import { THERMAL_ENRICHMENT_VERSION } from "../search/ontology/thermal";
import { DIM } from "../lib/text/embed";
import {
  SOURCE_FACTS_SCHEMA_VERSION,
  validateCompanySourceFact,
  type CompanySourceFact,
  type CompanySourceFactTerm,
} from "../lib/sourcefacts/contracts";

/**
 * Company Knowledge Corpus 的唯一 canonical builder（Phase 2）。
 *
 *   data/companies.json（规范化事实，committed）
 *   + data/enrichment/semiconductor/enrichment.json（stage3 知识标签，committed）
 *   + data/source_facts/facts.jsonl（Source Coverage 事实补充层，committed）
 *   → deriveProfile（确定性词面派生，与旧 profile 层同一实现）
 *   → DF 闸门（同一 0.05 阈值）→ themes / sourceFacts / exclusions / aliases / searchableText
 *   → data/company-corpus/companies.jsonl + manifest.json
 *
 * 纪律：
 * - 输入只有 committed 数据，离线、无网络；相同输入 → 逐字节相同 JSONL。
 * - 不读 data/raw（fetch 缓存）——语料必须能从 git 内输入完整再生。
 * - 主题必须证据回指；否定标签必须规则在案；缺失就是缺失。
 * - --check：用当前输入重建，与在盘 artifact 逐字节对账（确定性验证）。
 *
 * Usage: npx tsx scripts/build_company_corpus.ts [--check]
 */

const root = process.cwd();
const OUT_DIR = path.join(root, "data", "company-corpus");
const OUT_JSONL = path.join(OUT_DIR, "companies.jsonl");
const OUT_MANIFEST = path.join(OUT_DIR, "manifest.json");
const ENRICHMENT_FILE = path.join(root, "data", "enrichment", "semiconductor", "enrichment.json");
const SOURCE_FACTS_FILE = path.join(root, "data", "source_facts", "facts.jsonl");

/** Source Coverage 派生词面上限：640 字预算内的克制表现（来源事实行另截 160）。 */
const SOURCE_FACT_TERMS_CAP = 12;
const SOURCE_FACT_LINE_CAP = 160;

/** Evidence Coverage 投影上限（v1.2.0）：披露原文行的确定性预算（§35——
 * 按 source/factType 先级与整条收录，不用语义排序选）。行内至多 5 条、
 * 共 280 字；放不下的整条跳过——截断会伪造「完整原文」的形状。 */
const EVIDENCE_LINE_CAP = 280;
const EVIDENCE_SPANS_CAP = 5;
/** Surface 扩展（v1.3.0）：point-in-time / 官网产品面的分面配额（§24 surface
 * diversity）。没有配额时公告窗口（新而多）会把 3.6 年报窗口整体挤出预算——
 * 恰恰是公告最多的大公司（benchmark 锚点带）受伤；分面配额保证新 surface
 * 增量进入而年报证据至少保 3 槽。两个配额都是确定性上限，不是语义挑选。
 * 字符子预算（220）与槽配额（2+2）同时生效——不设字符上限时两个 200 字
 * 公告窗口会吃满 280 字行，年报证据照样被挤空；220 放得下单条典型公告窗口
 * （实测 155-219 字）或两条产品句。 */
const ANNOUNCEMENT_SPANS_CAP = 2;
const OFFICIAL_PRODUCT_SPANS_CAP = 2;
const NEW_SURFACE_CHAR_BUDGET = 220;

const check = process.argv.includes("--check");

type EnrichmentRecord = { code: string; level: string; retrievalLabels?: string[] };

function loadEnrichment(): { version: string; labels: Map<string, { level: string; labels: string[] }> } {
  if (!existsSync(ENRICHMENT_FILE)) {
    return { version: "none", labels: new Map() };
  }
  const parsed = JSON.parse(readFileSync(ENRICHMENT_FILE, "utf8")) as {
    version: string;
    records: EnrichmentRecord[];
  };
  if (parsed.version !== SEMICONDUCTOR_ENRICHMENT_VERSION) {
    console.error(`enrichment version mismatch: file=${parsed.version} expected=${SEMICONDUCTOR_ENRICHMENT_VERSION}`);
    process.exit(1);
  }
  const labels = new Map<string, { level: string; labels: string[] }>();
  for (const record of parsed.records) {
    const rows = (record.retrievalLabels ?? []).filter(Boolean);
    if (rows.length) labels.set(record.code, { level: record.level, labels: rows });
  }
  return { version: parsed.version, labels };
}

/**
 * Source Coverage 事实补充层（committed 输入，离线）。文件缺失 = 该层不存在
 * （pass 尚未运行），不是错误；文件存在但有一条不合法 = acquisition 侧违反
 * 证据纪律，直接拒绝构建（绝不带着坏证据进检索）。
 */
function loadSourceFacts(): { version: string; facts: Map<string, CompanySourceFact[]> } {
  if (!existsSync(SOURCE_FACTS_FILE)) {
    return { version: "none", facts: new Map() };
  }
  const facts = new Map<string, CompanySourceFact[]>();
  const lines = readFileSync(SOURCE_FACTS_FILE, "utf8").split("\n").filter((line) => line.trim());
  for (const line of lines) {
    const fact = JSON.parse(line) as CompanySourceFact;
    const issues = validateCompanySourceFact(fact);
    if (issues.length) {
      console.error(`source fact invalid (${SOURCE_FACTS_FILE}):`);
      for (const issue of issues) console.error(`  - ${issue}`);
      process.exit(1);
    }
    const bucket = facts.get(fact.companyCode) ?? [];
    bucket.push(fact);
    facts.set(fact.companyCode, bucket);
  }
  return { version: SOURCE_FACTS_SCHEMA_VERSION, facts };
}

/**
 * 从一家公司的事实里确定性派生检索词面：
 *   1. 事实按 (source.date 降序, factId 升序) 排——最新报告期优先，同日按 id 稳定；
 *   2. 每条事实的 terms 已由契约保证是 rawText 逐字子串（loader 已验）；
 *   3. 已被 head 文本（主营业务/主要产品行）覆盖的词不再重复占预算；
 *   4. DF 闸门与 themes 同一 0.05 阈值——词面在过多公司出现就不进检索文本。
 */
function deriveSourceFacts(
  companyFacts: CompanySourceFact[] | undefined,
  coveredText: string,
  genericTerms: Set<string>,
): CompanySourceFactTerm[] {
  if (!companyFacts?.length) return [];
  const sorted = [...companyFacts].sort((a, b) => {
    const dateA = a.source.date ?? "9999-12-31";
    const dateB = b.source.date ?? "9999-12-31";
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    return a.factId < b.factId ? -1 : 1;
  });
  const out: CompanySourceFactTerm[] = [];
  const seen = new Set<string>();
      /** 后缀剥离基形：伺服系统产品/伺服系统业务/PLC及扩展 与其短形等价；
       *  Pass 2 全样本审计补 行业/收入/板块（跨期命名漂移：房地产/房地产行业/
       *  技术服务/技术服务收入/轨道交通板块 是同一业务的不同期名称）。 */
      const baseOf = (term: string) => term.replace(/(业务|产品|类|行业|收入|板块|及扩展)$/, "");
  const bases = new Set<string>();
  for (const fact of sorted) {
    for (const term of fact.terms) {
      if (seen.has(term) || genericTerms.has(term)) continue;
      if (coveredText.includes(term)) continue;
      const base = baseOf(term);
      if (bases.has(base)) continue;
      // 与已收录词互为包含（伺服系统 ⊂ 伺服系统附件）时只留先者，省预算不加噪声。
      if ([...seen].some((kept) => kept.includes(term) || term.includes(kept))) continue;
      seen.add(term);
      bases.add(base);
      out.push({ term, factType: fact.factType, evidence: fact.factId });
      if (out.length >= SOURCE_FACT_TERMS_CAP) return out;
    }
  }
  return out;
}

/**
 * Evidence Coverage 投影（v1.2.0，Phase 3.6）→ Surface 扩展投影（v1.3.0，Phase 3.7）。
 * verbatim 证据句进文档。确定性选取（§24：source authority / freshness /
 * surface diversity 都是确定性属性，不是语义排序）：
 *   1. 新面先行：公告关系窗口（披露日新者优先）与官网产品句（factId 序），
 *      合计至多 2+2 条、至多 220 字；
 *   2. 年报关系窗口 + 细粒度产品窗口填满剩余预算（factId 序，3.6 行为）。
 * text 就是 fact.rawText 本身（零改写），evidence 指针可反查 provenance。
 * 总预算不变（≤5 条、≤280 字，整条收录放不下整条跳过）；没有新面事实的公司
 * 与 3.6 逐字节同行为。
 */
function deriveEvidenceSpans(companyFacts: CompanySourceFact[] | undefined): {
  spans: NonNullable<CompanyKnowledgeDocument["evidenceSpans"]>;
  joined: string;
  surfaces: { annual: boolean; announcements: boolean; officialProducts: boolean };
} {
  if (!companyFacts?.length) return { spans: [], joined: "", surfaces: { annual: false, announcements: false, officialProducts: false } };
  const byId = (a: CompanySourceFact, b: CompanySourceFact) => (a.factId < b.factId ? -1 : 1);
  const byDateDesc = (a: CompanySourceFact, b: CompanySourceFact) => {
    const dateA = a.source.date ?? "9999-12-31";
    const dateB = b.source.date ?? "9999-12-31";
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    return byId(a, b);
  };
  const newSurfaceFacts = [
    ...companyFacts.filter((fact) => fact.source.sourceType === "filing_announcement").sort(byDateDesc).slice(0, ANNOUNCEMENT_SPANS_CAP),
    ...companyFacts.filter((fact) => fact.source.sourceType === "official_product_page").sort(byId).slice(0, OFFICIAL_PRODUCT_SPANS_CAP),
  ];
  const annualFacts = [
    ...companyFacts.filter((fact) => fact.source.sourceId.startsWith("cninfo:annual_report#relation:")).sort(byId),
    ...companyFacts.filter((fact) => fact.source.sourceId.endsWith("#fine_product")).sort(byId),
  ];
  const spans: NonNullable<CompanyKnowledgeDocument["evidenceSpans"]> = [];
  const selectedFacts: CompanySourceFact[] = [];
  let joined = "";
  for (const fact of newSurfaceFacts) {
    if (spans.length >= EVIDENCE_SPANS_CAP || joined.length >= NEW_SURFACE_CHAR_BUDGET) break;
    const candidate = joined ? `${joined}；${fact.rawText}` : fact.rawText;
    if (joined.length + fact.rawText.length + 1 > NEW_SURFACE_CHAR_BUDGET) continue;
    if (candidate.length > EVIDENCE_LINE_CAP) continue;
    joined = candidate;
    spans.push({ evidence: fact.factId, factType: fact.factType, text: fact.rawText });
    selectedFacts.push(fact);
  }
  for (const fact of annualFacts) {
    if (spans.length >= EVIDENCE_SPANS_CAP) break;
    const candidate = joined ? `${joined}；${fact.rawText}` : fact.rawText;
    if (candidate.length > EVIDENCE_LINE_CAP) continue;
    joined = candidate;
    spans.push({ evidence: fact.factId, factType: fact.factType, text: fact.rawText });
    selectedFacts.push(fact);
  }
  return {
    spans,
    joined,
    surfaces: {
      annual: selectedFacts.some((fact) => fact.source.sourceType === "filing_annual_report"),
      announcements: selectedFacts.some((fact) => fact.source.sourceType === "filing_announcement"),
      officialProducts: selectedFacts.some((fact) => fact.source.sourceType === "official_product_page"),
    },
  };
}

/** 曾用名：只认「由 X 变更为」的明示语句，短形（≤8 字、无"公司"字样）。 */
const FORMER_NAME = /由[“"『「]?([\u4e00-\u9fffA-Za-z0-9*]{2,8})[”"』」]?变更为/g;

function formerNamesOf(name: string, profileText: string): string[] {
  const out: string[] = [];
  for (const match of profileText.matchAll(FORMER_NAME)) {
    const candidate = match[1].trim();
    if (!candidate || candidate === name) continue;
    if (candidate.includes("公司") || /^[0-9]+$/.test(candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
    if (out.length >= 2) break;
  }
  return out;
}

function aliasesOf(company: Company, former: string[]): string[] {
  const out: string[] = [];
  const push = (value: string | undefined | null) => {
    const alias = (value ?? "").trim();
    if (!alias) return;
    if (alias === company.name || out.includes(alias)) return;
    if (alias.includes("公司")) return;
    out.push(alias);
  };
  const stripped = company.name.replace(/^\*?ST/i, "");
  if (stripped !== company.name) push(stripped);
  push(company.fullName.replace(/股份有限公司$/, "").replace(/有限公司$/, ""));
  former.forEach(push);
  return out.slice(0, 8);
}

/** 与旧 profile searchText 同构的主题序：角色→应用→细分→热管理→商品→工艺→标签。 */
function themeOrder(dimension: string): number {
  const order = [
    "industryChainRole",
    "applicationScenario",
    "semiconductorSegment",
    "thermalSegment",
    "roboticsSegment",
    "thermalProduct",
    "thermalCoolingMode",
    "commodityExposure",
    "semiconductorKnowledge",
    "concept",
  ];
  const at = order.indexOf(dimension);
  return at === -1 ? order.length : at;
}

/** 数值口径与 lib/profile/latestProducts 一致：share 0..1.5 之外不收。 */
function ratioText(ratio: number | undefined): string {
  return ratio != null ? `(${Math.round(ratio * 100)}%)` : "";
}

function buildSearchableText(parts: {
  symbol: string;
  name: string;
  exchange: string;
  formerNames: string[];
  industry: string;
  swIndustry: string;
  province: string;
  city: string;
  business: string;
  productLine: string;
  evidenceJoined: string;
  sourceFacts: CompanySourceFactTerm[];
  concepts: string[];
  overseasRevenueShare: number | null;
  themes: CompanyKnowledgeDocument["themes"];
  exclusions: CompanyKnowledgeDocument["exclusions"];
  profile: string;
}): string {
  const lines: string[] = [];
  lines.push(`公司：${parts.name}（${parts.symbol}，${parts.exchange}）`);
  if (parts.formerNames.length) lines.push(`曾用名：${parts.formerNames.join("、")}`);
  const industry = [parts.industry, parts.swIndustry !== "unknown" ? parts.swIndustry : ""].filter(Boolean).join("／");
  if (industry) lines.push(`行业：${industry}`);
  if (parts.province) lines.push(`地区：${parts.province}${parts.city}`);
  if (parts.business) lines.push(`主营业务：${parts.business}`);
  if (parts.productLine) lines.push(`主要产品：${parts.productLine}`);
  if (parts.evidenceJoined) lines.push(`披露原文：${parts.evidenceJoined}`);
  if (parts.sourceFacts.length) {
    const joined = parts.sourceFacts.map((entry) => entry.term).join("、").slice(0, SOURCE_FACT_LINE_CAP);
    lines.push(`来源事实：${joined}`);
  }
  if (parts.concepts.length) lines.push(`概念：${parts.concepts.slice(0, 8).join("、")}`);
  if (parts.overseasRevenueShare != null) lines.push(`境外收入占比约${Math.round(parts.overseasRevenueShare * 100)}%`);
  if (parts.themes.length) lines.push(`主题：${parts.themes.map((theme) => theme.label).join("、")}`);
  if (parts.exclusions.length) lines.push(`排除：${parts.exclusions.map((row) => row.label).join("、")}`);
  const head = lines.join("\n");
  const room = SEARCHABLE_TEXT_CAP - head.length - "\n简介：".length;
  if (parts.profile && room > 8) lines.push(`简介：${parts.profile.slice(0, room)}`);
  return lines.join("\n").slice(0, SEARCHABLE_TEXT_CAP);
}

function sourcesRows(
  asOf: string,
  flags: { sourceFacts: boolean; annual: boolean; announcements: boolean; officialProducts: boolean },
): CompanyKnowledgeDocument["sources"] {
  const rows: CompanyKnowledgeDocument["sources"] = [
    {
      sourceId: "akshare:stock_zh_a_spot_em",
      sourceName: "交易所A股列表(ak.stock_zh_a_spot_em / ak.stock_info_a_code_name)",
      sourceType: "exchange_list",
      fields: ["symbol", "name", "identity.exchange", "identity.board", "aliases"],
      asOf,
    },
    {
      sourceId: "akshare:stock_zyjs_ths",
      sourceName: "同花顺主营介绍(ak.stock_zyjs_ths,回退 ak.stock_profile_cninfo 主营业务)",
      sourceType: "business_filing_summary",
      fields: ["business"],
      asOf,
    },
    {
      sourceId: "akshare:stock_profile_cninfo",
      sourceName: "巨潮公司资料(ak.stock_profile_cninfo:公司名称/机构简介/办公地址/上市日期)",
      sourceType: "company_profile",
      fields: ["fullName", "profile", "identity.listedAt", "identity.province", "identity.city"],
      asOf,
    },
    {
      sourceId: "akshare:stock_zygc_em",
      sourceName: "东方财富主营构成·按产品(ak.stock_zygc_em,最近报告期)",
      sourceType: "annual_filing_product_split",
      fields: ["products", "revenueMix"],
      asOf,
    },
    {
      sourceId: "akshare:stock_zygc_em:region",
      sourceName: "东方财富主营构成·按地区(境外词面确定性切分,lib/profile.overseasShare)",
      sourceType: "annual_filing_region_split",
      fields: ["overseasRevenueShare"],
      asOf,
    },
    {
      sourceId: "eastmoney:concept_boards",
      sourceName: "东方财富概念板块成员(噪声清洗后,lib/profile.cleanConcepts)",
      sourceType: "concept_board_membership",
      fields: ["concepts"],
      asOf,
    },
    {
      sourceId: "sw:level1_map",
      sourceName: "申万一级行业成分表(2021版,scripts/fetch_sw_industry.py)",
      sourceType: "index_constituents",
      fields: ["identity.swIndustry"],
      asOf,
    },
  ];
  if (flags.sourceFacts) {
    rows.push({
      sourceId: "a-atlas:source_facts",
      sourceName: "公司事实补充层(Source Coverage,data/source_facts/facts.jsonl,rawText 证据可反查)",
      sourceType: "source_facts",
      fields: ["sourceFacts"],
      asOf,
    });
  }
  if (flags.annual) {
    rows.push({
      sourceId: "cninfo:annual_report",
      sourceName: "巨潮年报(data/raw/source_facts annual-report PDF,披露原文证据可反查 facts.jsonl)",
      sourceType: "filing_annual_report",
      fields: ["evidenceSpans"],
      asOf,
    });
  }
  if (flags.announcements) {
    rows.push({
      sourceId: "cninfo:announcement",
      sourceName: "巨潮公告(data/raw/source_facts announcements PDF,point-in-time 关系证据可反查 facts.jsonl)",
      sourceType: "filing_announcement",
      fields: ["evidenceSpans"],
      asOf,
    });
  }
  if (flags.officialProducts) {
    rows.push({
      sourceId: "website:product_page",
      sourceName: "官网产品页(data/raw/source_facts website snapshot,官方产品证据可反查 facts.jsonl)",
      sourceType: "official_product_page",
      fields: ["evidenceSpans"],
      asOf,
    });
  }
  return rows;
}

function buildDocs(
  companies: Company[],
  knowledge: Map<string, { level: string; labels: string[] }>,
  sourceFacts: Map<string, CompanySourceFact[]>,
  asOf: string,
) {
  // DF 闸门：与旧 profile 构建同一阈值、同一口径（标签在过多公司出现就不进检索文本）。
  const GENERIC_LABEL_DF = 0.05;
  const labelDf = new Map<string, number>();
  const knowledgeDf = new Map<string, number>();
  const sourceFactDf = new Map<string, number>();
  const bundles = new Map<string, ReturnType<typeof deriveProfile>>();
  for (const company of companies) {
    const bundle = deriveProfile(company);
    bundles.set(company.code, bundle);
    for (const label of new Set(bundle.derived.map((entry) => entry.label))) {
      labelDf.set(label, (labelDf.get(label) ?? 0) + 1);
    }
  }
  for (const record of knowledge.values()) {
    for (const label of new Set(record.labels)) knowledgeDf.set(label, (knowledgeDf.get(label) ?? 0) + 1);
  }
  for (const companyFacts of sourceFacts.values()) {
    for (const fact of companyFacts) {
      for (const term of new Set(fact.terms)) sourceFactDf.set(term, (sourceFactDf.get(term) ?? 0) + 1);
    }
  }
  const genericLabels = new Set(
    [...labelDf.entries()].filter(([, n]) => n / companies.length > GENERIC_LABEL_DF).map(([label]) => label),
  );
  for (const [label, n] of knowledgeDf) {
    if (n / companies.length > GENERIC_LABEL_DF) genericLabels.add(label);
  }
  const genericSourceTerms = new Set(
    [...sourceFactDf.entries()].filter(([, n]) => n / companies.length > GENERIC_LABEL_DF).map(([term]) => term),
  );

  const asOfDate = asOf;
  const docs: CompanyKnowledgeDocument[] = [];
  const factById = new Map<string, CompanySourceFact>();
  for (const rows of sourceFacts.values()) {
    for (const fact of rows) factById.set(fact.factId, fact);
  }
  for (const company of companies) {
    const bundle = bundles.get(company.code)!;
    const knowledgeRecord = knowledge.get(company.code);
    const profileFull = company.companyDescription.slice(0, PROFILE_FIELD_CAP);
    const formerNames = formerNamesOf(company.name, company.companyDescription);
    const aliases = aliasesOf(company, formerNames);

    const themes: CompanyKnowledgeDocument["themes"] = [];
    const seenLabels = new Set<string>();
    const pushTheme = (label: string, evidence: string, dimension: string) => {
      if (!label || genericLabels.has(label) || seenLabels.has(label)) return;
      seenLabels.add(label);
      themes.push({ label, evidence: evidence.slice(0, 40), dimension });
    };
    for (const dimension of ["industryChainRole", "applicationScenario", "semiconductorSegment", "thermalSegment", "roboticsSegment", "thermalProduct", "thermalCoolingMode", "commodityExposure"]) {
      for (const entry of bundle.derived.filter((row) => row.dimension === dimension)) {
        pushTheme(entry.label, entry.evidence[0] ?? "", entry.dimension);
      }
    }
    if (knowledgeRecord) {
      for (const label of knowledgeRecord.labels) {
        pushTheme(label, `stage3:${knowledgeRecord.level}:${company.code}`, "semiconductorKnowledge");
      }
    }
    for (const tag of bundle.semantic.semanticTags) pushTheme(tag.tag, tag.evidence, "concept");
    themes.sort((a, b) => themeOrder(a.dimension) - themeOrder(b.dimension));

    const exclusions = bundle.semantic.negativeConcepts.map((row) => ({ label: row.label, because: row.because, rule: row.rule }));

    const productLine = company.mainProducts
      .slice(0, 4)
      .map((item) => `${item.name}${ratioText(item.revenueShare)}`)
      .join("、");

    // Source Coverage 词面：先按 head 文本（主营+产品行）判重，再进文档与检索行。
    // 词条选取即服从 160 字行预算：进 sourceFacts 块的词必须真正落进 searchableText
    // （Pass 1 锁：facts 进块就必须可检索，不得只存不检）；被预算挤出的词仍留在
    // facts 层可反查（§7：预算归 corpus 投影，不删 source truth）。
    const coveredText = `${company.businessDescription ?? ""}\n${productLine}`;
    const derivedSourceFactTerms = deriveSourceFacts(sourceFacts.get(company.code), coveredText, genericSourceTerms);
    const sourceFactTerms: CompanySourceFactTerm[] = [];
    let sourceFactJoined = "";
    for (const entry of derivedSourceFactTerms) {
      const candidate = sourceFactJoined ? `${sourceFactJoined}、${entry.term}` : entry.term;
      if (candidate.length > SOURCE_FACT_LINE_CAP) break;
      sourceFactJoined = candidate;
      sourceFactTerms.push(entry);
    }

    // Evidence Coverage 投影：verbatim 证据句（relation 窗口 → fine_product 窗口）。
    const evidence = deriveEvidenceSpans(sourceFacts.get(company.code));

    const doc: CompanyKnowledgeDocument = {
      schemaVersion: CORPUS_SCHEMA_VERSION,
      symbol: company.code,
      name: company.name,
      fullName: company.fullName,
      identity: {
        exchange: company.exchange,
        board: company.board,
        listedAt: company.listedAt,
        industry: company.industry,
        swIndustry: company.swLevel1Industry,
        province: company.region.province,
        city: company.region.city,
      },
      aliases,
      profile: profileFull,
      business: company.businessDescription ? [company.businessDescription] : [],
      products: company.mainProducts.map((item) => item.name),
      revenueMix: company.mainProducts
        .filter((item) => item.revenueShare != null)
        .map((item) => ({ name: item.name, ratio: item.revenueShare, dimension: "按产品" as const })),
      overseasRevenueShare: company.overseasRevenueShare,
      concepts: company.concepts,
      themes,
      sourceFacts: sourceFactTerms.length ? sourceFactTerms : undefined,
      evidenceSpans: evidence.spans.length ? evidence.spans : undefined,
      exclusions,
      searchableText: "",
      sources: sourcesRows(asOfDate, { sourceFacts: sourceFactTerms.length > 0, ...evidence.surfaces }),
    };
    doc.searchableText = buildSearchableText({
      symbol: doc.symbol,
      name: doc.name,
      exchange: doc.identity.exchange,
      formerNames,
      industry: doc.identity.industry,
      swIndustry: doc.identity.swIndustry,
      province: doc.identity.province,
      city: doc.identity.city,
      business: doc.business[0] ? doc.business[0].slice(0, 200) : "",
      productLine,
      evidenceJoined: evidence.joined,
      sourceFacts: sourceFactTerms,
      concepts: doc.concepts,
      overseasRevenueShare: doc.overseasRevenueShare,
      themes,
      exclusions,
      profile: doc.profile,
    });
    // 机械验证（builder 内建，不只靠测试）：span 必须回指真实 fact、逐字相等、
    // 且完整落在 searchableText 里——「进块就必须可检索」（Pass 1 锁的延伸）。
    for (const span of doc.evidenceSpans ?? []) {
      const fact = factById.get(span.evidence);
      if (!fact || fact.rawText !== span.text) {
        throw new Error(`evidence span ${span.evidence} does not resolve to the exact fact rawText`);
      }
      if (!doc.searchableText.includes(span.text)) {
        throw new Error(`evidence span ${span.evidence} is not fully inside searchableText`);
      }
    }
    docs.push(doc);
  }
  docs.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { docs, genericLabels };
}

function statsOf(docs: CompanyKnowledgeDocument[]): CorpusStats {
  const byExchange: Record<string, number> = {};
  let profile = 0;
  let business = 0;
  let product = 0;
  let revenueMix = 0;
  let themes = 0;
  let sourceFactsCovered = 0;
  let evidenceSpansCovered = 0;
  let evidenceSpanCount = 0;
  let announcementEvidence = 0;
  let officialProductEvidence = 0;
  let alias = 0;
  let concept = 0;
  let empty = 0;
  let truncated = 0;
  let chars = 0;
  let maxChars = 0;
  for (const doc of docs) {
    byExchange[doc.identity.exchange] = (byExchange[doc.identity.exchange] ?? 0) + 1;
    if (doc.profile) profile += 1;
    if (doc.profile.length >= PROFILE_FIELD_CAP) truncated += 1;
    if (doc.business.length) business += 1;
    if (doc.products.length) product += 1;
    if (doc.revenueMix.length) revenueMix += 1;
    if (doc.themes.length) themes += 1;
    if (doc.sourceFacts?.length) sourceFactsCovered += 1;
    if (doc.evidenceSpans?.length) {
      evidenceSpansCovered += 1;
      evidenceSpanCount += doc.evidenceSpans.length;
    }
    if (doc.sources.some((source) => source.sourceType === "filing_announcement")) announcementEvidence += 1;
    if (doc.sources.some((source) => source.sourceType === "official_product_page")) officialProductEvidence += 1;
    if (doc.aliases.length >= 1) alias += 1;
    if (doc.concepts.length) concept += 1;
    if (!doc.searchableText) empty += 1;
    chars += doc.searchableText.length;
    maxChars = Math.max(maxChars, doc.searchableText.length);
  }
  return {
    byExchange,
    profileCoverage: profile,
    businessCoverage: business,
    productCoverage: product,
    revenueMixCoverage: revenueMix,
    themesCoverage: themes,
    sourceFactsCoverage: sourceFactsCovered,
    evidenceSpansCoverage: evidenceSpansCovered,
    evidenceSpanCount,
    announcementEvidenceCoverage: announcementEvidence,
    officialProductEvidenceCoverage: officialProductEvidence,
    aliasCoverage: alias,
    conceptCoverage: concept,
    emptySearchableText: empty,
    duplicateSymbols: docs.length - new Set(docs.map((doc) => doc.symbol)).size,
    malformedRecords: 0,
    profileTruncated: truncated,
    avgSearchableTextChars: docs.length ? Math.round(chars / docs.length) : 0,
    maxSearchableTextChars: maxChars,
  };
}

function jsonlOf(docs: CompanyKnowledgeDocument[]): string {
  return docs.map((doc) => JSON.stringify(doc)).join("\n") + "\n";
}

function sha16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function main() {
  const started = Date.now();
  const { companies, generatedAt } = loadDataset();
  if (!companies.length) {
    console.error("companies.json empty; run npm run data first");
    process.exit(1);
  }
  if (new Set(companies.map((company) => company.code)).size !== companies.length) {
    console.error("companies.json has duplicate codes; fix the dataset before building the corpus");
    process.exit(1);
  }
  const knowledge = loadEnrichment();
  const sourceFacts = loadSourceFacts();
  const { docs, genericLabels } = buildDocs(companies, knowledge.labels, sourceFacts.facts, (generatedAt ?? "unknown").slice(0, 10));

  const issues: string[] = [];
  for (const doc of docs) issues.push(...validateCompanyKnowledgeDocument(doc));
  const stats = statsOf(docs);
  stats.malformedRecords = issues.length;
  if (issues.length) {
    console.error(`corpus validation failed (${issues.length} issues):`);
    for (const issue of issues.slice(0, 20)) console.error(`  - ${issue}`);
    process.exit(1);
  }

  const jsonl = jsonlOf(docs);
  const digest = createHash("sha256").update(jsonl, "utf8").digest("hex");
  const datasetBuf = readFileSync(path.join(root, "data", "companies.json"));
  const manifest: CorpusManifest = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    builderVersion: CORPUS_BUILDER_VERSION,
    ontologyVersion: ONTOLOGY_VERSION,
    derivationVersion: DERIVATION_VERSION,
    knowledgeEnrichmentVersion: knowledge.version,
    sourceFactsVersion: sourceFacts.version,
    commodityOntologyVersion: COMMODITY_ONTOLOGY_VERSION,
    thermalEnrichmentVersion: THERMAL_ENRICHMENT_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    embeddingDim: DIM,
    generatedAt: new Date().toISOString(),
    sourceSnapshot: {
      dataset: "data/companies.json",
      datasetSha16: sha16(datasetBuf.toString("utf8")),
      datasetGeneratedAt: generatedAt ?? "unknown",
    },
    contentDigest: { algorithm: "sha256", scope: "companies.jsonl", value: digest },
    companyCount: docs.length,
    stats,
  };

  if (check) {
    const mismatches: string[] = [];
    if (!existsSync(OUT_JSONL) || !existsSync(OUT_MANIFEST)) {
      console.error("corpus artifact missing; run scripts/build_company_corpus.ts first");
      process.exit(1);
    }
    const onDisk = readFileSync(OUT_JSONL, "utf8");
    if (onDisk !== jsonl) {
      const diskLines = onDisk.split("\n").length;
      mismatches.push(`companies.jsonl differs (disk ${onDisk.length} chars/${diskLines} lines vs rebuild ${jsonl.length} chars)`);
      const a = onDisk.split("\n");
      const b = jsonl.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          mismatches.push(`  first differing line ${i + 1}: ${a[i]?.slice(0, 120)} vs ${b[i]?.slice(0, 120)}`);
          break;
        }
      }
    }
    const diskManifest = JSON.parse(readFileSync(OUT_MANIFEST, "utf8")) as CorpusManifest;
    const { generatedAt: _ignore, ...rest } = diskManifest as unknown as Record<string, unknown>;
    const { generatedAt: _ignore2, ...rebuilt } = manifest as unknown as Record<string, unknown>;
    if (JSON.stringify(rest) !== JSON.stringify(rebuilt)) mismatches.push("manifest differs beyond generatedAt");
    if (diskManifest.contentDigest.value !== createHash("sha256").update(onDisk, "utf8").digest("hex")) {
      mismatches.push("manifest contentDigest does not match companies.jsonl on disk");
    }
    if (mismatches.length) {
      console.error("corpus --check FAILED:");
      for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
      process.exit(1);
    }
    console.log(`corpus --check ok: ${docs.length} docs, digest ${digest.slice(0, 16)}, byte-identical rebuild`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSONL, jsonl, "utf8");
  writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 1) + "\n", "utf8");
  console.log(`generic labels kept out of themes (df > 0.05): ${[...genericLabels].join("、") || "(none)"}`);
  console.log(`corpus: ${docs.length} docs, ${jsonl.length} chars (utf8 ${Buffer.byteLength(jsonl, "utf8")} bytes), sha256 ${digest.slice(0, 16)}`);
  console.log(`stats: ${JSON.stringify(stats)}`);
  console.log(`built in ${Date.now() - started}ms -> data/company-corpus/{companies.jsonl,manifest.json}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
