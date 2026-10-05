# Evidence Coverage Expansion（Phase 3.6 设计文档）

状态：**已冻结**（2026-09-30，tag `A_ATLAS_EVIDENCE_COVERAGE_EXPANSION_2026_09_30`）。
上游（全部冻结）：`A_ATLAS_JEV_FIRST_ARCHITECTURE` · `A_ATLAS_JEV_CAPABILITY_LAYER` ·
`A_ATLAS_JEV_EVIDENCE_UX` · `A_ATLAS_JEV_DISCOVERY_QUALITY_BASELINE`。
冻结报告：`reports/EVIDENCE_COVERAGE_EXPANSION/REPORT.md`（§46 三十问逐项作答）。

落地结果速览：年报通道 5,475 家（98.4%）/ 新事实 54,560 条（100% 带披露时点 +
PDF 页码 + sha256）/ corpus digest `41a0995d → 472e329f` / 三次 LIVE 重跑
corpus gap 归因 4 → 0（NONE 55）/ judge token +1、latency p50 525 vs 554ms。

---

## 0. 使命与边界

Phase 3.5 的 baseline 把「缺数据」和「智能不足」分开了：55 题中 51 NONE、4 corpus gap
（C02 美的供应链 / C04 英伟达相关 / C05 特斯拉产业链 = CORPUS_MISSING_FACT，
A06 K线软件 = CORPUS_WEAK_FACT），0 归因 Jev/parser/runtime。

Phase 3.6 只做一件事：

> **扩大 Atlas 能提供给 Jev 的真实世界事实覆盖——补事实，不补答案。**

本阶段不改动（回归不变量，测试在案）：

```text
grammar / parser / hybrid 执行器  —— 零改动
Jev capability 契约 / prompt / 阈值 —— 零改动
检索排序 / 阈值 / UI 语义          —— 零改动
market digest                     —— 字节级不变
benchmark-v1.json 的 query/anchor/evaluator —— 逐字不变
```

允许且仅允许变化：**corpus 的事实输入与投影**（corpus digest 受控变化）。

三条铁律（AGENTS.md 同步新增）：

> **Evidence expansion must add reusable facts, never benchmark-specific answers.**
> **A source mechanism must be company-agnostic before it may enter production corpus generation.**
> **Atlas may preserve source language, but must not semantically expand source facts into inferred concepts or relationships.**

---

## 1. Source Audit（Phase 3.6 §4 八问的回答）

离线扫描 `scripts/evidence_coverage_audit_scan.py`（产物 `audit_scan.json`）+
实地探针 `scripts/evidence_coverage_probe.py`（产物 `probe_results.json`）。

**Q1 现有数据里已有哪些 relation 事实？**
几乎没有。全池语料（Jev 所见）中：特斯拉 **0** 家、英伟达 **0** 家、华为 9 家、
苹果 5 家；「供应链」123 家、「供应商」24 家。事实层（83,245 条 rawText）同样：
特斯拉 0、英伟达 0。结论：relation 事实不是「没抽出来」，是现有 feed 根本不产生。

**Q2 哪些 source 实际携带客户/供应商/合作信息？**
探针实证（代表公司，§13）：

| source | 实证 |
|---|---|
| 巨潮年报 PDF | 科森科技 p11「为苹果、华为、亚马逊、谷歌、Meta、美敦力…提供消费电子…」；美的 p22「与比亚迪、蔚来、华为等行业头部企业深度合作」；四家代表全部含前五名客户/供应商集中度表 |
| 东财概念板块 | per-stock slist 可用；板块类型枚举（clist）在本网络被静默丢弃 → 无法确定性区分概念/行业/地域，本轮不用（§32 可重复性不成立） |
| 互动易/上证e互动 | 官方答复但按时点查询、体量巨大、措辞对冲；本轮不选 |

**Q3 已抓取但 corpus 未消费的字段？**
巨潮 profile 的登记性字段（官网/指数/法人——非业务事实）；东财 zygc 按行业分类行
（与按产品重复）。均无 relation 价值，维持不消费。

**Q4 raw snapshot 是否含可复用文本？**
feeds.json 三 feed 已被 Pass 1/2 榨干（产品类型/经营范围/主营构成全部入 facts）；
年报 PDF 只有 6 家 pilot 有。真正的增量在年报全文——本阶段的主通道。

