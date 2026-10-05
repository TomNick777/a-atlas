# Jev-First Architecture（Phase 3.2 冻结，2026-09-29）

> **Atlas builds the rails. Jev provides the intelligence.**
> **Atlas 把轨道铺好，让 Jev 发挥能力。** **Atlas 不做第二个 Jev。**

本文件是 Phase 3.2 之后 A-Atlas 查询智能边界的权威描述。历史出处：
Phase 3（NL Query Intelligence，tag `A_ATLAS_NATURAL_LANGUAGE_QUERY_INTELLIGENCE_2026_09_29`）
证明了 Hybrid DSL V2 / Capability Registry / Validator / Normalizer / postFilters /
comparison 的价值；Phase 3.1（Planner Runtime Activation，tag
`A_ATLAS_PLANNER_RUNTIME_ACTIVE_2026_09_29`）激活过 GLM 通用 LLM Planner；
Phase 3.2（本阶段，tag `A_ATLAS_JEV_FIRST_ARCHITECTURE_2026_09_29`）把通用 LLM Planner
从生产架构中整体退出，确定性 Parser 成为唯一 query compiler。历史报告保留在
`reports/NL_QUERY_INTELLIGENCE/`，它们是证据，不是现行架构。

## 1. 智能边界（冻结）

| 职责 | 归属 | 例 |
| --- | --- | --- |
| 公司语义匹配、自然语言概念 ↔ 公司事实、semantic eligibility、subset judge、semantic evidence | **Jev**（唯一语义智能，`lib/jev/`，云端 `https://api.typesafe.ai/v1/systemone`） | 机器人、AI芯片、光模块、储能、创新药、消费电子、工业自动化、机器人核心零部件 |
| 时间、数字、比较运算、市场字段、过滤、排序、TopN、postFilter、comparison、execution order、Market State | **Atlas**（确定性代码） | 今天、最近20日、涨幅 > 10%、成交额 > 50亿、前20、至少三连板、成交额比昨天高 |

生产路径中**禁止**重新出现第二语义智能源：通用 LLM Planner、第二个 semantic judge、
自然语言 Agent、LLM query rewriting、LLM result ranking。除非未来明确重新决定架构方向。

## 2. 最终 Query Pipeline

```text
Raw Query
   ↓
Deterministic Parser V2（hybrid-parser-v2，lib/hybrid/parser-v2.ts + lib/hybrid/compile.ts）
   ↓ PlannerOutput（有界中间形态，lib/planner/contracts.ts）
Validator（lib/planner/validate.ts —— Capability Registry 逐项校验，接受或拒绝）
   ↓
Normalizer（lib/planner/normalize.ts —— 冻结默认：默认排序、postFilter 无截断降级、order 推导）
   ↓ HybridQueryPlan（lib/hybrid/contracts.ts）
Hybrid Executor（lib/hybrid/execute.ts）
   ├─ Jev（语义资格与打分；唯一 judge）
   └─ Market State（市场事实，lib/market/）
   ↓
Explainable Results（plan + parser provenance + planCaption）
```

没有 Planner Router，没有 V1/LLM 二选一。`hybrid-planner-v1`（lib/hybrid/planner.ts）
作为冻结回归基线保留：Parser V2 复用它的全部词表（排序/连板/TopN/日期/残留清洗），
无 V2 结构的查询按 V1 语义逐字节编译（H1–H10 回归锁死）。

## 3. Grammar 与 Capability 的分工

```text
Query Grammar（lib/planner/grammar.ts，query-grammar-1）    Capability Registry（lib/planner/capabilities.ts，query-capability-registry-1）
  用户怎么「写」这些能力                                        Executor 真正「能答」什么
  时间词/数值单位/操作词/字段别名/排序短语/                       MARKET_FIELDS 全集、filterable/postFilterable/
  TopN/postFilter/comparison 句法/歧义与拒绝规则                  sortable、值域、comparison 可算字段、
  → 唯一扩展入口：新语法加在这里，parser 机械消费                  timeMapping、unsupportedIntents
```

