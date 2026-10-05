# PROJECT_STATE

> **统一正式仓库（2026-10-04）**：以验收提交 `2a45dca` 建立干净初始历史；旧提交完整归档。
> 正式目录保持 `D:\workspace\a-atlas`、分支 `master`，计划远端 `TomNick777/a-atlas`。
> 原创代码 Apache-2.0。2026-10-05用户选择仅公开代码：数据、真实响应夹具和历史评测产物
> 留在本机与归档，公开历史不包含这些内容，也不上传LFS数据对象。以下旧阶段记录中的
> committed/CI描述保留当时背景；当前公开范围与验收以 `docs/PUBLIC_CODE_RELEASE.md` 为准。

> **行情工程收尾（2026-10-04）**：验收范围为收盘排行＋业务条件；M1–M3 实现统一提交。
> 运行快照在发布后尝试保留最近7天、至少最新2份，并保护当前/在读快照及历史引用；
> `market:prune` 默认预览，`--apply` 执行，清理失败不影响发布。操作与验收见
> `docs/MARKET_DISCOVERY_CLOSEOUT_2026_10_04.md`。M2盘中实测/源端量比与M4本人使用继续待验收。

> **行情发现 M3 已落地（2026-10-03，收盘快照范围）**：确定性区分业务内 TopK 与行情 TopN 内业务子集，
> 沿完整可排行集合顺序分批判断，不再截断原语义候选；同值仅按代码排序，TopN 子集保留原行情名次且不补位。
> `market-eligibility-1` 只消费既有 Jev match/relation；未知/弱相关/失败填充不冒充业务资格。
> 资格缓存按 corpus/query/evidence/契约/应答身份，与行情刷新解耦；1,000家/20批/30秒/估算US$0.05预算。
> 结果/trace 明示扫描、预算和不完整。两轮冷实测：涨幅前5相同且完整，放量前20仅9/8家并标不完整。
> M3工程已交付；M2盘中及源端量比仍待验收，M4本人真实使用尚未开始。详情 `docs/MARKET_DISCOVERY_M3_REPORT.md`。

> **行情发现 M2 工程上线（2026-10-02，条件验收）**：机械源端时间/单位投影、SH/SZ/BJ
> 全池收盘对账、Data request-driven single-flight quote snapshot、固定快照与时效闸门、
> 卡片名次/指标/覆盖提示、公司 quote asOf 已落地。5,556 可排行 + 11 无成交 / 5,567 公司。
> 科创板腾讯成交量单位已按板块校正；field49 源端量比基准未核验，禁用且不替代。
> 盘中真实时效尚待开市验收，不能宣称 M2 无条件 PASS。详情 `docs/MARKET_DISCOVERY_M2_REPORT.md`。

> **行情发现 M1 已落地（2026-10-02）**：依据本人明确需求与“今天领涨的公司”的过期数据问题，
> 完成核验交易日历、盘后可用性闸门、`market:refresh` 独立运行时捕获/校验/原子发布，
> Web 固定请求快照、digest/交易阶段缓存失效，冻结回放显式读 committed 基线。
> 当前运行行情为 2026-09-30；历史 2026-09-28 基线保留。M1 当时盘中排行与业务内全池 TopK 尚未交付，
> parser/Jev capability/业务资格契约不变。任务、操作与验收见 `docs/MARKET_DISCOVERY_IMPLEMENTATION.md`。
> 这是明确使用需求驱动的修复，不解除其余能力扩展冻结。

> **Product Usage Baseline milestone FROZEN（2026-09-30）**：Phase 3.7 后转入 Usage-Driven
> Development（tag `A_ATLAS_PRODUCT_USAGE_BASELINE_2026_09_30`）——暂停一切能力扩展，
> 唯一目标是开始真实使用并完整记录每一次真实搜索。每次真实搜索在 `/api/discover` 入口铸造唯一
> `search_trace_id`（**全 order 覆盖**：market-only / market-first / unsupported / 缓存命中此前
> 完全没有 trace，是本次填补的最大缺口）。新增 DISCOVER_RECEIVED / DISCOVER_RESPONSE_READY
> （plan 逐字 + execution 时序/funnel + Top20 快照含 judgement evidenceRefs）/ JEV_CALL
> （每个 capability 调用一条：tokens/costUsd 恒标 estimated/latency/retries/cacheHit）/
> SEARCH_FEEDBACK（好·一般·差 + 闭词表原因，服务端重建 payload）四类事件；search_log 升 v3
> （+jev 块：成本 + jevValue 排名改变量 top1/top10/promoted/dropped/removed）；Jev 价值测量
> = pre/post 序纯派生（degraded 时 null 不造假）；发现答案缓存命中现在有完整 trace
> （cached:true + replayOfSearchId）。内部入口 `/usage` 汇总面板 + `/usage/trace/<id>`
> 单搜索重建（不进产品导航）；`telemetry:export` bundle v2（+discoverSearches/jevCalls/feedback，
> `--format=jsonl` 原始事件流）。**铁律：telemetry 是 observer**——失败不影响搜索、
> **零新增 Jev 调用**、intelligence 行为无变化（`tests/telemetry_usage.test.ts` 同 query
> log on/off 结果逐字段相等，vitest 560/560）。Benchmark 纪律改约：日常 0 次 REQUIRED_LIVE，
> Phase 3.7 55×3 冻结为 Pre-Usage Laboratory Baseline；无 trace/需求/完整性支撑的问题一律进
> `docs/OBSERVED_CAPABILITY_BACKLOG.md`（B1 IR 面、B2 JS 官网、B3 synonym bridge、B4 新闻面）。
> 报告 `reports/PRODUCT_USAGE_BASELINE/REPORT.md`；权威文档 `docs/PRODUCT_USAGE_BASELINE.md`。
>
> **Evidence Surface Expansion milestone FROZEN（2026-09-30）**：Phase 3.7 已在 master
> 冻结（tag `A_ATLAS_EVIDENCE_SURFACE_EXPANSION_2026_09_30`）——事实观察面从年报扩展到
> 两个新 surface：巨潮公告 point-in-time relation 通道（全池 5,567 家 12 个月窗口，
> 924 家标题命中、1,941 份 PDF，4,218 条 relationType/strength/direction 三段分类事实——
> 送样/候选人公示/意向协议零升级）+ 官网产品页通道（3,122 家发现成功、7,501 页快照，
> 4,423 条句级 verbatim 产品事实），facts 137,805 → 146,446。corpus 1.3.0 分面配额投影
> （digest `472e329f → a5db7e5d`，640/280 预算不变，judge token +1、latency 零退化）。
> 冻结 benchmark v1.2（query/anchor 逐字不变）三次 LIVE：NONE 55 ×3、relation 族
> MATCHED 0.82-0.98、稳定度同带；C04 英伟达/A06 K线 → 新失败类别 `SOURCE_SURFACE_GAP`
> （互动面/JS 官网未覆盖，非 extractor 漏抽）。IR 活动记录表因无稳定 API 被拒（在案）。
> 报告 `reports/EVIDENCE_SURFACE_EXPANSION/REPORT.md`；权威文档
> `docs/EVIDENCE_SURFACE_EXPANSION.md`；纪律锁 `tests/evidence_surface.test.ts`。
>
> **Evidence Coverage Expansion milestone FROZEN（2026-09-30）**：Phase 3.6 已在 master
> 冻结（tag `A_ATLAS_EVIDENCE_COVERAGE_EXPANSION_2026_09_30`）——第一轮由质量基线驱动的
> 事实扩展：巨潮年报通道（5,475/5,567 家，98.4%）确定性提取 54,560 条
> provenance-backed 关系/集中度/细粒度产品事实（100% 带披露时点+PDF 页码+sha256），
> corpus 1.2.0 经 `evidenceSpans` 逐字投影（digest `41a0995d → 472e329f`，640 预算内
> 重排，judge token +1、latency 零退化）。冻结 benchmark（v1.1，query/anchor 逐字不变，
> 仅重钉坐标）三次 LIVE 重跑：**corpus gap 归因 4 → 0**，relation 家族变为披露级证据
> 支撑（美的/特斯拉/新能源供货题 rank1 均为真实披露供应商），C04 英伟达/A06 K线
> 诚实低分（点名型/产品级来源留下一阶段）。补事实，不补答案。
> 报告 `reports/EVIDENCE_COVERAGE_EXPANSION/REPORT.md`；权威文档
> `docs/EVIDENCE_COVERAGE_EXPANSION.md`；隔离与证据纪律锁 `tests/evidence_coverage.test.ts`。
>
> **A-Atlas Refocus is now the canonical A-Atlas mainline. `master` is the authoritative
> development branch**（2026-09-28 由 `atlas/refocus-data-foundation` fast-forward 晋级，
> milestone tag `A_ATLAS_REFOCUS_MAINLINE_2026_09_28`；该分支已完成使命并删除）。
> 旧版 pre-Refocus 实现（含 Phase 0–4 的 Vibe 研究系统与一级导航产品）只是历史上下文，
> 不再是活跃产品基线。以后接手 A-Atlas，默认从 `master` 开始，不要把 Refocus 当实验分支。
>
> 当前产品与运行时以文首「NL Query Intelligence · Phase 3 / Jev-First · Phase 3.2」
> 「Market Intelligence · Phase 2」「Market Intelligence · Phase 1」「Source Coverage ·
> Pass 2」「Source Coverage · Pass 1」「UI2.0 · Visual Mainline」「Refocus · Data
> Foundation」「Phase 2 · Company Knowledge Corpus」与「Phase 3 · Discovery Quality」九节
> 为准（2026-09-29）；Phase 3.3/3.4（Capability Layer 与 Evidence UX）的冻结纪要
> 在上方 milestone 段。
> 其下「Laya（本地判断）现状」、Phase 2/3/4 各节是历史记录：那些事情确实发生过，
> 但当前产品只剩发现与公司两个面，Vibe 研究系统已整体退役，判断只有 Jev Cloud，
> 本地组件只有 Web + Data，发现索引读 Company Knowledge Corpus。
>
> **Market State Foundation milestone FROZEN（2026-09-29）**：Market Intelligence Phase 1 已
> ff-only 晋级 master 并冻结（tag `A_ATLAS_MARKET_STATE_FOUNDATION_2026_09_29`）——Atlas
> 第一次拥有「某个交易日市场发生了什么」的确定性 Market State 层：60 交易日 332,402 行
> objective 日线（公司池逐日可反查）、latestTradingDay 语义、实证校准的涨跌停规则
> （11,108 交叉审计零错配）、连板/区间收益/量比派生与 canonical queries Q1–Q7（全部
> 确定性 fixtures + CLI/API 查询面，`market:check` 字节级对账进 CI）。与 Company Corpus
> 完全隔离（corpus digest `41a0995d…` 复验未变）。报告
> `reports/MARKET_STATE_PHASE1/REPORT.md`；Hybrid Market Discovery 留 Phase 2。
>
> **Full-Market Source Facts milestone FROZEN（2026-09-29）**：Source Coverage Pass 1+2 已
> ff-only 晋级 master 并冻结（tag `A_ATLAS_FULL_MARKET_SOURCE_FACTS_2026_09_29`）——Atlas
> 第一次拥有覆盖全 A 股 5,567 家、83,245 条逐条可反查 provenance 的 source fact 层，并已
> 确定性进入 production corpus（digest `41a0995d4ef625ba`，字节级重建一致）。冻结日主线复验
> （integrity 全量 PASS / 全量回归 / flagship 零漂移 / benchmark 复跑）见
> `reports/FULL_MARKET_SOURCE_FACTS_FREEZE_2026_09_29.md`；两轮报告
> `reports/SOURCE_COVERAGE_PASS1/REPORT.md`、`reports/SOURCE_COVERAGE_PASS2/REPORT.md`。
>
> **Hybrid Market Discovery milestone FROZEN（2026-09-29）**：Market Intelligence Phase 2 已
> ff-only 晋级 master 并冻结（tag `A_ATLAS_HYBRID_MARKET_DISCOVERY_2026_09_29`）——Atlas
> 第一次能用自然语言「捞整个 A 股市场」：确定性 Hybrid Query Planner（hybrid-planner-v1，
> 冻结词表：今天/最近5日/最近20日、领涨/成交额最大/换手率最高/明显放量、连续N个涨停/N连板、
> 成交额前20）把自然语言编译成可序列化 HybridQueryPlan，四种 execution mode（semantic-only
> 原路径不动 / market-only 直走 Phase 1 / semantic-first 市场指标排序 / market-first 市场取集
> judge 判卡）单一 rank authority、两种分数永不融合；H1–H10 真实运行（Jev jev-1.13.0 在岗）
> 全部有固定 parser+execution 测试；UI 卡面按查询计划显示 Hero Metric + plan caption，物理
> 交互零改动。corpus `41a0995d…` 与 market state `4eada12b…` 字节级复验未变。报告
> `reports/HYBRID_MARKET_DISCOVERY/REPORT.md`；LLM planner 留 Phase 3。
>
> **Jev Test Isolation milestone FROZEN（2026-09-29）**：Phase 2.1 已落在 master（tag
> `A_ATLAS_JEV_TEST_ISOLATION_2026_09_29`）——测试中的 Jev API 使用完成治理：`npm test`
> （vitest 368）全离线且装 §14 网络 guard（任何出网尝试 fail fast，Jev 尝试给出 fixture
> 修复指引）；H1–H10 业务回归可全链路离线重放（planner→committed 语义 fixtures→冻结 Market
> State→executor→hero/evidence/caption）；committed raw payload fixtures 经真实 judge
> adapter 离线验证（§11）；REQUIRED_LIVE 矩阵固化为 `npm run test:jev-live`（7 场景 12 wire
> calls：身份探针/semantic-first 生产线/三域语义多样性/H5 诚实零/market-first subset judge，
> call accounting 记账、unexpected=0）；fixtures 显式刷新 `npm run semantic:fixtures:refresh`
>（provenance 在案，degraded 拒绝落盘）。必要真实覆盖一个不少（Phase 2 的 2 条 Jev 生产路径
> 都有真实集成测试），重复/意外真实调用清零，Phase 2 产品行为零变化（生产冒烟前后逐位一致）。
> 报告 `reports/JEV_TEST_ISOLATION/REPORT.md`。