**Q5–Q8 新增 source 的取舍**：见 §2。

## 2. Source Inventory

### 选入：巨潮年报 PDF（唯一新增 source，全池机制）

| §32 闸门 | 回答 |
|---|---|
| 来源/可信度 | 巨潮资讯网（证监会指定信披平台），上市公司一手披露 |
| 覆盖范围 | 全池 5567 家；本轮实抓 5478 家有年报，91 家次新上市无年报行（真空，如实记 NO_ANNUAL_REPORT_ROW）、1 家下载失败 |
| 稳定抓取 | Pass 1 同管线（orgId 映射 + hisAnnouncement query + static 下载 + curl 兜底），断点续跑，6 分片并行 |
| 登录/反爬 | 免登录；query 接口温和、static CDN 直连；限速 0.8-1.2s/家 |
| 可复现 | raw PDF 在盘（sha256 入 manifest + fact.artifactSha256），URL+页码 locator |
| deterministic 抽取 | 全部规则抽取（页扫描 + 触发词定位 + 句式门槛 + 守卫），零 LLM、零网络 |
| 全市场 generic | authority = companies.json 全池，不另抓名单；触发词/句式表不含任何 benchmark 专名（测试钉死） |
| 重复 | 公司内 cleaned rawText 精确/包含去重（§17）；跨源重复靠 covered-text 机制不重复占预算 |
| 时效 | date = filingDate（披露日）；绝不升级成 current 关系（§19/§20） |
| failure 语义 | SOURCE_UNAVAILABLE / NO_ANNUAL_REPORT_ROW / DOWNLOAD_FAILED / SIZE_ANOMALY / NO_PDF 分离记录；absence ≠ 没有关系（§21） |

### 评估后不选（记录在案）

- **东财概念板块**：成员资格本是 corpus contract 允许的事实（concepts 字段），
  且对 relation 家族杠杆最大；但板块类型枚举接口（clist m:90+t:2）在本网络被
  静默丢弃（多镜像同败），无法确定性区分概念/行业/地域板块。按 §32「可稳定
  抓取」一票不成立，本轮放弃，留待网络条件允许时按同一闸门重评。
- **互动易/上证e互动**：官方但问答体、按时点翻页、体量大、措辞对冲，信噪比
  与工程成本都差于年报。
- **东财 F10 经营评述**：vendor 无入口（假装不存在）。
- 雪球/股吧/搜索摘要/AI 回答：§5 明令禁止。

## 3. 事实模型（在既有 CompanySourceFact 上做加法）

不建知识图谱（§6）。不强制归一 SUPPLIER_OF/CUSTOMER_OF（§7）。扩展：

1. `SOURCE_FACT_TYPES` 增加 `"relation"`（additive；既有 83,245 行的行格式与
   schemaVersion 字符串逐字节不动，层版本 1.0.0 → 1.1.0 记在 facts manifest）。
2. 新增三类年报通道事实（`sourceType=filing_annual_report`，sourceId 带 category 片段）：

| 类别 | sourceId 片段 | 内容 | terms |
|---|---|---|---|
| 集中度 | `#concentration:customer/supplier` | 前五名客户/供应商合计句（逐字 span，含金额与占比） | []（只存证，不进检索投影——判别力/字符预算比太低） |
| 关系窗口 | `#relation:customer/supplier/cooperation/channel/other` | 关系触发词 ±60/100 verbatim 窗口，且必须命中关系句式门槛 | [] |
| 细粒度产品 | `#fine_product` | 该公司自己 committed 产品词的 verbatim 窗口 | [产品名]（rawText 逐字子串） |

**触发词与句式表只是抽取门槛**（Pass 1 ANNUAL_TERMS 同性质）：
触发词（客户/供应商/供应链/合作伙伴/战略合作/配套/定点/供货/经销/代理商…）
负责定位，句式门槛（为…提供 / 向…销售 / 与…合作 / 进入…供应体系 / 中标 / 定点…）
负责挡掉「以客户为中心」式战略套话。两者都不含任何 benchmark 专名
（`tests/evidence_coverage.test.ts` 机械证明），不做同义扩展（§10/§31C）。

