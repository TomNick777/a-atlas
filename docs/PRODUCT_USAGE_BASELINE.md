# Product Usage Baseline（使用基线）— 2026-09-30

**Phase 3.7 `A_ATLAS_EVIDENCE_SURFACE_EXPANSION_2026_09_30 @ 50c32a9` 冻结后，A-Atlas 暂停一切能力扩展
（Evidence Surface / Corpus Source / Query Grammar / Parser / Jev Capability / Judge / Ranking / 通用 LLM / benchmark query）。**

本阶段唯一目标：**开始真实使用 A-Atlas，并完整记录每一次真实搜索发生了什么**，为后续性能、成本、质量和产品体验
改进建立可分析、可回放的事实基础。这是从 Benchmark-Driven Development 切换到 **Usage-Driven Development**
的分界线。

权威报告：`reports/PRODUCT_USAGE_BASELINE/REPORT.md`。冻结 tag：`A_ATLAS_PRODUCT_USAGE_BASELINE_2026_09_30`。

---

## 1. 三条铁律（与既有纪律的关系）

1. **不改变 Intelligence。** 本里程碑零修改：query grammar、parser 行为、Jev contract、Jev prompt/threshold、
   rerank、ranking、corpus 投影规则、evidence ranking、market query 语义、搜索结果业务逻辑。
   允许的只有 telemetry plumbing，且必须通过行为无变化证明：
   `tests/telemetry_usage.test.ts :: "log:true and log:false produce identical business results"`
   ——同一 query 在 telemetry 开/关两种配置下，plan、结果序、概率、judgement、execution 完全相等。
2. **Telemetry 是 observer，不是 participant。** 一切写入 fire-and-forget（`void emit(...)`），append 失败只进
   failure 计数与 stderr（`lib/telemetry/store.ts` 的失败契约，Phase PRODUCT_TELEMETRY 冻结）。
   telemetry 写入失败不得让搜索失败、不得改变结果、不得阻塞、不得触发额外 Jev。
3. **不为 telemetry 增加 Jev 调用。** 所有记录来自已有运行时数据。`JEV_CALL` 事件在**调用点**从 capability
   契约结果（`tokens / costUsd / timings / chunks`，`lib/jev/capabilities/contracts.ts` 的 `CapabilityBase`）
   原样落账——不碰 wire、不在 `lib/jev` 内加 emit、不重放、不补发。

## 2. 存储边界（不变量）

| 位置 | 内容 | 纪律 |
|---|---|---|
| `data/telemetry/events/YYYY-MM-DD.jsonl` | 全部事件（envelope + payload） | append-only、gitignored、可按 traceId/date 重建 |
| `data/telemetry/incidents/incidents.jsonl` | 事件流镜像（incident 类） | 同上 |
| `data/telemetry/rollups/` `exports/` | 日汇总 / 研究导出 | 原子写（tmp→fsync→rename） |
| `data/search_log/search_log.jsonl` | SearchRun v3 高密度行（检索通道、每候选、jev 块） | 与事件流以 `searchId` join |

不污染 canonical corpus（`data/company-corpus/`）与 market canonical data（`data/market/`）；
不影响搜索正确性；Codex 可直接读文件或跑 `npm run telemetry:export`。
不引入 Elasticsearch / ClickHouse / Kafka / Prometheus / 第三方 SaaS——**简单、本地、透明、可查询**。

隐私（§12）：不记录 cookie / token / secret / API key / Authorization。Jev 相关事件只记计数、身份与 outcome；
导出脚本 `--redact` 提供第二道 scrub。原始 query 记录——它是本项目最核心的分析对象。

## 3. Trace 模型（§2/§19.1：每次真实搜索一个 id）

**`search_trace_id` 在 `/api/discover` 入口铸造**（`newSearchId()`，语法 `s_<ts36>_<hex>`，与 search_log 一致），
在任何执行发生之前——因此**缓存重放、corrupt 捕获、market-only、unsupported 全都有 trace**（此前这些路径
完全没有 search trace，是本里程碑填补的最大缺口）。同一 id 贯穿：

