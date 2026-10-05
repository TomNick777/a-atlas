# A-Atlas｜A股星图

一个工具：**用自然语言，在整个 A 股公司池中发现公司。**

产品只有两个面：发现 `/`（物理堆 + 搜索）与公司 `/stock/:symbol`（一张展开的公司卡）。
2026-09-28 Refocus 起不再是市场终端、交易工作台、复盘系统、回测系统、持仓系统或 AI Agent 工作台——
Phase 0–4 曾并入的 Vibe AStock 研究系统已整体退役（`docs/VIBE_REMOVAL_INVENTORY.md`），
数据底座为 a-stock-data（`docs/A_STOCK_DATA_INTEGRATION_AUDIT.md`）。

第一原则：**Discover 是产品，数据底座可以很大，产品表面必须很小。**
第二原则：**数据能力的存在，不构成展示它的理由。** 新增数据展示必须回答
「我在真实使用中遇到了什么问题，因此需要这项数据」，回答不出来就不加。

- 一级导航没有：只有 wordmark 回发现页。不设隐藏导航假装仍是多域产品。
- 首页保持物理堆的克制体验，禁止把大盘指数、新闻流、复盘、自选、持仓、行情卡片、Dashboard 堆上首页。首页只回答「我想找什么样的公司？」。
- 公司页是第二核心，canonical URL 是 `/stock/:symbol`（6 位代码）。全产品共享 `lib/atlas/stockIdentity.ts` 的 StockIdentity；adapter 负责向上游符号格式转换，A-Atlas 界面只见 canonical。
- 公司页是单页纵向阅读，没有 Tab、没有 DeepDive、没有 AI 研究：为什么匹配 → 简介 → 主营业务 → 市场快照 → 基础财务 → 最近公告 → 最近研报。视觉上像从物理堆拿起一张公司卡展开，不是 Bloomberg 终端。
- 数据不许伪造：四类数据块（quote/fundamentals/announcements/reports）必须区分 EMPTY（这家公司没有）/ UNAVAILABLE（数据源不覆盖该标的）/ ERROR（数据源暂时不可用），绝不把故障渲染成「没有数据」，绝不展示编造数字。每块轻量标注 provenance（源 · 时间）。
- a-stock-data 集成纪律：vendor 快照钉 commit（`vendor/a-stock-data/VENDOR.md`），build-time 抽取（`scripts/extract_stock_data.py` → `services/stock-data/generated/`，绝不手抄、绝不运行时解析 SKILL.md），upstream 更新走 VENDOR.md 的同步流程。底层 87 个入口暂不接入的能力，产品假装它们不存在。
- Company Knowledge Corpus 是发现索引的唯一语义层（`docs/COMPANY_KNOWLEDGE_CORPUS.md`）：检索文本/嵌入/Jev judge 输入共读 `data/company-corpus/`（唯一 builder `npm run corpus:build`，确定性、committed、`corpus:check` 进 CI）。语料纪律=事实纪律：缺失就是缺失、主题必须证据回指、排除标签规则在案、无公告语义/研报观点/LLM 富化；Jev 不做数据清洗，改语料只改 builder 不改检索代码。
- AI 原则：事实数据 → 确定性计算/搜索 → 结构化结果 → AI 阅读解释。大模型不做行情或事实数据源；公司发现始终由现有检索系统负责。
- **Jev-First 查询架构（Phase 3.2 冻结）**：Atlas builds the rails, Jev provides the intelligence。自然语言查询由确定性 Parser 编译（`hybrid-parser-v2`，`lib/hybrid/parser-v2.ts` + `lib/planner/grammar.ts` QueryGrammarRegistry）；grammar 只保存市场查询语言（时间/数值/操作符/市场字段/排序/TopN/postFilter/comparison），**不许出现行业/概念词**；grammar 吃剩的 semantic residual 原样交 Jev，不拆不归一不同义词替换。没有通用 LLM Planner、没有第二个 semantic judge、没有 LLM query rewriting——不支持的表达诚实拒绝（ambiguous/unsupported），绝不猜。Jev 变强 Atlas 自动受益，只要 Jev contract 不变。权威文档 `docs/JEV_FIRST_ARCHITECTURE.md`。
- **Jev Capability Layer（Phase 3.3 冻结）**：**Atlas owns facts. Jev owns judgement.** Jev 的智能经四个 capability 契约进入 Atlas（`lib/jev/capabilities/`：semantic_match / semantic_relation / semantic_comparison / evidence_explanation，契约版本如 `semantic-match-1` 独立于 jev 运行时版本）。lib/app 只准 import `lib/jev/capabilities` 这个 seam——wire/预算/计费知识出 `lib/jev/` 即违规（架构测试钉死）。每个 decision 必须带 evidenceRefs；relation 无 evidence 发请求前即拒；explanation 只能逐字引用所选 evidence；capability 路由只用确定性关系句法（供应链/供应商/上下游…），router 里行业/公司词零容忍。**新增 semantic intelligence 前，优先判断它是否应成为 Jev Capability（进 registry、带契约版本、带 evidenceRefs）；不得通过添加通用 LLM、Planner、行业词典或概念映射绕过 Jev Capability Layer。**权威文档 `docs/JEV_CAPABILITY_LAYER.md`。
- **Jev Evidence UX（Phase 3.4 冻结）**：**Every important judgement should be inspectable.** 前端经三层证据（卡面 hint / hover peek / 公司页 Evidence Inspector）消费 `lib/atlas/evidence.ts` 的 EvidenceView，不消费 corpus 行或 Jev wire 形状；`components/` 零 import lib/jev（架构测试钉死）。Any UI explanation of Jev judgement must be grounded in evidenceRefs supplied by the Jev Capability Layer；Frontend code must not recreate semantic judgement or semantic evidence selection——前端只 present/expand/inspect/navigate，解释散文只能在 capability 内合成（`/api/explain`，judgement 从服务端缓存读回，绝不伪造）。degraded 的中位数填充不是 judgement，永不 surface；score 是语义相关度不是概率，UI 如实标注。权威文档 `docs/JEV_EVIDENCE_UX.md`。
- **Jev Discovery Quality Baseline（Phase 3.5 冻结）**：**Measure first. Improve later.** `quality/discovery/` 是 Jev 发现质量的观察仪器（discovery-quality-v1：8 families × 55 query、克制锚点、golden evidence 预检、机械指标 + 人工 labels、≥2 次 LIVE 重复、environment 全钉）——它回答「搜索质量怎么样」，与回答「系统有没有坏」的 `tests/` 分离。**Discovery benchmark failures must not be fixed by adding query-specific, company-specific, industry-specific, or benchmark-specific production rules；quality benchmark 是观察仪器，不是优化目标。**Query/anchor 冻结后不许因结果不好改写或偷删（纠错 = documented correction + version bump）；corpus gap 记 `CORPUS_MISSING_FACT` 不许记成 Jev 失败；不引入第二个 LLM judge、不生产单一总分；Jev 升级验收 = 同一 Atlas commit/corpus/market/benchmark 版本上重跑 `npm run quality:discovery` 并 compare/stability。权威文档 `docs/JEV_DISCOVERY_QUALITY_BASELINE.md`。
- **Evidence Coverage Expansion（Phase 3.6 冻结）**：**补事实，不补答案。** 事实扩展只走「通用机制」：新增 evidence source 进 production 前必须证明 company-agnostic（authority=全池 companies.json；覆盖可以不完整，机制不许点名）、provenance 可回指（locator/披露时点/artifact sha）、抽取 deterministic、失败语义与真空分离（absence ≠ 没有关系）。Atlas 保存原文语言，**不许把 source 事实语义扩展成推断的概念或关系**（专名出现≠关系事实，关系判断归 Jev）；触发词/句式表只是抽取门槛，不许长成同义词表或行业映射。production corpus 路径（builder/acquisition/extraction/契约）不得 import 或读取 `quality/discovery/`、不得出现 benchmark query/锚点公司字面量（`tests/evidence_coverage.test.ts` 机械钉死）。关系事实一律带披露时点，绝不升级成 current 关系。权威文档 `docs/EVIDENCE_COVERAGE_EXPANSION.md`。
- **Evidence Surface Expansion（Phase 3.7 冻结）**：**More surfaces, not more semantic rules.** 公司事实观察面 = 年报（3.6）+ 巨潮公告 point-in-time relation 通道 + 官网产品页通道。新 surface 进 production 前必须过预注册 pilot 闸门（30-50 家分层样本、检索/解析/产出/假阳性阈值、STOP 规则）与人工抽查（50+50，wrong_strength 必须为零）。**不能把不同强度的关系压成一个 Boolean**：relationType/strength/direction 三段编码进 sourceId（`cninfo:announcement#type:strength:direction`），词面规则顺序机械锁定——送样永不升级成供货、中标候选人公示永不标成中标、「拟签署」永不标成已签署；方向判不出就 unresolved。公告窗口 = 12 个月滚动 + 通用标题门槛（零专名）；官网 = 静态 IA 词表发现 ≤3 页 + 页面快照（sha256 + snapshot 链），JS 渲染站如实 NO_PRODUCT_LINKS，不引浏览器路径。披露原文行分面配额（公告≤2 槽/产品≤2 槽/新面≤220 字，年报保底）守护 640 字与 280 字预算不变。新失败类别 `SOURCE_SURFACE_GAP`＝事实在现实世界存在但 Atlas 未覆盖该 surface（IR 活动记录表无稳定 API、互动问答维持 3.6 裁定、JS 官网、新闻面），与 CORPUS_MISSING_FACT 分开记账。刷新走增量/哈希守卫，不建 scheduler。production surface 路径零 benchmark 知识（隔离扫描含全部新脚本）。权威文档 `docs/EVIDENCE_SURFACE_EXPANSION.md`。
- **Product Usage Baseline（2026-09-30 起的使用纪律）**：**Measure usage, not benchmarks.** Phase 3.7 后暂停扩展一切能力（surface/source/grammar/parser/capability/judge/ranking/通用 LLM/benchmark query），转入 Usage-Driven Development。每次真实搜索必须在入口铸造唯一 `search_trace_id`（`/api/discover` 全 order 覆盖，含缓存命中与 unsupported）并完整落 trace（`data/telemetry/` + `data/search_log/` v3，append-only、gitignored、observer-only）：telemetry 失败不得影响搜索、**不得为 telemetry 增加任何 Jev 调用**（`JEV_CALL` 只在既有调用点从 capability 契约结果落账，cost 恒标 estimated）、intelligence 行为无变化由 `tests/telemetry_usage.test.ts` 证明。内部入口 `/usage`（URL 直达，不进产品导航）与 `/usage/trace/<id>`；机器可读出口 `npm run telemetry:export [--format=jsonl]`。**Benchmark 成本纪律：日常开发默认 0 次 REQUIRED_LIVE**（仅 Jev 行为相关修改例外，targeted 只跑受影响 family，milestone 才全量）；Phase 3.7 55×3 冻结为 Pre-Usage Laboratory Baseline。**没有真实 Search Trace / 明确用户需求 / 数据完整性问题支撑的问题，不自动晋升新 capability phase**——候选一律进 `docs/OBSERVED_CAPABILITY_BACKLOG.md`（IR/互动面、JS 官网、Jev synonym bridge 等），发现问题记录不顺手修。权威文档 `docs/PRODUCT_USAGE_BASELINE.md`。
- **个人行情发现 M3（2026-10-03，明确用户需求）**：权威契约 `docs/MARKET_DISCOVERY_M3_REPORT.md`。`plan.selection` 区分业务内 TopK 与行情 TopN 内业务子集；固定请求快照，沿整个可排行集合的数值/代码顺序分批判断，不用检索候选截断，不用语义分数重排，不补位。`market-eligibility-1` 只消费既有 match/relation，未知/失败填充/弱相关不冒充资格；缓存按 corpus/query/evidence/契约/实际身份，与行情快照解耦。预算停止与高位未决必须标不完整，`complete` 只指已覆盖行情集合中的资格扫描完整。历史回放显式 `legacyReplay`，生产 API 不暴露。M3 工程已交付；M2 盘中时效/源端量比仍待验收，下一步 M4 本人真实使用，不因此解除其他能力冻结。
- Jev 只做判断、分类和打分，且 **A-Atlas 只有 Jev Cloud 一个 judge**（`https://api.typesafe.ai/v1/systemone`）。Key 只来自 `TYPESAFE_API_KEY`；`JEV_MODEL` 只是别名，在岗身份以云端应答为准经 `identityProbe()` 核验（契约 `jev-1.13.0`），不接受「配置说是什么就是什么」。不要为了演示写死 key。
- **不许给 Jev 加回落**：没有 key、或云端超时/熔断/准入失败时，搜索退回确定性检索排序并如实标 DEGRADED，绝不回落本地模型、绝不静默引入第二个 judge。A-Atlas 本地运行时只有 Web（`:3400`）+ Data（`:8920`，a-atlas-data）两个组件，GPU/VRAM 不是运行时要求。Laya（`:8787` sidecar、checkpoint、训练与实验）归 a-share-trawler：本仓只保留 `reports/LAYA_*.md` 与 Laya 脚本作为历史出处链，会打到云的 7 个脚本由 `requireLayaLane()` 拦下。不要重写搜索算法。
- 物理是功能：掉落、堆积、碰撞、拖拽、弹簧上浮。不要用 CSS 平移代替。不为 Refocus 改物理交互。
- Harbor 只允许「应用登记」这一种关系：Harbor 按 `AppRuntimeSpec` 启动/探活/停止 A-Atlas（内部是 web + data 两个受管 service，用户看到的仍是一个 A-Atlas，Inspector 如实分列）；两边不交换数据，界面不做 Harbor 的功能。
- 不做交易推荐、持仓、回测、复盘；不接海獭持仓/交易之外的关系。
- 参考项目 aayans-yc-indexor 没有开源许可证。只把它当行为和视觉规格，不要复制它的源码。

- **统一正式仓库（2026-10-04；公开范围2026-10-05修订）**：本目录是唯一开发入口，默认分支 `master`；原创代码 Apache-2.0。用户选择仅公开代码，`data/`、`reports/`、冻结质量数据和真实响应夹具留在本机及归档，不进入公开Git历史或LFS。旧历史已归档，历史报告中的旧commit原样保留；日常先 `npm run publication:check` 再正常commit/push，不维护导出副本、不mirror旧refs、不用 `git add -f` 绕过私有数据排除。公开CI执行明确代码测试子集，完整本地验收仍运行原测试与 corpus/market 对账。旧阶段文档中committed/CI的表述保留历史背景，当前发布范围以 `docs/PUBLIC_CODE_RELEASE.md` 为准；数据许可与代码许可分开，以 `DATA_NOTICE.md` 为准。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
