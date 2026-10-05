# Evidence Surface Expansion（Phase 3.7 设计文档）

状态：**已冻结**（2026-09-30，tag `A_ATLAS_EVIDENCE_SURFACE_EXPANSION_2026_09_30`）。
上游（全部冻结）：`A_ATLAS_JEV_DISCOVERY_QUALITY_BASELINE` · `A_ATLAS_EVIDENCE_COVERAGE_EXPANSION`
（corpus digest `472e329fcf3134ec`）。
冻结报告：`reports/EVIDENCE_SURFACE_EXPANSION/REPORT.md`（§56 三十问逐项作答）；
surface 审计：`reports/EVIDENCE_SURFACE_EXPANSION/SURFACE_AUDIT.md`。

落地结果速览：两个新 surface 进 production——巨潮公告通道（point-in-time relation，
12 个月窗口，全池 5,567 家列表扫描）+ 官网产品页通道（静态产品页快照逐字证据）；
IR 活动记录表无稳定 API，如实记 `SOURCE_SURFACE_GAP`。

---

## 0. 使命与边界

Phase 3.6 证明了「广覆盖、高可信的年报事实可以显著改善 Jev 发现能力，而不改 Jev、
Parser、Ranking」。同时暴露年报天然不擅长的两类事实：

- **Point-in-time Relation**：最新客户关系、新进供应链、送样、认证、中标、合作——
  年报一年一披露，且措辞审慎。
- **Official Product**：具体产品名、功能、型号、应用场景——年报只有粗类目。

Phase 3.7 只做一件事：

> **扩展 Atlas 获取事实的 surface，而不是扩展 Atlas 的 intelligence。**

继续保持：**补事实，不补答案**；**Atlas owns facts. Jev owns judgement.**

本阶段不改动（回归不变量）：

```text
grammar / parser / hybrid 执行器  —— 零改动
Jev capability 契约 / prompt / 阈值 —— 零改动
检索排序 / 阈值 / UI 语义          —— 零改动
benchmark-v1.json query/anchor/evaluator —— 逐字不变（只做 digest 坐标重钉 v1.1→v1.2）
market digest                     —— 字节级不变
```

允许且仅允许变化：**corpus 的事实输入与投影**（corpus digest 受控变化）。

三条铁律（AGENTS.md 同步）：

> **More surfaces, not more semantic rules.**
> **不能把不同强度的关系压成一个 Boolean。**
> **Production crawler 不得知道 benchmark query。**

---

## 1. Surface Audit（§3 八问）

详见 `SURFACE_AUDIT.md`。结论：公告通道复用 3.6 巨潮管线（组织映射/query/static
下载/断点续跑全部已实证），新增的只有「无类别列表 + 通用标题门槛」；IR 活动记录
表在 irm.cninfo 只有页面渲染无稳定 API（搜索端点只索引互动问答），按 §49 停止规则
放弃并记 `SOURCE_SURFACE_GAP`；官网 URL 5533/5567 已在全池 raw 缓存
（巨潮登记字段「官方网站」），产品页静态发现率 pilot 实测 52.5%。

---

## 2. Surface A — Point-in-time Relation（公告通道）

### 2.1 获取（`scripts/evidence_surface_fetch_announcements.py`）

- authority = `data/companies.json` 全池（company-agnostic；pilot 40 家分层样本
  `pilot_sample.json`，固定种子 20260930）。
- 窗口 2025-10-01~2026-09-30（12 个月；point-in-time 的语义就是「最近」，同时把
  列表请求量压在运维预算内——§47）。
- 选择 = 标题确定性门槛（`TITLE_GATE_RE`）：中标/中选/重大合同/框架协议/合作协议/
  战略合作/购销(销售采购)合同/供货/定点/订单/入围/供应商/联合开发——公告文体通用
  结构词，零专名（测试钉死）。中标/重大合同类公告没有专用类别码
  （`category_rcjy_szsh` 在该端点无效，探针在案），全列表翻页 + 标题门槛是唯一
  确定性机制。
- 预算：单家 PDF ≤6 份；断点续跑（manifest artifact 在盘即跳过下载，列表总是重查）。
- 失败语义分离：`SOURCE_UNAVAILABLE`（网络）/ `NOT_IN_CNINFO_MAP` /
  `NO_ANNOUNCEMENTS`（窗口内真空）/ `OK_ZERO_HITS`（有公告无命中=正常）/
  `DOWNLOAD_FAILED` / `SIZE_ANOMALY`。absence ≠ 没有关系（§21 延续）。