```
DISCOVER_RECEIVED（路由层：query/origin/session/缓存/市场身份/reformulation）
  ├─ semantic-only / semantic-first：
  │    SEARCH_RECEIVED → QUERY_PARSED → RETRIEVAL_COMPLETED → RERANK_* → SEARCH_RESPONSE_READY（runSearch 既有事件）
  ├─ market-first：JEV_CALL（executor 自己的调用点，带同一 traceId）
  └─ 全部 order：
DISCOVER_RESPONSE_READY（plan 逐字 + execution 计数/时序 + Top20 快照 + jev 汇总 + jevValue）
SEARCH_RESULTS_VISIBLE / SEARCH_RENDERED（浏览器，含 timeToVisibleResultsMs）
RESULT_OPEN_DETAIL / SEARCH_REQUERY / SEARCH_EDIT_AFTER_RESULTS / SEARCH_CLEAR / SEARCH_STOP
SEARCH_FEEDBACK（§8 轻量反馈）
JEV_CALL（每个 capability 调用一条）
incident 类：SEARCH_FAILED / JEV_UNAVAILABLE / SEARCH_TIMEOUT / RATE_LIMIT / CIRCUIT_OPEN / …（既有词汇）
```

`/api/search`（API 直连面）同样入口铸造 traceId；`/api/explain` 的两次 Jev 调用（explanation / comparison）
各记一条 `JEV_CALL`，explanation 挂在产生 judgement 的 discover searchId 上（答案仍在缓存时）。

**Identity 块**：每个 event envelope 自带 `appRunId / gitHead / runtime.nodeVersion / pid`；
search 级 identity 补齐 corpus 侧（`productionTuple`：corpus schema/digest、retrievalVersion、judge 双身份）与
market 侧（`marketIdentity`：`latestTradingDay` + state digest16，读自 market manifest，全部 discover 搜索统一记录）。
app version = package.json `version`。

**Query family 的诚实口径**：生产 trace 只记录**机械可证**的形状——execution order、capability、
parser route/version、plan 里的 filters/sort/limit/postFilters/comparison、QuerySpec 的 must/should/exclude/concepts/attrs。
**不 import `quality/discovery` 的 family 标签**（production 面零 benchmark 知识，Phase 3.6 隔离纪律延伸到 telemetry）。

## 4. Execution / Cost / Value / Snapshot（§3-§6）

- **Latency 拆解**（全部已有计时照记，不重构搜索架构）：
  - 路由级：`serverMs`（/api/discover）、浏览器 `timeToVisibleResultsMs`；
  - discover 级：`parserMs / semanticMs / marketMs / mergeMs / totalMs`；
  - pipeline 级：`queryParseMs / retrievalMs / rerankMs / fusionMs` + 检索通道计时；
  - Jev 级：capability `judgeMs / totalMs`。
- **Candidate funnel**：`bm25TopN / vectorTopN / fusedBeforeCap / droppedByHardFilter / candidateCount`（pipeline），
  `semanticCandidates / semanticEligible / marketTotal / marketSetSize / marketPostEligible`（discover execution.counts）。
- **Jev cost（§4）**：`JEV_CALL` = {invocation, capability, contractVersion, runtimeModel, status, outcome,
  subjectCount, decisionCount, chunkCount, answeredChunks, tokens, costUsd(`costEstimated: true`),
  judgeMs, totalMs, retries, timeouts, `cacheHit: false`}。**A-Atlas 没有 Jev 结果缓存，`cacheHit` 如实记 false。**
  tokens 是 capability usage 的精确和；cost 是按冻结价格表的估算——从不伪装成账单。
- **Jev value（§5）**：`computeJevValue(preTop, postTop, jevRemovedCount)` 纯派生：
  `top1Changed / top10Changed / rankingChanged / promotedIntoTop10 / droppedFromTop10 / jevRemovedCount`。
  挂载点：pipeline（semantic 的 pre=检索序、post=最终序，进 `SEARCH_RESPONSE_READY.jevValue` 与 search_log v3 `jev.value`）；
  executor（market-first 的 pre=市场集序、post=最终序，进 `DISCOVER_RESPONSE_READY.jevValue`）。
  Jev 没有真正决定排序时（degraded / skip）——**null，不是 0**。
- **Result snapshot（§6）**：`DISCOVER_RESPONSE_READY.snapshot` = Top20 行
  {rank, code, name, probability, hero(排名解释的市场数值), matchedFacts(≤6), judgement{capability, score,
  matched, relationLabel, evidenceRefs(refs 数组)}}。**refs 是引用标识，不含 corpus 原文**——重建「为什么它排在
  这里」所需的最小充分信息；原文按 ref 从 corpus 现读。

## 7. Interaction & Reformulation & Feedback（§7/§8）

- 交互事件（既有 UI 行为的记录，无新 UI）：RESULT_OPEN_DETAIL（=点击进公司页，payload 带 code/查询/概率）、
  SEARCH_REQUERY、SEARCH_EDIT_AFTER_RESULTS、SEARCH_CLEAR、SEARCH_STOP、SEARCH_RESULTS_VISIBLE。
  点击排名由分析侧 join（事件 snapshot 中按 searchId+code 回查）得到 avgClickedRank / Top1 / Top3。
