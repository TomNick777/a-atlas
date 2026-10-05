# Company Knowledge Corpus（Phase 2 设计文档）

状态：**现行**（2026-09-28，分支 `atlas/refocus-data-foundation`）。
上游：Refocus · Data Foundation（收口报告 `reports/REFOCUS_CLOSEOUT.md`）。

---

## 1. Purpose

Corpus 是一个独立、明确的数据层，回答一个问题：

> **这家公司有哪些可以被搜索的真实业务语义。**

它位于规范化公司事实与 Jev 发现索引之间。数据层级：

```text
a-stock-data vendor snapshot（vendor/a-stock-data，钉 commit）
        ↓
规范化公司事实 data/companies.json（scripts/fetch_companies.py → build_profiles.ts）
        ↓
Company Knowledge Corpus Builder（scripts/build_company_corpus.ts，唯一 canonical builder）
        ↓
版本化 corpus artifact（data/company-corpus/{companies.jsonl, manifest.json}）
        ↓
Jev 发现索引（BM25 ⊕ bge 向量，检索文本/嵌入/排除模式共读 corpus）
        ↓
A-Atlas search UI（产品面不变：/ 与 /stock/:symbol）
```

职责边界：**Jev 负责 discovery/retrieval，不做数据清洗、字段猜测、事实生成、
标签幻想或 provenance 拼装**——那些全是 corpus builder 的事，且全部确定性完成。

## 2. Schema

`lib/corpus/contracts.ts` 是唯一 schema 定义（`CORPUS_SCHEMA_VERSION = "1.0.0"`）。
每行 JSONL 一个 `CompanyKnowledgeDocument`：

| 字段 | 内容 | 纪律 |
|---|---|---|
| `symbol` | canonical 6 位码，全语料唯一主键 | 与 companies.json 逐一对齐 |
| `identity` | exchange/board/listedAt/industry/swIndustry/province/city | 申万未入类如实 `unknown` |
| `aliases` | ST 前缀剥离、全称短形、**明示更名语句**提取的曾用名 | 不含炒作概念；上限 8 |
| `profile` | 机构简介原文（≤2000 字截断，截断计数进 manifest.stats） | 不伪装完整 |
| `business` | 主营业务（披露口径） | 缺失 = 空数组 |
| `products` / `revenueMix` | 主营构成·按产品，最近报告期（名称 + 占比） | 上游无报告期就缺，不编 |
| `overseasRevenueShare` | 按地区分类的境外确定性切分 | 无地区拆分如实 null |
| `concepts` | 东财概念板块成员（清洗后） | 是成员关系事实，非观点 |
| `themes` | **证据回指**的检索主题（label + evidence + dimension） | evidence 必须能在该公司自己的事实文本里找到（知识标签例外：`stage3:<级别>:<code>` 指针，resolvable） |
| `exclusions` | 确定性否定标签（label + because + rule） | 不是业务观点；absence-of-evidence 结论，规则在案，只服务「不要 X」排除 |
| `searchableText` | 检索与重排共读的语义主文档 | ≤640 字，见 §6 |
| `sources` | 逐字段组 provenance（sourceId/sourceName/sourceType/fields/asOf） | 7 行固定，见 §7 |

## 3. Fact vs Opinion 边界

本阶段最高优先级的数据纪律。

**P0（已收录）**：公司名称/代码、行业（东财口径 + 申万一级）、公司简介、主营业务、
主营产品/服务、主营构成、地区、境外收入占比、概念板块成员、
stage3 半导体知识标签（年报证据管线，A/B/C 级，`data/enrichment/semiconductor/` committed）。

**P1（V1 未收录）**：近期公告中的经营事实（新增产品/项目/产能/重大合同/业务退出）。
公告数据在 a-stock-data 里是运行时能力（:8920，在线源），Phase 2 corpus 是离线确定性
产物；在无法对 5567 家可靠分类公告业务语义之前，**宁可不加**（规格 §10 明确允许）。
`recentBusinessSignals` 字段留待真实使用驱动。

**P2（不混入）**：券商研报、评级、预测、投资逻辑是 opinion corpus。当前架构里
研报只是公司页的一个展示块（运行时拉取），从未进入检索文本——迁移后依然如此，
无标记混合为零。

**禁止（builder 层面不存在这些能力）**：推断龙头/核心供应商/受益于/高成长/行业领先、
推断产业链关系、按行业赋值业务、把研报观点当事实、LLM 改写出原始数据不存在的新事实。
builder 是纯规则代码，没有模型调用，没有网络调用。

## 4. Source hierarchy（数据源与覆盖率）

| 源 | 覆盖（5567 家） | 用途 |
|---|---|---|
| 交易所 A 股列表 | 5567/5567 | symbol/name/exchange/board |
| 同花顺主营介绍（回退巨潮） | 5567/5567 | business |
| 巨潮公司资料 | 5284/5567 有简介 | profile/fullName/地址/上市日 |
| 东财主营构成·按产品 | 5553 家有产品、5552 有占比 | products/revenueMix |
| 东财主营构成·按地区 | 有地区拆分的公司 | overseasRevenueShare |
| 东财概念板块 | **0**（上游数据集本身全空，如实为 0） | concepts |
| 申万一级行业成分表 | 非 unknown 的公司 | identity.swIndustry |
| stage3 enrichment | 507 家记录（175 家有能力标签） | themes.工艺 |