### 2.2 抽取（`scripts/evidence_surface_extract.py`）

窗口 = 关系短语定位 ±60/100 + 句读吸附（3.6 同法），加两级确定性分类——
**全部来自窗口原文词面，零推测**：

- `relationType` ∈ {customer, supplier, cooperation, certification,
  joint_development, project, bid, other}——由 TYPE_RULES 词面表按序判定；
  **方向（§8）**随 type 确定（中标/供货/销售→sells_to；采购→buys_from；合作→mutual；
  判不出→other/unresolved，宁可保留原文也不猜）。
- `assertionStrength` ∈ {planned, sampling, trial, confirmed, stated, unclear}——
  由 STRENGTH_RULES 词面表按序判定。**规则顺序机械锁定在
  `tests/evidence_surface.test.ts`**：sampling/trial/planned 先于 confirmed——
  送样永不升级成供货、中标候选人公示（planned）永不标成中标（confirmed）、
  「拟…签署」（planned，允许中间隔公司简称括注）永不标成已签署。
- 两者编码进 `sourceId = cninfo:announcement#<type>:<strength>`（行 schema 不变，
  字段适配现有 `CompanySourceFact`，§5「重点不是字段名」）。
- **时间（§9）**：`source.date = announcedAt`（披露日），一等字段，缺失即不收行；
  绝不升级成 current 关系。窗口原文里的历史日期（「2019年5月签订」）逐字保留，
  持续性推断归 Jev。
- **否定/不确定事实保留（§10）**：风险提示句（「本次仅为入选名单，后续仍需投标，
  存在不确定性」）如实进证据层（strength=stated）——不删除后续否定事实，
  也不建 relation state machine。
- 守卫：释义/简历/表格/勾选框（3.6 同表）+ 法律条款段（诉讼/仲裁/管辖）+
  「为…提供」必须跟通用产品名词（挡「为…发展提供强力支撑」式抽象支撑语）。
- 窗口上限：单家 ≤6（跨文档披露日新者优先），公司内 verbatim 精确/包含去重。

### 2.3 Pilot 门槛（§27 预注册 → 实测）

| 门槛 | 预注册 | 实测 | 结论 |
|---|---|---|---|
| 列表成功率 | ≥80% | 100%（40/40；全池SOURCE_UNAVAILABLE 率见 REPORT §J） | PASS |
| 标题命中率 | >0 | 40 家中 6 家命中（样本偏非制造） | PASS |
| PDF 下载成功率 | ≥70% | 6/6 = 100% | PASS |
| 抽取假阳性率（人工审 50） | ≤10% | 见 REPORT §K | 见报告 |
| 站点/公司专属规则 | 0 | 0 | PASS |

---

## 3. Surface B — Official Product（官网产品页通道）

### 3.1 获取（`scripts/evidence_surface_fetch_products.py`）

- 官网 URL = 巨潮登记字段（raw feeds.json 全池缓存），https 严格 → http →
  https 宽松（curl -k，artifact 如实记 `insecure: true`）。
- 发现 = 首页静态 `<a>` href/锚文本 × 通用 IA 词表（产品/解决方案/Products/
  Solution…），§15 排除面 = 通用路径段与锚文本词（news/about/careers/esg/
  新闻/招聘/关于…）；同域、非二进制、≤3 页。
- 快照落盘 `data/raw/source_facts/<code>/website/*.html` + sha256 + retrievedAt +
  canonical URL 进 manifest（§41）；内容变化不静默覆盖（§42——facts.jsonl
  append-only 是结构性保证，raw 层旧 snapshot 改存日期后缀留链）。
- 失败语义分离：`NO_WEBSITE`（登记真空）/ `HOMEPAGE_UNREACHABLE`（网络/证书）/
  `NO_PRODUCT_LINKS`（静态发现落空——JS 渲染站点如实落空，不是失败）/ OK。
  JS 渲染不引浏览器路径（§20）。

### 3.2 抽取（同 `evidence_surface_extract.py`）

- 句级 verbatim 证据：产品语境词 × 能力动词双词面定位 + 页面噪声守卫
  （版权/登录/备案/法务…）+ FAQ 问答体整句不收（§12：不截断问答上下文）。
- 单页 ≤4 句、单家 ≤6 行，10-160 字。**不自造 tag、不扩写**（§18：官网写什么
  Atlas 存什么，关系与概念判断归 Jev）。
- `sourceId = website:product_page`，provenance = canonical URL + retrievedAt +
  sha256；页面自报时点不可信 → **不写 source.date**（freshness 只记 retrievedAt，
  §26 只记录不推断「最新=最真实」）。

