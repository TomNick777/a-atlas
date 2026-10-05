/**
 * Company Source Facts — 外部 source 事实契约（Source Coverage Pass 1）。
 *
 * 解决的问题：corpus Enrichment Pass 1 已证实若干旗舰搜索失败不是词形问题，
 * 而是 A-Atlas 的 source 层根本没有「空调 / 伺服 / IGBT」这类真实业务事实——
 * 其中大部分是上游 payload 里存在、normalize 层丢弃的字段（见
 * reports/SOURCE_COVERAGE_PASS1/SOURCE_COVERAGE_MATRIX.md）。本层把
 * 「来自外部 source 的原始事实」作为独立、可追溯的证据层固定下来：
 *
 *   External Source → data/raw/source_facts/<code>/（原始缓存，gitignored）
 *                   → data/source_facts/facts.jsonl（committed，rawText 保真）
 *                   → corpus builder 派生 terms（substring 可验证）
 *                   → discovery
 *
 * 纪律（与 corpus 同源）：
 * - rawText 必须保持 source 原貌，绝不改写；同义扩展属于后续 normalization，
 *   不属于 source evidence。
 * - 每条事实可回答：来自哪个 source（sourceId/locator）、原始证据是什么
 *   （rawText 逐字）、什么时候抓的（retrievedAt）、属于哪家公司（companyCode）。
 * - facts.jsonl 是 committed 输入：acquisition（网络）与 compilation（离线）
 *   分离，corpus build 永不联网。
 * - terms 与 rawText 的关系只有一条规则：**term 必须是 rawText 的子串**
 *   （词面回指，机械可验证）。没有子串关系的词不许进 facts。
 */

export const SOURCE_FACTS_SCHEMA_VERSION = "1.2.0";

/**
 * Phase 3.6 Evidence Coverage：additive 枚举扩展——新增 "relation"。
 * Phase 3.7 Evidence Surface：新增 sourceType（filing_announcement /
 * official_product_page）与强度分类（sourceId 片段编码）——行格式（row shape）
 * 仍未变：已在盘的行保持各自写盘时的 "1.0.0" 字符串，Layer 版本号升 1.2.0
 * 表示 source 集合扩展，不重写历史行。
 */
export const SOURCE_FACT_TYPES = [
  "business",
  "product",
  "technology",
  "brand",
  "application",
  "segment",
  "industry_position",
  "relation",
  "other",
] as const;

export type SourceFactType = (typeof SOURCE_FACT_TYPES)[number];

/**
 * 一条公司级 source 事实。JSONL 每行一条；字段顺序即写盘顺序（稳定 diff）。
 */
export type CompanySourceFact = {
  schemaVersion: string;
  /** 稳定事实 id：`sf_<code>_<seq>`，acquisition 侧确定性生成。 */
  factId: string;
  /** canonical 6 位代码（全库唯一主键，与 corpus.symbol 同一口径）。 */
  companyCode: string;
  companyName: string;
  factType: SourceFactType;
  /**
   * 从 rawText 中断言出的词面（原文逐字子串，词面回指）。
   * 结构化表格行通常恰好一个；登记性长文可为空数组（只存证据不派生词）。
   */
  terms: string[];
  /** source 原文，逐字保真。表格行 = 单元格原文；文本源 = 最小证明片段。 */
  rawText: string;
  source: {
    /** 稳定源标识，如 "akshare:stock_zyjs_ths#product_types"。 */
    sourceId: string;
    sourceName: string;
    /** disclosure_summary | registry_scope | filing_product_split | filing_annual_report。 */
    sourceType: string;
    /** 可定位指针：URL、文件相对路径、PDF `path#page=N`。 */
    locator?: string;
    /** 事实自身时点（报告期/披露日期），非抓取时间。 */
    date?: string;
  };
  /** 抓取时间（ISO 8601）；acquisition 冻结进 committed 文件后不再变。 */
  retrievedAt: string;
  /** 原始 artifact（PDF/JSON payload）的 SHA256，审计反查用。 */
  artifactSha256?: string;
};

/** corpus 侧的派生块：term → 事实指针（evidence=factId，可反查 rawText）。 */
export type CompanySourceFactTerm = {
  term: string;
  factType: SourceFactType;
  /** 指回 facts.jsonl 的 factId（resolvable pointer，同 stage3 标签例外）。 */
  evidence: string;
};

/** 结构校验：返回问题列表（空 = 合法）。只查结构与不变量，不评业务内容。 */
export function validateCompanySourceFact(fact: CompanySourceFact): string[] {
  const issues: string[] = [];
  const at = (detail: string) => `${fact.factId ?? "?"}: ${detail}`;
  if (!/^sf_\d{6}_\d{6}$/.test(fact.factId ?? "")) issues.push(at("factId 不是 sf_<code>_<seq> 形"));
  if (!/^\d{6}$/.test(fact.companyCode ?? "")) issues.push(at("companyCode 不是 6 位 canonical 代码"));
  if (!fact.companyName) issues.push(at("companyName 缺失"));
  if (!(SOURCE_FACT_TYPES as readonly string[]).includes(fact.factType)) issues.push(at(`factType 非法: ${fact.factType}`));
  if (!fact.rawText || !fact.rawText.trim()) issues.push(at("rawText 为空（证据必须保真）"));
  if (!Array.isArray(fact.terms)) issues.push(at("terms 非数组"));
  else {
    for (const term of fact.terms) {
      if (!term.trim()) issues.push(at("terms 有空词"));
      else if (!fact.rawText.includes(term)) issues.push(at(`term「${term}」不是 rawText 子串（词面回指断裂）`));
    }
    if (new Set(fact.terms).size !== fact.terms.length) issues.push(at("terms 有重复"));
  }
  if (!fact.source?.sourceId || !fact.source.sourceName || !fact.source.sourceType) issues.push(at("source provenance 不完整"));
  if (!fact.retrievedAt || Number.isNaN(Date.parse(fact.retrievedAt))) issues.push(at("retrievedAt 缺失或非 ISO 时间"));
  return issues;
}

/** corpus 派生的确定性规则（builder 与测试共用）：同一 fact 内 terms 保序去重。 */
export function dedupeTerms(terms: string[]): string[] {
  return [...new Set(terms.filter((term) => term.trim()))];
}
