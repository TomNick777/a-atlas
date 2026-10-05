/**
 * Company Knowledge Corpus — 版本化契约（Phase 2）。
 *
 * Corpus 是独立的数据层，位于规范化公司事实（data/companies.json）与
 * Jev 发现索引之间：它回答「这家公司有哪些可以被搜索的真实业务语义」，
 * 不做观点、评级、预测；检索/重排（Jev）只消费它，不自己清洗字段。
 *
 * 纪律（docs/COMPANY_KNOWLEDGE_CORPUS.md）：
 * - 缺失就是缺失：字段空 = 该事实不存在，绝不为 UI/覆盖率编造。
 * - 每个主题（themes）必须携带回指原文的证据；否定标签（exclusions）必须
 *   携带规则与理由，只服务「不要 X」类排除，不参与正向召回。
 * - companies.jsonl 逐字节确定性（无时间戳）；构建时刻只在 manifest。
 *   contentDigest 覆盖 JSONL 全部字节，因此 generatedAt 不可能污染它。
 */

import type { CompanySourceFactTerm, SourceFactType } from "../sourcefacts/contracts";
import { SOURCE_FACT_TYPES } from "../sourcefacts/contracts";

const SOURCE_FACT_TYPE_SET: ReadonlySet<string> = new Set<string>(SOURCE_FACT_TYPES);

export const CORPUS_SCHEMA_VERSION = "1.3.0";
export const CORPUS_BUILDER_VERSION = "corpus-builder-1.3.0";

/** JSONL 主文档。字段顺序即写盘顺序（稳定 diff）。 */
export type CompanyKnowledgeDocument = {
  schemaVersion: string;
  /** canonical 6 位代码，全语料唯一主键（A-Atlas 全产品只认这个符号）。 */
  symbol: string;
  name: string;
  fullName: string;
  identity: {
    exchange: "SH" | "SZ" | "BJ";
    board: string;
    listedAt?: string;
    /** 东财行业口径。 */
    industry: string;
    /** 申万一级行业（2021 版）；申万未入类如实 "unknown"。 */
    swIndustry: string;
    province: string;
    city: string;
  };
  /** 确定性别名：曾用名、去 ST 前缀、全称短形。不含炒作概念。 */
  aliases: string[];
  /** 机构简介原文（≤2000 字截断；截断在 manifest.stats 记录，不伪装完整）。 */
  profile: string;
  /** 主营业务（披露口径），缺失=空数组。 */
  business: string[];
  /** 主营产品/服务名（最近报告期主营构成·按产品，无报告期如实缺）。 */
  products: string[];
  revenueMix: Array<{ name: string; ratio?: number; dimension: "按产品" }>;
  /** 境外收入占比（按地区分类确定性切分），无地区拆分如实 null。 */
  overseasRevenueShare: number | null;
  /** 东财概念板块成员资格（vendor 派定、清洗后），是事实成员关系不是观点。 */
  concepts: string[];
  /** 检索主题：从事实字段确定性派生，label 必须能回指 evidence 原文词面。 */
  themes: Array<{ label: string; evidence: string; dimension: string }>;
  /**
   * Source Coverage 层派生的公司事实词面（v1.1.0 起，可选）。
   * evidence 是 data/source_facts/facts.jsonl 的 factId（resolvable pointer，
   * 可反查 rawText 原文与 source provenance）；term 必须是该 fact rawText
   * 的逐字子串——词面回指由 builder 机械验证，不由人肉保证。
   */
  sourceFacts?: CompanySourceFactTerm[];
  /**
   * Evidence Coverage 层（v1.2.0 起，可选）：披露文件里的 verbatim 证据句。
   * evidence 是 facts.jsonl 的 factId（resolvable pointer）；text 必须与该 fact
   * 的 rawText 逐字相等（span 投影零改写——原文事实优先，语义关系留给 Jev 判断），
   * 且必须完整出现在 searchableText 里（「facts 进块就必须可检索」锁的延伸）。
   * 确定性选取与行预算在 builder（EVIDENCE_LINE_CAP），不在人手。
   */
  evidenceSpans?: Array<{ evidence: string; factType: SourceFactType; text: string }>;
  /**
   * 确定性否定标签（检索卫生，非业务观点）：「只有零部件证据、无整机词」
   * 这类 absence-of-evidence 结论，规则+理由在案，仅供「不要 X」排除用。
   */
  exclusions: Array<{ label: string; because: string; rule: string }>;
  /** 检索与重排共读的自然语言语义主文档（发现索引的唯一语义输入）。 */
  searchableText: string;
  /** 逐字段组 provenance：事实从哪个源来、覆盖哪些字段、数据时点。 */
  sources: CompanySource[];
};

export type CompanySource = {
  /** 稳定源标识，如 "akshare:stock_zyjs_ths"。 */
  sourceId: string;
  sourceName: string;
  sourceType: string;
  /** 该源覆盖的文档字段组。 */
  fields: string[];
  /** 事实数据时点（快照生成日），无则省略。 */
  asOf?: string;
};