**Jev-First Architecture milestone FROZEN（2026-09-29）**：NL Query Intelligence Phase 3 +
3.1 + 3.2 已整体落在 master——Phase 3（tag `A_ATLAS_NATURAL_LANGUAGE_QUERY_INTELLIGENCE_2026_09_29`）
证明 Hybrid DSL V2 / Capability Registry / Validator / Normalizer / postFilters / comparison
的价值；Phase 3.1（tag `A_ATLAS_PLANNER_RUNTIME_ACTIVE_2026_09_29`）激活过 GLM 通用 LLM
Planner（历史 tag 不动，保留证据）；Phase 3.2（tag
`A_ATLAS_JEV_FIRST_ARCHITECTURE_2026_09_29`）把通用 LLM Planner 从生产架构整体退出：
**Atlas builds the rails, Jev provides the intelligence**——确定性 Parser（hybrid-parser-v2，
`lib/hybrid/parser-v2.ts` + `lib/planner/grammar.ts` QueryGrammarRegistry）是唯一 query
compiler，semantic residual 原样交 Jev，Atlas 不做第二个 Jev、不猜不支持的表达；Jev
REQUIRED_LIVE 覆盖一个不少；corpus/market 字节级未变。详见 `docs/JEV_FIRST_ARCHITECTURE.md`
与 `reports/NL_QUERY_INTELLIGENCE/PHASE3_2_JEV_FIRST_REPORT.md`。

**Jev Capability Layer milestone FROZEN（2026-09-29）**：NL Query Intelligence
Phase 3.3 已落在 master（tag `A_ATLAS_JEV_CAPABILITY_LAYER_2026_09_29`）——Jev 在
Atlas 承担的智能正式合同化为四个 capability（`semantic_match` / `semantic_relation` /
`semantic_comparison` / `evidence_explanation`，契约版本 `semantic-match-1` 等独立于
jev 运行时版本），**lib/app 只准通过 `lib/jev/capabilities` 这一个 seam 触达 Jev**
（架构边界测试钉死：wire 知识、传输预算、计费常量出 `lib/jev/` 即违规；确定性查询轨道
零 import lib/jev）。原则 **Atlas owns facts. Jev owns judgement.** 落成类型：
Fact(evidence) / Judgement(decision+evidenceRefs) / Explanation(逐字引用证据) 三种
对象互不混合；relation 无 evidence 发请求前即拒 `insufficient_evidence`，
explanation 只能逐字引用所选 evidence。capability 路由确定性（关系句法→relation，
其余→match，无 intent model）；REQUIRED_LIVE 扩至 10 场景 15 wire calls（含
relation 正例+对照组、comparison 排序、explanation 逐字 grounding 全部真云通过）；
corpus `41a0995d…` / market `4eada12b…` 字节级未变；`/api/discover`、`/api/search`
向后兼容（新增可选 `intelligence` 信封），`/api/intelligence` 为内部测试面。
架构权威 `docs/JEV_CAPABILITY_LAYER.md`；报告 `reports/JEV_CAPABILITY_LAYER/REPORT.md`。

**Jev Evidence UX milestone FROZEN（2026-09-29）**：NL Query Intelligence Phase 3.4
已落在 master（tag `A_ATLAS_JEV_EVIDENCE_UX_2026_09_29`）——把 Phase 3.3 已产生的
judgement/evidenceRefs/relation/explanation 转化为可见、可查、可信的 Evidence UX，
**零新增 intelligence**。**Every important judgement should be inspectable**：
L1 卡面 hint（词面逐字、仅 judgment-backed）→ L2 hover peek（score+逐字摘录）
→ L3 公司页统一 Evidence Inspector（judgement 行「语义相关度，不是概率」+ 资料依据
逐字 + 按需 Jev 解释 + 来源/provenance + 折叠技术细节）；`/api/explain` 把冻结的
`evidence-explanation-1` 产品化（judgement 从服务端 discover 缓存读回，绝不伪造，
insufficient_evidence 与低分是不同语义），comparison 留内部面。前端经
`lib/atlas/evidence.ts` 的 EvidenceView 消费证据——`components/` 零 import
lib/jev（架构测试钉死）；grounding 机械测试：displayed evidence 全解析且逐字、
explanation ⊆ evidenceRefs、无 orphan judgement（H10 真实适配器重放）。
REQUIRED_LIVE 10/10（15 wire calls，unexpected=0）；corpus `41a0995d…` /
market `4eada12b…` 字节级未变；vitest 517 / python 38 / tsc / build 全绿；
生产场景真实验收（减速器/光模块/未来教育/K线软件/苹果供应链 relation + 浏览器
三层走查）。权威文档 `docs/JEV_EVIDENCE_UX.md`；报告 `reports/JEV_EVIDENCE_UX/REPORT.md`。

**Jev Discovery Quality Baseline milestone FROZEN（2026-09-29）**：NL Query Intelligence Phase 3.5
已落在 master（tag `A_ATLAS_JEV_DISCOVERY_QUALITY_BASELINE_2026_09_29`）——**测量阶段，不是优化阶段**：
建立第一套长期稳定的 Jev 发现质量坐标系（`quality/discovery/`，discovery-quality-v1），
**Measure first. Improve later**。8 families × 55 query（explicit/broad/relation/comparison/
composite/ambiguous/weak-concept/negative-control）+ 克制锚点（must 仅限语料逐字核验的旗舰、
should 观察、negative 对照）+ golden-evidence 预检 + query/anchor 冻结纪律；runner 只经
`lib/jev/capabilities` seam 观察生产查询路径（wire 记账、unexpected=0、identityProbe 每跑核验
`jev-1.13.0`）。**Baseline（r1/r2/r3 全 LIVE，55/55 ok ×3）**：evidence resolution /
explanation grounding 100%，negative 侵入 0，must recall @5/@10/@20 = 0.6/0.8/1.0（三跑零漂移），
overlap@10 ≈ 83%、|Δscore| ≈ 0.015；失败归因 51 NONE + 4 corpus（C02 美的供应链/C04 英伟达/
C05 特斯拉 = CORPUS_MISSING_FACT，A06 K线软件 = CORPUS_WEAK_FACT），0 归因 Jev/parser/runtime；
人工 review 55 题 + 151 行标签（DIRECT 84/WEAK 34/VALID 22/UNSUPPORTED 9/UNCERTAIN 2）。
**Corpus gaps are not Jev failures**；**不生产单一总分**（capability matrix 见报告）；
所有发现（关系事实层、词面表示缺口、eval 词虚高置信、E06 排序观察项）进 backlog 不修。
新原则入 AGENTS：**Discovery benchmark failures must not be fixed by adding query-specific,
company-specific, industry-specific, or benchmark-specific production rules.**
corpus `41a0995d…` / market `4eada12b…` 字节级未变。权威文档 `docs/JEV_DISCOVERY_QUALITY_BASELINE.md`；
报告 `reports/JEV_DISCOVERY_QUALITY_BASELINE/REPORT.md`；baseline 指针 `quality/discovery/baseline.json`。