corpus 的直接输入只有 **committed** 数据（companies.json + enrichment.json）——
不读 `data/raw`（fetch 缓存），语料能从 git 内输入完整再生。

## 5. Build pipeline

```bash
npm run corpus:build     # 重建 artifact（确定性，~1.3s，离线）
npm run corpus:vectors   # 增量 embedding（hash16 复用，只重嵌变更行）
npm run corpus:update    # 两者
npm run corpus:check     # 用当前输入重建，与在盘 artifact 逐字节对账（CI 步骤）
```

`scripts/build_company_corpus.ts` 是**唯一** canonical builder。没有第二个实现：
主题派生直接 import `search/profile/derive.ts`（与旧 profile 层同一套规则、同一
`ONTOLOGY_VERSION`/`DERIVATION_VERSION`、同一 5% DF 闸门）。规格建议的 Python 文件名
被 TS 取代，原因：派生规则已是 TS 实现，Python 重写 = 第二套竞争实现（Preflight §5
「优先复用，不重新造第二套系统」）。

manifest 记录：schema/builder/ontology/derivation/知识富化版本、embedding 模型、
源快照（companies.json sha16 + 生成时间）、**contentDigest = sha256(companies.jsonl
全部字节)**、companyCount、stats（九项 coverage + 空 searchableText/重复/malformed/
截断/长度分布）。`generatedAt` 只在 manifest——JSONL 无时间戳，逐字节确定，
digest 不可能被构建时刻污染。

## 6. searchableText

自然语言文档，非 JSON.stringify、非无脑拼接。优先级即截断顺序：

```text
公司：贵州茅台（600519，SH）
曾用名：…（有才写）
行业：酒、饮料和精制茶制造业／食品饮料
地区：贵州仁怀市
主营业务：…（≤200 字）
主要产品：茅台酒(86%)、其他系列酒(14%)…
概念：…（有才写，≤8）
境外收入占比约1%（有才写）
主题：…（DF 闸门后的派生标签）
排除：…（确定性否定标签）
简介：…（机构简介，用剩余预算）
```

640 字上限（bge-small-zh 512 token 预算内）。身份信息权重最高，主营业务/产品/
收入结构优先；不重复同一句话；无财务噪声（无市值/估值）；无公告全文；无研报全文。

## 7. Provenance

- 文档内：`sources[]` 7 行固定映射（identity/business/profile/products/regionSplit/concepts/sw），
  每行 `fields[]` 声明覆盖哪些字段，`asOf` = 数据集生成日。
- 主题内：每条 theme 携带 evidence（原文词面或 stage3 指针）。
- 排除内：每条携带 rule（规则 id）+ because（规则理由）。
- 全局：manifest 的 sourceSnapshot + 版本五元组。
- 搜索侧：`data/search_log` 每行 versions 增 `corpusSchemaVersion` +
  `corpusContentDigest16`——任何一次搜索「当时读的是哪份语料」永远可答。

## 8. Jev integration

Jev 代码零改动。judge 的 prompt 一直读 `company.searchProfileText`——迁移后该字段
就是 corpus 的 `searchableText`（`lib/companies.ts` 装载时映射）。检索（BM25 over
searchProfileText、向量通道）、排除模式匹配、judge 三者同源共读同一份文本。

装载是**全有或全无**：JSONL、manifest、向量三者齐全且数量对齐，corpus 才生效；
缺任何一样，整体回落 legacy search-profile 层，并在遥测/search log 如实标注
（`corpus: null`、`searchProfileVersion` 非空、`retrievalVersion: v3-rrf60-profile-*`）。
不允许「新文本 × 旧向量」的半套状态。

`v3-rrf60-corpus` 是迁移后的 retrieval 标签；`PRODUCTION_CONTRACT.corpusSchemaVersion`
钉 `1.0.0`。旧 profile 层（`search_profiles_v3.json`）留盘供 A/B 与历史基准，
产品不再消费；`search-profile:*` 命令保留为研究工具，不再属于产品构建链。

## 9. Quality rules（锁在测试里）

`tests/corpus.test.ts`（CI 必跑）+ CI `corpus:check`：

- digest = 在盘字节；companyCount 与 canonical universe 对齐
- symbol 唯一、6 位 canonical；每家有 name 与非空 searchableText（≤640）
- manifest stats 从字节重算一致（诚实性）
- **全 5567 家逐字段回指 companies.json**：name/fullName/identity/profile/business/
  products/concepts/overseas 逐一相等，revenueMix 逐条匹配——跨公司串号或编造
  事实必然在此断裂
- 主题证据回指该公司自己的事实文本（知识标签验 stage3 指针形态）
- 别名可回指（ST 剥离 / 全称包含 / 简介明示更名）
- 运行时真消费 corpus（loadDataset.corpus 非空、searchProfileText 即文档、向量对齐）
- 退役栈词表（vibe/8910/backtest/watchlist/…）在语料与 manifest 零残留
- `npm run corpus:check`：同输入重建逐字节等于在盘 artifact（确定性，进 CI）

## 10. 明确不做

不为覆盖率牺牲真实性：没有公告语义（P1 留白）、没有研报观点、没有概念炒作标签、
没有 LLM 富化。UI 零变化——corpus 是纯后层数据结构，`/` 与 `/stock/:symbol`
不暴露 themes/JSON/score breakdown。