export type CorpusStats = {
  byExchange: Record<string, number>;
  /** 以下 coverage 均为 count（非比率），分子=满足的文档数。 */
  profileCoverage: number;
  businessCoverage: number;
  productCoverage: number;
  revenueMixCoverage: number;
  themesCoverage: number;
  /** 有 sourceFacts 派生词面的文档数（Source Coverage v1.1.0 起）。 */
  sourceFactsCoverage: number;
  /** 有 evidenceSpans 投影的文档数（Evidence Coverage v1.2.0 起）。 */
  evidenceSpansCoverage: number;
  /** evidenceSpans 投影总条数。 */
  evidenceSpanCount: number;
  /** sources 含公告通道（filing_announcement）的文档数（Evidence Surface v1.3.0 起）。 */
  announcementEvidenceCoverage: number;
  /** sources 含官网产品页通道（official_product_page）的文档数（Evidence Surface v1.3.0 起）。 */
  officialProductEvidenceCoverage: number;
  aliasCoverage: number;
  conceptCoverage: number;
  emptySearchableText: number;
  duplicateSymbols: number;
  malformedRecords: number;
  profileTruncated: number;
  avgSearchableTextChars: number;
  maxSearchableTextChars: number;
};

export type CorpusManifest = {
  schemaVersion: string;
  builderVersion: string;
  ontologyVersion: string;
  derivationVersion: string;
  /** 半导体知识富化版本（无富化输入时 "none"）。 */
  knowledgeEnrichmentVersion: string;
  /** Source Coverage source facts 版本（无 facts 输入时 "none"）。 */
  sourceFactsVersion: string;
  /** 主题行消费的其余派生词表版本（provenance 完整性）。 */
  commodityOntologyVersion: string;
  thermalEnrichmentVersion: string;
  /** 发现索引的 embedding 口径（向量构建读 manifest，不另猜模型）。 */
  embeddingModel: string;
  embeddingDim: number;
  generatedAt: string;
  sourceSnapshot: {
    dataset: "data/companies.json";
    datasetSha16: string;
    datasetGeneratedAt: string;
  };
  contentDigest: {
    algorithm: "sha256";
    /** 覆盖 companies.jsonl 的全部字节；manifest 自身不入 digest。 */
    scope: "companies.jsonl";
    value: string;
  };
  companyCount: number;
  stats: CorpusStats;
};

/** 语义主文档长度上限：bge-small-zh 512 token 预算内，与旧 profile searchText 同量级。 */
export const SEARCHABLE_TEXT_CAP = 640;
/** 机构简介在文档内的截断上限（原文长度如实记录在 profile 字段本身）。 */
export const PROFILE_FIELD_CAP = 2000;

/** 结构校验：返回问题列表（空 = 合法）。只查结构与不变量，不评业务内容。 */
export function validateCompanyKnowledgeDocument(doc: CompanyKnowledgeDocument): string[] {
  const issues: string[] = [];
  const at = (detail: string) => `${doc.symbol ?? "?"}: ${detail}`;
  if (!/^\d{6}$/.test(doc.symbol ?? "")) issues.push(at("symbol 不是 6 位 canonical 代码"));
  if (!doc.schemaVersion) issues.push(at("schemaVersion 缺失"));
  if (!doc.name) issues.push(at("name 缺失"));
  if (!doc.searchableText) issues.push(at("searchableText 为空"));
  if (doc.searchableText.length > SEARCHABLE_TEXT_CAP) issues.push(at(`searchableText 超长 ${doc.searchableText.length}`));
  if (!doc.searchableText.includes(`公司：${doc.name}（${doc.symbol}`)) issues.push(at("searchableText 缺身份行"));
  if (!Array.isArray(doc.sources) || !doc.sources.length) issues.push(at("sources 为空"));
  else {
    doc.sources.forEach((source) => {
      if (!source.sourceId || !source.sourceName || !source.sourceType) issues.push(at(`source 字段不完整: ${source.sourceId}`));
      if (!Array.isArray(source.fields) || !source.fields.length) issues.push(at(`source 未声明 fields: ${source.sourceId}`));
    });
  }
  if (!Array.isArray(doc.themes)) issues.push(at("themes 非数组"));
  else
    doc.themes.forEach((theme) => {
      if (!theme.label) issues.push(at("theme 缺 label"));
      if (!theme.evidence) issues.push(at(`theme ${theme.label} 缺 evidence（主题必须回指原文）`));
    });
  if (doc.sourceFacts !== undefined) {
    if (!Array.isArray(doc.sourceFacts)) issues.push(at("sourceFacts 非数组"));
    else
      doc.sourceFacts.forEach((entry) => {
        if (!entry.term) issues.push(at("sourceFact 缺 term"));
        if (!entry.evidence || !entry.evidence.startsWith("sf_")) issues.push(at(`sourceFact ${entry.term} 的 evidence 不是 factId 指针`));
        if (!(SOURCE_FACT_TYPE_SET as Set<string>).has(entry.factType)) issues.push(at(`sourceFact ${entry.term} factType 非法: ${entry.factType}`));
      });
  }
  if (!Array.isArray(doc.exclusions)) issues.push(at("exclusions 非数组"));
  else
    doc.exclusions.forEach((exclusion) => {
      if (!exclusion.label || !exclusion.rule) issues.push(at(`exclusion ${exclusion.label} 缺 label/rule`));
    });
  doc.revenueMix?.forEach((row) => {
    if (row.ratio != null && (row.ratio < 0 || row.ratio > 1.5)) issues.push(at(`revenueMix ${row.name} ratio 越界 ${row.ratio}`));
  });
  const aliases = doc.aliases ?? [];
  if (new Set(aliases).size !== aliases.length) issues.push(at("aliases 有重复"));
  return issues;
}