# NL Query Intelligence · Phase 3 / Jev-First · Phase 3.2（2026-09-29，master）

**自然语言查询智能的最终形态**：市场查询语法由代码解析，公司语义全部交 Jev。报告
`reports/NL_QUERY_INTELLIGENCE/{REPORT,PHASE3_1_RUNTIME_ACTIVATION_REPORT,PHASE3_2_JEV_FIRST_REPORT}.md`；
架构权威 `docs/JEV_FIRST_ARCHITECTURE.md`。

- **Query Grammar Registry**（`lib/planner/grammar.ts`，`query-grammar-1`）：用户怎么
  「写」市场查询的唯一权威——操作词（超过/至少/达到/不超过/≥/50亿以上…）、指标别名
  （成交额/成交量/换手率/量比/市值/股价/涨跌幅/跌幅）与单位换算（亿/万/%/倍/元）、
  已物化时间窗（最近5日/20日 + 一周→5d、一个月→20d 冻结映射）、日环比句法（比昨天高/低）、
  「并且今天仍然上涨」、postcut 句法（前N里/并且B）、模糊与注入纪律。**无任何行业/概念词**——
  `tests/architecture_boundary.test.ts` 把 grammar.ts 文件本身钉为零语义词（注释也算）。
- **Deterministic Parser V2**（`lib/hybrid/parser-v2.ts`，`hybrid-parser-v2`）：唯一权威
  query compiler（`lib/hybrid/compile.ts` 是唯一编译 seam）。V2 语法（阈值/环比/窗口/
  postcut/多条件）产出 Phase 3 的 PlannerOutput，经真实 Validator → Normalizer →
  HybridQueryPlan；无 V2 结构的查询按冻结 V1 词表逐字节编译（H1–H10 回归锁死）。
  semantic residual 原样交 Jev（「做人形机器人减速器」不拆不归一）；不支持就诚实拒绝
  （ambiguous_query / unsupported_time_window / unsupported_or_combination /
  unsupported_market_field），绝不猜。
- **Hybrid DSL V2 保留**（Phase 3 资产零降级）：filters/postFilters（先按排序取前 N 再施加
  资格）/comparison（今日 vs PREV_TRADING_DAY）/sort/limit/execution order 四模式单一 rank
  authority/assumptions 与 notes（所有默认解释在案）/unsupported contracts/capability
  registry（query-capability-registry-1）/network guard/Jev REQUIRED_LIVE。P1–P22 全集
  确定性分类：17 条有计划执行、P8/P17 冻结拒绝、P18–P21 产品纪律拒绝——每条都有正确、
  冻结、可解释的 deterministic outcome。
- **已退出**（Phase 3.2 移除，历史 tag/报告保留为证据）：GLM Planner Runtime
  （HttpPlannerProvider、PLANNER_LLM_* 配置、BigModel coding-plan 端点、planner probe /
  test:planner-live / planner:fixtures:refresh、17 个 recorded fixtures、Planner Router 的
  LLM 路径、`planner_unavailable` 意图）。响应面 provenance 收敛为
  `parser: { route: "deterministic", version: "hybrid-parser-v2", parseMs }`（provider/
  model/reasoning/LLM latency 字段消失）；`/api/discover` 其余契约不变，UI 零改动。
  复杂查询从 10–33s（LLM 尾延迟）回到毫秒级 parser + Jev 判卷原速。
- **CLI**：`npm run hybrid:query -- [--explain|--json] "query" | --preset H1..H10|P1..P22 |
  --suite | --vocab`（--vocab 输出 grammar registry）。
- **测试**：parser_v2 54 + p_suite 25 + capability_registry 24 + architecture_boundary 6，
  全量 vitest 477/477 离线绿（Jev 真云只走 `test:jev-live`）；tsc/build/生产冒烟全过。

# Market Intelligence · Phase 2（2026-09-29，master）

**Hybrid Market Discovery 落地**：公司事实 × 市场状态可组合的自然语言发现。报告
`reports/HYBRID_MARKET_DISCOVERY/REPORT.md`（A–L 全节）。

- **Planner**（`lib/hybrid/planner.ts`，`hybrid-planner-v1`，纯函数无 LLM）：冻结词表 + 优先级
  （unsupported 扫描 → 时间窗 → 排序（先到先得）→ 窗口组合改写 → 连板过滤（计数短语优先）→
  TopN → 日期限定词 → 语义残留）。歧义解释全部落 `plan.notes`（活跃→成交额、明显放量无阈值、
  连板缺「连续」按 ≥N 注明）；unsupported 明确拒绝（未来预测/投资建议/跌停连板/未映射窗口/
  裸 TopN/出域指标），「做K线软件的公司」「做未来教育的公司」等纯事实查询不受牵连（§14）。
- **Executor**（`lib/hybrid/execute.ts`）：四模式单一 rank authority——semantic-only 原话透传
  `runSearch`；market-only 原样 `runMarketQuery`；semantic-first 用既有 SHOWN/matchCount 资格
  契约定 WHO、market metric 排序（**未过市场过滤的语义命中剔除**——真实运行暴露的资格 bug，
  回归锁死）；market-first 市场取 Top-N、judge 只判该集、顺序仍由市场保持。judge 不可用 =
  管线同款确定性混合 + DEGRADED 标注。全链路 DI（semanticEngine/subsetScorer/marketInject/
  companies）即离线 fixture 重放。
- **CLI/API**：`npm run hybrid:query -- [--explain|--json] "query" | --preset H1..H10 | --suite |
  --vocab`；`POST /api/discover` 返回 query/plan/execution/results（缓存身份含 corpus+judge+
  planner+latestTradingDay）。
- **UI**：搜索框切 `/api/discover`；`Match.hero`（plan.formatted）上卡面底部一行，五处重绘路径
  （theme/face/logo 到达/inject/begin）全携带；plan caption 一行「交易日 · 排序依据 · 语义」；
  物理零改动。
- **真实运行**（2026-09-28 状态，jev-1.13.0，H1–H10 degraded=false）：H2 寒武纪 88.43亿 登顶
  AI芯片成交额、H4 新华传媒 5连板、H7 利扬芯片 20日 +40.66%、H10 中际旭创/新易盛 光模块
  双龙头按成交额序；H5 如实空（语义池120 × 连板集4 判分过线 0）。性能：parser ≤10ms、
  market join 55–76ms、merge ≤10ms，瓶颈仍是 Jev 判卷（与 /api/search 同源）。
- **测试**：parser 67 + execution 17 = 84 新增，全量 vitest 343/343；corpus/market 字节级未变；
  tsc/build/生产冒烟（四路 + /api/search 回归）全过。


# Jev Test Isolation · Phase 2.1（2026-09-29，master）

**测试中的 Jev API 治理**：不开发产品能力，不进 Phase 3；只回答一件事——
「该真实调用的一个不少，不该真实调用的一个不浪费」。报告 `reports/JEV_TEST_ISOLATION/REPORT.md`。

- **测试分层**（§10）：`npm test`（vitest 368 + py 38）= unit/planner/executor/H1–H10 离线
  replay/payload contract/UI-API 业务，**零真实请求，且由 §14 网络 guard 强制**（setup
  `tests/setup/no_real_jev.ts`，任何出网尝试 fail fast，Jev 尝试的报错直接给出 fixture 刷新
  指引；guard 有自身自测防腐烂）；`npm run test:jev-live` = REQUIRED_LIVE 矩阵（唯一被授权
  真实联网的测试面）；CI（windows-runtime）保持 stub 冒烟，从不需要真云。
- **REQUIRED_LIVE 矩阵**（`scripts/jev_live_suite.ts`，7 场景 12 wire calls，记账在案、
  unexpected=0）：L1 身份探针（认证+应答身份=jev-1.13.0）→ L2 semantic-first 生产线（V3 全池
  2 chunks+市场 join）→ L3 三域语义多样性（AI芯片×成交额 / 储能×5日涨幅 / 创新药×跌幅）→
  L6 H5 诚实零（资格边界是真实语义判断）→ L7 market-first subset judge（§7：真实生产 payload
  + 真实 SHOWN 契约只能真云证明）。证据落 `reports/JEV_TEST_ISOLATION/live_run_*.json`。
- **Fixture 层**（`tests/fixtures/semantic/`，committed、可 diff、离线重放）：retrieval
  fixtures（7 个残留语义查询的 SemanticOutcome 采集，H1/H8 共享「机器人」）+ judge raw
  payload fixtures（H1 首个 100-candidate chunk、H10 market-first Top-20 子集）。语义 fixture
  缺失 = FAIL（`FixtureSemanticProvider` fail-closed，绝不静默回落真云）；raw payload 经
  `RecordedJudgeProvider` 走**真实 judge adapter**（解析/打分/缺字段 0.5 填充/usage），只有网络
  被录制（§11）。显式刷新：`npm run semantic:fixtures:refresh -- --all | --preset H1 |
  --query "机器人"`（provenance：query/operation/Jev 身份/检索选项/digests/capturedAt；
  degraded 拒绝落盘；生产面校验，stub 不许采集）。
- **修改前审计**（preload 计数器实测，非静态 grep）：vitest 343 全套带真实 key = **0** 次真实
  调用（离线但无强制）；`hybrid:query --suite` H1–H10 = **17** 次（8 语义查询 × 2 chunks +
  H10 子集 1；V3 路径 classify 被跳过）；生产冒烟五请求 = **6** 次 + 启动 identityProbe
  **1** 次。修改后：同样覆盖由 test:jev-live 12 次 + fixture 采集（一次性 17 次）承担；
  `hybrid:query`/生产冒烟照旧可用（人类工具，不是测试）。
- **产品行为零变化**（§15）：planner/contracts/executor/hero/Market State/Corpus/UI 全未动
  （唯一 lib 改动是 presets 常量搬家与新增 recorded seam，均在生产路径之外）；改动前后生产
  冒烟五路 top3 逐位一致、调用画像一致（6+1 boot）。
- **回归**：vitest 368/368（343 基线 + 14 离线 H-suite replay + 7 payload contract + 4 guard
  自测）/ py 38 OK / corpus:check 字节级 `41a0995d…` / market:check 字节级 `4eada12b…` /
  Q1–Q7 全命中 / tsc / build / 生产冒烟 / test:jev-live 7/7（12 calls，unexpected=0）全绿。