两者都不许出现行业/产品/概念词（机器人、半导体、CPO…）。grammar.ts 有边界测试锁死
（`tests/architecture_boundary.test.ts`），语义词一旦进词表就是「第二个 Jev」。

## 4. Semantic Residual 是核心接口（§9–§11）

Parser 把市场查询语法吃干净后，剩下的语言**原样**作为 semantic residual 交给 Jev：

```text
最近20日涨幅超过10%的机器人核心零部件公司
  → market: return20d > 10（filter）+ return20d desc（默认排序）
  → semantic residual: 「机器人核心零部件」——不拆、不归一、不同义词替换
今天成交额最大的做人形机器人减速器的公司
  → market: amount desc；semantic residual: 「做人形机器人减速器」
```

Atlas 不维护行业/概念同义词词典；`做机器人或者自动化的公司` 的语义或由 Jev/检索处理，
只有**两个市场条件之间的 OR** 才拒绝（`unsupported_or_combination`）。因此：

```text
Jev semantic improvement  →  Atlas semantic results improve（§29）
```

Jev 升级时 Atlas 不需要重新训练 parser、不改行业词典、不加 semantic aliases——
只要 Jev contract 不变。

## 5. 不支持就明确拒绝（§12/§18）

没有冻结定义的表述返回 `ambiguous_query`（如「最近表现不错的机器人公司」——不猜成
return20d > 10%）；没有事实层的能力返回 `unsupported_market_field`（如估值比较）；
未物化日历窗口返回 `unsupported_time_window`（9月以来/今年/上周）；两个市场条件的
OR 返回 `unsupported_or_combination`。所有拒绝意图收敛在 Capability Registry 的
`unsupportedIntents`，validator 逐项把关。有意收窄语言覆盖必须逐条记录——那是架构
简化，不是 regression。

## 6. 扩展原则（§30）

以后增加查询能力，优先顺序是：

```text
new deterministic fact  →  new DSL capability  →  new grammar row
（例：任意历史窗口、行业聚合、财务事实、市场事件）
```

而不是再接一个 LLM。Query Grammar Registry 是扩展查询语言的唯一入口。

## 7. 已退出的 LLM 面（Phase 3.2 移除清单）

- `HttpPlannerProvider` / `QueryPlannerProvider` seam、`PLANNER_LLM_BASE_URL` /
  `PLANNER_LLM_API_KEY` / `PLANNER_LLM_MODEL` / `PLANNER_LLM_TIMEOUT_MS` /
  `PLANNER_LLM_THINKING` / `PLANNER_LLM_DO_SAMPLE`（BigModel coding-plan 端点默认值）
- `npm run test:planner-live` / `planner:probe` / `planner:fixtures:refresh` 及脚本
- 17 个 recorded GLM planner fixtures、offline planner test shim
- Planner Router 的 LLM 路径（`lib/hybrid/router.ts` 删除；`planner_unavailable` 意图随之消失）
- 响应面 `planner` provenance（provider/model/mode/attempts/plannerMs/rawOutput）→
  `parser: { route: "deterministic", version: "hybrid-parser-v2", parseMs }`

`tests/architecture_boundary.test.ts` 把以上清单钉成常驻回归：active tree 中
`PLANNER_LLM / GLM / BigModel / coding-plan / planner:probe / test:planner-live` 引用为零
（`reports/` 里的历史报告是证据，不算 architecture）。

## 8. API 兼容（§24）

`POST /api/discover` 契约不变：query/plan/execution/results/planCaption/searchId/ms。
唯一变化是 provenance 字段 `planner` → `parser`（UI 从不读取它，缓存身份已改为携带
parser version）。UI 不改：单搜索框、Hero Metric、plan caption、Company/Market Evidence、
unsupported 诚实提示——全部保持。