**专名出现 ≠ 关系事实**：拓普年报「如特斯拉这样伟大的创新者」这类行业评论
同样只是原文窗口——Atlas 不判断它与「特斯拉产业链」的关系，Jev 判断（§7）。
已知 A 股公司名（companies.json 词表，运行时数据）只用于窗口的确定性优先级
排序，不产生任何词面。

## 4. Corpus 投影（schema 1.2.0）

- 新文档字段 `evidenceSpans?: Array<{ evidence: factId; factType; text }>`：
  **text 与 fact.rawText 逐字相等**（零改写），evidence 可反查
  provenance（URL#page / filingDate / sha256）。
- searchableText 新行 `披露原文：`：插在「主要产品」之后、「来源事实」之前；
  确定性预算（§35）：至多 5 条、共 280 字，按 factId 序（extractor 写盘顺序 =
  relation 先于 fine_product）整条收录，放不下的整条跳过——截断会伪造
  「完整原文」的形状。
- builder 内建机械验证（不只靠测试）：span 必须回指真实 fact、逐字相等、
  完整落在 searchableText（「facts 进块就必须可检索」锁的延伸）。
- manifest stats 新增 `evidenceSpansCoverage` / `evidenceSpanCount`。

### 为什么 Jev payload 不会膨胀（§34）

searchableText 的 640 字上限不变——新证据是**在同一预算内重排**（披露原文行
挤占简介尾段），judge 每家公司看到的 profile 字节数不变。代价是简介尾段被
挤出（确定性、按优先级），收益是可判别的原文证据。640 预算的纪律不破。

## 5. Provenance 与时间语义

- 每条新事实：`source.locator = 巨潮公告URL#page=N`、`source.date = filingDate`、
  `artifactSha256 = PDF sha256`、`retrievedAt = 抓取时刻`——复用既有
  provenance 结构（§18，没有第二套框架）。
- 关系事实可能过期：一律「某披露时点公开陈述过」，无 current 标志、无永久化
  升级（§19/§20）；历史语义交给 Jev 结合 query 判断。

## 6. 失败语义

acquisition 与 extraction 分离记录；「没抓到」永不解释成「该公司没有这种关系」：
`SOURCE_UNAVAILABLE`（网络）/ `NO_ANNUAL_REPORT_ROW`（巨潮无匹配，次新上市常见）
/ `DOWNLOAD_FAILED` / `SIZE_ANOMALY` / `NO_PDF`（extract 侧看不到 PDF）。

## 7. Benchmark Isolation

- production corpus 路径（builder/acquisition/extraction/契约）不得 import 或
  读取 `quality/discovery/` —— `tests/evidence_coverage.test.ts` 机械扫描。
- 不出现 benchmark query 或锚点公司字面量 —— 同上（55 条 query + 锚点公司名
  全量扫 production 文件）。
- 本阶段的触发词/句式/守卫表全部来自年报文体本身的通用结构，与具体 query
  无对应关系；增量来源 = 年报通道这一「机制」，不是任何题面。

## 8. 重跑协议（§23）

1. corpus rebuild → vectors → `corpus:check` 字节级一致。
2. benchmark-v1.json 只更新 `corpusContentDigest16` 坐标 + benchmarkVersion
   （documented correction，query/anchor/evaluator 逐字不动；§27/§28 协议）。
3. golden-evidence.json 重钉 digest：requiredTerms 逐条对新语料重验，
   `quote` 重摘；新增 relation 旗舰（§22：真实 source + 通用管线 + 可复现）。
4. `npm run quality:discovery -- --label p36-r1/r2/r3`（LIVE ×3）→
   `quality:discovery:compare -- --base r1 --target p36-r1` + stability。
5. 归因迁移（§39）：重点看 CORPUS_MISSING_FACT/WEAK_FACT ↓，以及补事实后
   仍失败者**才有资格**重新归因 Jev。

## 9. 明确不做

- 不建产业链知识图谱 / 供应链 ontology（§8）。
- 不做语义扩展（K线≠技术分析软件的同义桥不建，§10；A06 若仍失败如实记录）。
- 不引入第二个 judge、不产单一总分。
- 不为覆盖率牺牲真实性：91 家无年报 = 该通道无事实，不是没有关系。