# Market Intelligence · Phase 1（2026-09-29，分支 atlas/market-state-phase1）

**Market State Foundation 落地**：Atlas 第一次拥有「某个交易日市场发生了什么」的确定性事实层，
与 Company Corpus 完全隔离（corpus digest `41a0995d…` 复验未变，检索/Jev/UI 零改动）。
报告 `reports/MARKET_STATE_PHASE1/REPORT.md`（A–J 全节 + 制度校准证据）。

- **三层**：Market Data（`data/market/daily/*.jsonl` 60 交易日 332,402 行，vendor tdx 全市场
  盘后包按 (market,code)∈公司池过滤；`quote/*.json` 最新日腾讯快照，一致性闸门 ≥99.5% 防
  错日归属）→ Market State（`state/*.jsonl` 派生状态，`market:check` 字节级对账进 CI）→
  Market Query（`lib/market/query.ts` + CLI `market:query --preset Q1..Q7` + `app/api/market`）。
- **latestTradingDay**：max(day files)，绝不取系统日期；周末/节假日/当晚包未发布自动停前一日。
- **涨跌停=实证校准的交易所规则**（非 9.9% 阈值）：主板（含 ST）10% HALF_UP、S 股 5%、
  创业板/科创板 20% HALF_UP、北交所 30% **内取整**（涨停 floor/跌停 ceil）、注册制新股前 5 日
  等特殊阶段如实 unknown。制度结论由 60 日真实封板收盘实证（主板 ST=10%：158 次精确封板/
  0 越限；920885 15.93= floor 型），与腾讯 limit 字段 11,108/11,108 全一致。
- **canonical queries**：Q1–Q7 全部有确定性 fixtures（47 条 vitest）；真实运行
  09-28（大跌日）涨停 35/跌停 60、连板≥3 恰 4 家（新华传媒 5 板）、换手率榜首洛轴 65.57%，
  null 永不冒充 0。性能：构建 1.9s/60 日，查询热态 p50 1.3ms。
- **纪律**：不做 Hybrid Query（Phase 2 入口）、不加 UI、不碰冻结的 corpus pipeline；
  follow-up（历史换手率回填、复权口径、制度校准脚本化、池外新股）见报告 §J。


# Source Coverage · Pass 2（2026-09-29，分支 atlas/source-coverage-pass2）

**Source A 事实层全池扩量**（Pass 1 pilot 6 家 → 5,567 家全池）。corpus digest
`f213496a…`→**`41a0995d4ef625ba`**，83,245 条 provenance-backed facts
（pilot 169 条逐字节未动），检索算法/benchmark 期望/UI2.0 零改动。

- **acquisition**：`scripts/source_coverage_fetch_full.py`（authority=companies.json、
  BJ 92 前缀修复、逐 feed ok/empty/error 状态、断点续跑、双分片并行）5,291 家
  抓取零网络失败；`source_coverage_extract_facts.py` 规则经 266 家分层样本复检
  （`reports/SOURCE_COVERAGE_PASS2/FULL_MARKET_EXTRACTION_AUDIT.md`：抵销/租赁收入/
  小计/调整项目/下角料/枚举标记/括号切分 7 类假阳性扩量前修复；「其中」三形/单字/
  废料副产物全池后精修）。
- **integrity**：`source_coverage_pass2_integrity.py` 全量机械验证 PASS——0 orphan/
  0 name mismatch/0 invalid term/0 同源重复，rawText 逐字回指 feeds payload 与
  年报 PDF 页；跨源同词 215 组按双重 provenance 保留。coverage：5567/5567 家有
  事实、zygc 历史产品行 64,514 条（97,052 个报告期）、facts/company p50=14。
- **corpus 消费**：sourceFactsCoverage 6→**5,350 家**；DF 闸门全池仅拦 1 词；
  cap12 撞顶 21.1%、640 预算触顶 30.6%（挤压的是简介尾段，主要产品行 1,638/1,640
  原样）——数据在案不调参；160 字行预算修复为选词即服从（截断率 0，vitest 抓到）。
  语义 diff 5,344 变更严格限于三字段，pilot 文档零变化。
- **search impact**：@10 86.2→**87.7%**、排除违例 1→**0**；flagship 全保（格力2/美的3、
  伺服三家 Top5 + 北交所星辰科技登顶、斯达1/时代7）；@1 56.9→52.3% 逐题归因
  （4 题判分翻动 + 1 题 facts 富化池挤出，零数据错误归因）；expected-evidence
  233→236 verified 零退化。UPS 探针：全池词面 2→5 家自然增长。
- **回归**：vitest 212/212（含 11 条 Pass 2 规模锁）、python 33/33、corpus:check
  字节级一致、typegen/tsc/build/search smoke/API smoke 全绿。
- **纪律**：年报通道冻结未动（Pass 1 follow-up S3 留独立阶段）；`atlas/corpus-enrichment-pass1`
  分支原样未动；follow-up 见 `reports/SOURCE_COVERAGE_PASS2/REPORT.md` K 节
  （SOURCE：EM zygc 200 行上游窗口；CORPUS：cap12/DF/640 观察项；DISCOVERY：judge 波动带）。

# Source Coverage · Pass 1（2026-09-28，分支 atlas/source-coverage-pass1）

**公司事实补充层落地**。Corpus Enrichment Pass 1 证实旗舰失败（空调/伺服/IGBT）不是词形
问题而是 source 层没有事实；本 Pass 进一步证实其中大部分是**上游 payload 里有、normalize
层丢弃**（THS 产品类型/经营范围、巨潮主营业务（fallback 覆盖即丢）/经营范围、东财主营构成
全历史报告期行），小部分（汇川/信捷的「伺服」、时代电气「IGBT」字面）确实只有年报有。

- **合同**：`lib/sourcefacts/contracts.ts` schema 1.0.0——`CompanySourceFact{factId,
  companyCode, factType(8 枚举), terms, rawText, source{sourceId,sourceName,sourceType,
  locator,date}, retrievedAt, artifactSha256}`。唯一 normalization 规则=词面回指：
  term 必须是 rawText 逐字子串（机械验证，builder 加载时一条不合法即拒绝构建）。
- **acquisition**：`scripts/source_coverage_fetch.py`（feed 被丢字段 + 巨潮 FY2025 年报
  PDF，fetch→pin 分离，原始缓存 gitignored `data/raw/source_facts/`）→
  `scripts/source_coverage_extract_facts.py`（确定性提取，committed
  `data/source_facts/facts.jsonl`）。窗口守卫规则在案：释义节/多指 glossary/上游采购
  语境/高管简历/公司语境；残差桶（其他*、合计、平衡项目）不收。
- **corpus 消费**：schema 1.1.0 新可选块 `sourceFacts[{term,factType,evidence=factId}]` +
  searchableText「来源事实：」行（≤160 字）；派生确定性（date 降序→head 判重→DF 闸门
  0.05→后缀/互包含去重→cap12）。digest `727a933f…`→**`f213496a…`**，语义 diff 恰好
  6 家 pilot 文档。
- **结果**：pilot 6 家（格力/美的/汇川/禾川/信捷/时代电气）169 条 provenance-backed
  事实；旗舰修复实证——A12 空调格力 rank2/美的 rank3（前：rank5/落榜）、C01 伺服三家
  全进 Top10（前：pool50=0 全落榜）、C06 IGBT 时代电气 rank5（前：落榜）；82 题全量
  @5/@10/Expected@10 提升（84.6%/86.2%/96.9%），@1 -3.1pp 在云判分方差带内，唯一排除
  违例 F07=Phase 3 已立案的 judge 侧问题（涉事公司文档零改动）。benchmark.v1.json 与
  检索算法零改动；线上 API「伺服电机」→ 禾川3/信捷4/汇川5。
- **纪律**：`atlas/corpus-enrichment-pass1` 分支原样未动（不 merge 不 cherry-pick）；
  UI2.0 零改动；UPS 无冻结案例只做词面统计（全池 2 家已有）；扩量（Source A 全池补抓、
  年报通道扩量）是 Pass 2 决策，样本扫描见 `reports/SOURCE_COVERAGE_PASS1/`。

# UI2.0 · Visual Mainline（2026-09-28，分支 atlas/ui2-integration）

把 a-share-trawler 移植来的 UI2.0（pre-Refocus WIP，stash@{0}）重新适配到 Refocus 主线：
产品体验全部回来，检索/corpus/API 契约零改动。检索引擎继续独占 query/ranking/score/identity；
UI 只做表达。

- **卡面两根正交轴**：牌堆卡面（`cardFace` localStorage + `?face=` 覆盖，默认 LOGO；
  文字卡=简称+代码 1.62:1 / LOGO 卡=纯标志 1:1）与举牌 brand 面（恒为 LOGO+名称正方形卡，
  与牌堆纵横比解耦）解耦。卡面切换=逐轴 `Body.scale` 重缩全部刚体+唤醒重新沉降+重烤图集
  +relayout；物理不变量零改动。行业由底色承载（`plateShowsIndustry` 恒 false），
  sw-industry 色板加深且与深色代码文字 AA 对比度 ≥4.5 有测试锁定，默认 sw-industry。
- **LOGO 是表现层增强**：`data/raw/logos/`（5567 家全量，gitignore 本地缓存，
  文件=manifest=公司池三方对账；同花顺 F10 直链 60×60 PNG；增量补抓
  `scripts/fetch_logos.py`，全量务必 ≤1-2 worker 防同花顺软挂起）。供图
  `/api/logos/[code]`（6 位码校验防穿越，immutable 缓存一年，缺码 404、非法码 400）。
  `components/floor/logoCache.ts` 懒加载+失败负缓存+订阅；logo 未到达/缺失回退文字面，
  到达后图集单格重绘，渲染循环零改动。logo 不参与匹配，canonical identity 始终
  name + stock code。
- **搜索体验**：composer 换双光轨 perimeter 光束 + 信号条，搜索中 orb 变停止键
  （abort + `SEARCH_STOP` 遥测）；结果客户端按匹配度降序排列后举牌，不显示匹配度数字。
  检索链路仍是 `/api/search` 单一入口，无第二套搜索逻辑。
- **Refocus 剔除项**（stash 版本基于旧 master，含已退役栈，重建时剥除）：右键加入自选
  （`/api/atlas/*` 已退役）、`.atlas-report` DeepDive 样式、`atlasPost` 引用——
  refocus 零残留不变量测试全绿。