- **possible_reformulation**：两个独立会话映射同窗口（120s）分组——pipeline 的 `beginSearch`（既有，semantic 路径）
  与 discover 层（新，覆盖全部 order）。**改写组只是研究信号，绝不自动断言前一次搜索失败。**
- **轻量反馈**：结果下方一行「这些结果怎么样？好 · 一般 · 差」+ 可选原因
  （漏掉公司/排名不合理/不相关/太慢/证据不够/其他），闭词表（`FEEDBACK_RATINGS` / `FEEDBACK_REASONS`），
  服务端重建 payload（不信任客户端字段），可完全忽略，每 searchId 记最新评分+原因。

## 9. Cache Observability（§9，先观察不新建）

- 发现答案缓存（`/api/discover` LRU 48）：命中现在有完整 trace（cached:true + replayOfSearchId + 快照照记），
  avoided execution / avoided Jev call 可从同一 trace 推出；/api/search 命中走既有 `logCacheHit`（cacheReplay 行）。
- Jev 结果缓存：**不存在**——`JEV_CALL.cacheHit` 恒 false 是事实陈述。
- parser/corpus/market 的进程内 memoization：无独立观测点，其效果体现在各阶段 latency 里；本阶段不为 dashboard
  设计新缓存。

## 13/14/15. Dashboard / Inspector / Export

| 入口 | 形态 | 说明 |
|---|---|---|
| `/usage?days=N` | 服务端渲染表格（内部，URL 直达，**不进产品导航**） | Search / Latency / Jev / Interaction / Feedback 五节，全部数字由 `lib/telemetry/usage.ts::buildUsageSummary` 单一定义 |
| `/usage/trace/<id>` | 单次搜索全过程重建 | plan/execution/snapshot/jevValue/JEV_CALL/pipeline 时间线/交互/反馈/incident/search_log 行 |
| `npm run telemetry:inspect -- <id>` | CLI | 新事件类型关键词已扩展 |
| `npm run telemetry:export -- --since 7d [--redact] [--format=jsonl]` | 机器可读 | bundle v2 增 `discoverSearches / jevCalls / feedback` 三节；`--format=jsonl` 导出原始事件 NDJSON |
| `npm run telemetry:rollup` | 日汇总 | 既有 |

## 16. Benchmark / REQUIRED_LIVE 成本纪律（自本里程碑起）

- **日常开发：默认 0 次 REQUIRED_LIVE**（除非本次修改确实涉及 Jev 行为）。
- **Targeted validation**：只跑受影响修改的 query family。
- **Milestone**：完整 REQUIRED_LIVE 才跑一次。
- Phase 3.7 的 55×3 结果（NONE 55、relation MATCHED 0.82–0.98、stability baseline）正式冻结为
  **Pre-Usage Laboratory Baseline**——它是「接入 telemetry 前的实验室基线」，不因 telemetry 开发重复消耗 Jev token。
- 升级验收协议不变（同 commit/corpus/market/benchmark 版本重跑 + compare/stability）。

## 17. Usage-Driven Development Rule

> **没有真实 Search Trace、明确用户需求或数据完整性问题支撑的问题，不自动晋升为新的 capability phase。**

已知候选全部进 `docs/OBSERVED_CAPABILITY_BACKLOG.md`（IR/互动面、JS-rendered 官网、Jev synonym bridge），
等待真实使用数据证明其影响后再决定是否立项。发现问题：**记录，不顺手修**——除非它阻止 Usage Baseline 本身成立。

## 18. Baseline Period

不规定人工查询数；**禁止制造假使用**。正常使用，自然积累；样本足够后做第一次 Product Usage Review
（最多/最慢/最贵查询、reformulation 频发段、零点击结果、低排名高点击公司、真正有用的 Evidence、
没有排名价值的 Jev call、deterministic path 已足够的查询、parser/data/retrieval/Jev/ranking/UX 归因），
再决定下一个 Phase。

## 验收对照（§19 的 20 条）

见 `reports/PRODUCT_USAGE_BASELINE/REPORT.md` 的逐条回答表。关键证明：
行为无变化 = `tests/telemetry_usage.test.ts`（+全量 560 vitest）；
telemetry 零新增 Jev 调用 = 本文档 §1.3 的调用点发射设计（代码级：`recordJevCall` 仅被三个既有调用点消费契约结果）。