### 3.3 Pilot 门槛（§27 预注册 → 实测）

| 门槛 | 预注册 | 实测 | 结论 |
|---|---|---|---|
| 首页可达率 | ≥70% | 32/39 = 82%（1 家无官网登记） | PASS |
| 产品页发现率 | ≥15% | 21/40 = 52.5% | PASS |
| 抽取假阳性率（人工审 50） | ≤10% | 见 REPORT §K | 见报告 |
| 站点专属规则 | 0 | 0（通用词表+通用路径排除） | PASS |

---

## 4. Corpus 投影（schema 1.2.0 → 1.3.0）

- 新事实行进 `data/source_facts/facts.jsonl`（排序合并 append-only，既有行逐字节
  不变）；facts manifest 升 1.2.0（行格式仍 1.0.0）并新增 **surfaces registry**
  块（§38/§39：surface id / authorityClass / temporal / extractorVersion /
  factCount——薄注册，不是 plugin framework）。
- `evidenceSpans` 投影预算不变（≤5 条、≤280 字、整条收录），选取改为**分面配额**
  （§24 surface diversity，全部确定性属性）：
  新面先行——公告窗口（披露日新者优先）与官网产品句合计 ≤2+2 条、≤220 字；
  年报关系 + fine_product 随后填满剩余预算（factId 序，3.6 行为）。
  字符子预算与槽配额同时生效（220 放得下单条典型公告窗口或两条产品句）；没有
  新面事实的公司与 3.6 逐字节同行为——分面配额防的是「公告最多的大公司恰好
  是 3.6 证据最足的公司」被新面整体挤出。
- `sources[]` 新增条件行：`cninfo:announcement`（filing_announcement）/
  `website:product_page`（official_product_page），字段如实声明。
- manifest stats 新增 `announcementEvidenceCoverage` / `officialProductEvidenceCoverage`
  （字节可重算）。
- **为什么 Jev payload 仍不膨胀（§23）**：searchableText 640 字上限与披露原文行
  280 字预算逐字不动——新证据在同一预算内按确定性配额重排，judge 每家看到的
  profile 字节数不变。

## 5. Benchmark Isolation（§30/§31）

- production surface 路径（sample/fetch_announcements/fetch_products/extract/
  builder/契约）不得 import 或读取 `quality/discovery/`；55 条 benchmark query
  字面量 + 锚点公司名零容忍——`tests/evidence_coverage.test.ts` 扫描清单已扩入
  全部新脚本（机械）。
- 标题门槛/强度表/类型表/IA 词表全部来自公告与官网文体的通用结构，与任何具体
  query 无对应关系；pilot 样本按行业×交易所分层随机（种子在案），与锚点无关。
- 英伟达/K线只是 probe（§32）：完成后重跑观察，不为它们做任何特殊处理；
  仍无事实则如实记录（SOURCE_SURFACE_GAP）。

## 6. 失败语义与 SOURCE_SURFACE_GAP（§36/§37)

- 两个新 surface 的「该公司无事实」全部可区分：登记无官网 / 首页不可达 /
  静态发现落空 / 窗口内无公告 / 有公告无命中 / 有 PDF 无关系句——各各分离，
  绝不解释成「没有关系/没有产品」。
- 新失败类别 `SOURCE_SURFACE_GAP`：事实很可能存在于现实世界但 Atlas 尚未覆盖该
  surface。本轮在案：IR 活动记录表（无稳定 API）、JS 渲染官网产品页（无浏览器
  路径）、12 个月窗口外的历史事件、东财概念板块（3.6 遗留）。

## 7. Refresh 策略（§48）

- 公告 = 增量重跑（同脚本同窗口：列表重查便宜，新 PDF 按 adjunct 文件名增量落盘，
  断点续跑）。
- 官网 = 内容哈希守卫（同 URL 字节不同 → 旧 snapshot 留链）；周期性全刷 = 删
  website/ 缓存重跑（facts.jsonl append-only 保证旧事实永不静默消失）。
- 不建设通用 scheduler platform。

## 8. 明确不做

- 不接互动易/上证e互动（3.6 裁定维持：措辞对冲 + 时点翻页 + 体量大；§13 纪律
  在案，日后若接，non-confirming 回答不得转正）。
- 不做官网整站抓取、不引浏览器渲染、不做站点专属规则。
- 不做 relation state machine、不做语义 fact merging、不做「最新=最真实」升级。
- 不为覆盖率牺牲真实性：静态发现落空 = 该公司本通道无事实。