- **QA 工具**：`scripts/face_check.mjs`（两牌堆卡面截图；brand 是举牌专用面，
  单卡形态由 export_faces 导出）、`export_faces.mjs`（`__floor.card()` 走真实
  renderPlate 单卡导出）、`search_smoke.mjs`（服务端序 vs 页面序排序断言，已知对云判分
  波动敏感，排序口径以拦截同一次响应比对为准）、`settings_check.mjs`，均 `FACE_URL`
  指端口。视觉证据 `reports/ui_preview/`（本分支真实再生）。

## 验收状态（UI2.0，2026-09-28）

vitest 188/188（含 theme 6 项新断言：AA 对比度/默认 sw-industry/两主题归一）+
python 33/33 + corpus:check 逐字节一致（digest 727a933f4febb661 不变，benchmark 期望
未动）+ typegen/tsc 干净 + 生产 build 通过；refocus 验收旅程 17/17（真实 Jev + 降级
双 journey）；QA 四脚本跑通（search_smoke SORT PASS）；真实浏览器 12 项走查全过
（首屏 LOGO 堆/光束、光刻胶搜索举牌降序、点牌进公司页六段完整、空查询禁用、连续
查询、清空回堆、刷新恢复）；冻结基准 6 题跨类别对账与 Phase 3 baseline 逐题一致
（C01 伺服 0/3 即基线已录的 corpus 词表缺口，非回归）。

---

# Phase 3 · Discovery Quality（2026-09-28，分支 atlas/refocus-data-foundation）

诊断层加法（产品零变化、检索算法零改动）：系统评估自然语言公司发现的质量，
建立可重复基准、全链路 Inspector 与失败归因。按 Hard Rule 顺序执行：
Benchmark（冻结先于运行）→ Inspector → Taxonomy → Baseline → 归因 → 决策。

- **Benchmark v1**：`evaluation/discovery/`（82 题 9 类 + `expected-evidence.json`
  机械证据审计 252 符号 90% 词面回指 + README 契约）。Ground truth 来自领域知识
  先于任何搜索运行成稿（git 可证 `90a479f`）；已知语料缺口（格力无「空调」、
  汇川无「伺服」等）如实保留不美化。
- **Discovery Inspector**（DEV-only）：`lib/discovery/inspector.ts` +
  `scripts/discovery_inspect.ts`。用 runSearch 同一组原语逐级组装，零改动生产代码；
  identity/Top-50 双通道候选/逐候选 corpus 证据/Jev 判分/排除记账/最终排序/期望符号
  消失点 trace，一次搜索可完整复现。
- **Baseline**（真实 Jev jev-1.13.0，82 题 0 降级，中位 509ms）：StrongRecall
  @1=60% / @5=83.1% / @10=84.6%，Expected@10=95.4%，负例题全部诚实低分。
  逐题终审归因 `reports/PHASE3_DISCOVERY_BASELINE/attribution.md`。
- **结论**：题级失败由评估侧（F0/F10 期望集不完整/歧义/边界噪声）主导；真实系统
  瓶颈=corpus 词表粗类目化（F1/F2，如「伺服/检验/脱硫」词面缺失）；无 F3/F5/F6/F8/F9
  主因；F7 一处排除 pattern 与语料措辞脱节（无安全修法，follow-up）。
  **NO SEARCH ALGORITHM CHANGE**——修复方向是数据侧词表管线（§16），留待后续。

## 验收状态（Phase 3，2026-09-28）

vitest 188/188（+discovery 17 项：schema/符号有效性/证据回指防串证/digest 钉版/
taxonomy 枚举/Inspector 结构与确定性/退役栈零残留）+ python 33/33 + tsc 干净 +
build 通过 + corpus:check 逐字节一致；生产栈 :3400/:8920 健康绿、judge 身份云端核验；
产品 UI 零变化。证据：`reports/PHASE3_DISCOVERY_BASELINE/`（baseline.json+attribution）、
收口报告 `reports/PHASE3_DISCOVERY_CLOSEOUT.md`。

---

# Phase 2 · Company Knowledge Corpus（2026-09-28，分支 atlas/refocus-data-foundation）

数据层加法（产品零变化）：把分散的公司事实整合成统一、可追溯、适合自然语言发现的
语料层，发现索引（检索文本/嵌入/排除模式/Jev judge 输入）整体切换到 corpus。

- **Artifact**：`data/company-corpus/companies.jsonl`（5567 份 CompanyKnowledgeDocument，
  schema 1.0.0，committed）+ `manifest.json`（contentDigest=JSONL 全字节 sha256，
  generatedAt 不入 digest）；向量 `data/vectors_corpus.f32`（5567×512）。
- **Builder**：`scripts/build_company_corpus.ts` 唯一 canonical builder，输入只有
  committed 数据（companies.json + stage3 enrichment），确定性离线，`corpus:check`
  逐字节对账并进 CI。主题派生复用 `search/profile/derive`（同一实现、同一 DF 闸门），
  没有第二套规则代码。
- **纪律**：缺失就是缺失（concepts 全空如实为 0）；主题必须证据回指；排除标签规则
  在案只服务「不要X」；无公告语义（P1 留白待真实使用）、无研报观点、无 LLM 富化。
- **迁移**：Jev 代码零改动，judge/检索/排除共读 corpus searchableText；装载全有或
  全无（缺件整体回落 legacy 层并如实标注）；search log 如实记
  `corpusSchemaVersion/corpusContentDigest16`，retrievalVersion=`v3-rrf60-corpus`。
  设计文档：`docs/COMPANY_KNOWLEDGE_CORPUS.md`。

## 验收状态（Phase 2，2026-09-28）

vitest 171/171（含 corpus 8 项不变量：全 5567 家逐字段回指防串号）+ python 33/33 +
tsc 干净 + build 通过 + CI 增 corpus:check；确定性重建逐字节一致；真实 Jev 16 题
（6 回归 + 10 新题）全部 `decidedBy=jev` / `degraded=false`，6 道回归题 5 道 Top1
不变、「机器人」Top1=宇树科技与 Refocus 冻结记录一致；Journey A/B 浏览器验收 17/17；
生产栈 ：3400+:8920 健康绿、search log 行如实携带 corpus digest。证据：
`reports/PHASE2_CORPUS/`（baseline/post 评测、QA 抽样、journeys）、收口报告
`reports/PHASE2_CORPUS_CLOSEOUT.md`。

---

# Refocus · Data Foundation（2026-09-28，分支 atlas/refocus-data-foundation）

一次产品方向纠正（不视为普通 Phase 5）：**先恢复产品纯粹性，再慢慢做加法。**

## 产品

A-Atlas 收敛为一个工具：**用自然语言，在整个 A 股公司池中发现公司。**
只有两个面：发现 `/`（物理堆 + 搜索）与公司 `/stock/:symbol`（单页纵向阅读的公司卡：
为什么匹配 → 简介 → 主营业务 → 市场快照 → 基础财务 → 最近公告 → 最近研报，无 Tab）。
`/market` `/research` `/my` 与全部 Vibe 产品面（DeepDive/Daily Review/Backtest/Journal/
Risk/模式卡/myreports/watchlist/portfolio/AskAI/job UI/事件概率/历史统计/盘中核验/资讯雷达）
已删除，旧 URL 如实 404。

## 运行时

```text
Browser → A-Atlas Web :3400 ── /api/search ── Jev Cloud（唯一 judge, jev-1.13.0）
                        └── 公司页 ── a-atlas-data :8920（services/stock-data）
                                            └── a-stock-data generated（vendor/a-stock-data @ f814dcf, v3.10.0）
                                                → 腾讯 / 新浪 / 巨潮 / 东财
```

- Harbor spec：`A-Atlas = Web(:3400) + Data(:8920)`（Harbor 仓 d9e5b0b）；`:8910` Vibe Research 已退役且不再被任何代码引用。
- 数据纪律：canonical 6 位码（StockIdentity）→ 服务内转前缀；TTL 缓存（30s/6h/30m/1h）；
  契约 `lib/stockdata/contracts.ts` 四类；EMPTY/UNAVAILABLE/ERROR 三态如实渲染；provenance 轻量可见。
- 抽取：`scripts/extract_stock_data.py`（唯一 def 块 + AST 剪示例）→ `services/stock-data/generated/`，头部带 upstream commit；`vendor/a-stock-data/VENDOR.md` 是同步流程。

## 删除了什么（出处链）

- `services/vibe-research`（185 跟踪文件 + .venv）、`app/api/atlas`（27 BFF 路由）、
  `lib/atlas/research`、components/atlas（23 文件）、market/research/my 页、
  Vibe 测试与 phase 走查脚本、CI 的 vendor job。
- 完整逐项处置表：`docs/VIBE_REMOVAL_INVENTORY.md`。历史证据（Phase 0–4 报告、tags、
  `docs/A_ATLAS_*.md` 加 RETIRED 标注）原样保留；用户数据（`data/user/`、
  `~/.duanxian-agents/`、`~/.vibe-astock-agent/`）一律未删，只停止引用。

## 验收状态（2026-09-28）

vitest 163/163 + python 离线 33/33 + tsc 干净 + build 通过；
六题真实 Jev 回归全 `decidedBy=jev` / `degraded=false`（光刻胶/谐波减速器/机器人/半导体设备/热管理/复杂句）；
a-stock-data 五板样本（600519/688138/000001/300750/920808）quote+fundamentals 全 ok、
公告/研报按源覆盖如实返回；Journey A/B 浏览器验收 17/17（`reports/REFOCUS/`）。

---

（以下为 Phase 0–4 历史记录，未经改写。）

阶段：第五阶段（Stage 3 半导体工艺知识层）。搜索 Universe 覆盖全部 A 股（约 5,5XX 家），画面物理池固定抽样（`PHYSICS_POOL_SIZE`，默认 300）。

## 产品

自然语言从公司堆里捞公司。视觉是 Matter.js 物理堆，搜索后匹配牌子浮到搜索框上方的格子里。牌子只有简称和代码（放大牌多一行申万一级行业），分数写成「匹配度 NN%」。

## 现在有的

- 数据：AkShare → `data/raw/`（不提交）→ `data/companies.json` + `data/vectors.f32`
- **Search Profile V2 知识层（2026-09-23）**：`search/ontology/`（六维本体 TS 源：产业链角色/应用场景/半导体细分/热管理细分/机器人细分/商品敞口梯子 + 3 条保守负向概念；JSON 是生成物）→ `search/profile/`（derive 引擎：词面命中带证据+规则+版本+置信；每家 5 行 provenance 指 raw 快照）→ `data/search_profiles_v2.json` + `vectors_profile_v2.f32` + `data/search_index_manifest.json`（版本五元组+快照 sha）。UNKNOWN 不当 0；泛化标签 DF>5% 不进检索文本；排除硬过滤只打 judgeText（防负向标签行自命中）。命令：`search-profile:build / :build:incremental / :vectors / :validate / :update`；`SEARCH_PROFILE_EDITION=v1` 钉旧版做 A/B。基准（同 Laya V3 成对复测）：检索 R@200 0.357→0.363、铜链族 +0.11/机器人族 +0.10，rerank MRR +0.057、ExclViolation -0.026、P@10 持平 —— V3 reranker 成为主要瓶颈，报告 `reports/SEARCH_PROFILE_V2_*.md`
- **Stage 3 半导体工艺知识层（2026-09-24）**：Tier1 年报证据管线 → 结构化工艺能力 → Profile v3。`data/enrichment/semiconductor/`（universe 814 家=A187/B320/C307 + evidence.json 1.7MB + enrichment.json 175 家有能力）← `data/sources/semiconductor/`（181 份 FY2025 年报 PDF,0.47GB,gitignore;manifest 记 SHA/URL/披露日;cninfo 被限流→东财镜像 curl 通道）。派生全确定性规则(`search/knowledge/semiconductor.ts`, s3-derive-v1):窗口→能力,带 定义句/分类学/公司锚定/材料供给侧/光伏标签隔离 守卫,10 题单测锁纪律。Profile v3=schema 2.1.0+domainKnowledge+searchText「工艺:」行(同一 5% DF 闸门);ontology v2.2(29 规则);editions v1/v2/v3,生产默认 v3,`SEARCH_PROFILE_EDITION=v2` 钉旧。命令 `stage3:* / search-profile:*:v3`;评测 `eval_profile_ab --a=v2 --b=v3` + `stage3_ranking_ab`。同 V3 checkpoint(419daa88) A/B:87 题工艺基准 R@200 0.671→0.900、rerank P@5 +0.044/MRR +0.087/R3@200 0.663→0.916/ProcessSpecificRecall@20 0.014→0.208;203 题零回退;设备三族回血(EQUIP2 0.70→0.90 超V1)。残留:部件厂带下游设备词的少量误标(evidenceId 可审计)、reranker 仍是瓶颈(V4 靶向数据已就位)。报告 `reports/STAGE3_*.md` 七份
- **Search Log（2026-09-23）**：生产 `/api/search` 每次真实搜索 append-only 落 `data/search_log/search_log.jsonl`（eval 不落）；一条 SearchRun = QuerySpec + 版本五元组 + 逐层耗时 + Top200 逐层分数（bm25/vector/rrf/grade/matchedMust/排除命中/硬过滤拦截名单）+ Top20；写入失败不影响搜索；缓存命中也记（cached:true）。命令：`search:inspect -- <searchId>`（重放+Stage3 知识链）、`search:export-review`（自包含审计 JSON→`reports/search-review/`）、`search:health`（RepeatOffender/ScoreCollapse/ExclusionFailure/PROFILE_GAP/RANKING_FAILURE→`reports/search-health/`）。设计/验证：`reports/SEARCH_LOGGING_*.md`
- 名单：交易所 A 股列表（沪深主板、创业板、科创板、北交所；不含 B 股、基金、债券、退市证券、新三板）。ST/\*ST 保留
- 申万一级行业：申万宏源「申万指数」成分表（akshare `sw_index_first_info` + `index_component_sw`，**2021 版，31 类**）。只做这一种口径；申万指数不含北交所、次新未入类 → `swLevel1Industry: "unknown"`，不用东财/同花顺/证监会行业冒充
- 抓取分片：`fetch_companies.py --shard i/n` 多进程跑（akshare 在 cninfo/eastmoney 调用里各建一个 py_mini_racer V8 实例，同进程并发会撞 V8 池初始化直接 FATAL，必须每进程串行）
- 召回（V3）：QuerySpec（`lib/search/querySpec.ts`+`data/search_ontology.json`，确定性，排除条件在代码）→ 扩展查询 → searchProfile 文本 BM25 ⊕ bge 向量（`data/vectors_profile.f32`，底文=judgeText+派生标签行）RRF → 本体排除/海外占比硬过滤 → Top200
- 判断（V3）：Laya V3 score 头 graded 0-3（`judgeGraded`，仅 laya 后端）；noul fallback；TypeSafe key 存在时行为与 V2 一致
- V3 报告：`reports/LAYA_V3_*.md` 六份（审计/检索/QuerySpec/训练/盲测/总）；内部基准 `data/eval/v3_search_benchmark.jsonl`（held-out 问法零训练接触），Q01-Q20 错例按规格入训、复跑按 post-hoc 解读
- 物理：固定 1/180s 子步、睡眠、弹簧上浮、匹配之间不互撞、拖拽
- 堆高控制（搜索框顶下方 60px 为净空线）：三层——池抽样（`PHYSICS_POOL_SIZE`）、牌面预算（`CompanyFloor.tsx` 的 `PILE_AREA`=0.285，除以 ASPECT 按真实牌面积算）、governor（每秒量睡稳堆顶，越线整体缩牌唤醒重压实；只缩不放、3s 冷却、20px 滞回）。定标/验收 rig `scripts/measure_pile.mjs --verify`（headless Edge，N 用 `PHYSICS_POOL_SIZE=…` 起 server；~~必须用 `localhost`~~ 2026-09-27 起 `next.config.ts` 已加 `allowedDevOrigins: [127.0.0.1, localhost]`，两个 host 都能 hydrate——此前 `127.0.0.1` 被 Next 16 dev 跨域守卫拦掉 dev chunk，症状是 SSR 正常、无报错、页面永不 hydrate）。实测：静态浇注全部过线且余量大；盖搜索框的堆是多轮搜索落回的牌反复再浇注累出来的，由 governor 兜住
- 主题：`classic`（米白基线，原样保留）/ `sw-industry`（同一张米白卡上加极轻的申万一级行业色偏）。`components/floor/theme.ts` 的 `SW_LEVEL1_COLOR_MAP`，左下角切换，localStorage 记忆，默认 classic
- Universe/池分离：搜索覆盖全池；堆是稳定种子抽样；命中公司不在池里时动态注入刚体，松手落回堆里

## 明确不做

海獭、持仓、交易、投资建议、Logo、OCR、实时股价、涨跌幅、K线、财务、市值颜色、概念颜色、筛选器、产业链图谱、投资评分。

Harbor（2026-09-23 用户决定，修订原「不接 Harbor」边界）：仅作为**应用登记宿主**——Harbor 注册表（`desktop/src/services/apps.ts`）按 `AppRuntimeSpec` 拉起/探活/停止本项目的两个组件（next dev 7488 + laya sidecar 8787）。仅此而已：不交换数据，本项目不读 Harbor 状态，`/api/health` 与 sidecar `/health` 的 `service` 字段是 Harbor ADR-008 强身份探针的锚点。

## 无 Jev 时全池召回基线的落差

200 家时代无 Jev 召回基线是 8 条验收过 6 条。扩到全池后干扰项按数量级涨：小模型 embedding + bigram 词面会把 ST/跨界公司顶进 top10，top-10 命中验收在 1.4k 池上落到 2/8。这不是回归，是 Jev 缺位的代价在放大（每条验收需要的公司仍大多在候选里，只是排不进前十）。路径不变：召回上限很宽（240 进判断），判断由 Jev 做——有 key 后重跑 `npm run eval` 看 Jev 能不能把它拉回来；拉不回来再考虑行业桶整桶送判。

## Laya（本地判断）现状

Laya（开源判断模型，TypeSafe 的开源对标）2026-09 探测过一轮。接口已接通：`scripts/laya_server.py` 把它包成相同的 `/v1/systemone` 线格式，classify/judge 代码不区分后端，TS 侧只多了 `LAYA_URL` 路由和 `jevSource: "laya"`。但 `multilingual` 检查点不能当判断用：noul 在 272 条验收标注上 AUC 0.502、全题饱和 1.0，温度 1→24 无一可救（sidecar 现在会拒绝这种无散布的回答，退回 mock）；choice 头可用但选项被 48 token 截断，排序弱于检索本身；CPU 延迟也到不了 classify 8s / judge 12s 的预算。

**2026-09-23 微调已落地**：按官方 RLCD 方法在本机 RTX 4060（torch cu130）上训出 A 股专用模型 `models/a-share-laya`，冻结 TEST（59 题/921 行，`data/eval/a_share_laya_eval.jsonl`，与训练零 family 交集）上 noul AUC **0.526 → 0.666**（V2，两轮靶向数据），行业词查询 0.85+，合取/比喻类还弱。`npm run laya:base`（原版）vs `npm run laya:ft`（微调）可 A/B，线格式与 TS 侧零改动；报告在 `reports/LAYA_A_SHARE_FINAL_REPORT.md`，模型卡在 `models/a-share-laya/MODEL_CARD.md`。两个坑记下：(1) laya 库 `_to_internal` 默认把中文 instructions 转成 `\uXXXX` 转义，token 膨胀且模型学不到东西——sidecar 现在用 `ensure_ascii=False` 预序列化（线格式不变），训练与推理才逐字一致；(2) Windows 上 Defender 会锁刚写完的 safetensors，训练保存必须「唯一 tmp 名 + 退避重试」。剩余短板（汽零+出口这类合取、比喻、品牌 vs 代工）是数据规模问题，按 `scripts/laya_lab/topics_train.py` 加 family 重跑 `build_train_pairs → build_laya_items → train_laya` 即可。

**默认 checkpoint = latest（2026-09-23 起）**：`npm run laya` 不再默认原版 multilingual，而是解析 `models/` 下 `a-share-laya-vN` 取最大 N（无版本目录回退首个微调 `a-share-laya`，再不行回退 multilingual）。`.env.local` 已设 `LAYA_URL`（gitignore 内，本机文件），跑起来即「V3 + graded score 头」。训 V4/V5 只要沿用 `train_laya_v3.py --out models/a-share-laya-v4` 的命名，重启 sidecar 自动接管，配置零改动；要钉旧版本用 `laya:base` / `laya:ft` / `laya:v3`。

`judgeTextEn` 全是空。`npm run eval:lang` 会先数覆盖率，没有英文文本就不跑对照，判断继续读中文。

## Product Evidence Layer（Product Telemetry v1，2026-09-27 起）

生产可观测层已落地，运行契约（规格 §47）：**服务能返回 200 ≠ 服务正确**。真正 Ready = health ok + actual reranker SHA 契约一致 + knowledge tuple 契约一致 + manifest 不 stale + telemetry 可写。`npm run telemetry:status` 一眼核对（actual SHA 必须来自 sidecar 实答，不许只报 expected）。

- 事件流：`data/telemetry/events/YYYY-MM-DD.jsonl`（append-only、best-effort、写失败只进 stderr+计数，永不阻塞搜索）；事故独立落 `data/telemetry/incidents/incidents.jsonl`（双写进事件流）；日汇总 `rollups/`（tmp→fsync→atomic rename）；研究导出 `exports/`。
- 三 ID 关联：`appRunId`（进程生命周期）/ `sessionId`（浏览器 30min 空闲过期，sessionStorage）/ `searchId`（与 `data/search_log/search_log.jsonl` 同值同源）。schemaVersion=1。
- sidecar 自证身份：`/health` 新增 `checkpointPath/sha16/pid/startupMs/cuda/vram`（additive，`service` 锚点未动）；启动写 SIDECAR_* 事件（含 SIDECAR_IDENTITY_VERIFIED 自证 SHA16）；`models/` 目录自身 SHA 由 laya_identity.py 流式计算。
- Next 启动自检序（§46）：telemetry 可写 → APP_START → 端口占用（netstat→owningPid）→ 上轮 crash recovery → manifest loaded-vs-disk → profile/vectors SHA16 → sidecar identity 探测（含 mismatch→MODEL_IDENTITY_MISMATCH 事故，V4.2 candidate 漂移可点名）→ APP_READY → 5min 心跳（30min 空闲暂停）。
- organic 资格（§31）：UI 默认 `requestOrigin=organic_ui→CANDIDATE`；developer/smoke/benchmark/replay/api 自报排除类；缓存命中 EXCLUDED_CACHE；query 带 U+FFFD/控制符 = EXCLUDED_CORRUPT + CORRUPT_QUERY_CAPTURE 事故（乱码 query 会「正常」返回垃圾结果，见 VALIDATION 报告的首跑实录）。
- detectors 只产 SUSPECT（§29/§30/§42）：CMP 材料入侵、family-noun 角色入侵、BM25/VECTOR 空、filter overdrop、rerank timeout/retry、exclusion failure、ranking failure、repeat offender 等 20 类——只检测不修排名、不判 root cause、无综合评分。
- 命令：`telemetry:status / telemetry:inspect -- <searchId> / telemetry:export -- --since 7d [--redact] / telemetry:health / telemetry:rollup`。
- 不变量：本轮零训练、零 checkpoint 变更、V4.2 仍只是 frozen candidate（727a685c 不许上岗）；telemetry 不是 truth source，到训练数据必须经 Inspect→Root Cause→Review→Candidate Queue。

---

# A-Atlas Phase 2（2026-09-27，atlas/phase-2 分支收口）

Vibe AStock 后端原样 vendor 为 `services/vibe-research/`（Apache-2.0，偏差 3 处见其 README-ATLAS.md），
:8910 独立进程 = Research Backend；浏览器经 BFF `/api/atlas/*`（lib/atlas/research：九码错误模型/
canonical symbol/短缓存/来源时间戳）访问，React 不感知 8910。公司页七 tab（概览/财务/估值/资金/
事件/资料/AI研究）+ DeepDive job 全生命周期 + /market 六分区 + /research 任务入口 + /my（自选/笔记
迁 data/user/ 持久层，legacy 显式导入；持仓=成交日志聚合透传）。Harbor 注册 a-atlas 双受管组件
（web/research），laya external。验收：vitest 7/7、活栈契约 61/61（14 家×4 端点不串号+U+FFFD 守卫）、
浏览器走查 36/36（DeepDive 43s 全生命周期+刷新恢复）。pytest baseline：上游 993✓/28 环境失败，
vendored 零回归。报告 `reports/PHASE2_*.md`。

---

# A-Atlas Phase 2 正式冻结（2026-09-28，tag A_ATLAS_RESEARCH_CORE_COMPLETE）

| 项 | 值 |
|---|---|
| 冻结 HEAD（tag 所指） | `03683a8`（master，= atlas/phase-2 的 --no-ff merge commit；PHASE2_CLOSEOUT §M commit 数已修正为实际 10 个） |
| Laya | 生产 sha16 `2742affc3f677d71`（V4.1，:8787 external，双 Laya 禁令有效；V4.2 727a685c 仍为 frozen candidate） |
| Research vendor upstream | `D:\workspace\vibe-astock` main@`bd96df4`（v1.1.3，clean，vendor 零回归） |
| Capability Matrix revision | `docs/A_ATLAS_CAPABILITY_MATRIX.md` @ `b9148d6`（Phase 2 收口 §7，39 项逐项标记） |

下一阶段 = Phase 3（SERVICE-LIVE 能力收敛为原生体验：回测/盘中核验/历史统计/事件概率/
Journal/Risk/Mode/MyReports UI 点亮 + 统一 AI 入口与显式上下文 + 真实 provider 验收 +
BJ fallback + Windows CI + vendor 测试 ownership 四分类）。冻结边界：Phase 2 已建立的
Discover Engine / canonical StockIdentity / BFF / Vibe Research Service / Company Page /
Market Workspace / My Workspace / DeepDive lifecycle / multi-service Harbor contract
不得重新设计。

---

# A-Atlas Phase 3（2026-09-28，atlas/phase-3 分支）

目标兑现：SERVICE-LIVE 能力收敛为 A-Atlas 原生体验。事实由数据与确定性程序提供，
AI 只解释、研究和组织证据；发现是入口，公司是核心，市场和研究是纵深。

- **Phase 2 冻结**：tag `A_ATLAS_RESEARCH_CORE_COMPLETE` @ 03683a8（PHASE2_CLOSEOUT commit 数修正）。
- **Harbor 收口**：同 dirty worktree 按 ownership 拆两笔——inkwave 注册 fa5e8c3（他人成果，
  原样收口+断言文件中间态在后续 commit 终定）、a-atlas 注册 5568718 系（dual-managed web+research、
  laya external、research 组件独立 health）。436 测试全绿 + 隔离 smoke exit 0；活栈三服务
  health 身份实测（a-atlas-web / a-atlas-research / a-share-laya-sidecar）。
- **真实 provider 验收**：codex 订阅登录态共享到引擎隔离 home（auth.json 复制），
  `codex-private/gpt-6-astra`。DeepDive 688138 全流程 115s，七项检查全过（身份/数字溯源/
  冻结证据 SHA/正反同资料/风险/无买卖指令/ai_source）；第二样本 600519（ci_smoke 彩排）。
  首份真实复盘归档 2026-09-24（204s，target=trade=expected 日期无混淆，降级缺口如实 warnings，
  report_grounding references_validated + input_revision SHA）。fixture 在 reports/PHASE3_RUNTIME/。
- **UI 点亮**（SERVICE-LIVE→UI-LIVE 8 项）：盘中核验/历史统计/事件概率/回测全流程
  （AI 整理条件→确认→确定性执行→报告+导出+免责）/Research Workspace/风控/模式卡(交易方法)/
  研报资料；Journal 全功能记账（写后 journal+positions 双刷新=持仓派生可见）；
  公司页加入自选+研究动作+牌面右键自选+报告追问；统一 AI 入口=AtlasAIContext 显式上下文
  + AskAIPanel（上下文 chip 亮明 AI 正在读什么）。
- **北交所行情真因**：Phase 2「腾讯无 BJ 覆盖」实为 vendor get_prefix 前缀 bug（92 误归 sh）。
  修正后腾讯对 BJ 全覆盖（quote+valuation 同链路解锁）；东财单股 fallback 作为真实兜底
  （vendor 偏差 #4 已登记，行级 source + meta.fallbackUsed 如实标注，不合成行情）。
- **CI + 测试 ownership**：windows-runtime 三 job（web/research-strict/live-stack smoke）；
  vendor pytest 86 失败逐条定类冻结（FRONTEND 58 / ENVIRONMENT 27 / COMPAT 1），
  vendor_pytest_ci.py 未归类失败=红，清单转绿=DRIFT 提示。
- **验收**：vitest 154/154、typecheck 干净、活栈契约 local scope ALL PASS、
  ci_smoke 17/17、浏览器四旅程 36/37 + 自选转变受控探针 5/5（唯一未决为走查状态污染，
  非产品缺陷）。性能只测不追数：公司页 SSR p50 18ms、Market HTML 7ms、job poll 5ms、
  accept 14ms、BFF quote p50 479ms（腾讯穿透波动 203-682ms）。
- 运维教训：laya sidecar 在多真实 LLM 任务并发期间进程死亡（:8787 失联、GPU 释放），
  按生产 default 重启（V4.1 2742affc，PID 39600）——再次验证 detached 常驻服务需开工检查。

---

# A-Atlas Phase 3 正式冻结（2026-09-28，tag A_ATLAS_PRODUCT_CONVERGENCE_COMPLETE）

| 项 | 值 |
|---|---|
| 冻结 HEAD（tag 所指） | `b4408a4`（master，= atlas/phase-3 的 --no-ff merge commit） |
| Harbor HEAD | `5567381`（master，clean） |
| Research vendor upstream | `D:\workspace\vibe-astock` main@`bd96df4`（v1.1.3，clean，vendor 零回归） |
| Capability Matrix revision | `docs/A_ATLAS_CAPABILITY_MATRIX.md` @ `c1c5b3a`（§8 Phase 3 收口逐项状态） |
| Jev 配置（冻结时刻） | 未启用：`a-atlas/.env.local` 的 `TYPESAFE_API_KEY` 为空，判断走本地 Laya（`judge:"laya"` 实测） |
| Research service | :8910 常驻，`GET /api/health` 200（canonical；`/health` 是 404），v1.1.3 |

四仓 clean：a-atlas / harbor / vibe-astock clean；**a-share-trawler dirty（10 项，他人模型竞赛实验在制品）**——
按 Phase 4 §4 原样不动。详见 `reports/PHASE3_FREEZE.md`。

下一阶段 = Phase 4（Jev Cloud Cutover & Production Hardening）。冻结边界：Discover Engine
（QuerySpec/BM25/vector/RRF/ontology/Top200）、canonical StockIdentity、BFF `/api/atlas/*`、
Vibe Research Service、Company / Market / My、DeepDive lifecycle、Harbor 多受管组件契约
不得重新设计。Phase 4 只换判断智能 provider（Laya→Jev Cloud）与运行时稳定性。

---

# A-Atlas Phase 4（2026-09-28，分支 atlas/phase-4）— Jev Cloud Cutover & Production Hardening

功能整合期结束。本轮只做两件事：判断智能换到 Jev Cloud，以及把运行时加固到可长期常驻。
收口报告 `reports/PHASE4_CLOSEOUT.md`（A-Q 十七节），切换细节 `reports/PHASE4_JEV_CUTOVER.md`。

## 架构分叉（正式冻结）

```
A-Atlas      → Jev Cloud（唯一 judge；没有 Laya 回落，也不允许加）
a-share-trawler → Laya Local（:8787 sidecar、models/、V4.1 checkpoint，全部归它）
```
两个项目共享历史，不共享运行时。A-Atlas 本地 runtime 只有两个组件：
**Web :3400（managed）+ Research :8910（managed）**；Jev 是外部云能力，不是本机进程，
不进 Harbor Inspector 的 component 列表，GPU/VRAM 不再是运行时要求。

## 判断 provider

- `lib/jev/provider.ts` 契约 + `CircuitBreaker` + `JEV_TIMING`；`lib/jev/cloud.ts` 的
  `JevCloudProvider` 是唯一实现（`lib/jev/client.ts` 双路由点已删）。
- env：`TYPESAFE_API_KEY`（唯一 key 来源）/ `JEV_MODEL`（别名）/ `JEV_DETAIL` /
  新增 `JEV_BASE_URL`（只为 CI 与故障注入指向 `scripts/jev_stub.mjs`）。`LAYA_URL` 全删。
- 生产头是 **noul 二分类**：冻结盲测 Jev 是/否 95.8%/NDCG 1.000 > Jev 四档 90.0% >
  Laya V4.1 四档 82.5%，所以没有把 Laya 的 graded 头继承过来（`judgeGraded` 只留离线对照）。
- 在岗身份 = 响应体里的 `jev-1.13.0`（`identityProbe()` 启动真打一次），别名不算身份；
  漂移即 `MODEL_IDENTITY_MISMATCH`。这是 §47「actual 必须来自答题者」在云上的等价物。
- 预算全部实测（`npm run jev:baseline`，真实 Top-200 池 45 次）：connect 2.5s / request 4s /
  rerank 总预算 6s / classify 3.5s；单批延迟几乎与批大小无关（10→100 候选 271→370ms），
  200 候选 p50 539ms、p95 1358ms；并发 8 零 429 但超 4 之后云端自己排队 ⇒ `maxInFlight 4`。
  retry 2 次尝试 + jitter + Retry-After；breaker 3 连败→OPEN 20s→HALF_OPEN 1 探针（401 直接 60s）。
- 成本实测 ≈61k tokens、**$0.0026 / 次真实搜索**；聚合与延迟分位数在 `/api/runtime` 可读。

## 降级语义（§10/§11）

没有 key 或云端故障 ⇒ `degraded=true`、`decidedBy="retrieval"`、`judge.outcome=<原因>`，
UI 一行克制提示「语义判断服务暂不可用，当前结果使用基础检索排序」。`decidedBy:"mock"` 这个取值
被删除——「mock」不是事实，事实是检索基础排序。A-Atlas 仍然可以启动、可以搜索，
Company/Market/Research/My 完全不受 Jev 影响（§24 实测）。

## Laya 解耦证据

结构断言（13 个运行时文件不得出现 `LAYA_URL|LAYA_CHECKPOINT|layaUrl|8787|laya_server|from "..laya"`）
+ 行为断言（6 次真实搜索期间 A-Atlas 进程到 :8787 连接数 = 0，同时刻 :8787/health 仍 200）。
删除：sidecar 健康探测与启动依赖、`rerankerSha16()`、`lib/search/modelVersion.ts`、GPU 心跳、
双 Laya 禁令（前提消失）、CI 的 LAYA_URL 与 laya unittest 套件、`laya*` npm 入口。
保留：`scripts/laya_*`、`laya_lab/`、`kaggle_laya_finetune/`、`reports/LAYA_*.md` 作出处链；
其中 7 个会经 `lib/jev` 打到云、却自称在测 Laya 的脚本由 `requireLayaLane()` 拦下。
a-share-trawler：HEAD `e9869ff` 未动，dirty 条目与冻结时逐字相同。

## 稳定性收口（P0 两条真因）

- **Research 间歇 502**：东财 push2 成波 reset + akshare 绕开本仓自己的节流/session/timeout +
  `/api/info` 无缓存 + BFF 只缓存成功 ⇒ 公司页 16 并发块把一次坏波放大成持续 502。
  修：`_cached_stale()`（陈旧兜底 + 被拒后 30s 不再打源，头标注 stale）、`_em_slot()` 节流 +
  `timeout=10`、`timeout_keep_alive=30`、错误按 `layer=bff|research|upstream` 分层、
  rid 端到端（中间件必须写在 `server.py`——`_merge_vr_routes` 只并路由不并中间件）。
- **自选 44s**：不在服务端（写入 8-11ms，POST 路径零行情调用）。是 HTTP/1.1 + Chromium 单 origin
  6 连接的队头阻塞：公司页并发只读慢 GET 把写请求排在后面。修：浏览器侧只读车道限 4，
  写操作走独立通道。基准 100×add/remove 五条件下 max 从 ~44000ms 降到 ≤193ms。
- **任务排队**：vendor 全局锁保留（共用 codex-home，理由是真的），只加 `TaskBusyError`→409 词汇；
  A-Atlas `admission.ts` 把 409 变 QUEUED，用原 request_id 重放（幂等，不会双开），
  队列落盘可跨重启，界面不再出现「global task lock held」。§32 结论：本轮不给回测执行开第二槽
  （标量 `current` 会互相覆盖 + 执行期仍联网），记为 follow-up。

## 验收状态

vitest **188/188**、`tsc` 干净、`tests.test_vr_bj_quote` 4/4、CI 拓扑本地全量彩演
（`assert_jev_stub` 25/25、contract check local ALL PASS、`ci_smoke 17/17`）、
混沌四旅程 **24/24 PASS**、真实 Jev 六题验收集全 `decidedBy=jev`。

**未做/待办**：GitHub hosted Windows runner 未跑（本仓无 GitHub 远端，`gh` 未登录）；
真实 DeepDive provider（codex-private）当前返回「AI 请求失败…额度/登录态」需恢复后重跑；
Harbor UI 需重启才反映新 spec。详见 `reports/PHASE4_CLOSEOUT.md` §Q。

---

# A-Atlas Phase 4 正式冻结（2026-09-28，tag `A_ATLAS_JEV_PRODUCTION_READY`）

## 长期架构（本次冻结写入，取代此前一切 Laya 运行时描述）

- **A-Atlas Discover = Jev Cloud**：唯一 judge（`https://api.typesafe.ai/v1/systemone`，
  契约 `jev-1.13.0`，`identityProbe()` 在岗核验，别名不算身份）。没有 Laya 回落，
  也不允许加；云端故障/无 key ⇒ 确定性检索排序如实 DEGRADED。
- **A-Atlas runtime = Web + Research**：只有 Web :3400（managed）+ Research :8910（managed）
  两个受管组件；Jev 是外部云能力，不进 Harbor Inspector 的 component 列表，
  GPU/VRAM 不再是运行时要求。
- **A-Atlas 不依赖 Laya / :8787**：结构断言（13 个运行时文件零
  `LAYA_URL|LAYA_CHECKPOINT|8787`）+ 行为断言（6 次真实搜索期间到 :8787 连接数 = 0）。
- **a-share-trawler 独立继续使用 Laya V4.1**：:8787 sidecar、`models/`、checkpoint
  全部归它，V4.2 仍只是 frozen candidate；其模型竞赛实验（Laya vs Jev 同题）在它自己的
  dirty worktree 里继续，与本仓运行时无关。
- **两项目共享历史，不共享运行时**：本仓只保留 `reports/LAYA_*.md` 与 Laya 脚本作
  历史出处链（会经 `lib/jev` 打到云、却自称在测 Laya 的 7 个脚本由 `requireLayaLane()`
  拦下）；a-share-trawler 是 Laya lane 的现役仓库。

| 项 | 值 |
|---|---|
| 冻结 HEAD（tag 所指） | `1ab5b8c`（master，= atlas/phase-4 的 --no-ff merge commit） |
| Harbor HEAD | `c5678e3`（master，clean；A-Atlas 规格已去 Laya 化=两 component 运行时） |
| Research vendor upstream | `D:\workspace\vibe-astock` main@`bd96df4`（v1.1.3，clean，vendor 零回归） |
| Capability Matrix revision | `docs/A_ATLAS_CAPABILITY_MATRIX.md` @ `2d164dc`（§47 Phase 4 逐项状态） |
| Jev 配置（冻结时刻） | `TYPESAFE_API_KEY` 已配置（`.env.local`，唯一 key 来源）；`JEV_MODEL` 未设 → 别名 `jev-latest`，在岗应答 `jev-1.13.0`，identity verified、breaker closed |
| 运行时（冻结构建实测） | Web :3400 healthy + Research :8910 ok v1.1.3（生产构建=冻结 HEAD）；:8787 是 a-share-trawler 的 Laya sidecar（外部进程，A-Atlas 零连接） |
| Inspector 两组件验收（Harbor 重启后） | A-Atlas 卡片恰两组件：A-Atlas Web :3400（ready/owned/运行中，PID 49772）+ A-Atlas Research :8910（ready/owned/运行中，PID 43372），**Jev 不在 component 列表**；app 裁决 `current`（workspace=runtime=`54dd71f:a8e37b8`，身份记录持久化于 Harbor `runtime-identity.json`）。ensure-current 全链路真实执行：`next build`（生产）→ 停旧 → 启新 → 健康探针（expectService a-atlas-web / a-atlas-research）→ 记录身份；`/api/health` judge jev-1.13.0 verified、breaker closed |

四仓状态：a-atlas（master，冻结提交后 clean）/ harbor / vibe-astock clean；
a-share-trawler dirty（10 项，模型竞赛在制品）——按 Phase 3 冻结以来政策原样不动。

## Operational follow-ups（保留，不阻塞冻结）

1. **补跑真实 DeepDive**：Codex provider（`codex-private`）恢复后（Phase 4 收口时返回
   「AI 请求失败…额度/登录态」）补跑一次真实 DeepDive 全生命周期验收。
2. **首跑 hosted Windows CI**：建立 GitHub remote 后首跑 hosted Windows CI
   （windows-runtime 三 job：web / research-strict / live-stack smoke）。
