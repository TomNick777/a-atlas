# Jev Capability Layer（Phase 3.3 冻结，2026-09-29）

> **Atlas builds the rails. Jev provides the intelligence.**
> **Atlas owns facts. Jev owns judgement.**
> **Atlas 事实是什么；Jev 这些事实是否符合用户描述。**

本文件是 Phase 3.3 之后 A-Atlas 与 Jev 之间智能边界的权威描述。前置：
Phase 3.2 冻结了 Jev-First 查询架构（`docs/JEV_FIRST_ARCHITECTURE.md`，tag
`A_ATLAS_JEV_FIRST_ARCHITECTURE_2026_09_29`）——确定性 Parser 是唯一 query
compiler，semantic residual 原样交 Jev。Phase 3.3 把「Jev 在 Atlas 承担的智能」
显式化、合同化、模块化：它不重新设计 Planner、不新增通用 LLM、不给 parser 加
行业语义、不训练模型。

## 1. 唯一 intelligence seam

```text
Atlas Domain（executor / pipeline / API routes / UI）
      │  只准 import lib/jev/capabilities
      ▼
Jev Capability Contract（lib/jev/capabilities/contracts.ts）
      │  Fact / Judgement / Explanation 三种对象，互不混合
      ▼
Jev Runtime Adapter（lib/jev/cloud.ts —— 唯一 HTTP 消费者）
      ▼
Jev（https://api.typesafe.ai/v1/systemone）
```

边界由 `tests/architecture_boundary.test.ts` 机械保证：

- `lib/`、`app/` 只准 import `lib/jev/capabilities`（seam）——直接 import
  `cloud/provider/judge/classify/mock` 是违规；
- SystemOne wire 知识（`looking_for` / `how_to_judge` / `SystemOneResponse` /
  payload builder / 传输预算 / 计费常量）在 `lib/jev/` 之外出现即违规；
- 确定性查询轨道（parser-v2 / grammar / validator / normalizer / planner）
  一个字都不 import `lib/jev`；
- capability 路由文件（`lib/jev/capabilities/route.ts`）只准有关系句法词
  （供应链/供应商/上下游/合作/配套），行业/产品/公司词零容忍（连注释也不行）。

## 2. Principle（冻结）

```text
Atlas owns facts. Jev owns judgement.
```

- **Fact**：Atlas 提供的证据文本（corpus / profile），带 Atlas 可回指的 ref。
- **Judgement**：带 evidenceRefs 的 decision；没有 evidence 的 semantic
  assertion 永远不能升级为 Atlas fact。
- **Explanation**：解释一个**既有** judgement 的行，每行逐字引用所选
  evidence 的原文——解释性文字在机械上不可能超出证据。

Jev 的任何 decision 必须可追溯到 evidenceRefs。corpus/evidence 没有支持的
关系，就不能成为 production fact。

## 3. Capability Matrix

Registry：`lib/jev/capabilities/registry.ts`（`jev-capability-registry-1`，
静态闭集，不是插件系统；未注册的 capability 一律 `capability_unsupported`）。

| capability | contract | input | output | fact authority | allowed inference | forbidden |
| --- | --- | --- | --- | --- | --- | --- |
| `semantic_match` | `semantic-match-1` | query + subjects(companyId/name/evidence) | decisions `{companyId, score, matched, evidenceRefs}`，输入序对齐 | Atlas | 依据所给 profile 判断主营是否符合 query | 同义词扩展、行业映射、概念词典、对地域/排除条件的猜测 |
| `semantic_relation` | `semantic-relation-1` | relationQuery + subjects（每家必须带 evidence） | decisions `{companyId, matched, score, relationLabel(=relationQuery 原文), evidenceRefs}` | Atlas | 仅依据 evidence 判断关系是否被资料支持 | 凭内部知识补关系、改写 relationLabel、无 evidence 作答 |
| `semantic_comparison` | `semantic-comparison-1` | comparisonQuery + subjects（Atlas 决定对象/证据/数据版本） | decisions `{companyId, grade(0-3), score, evidenceRefs}`，排序即比较结论 | Atlas | 基于证据给每个对象与描述的相对语义关系打分 | 自由问答、增删比较对象、evidence 之外的事实 |
| `evidence_explanation` | `evidence-explanation-1` | userQuery + judgement(JudgementRecord) + evidence | lines `{ref, quote(=evidence 原文)}`；`insufficientEvidence` 时 lines 为空 | Atlas | 只判断所给 evidence 是否支持既有判断 | 产生新事实、外部检索、补全企业关系、把推测写成事实 |

契约版本独立于 Jev 运行时版本：`semantic-match-1` 今天由 jev-1.13.0 判，
明天由 jev-1.20 / 2.x 判——运行时升级原则上只改 `lib/jev/` 内的 adapter 与
payload builder，契约不动。

## 4. 四个能力的落点

- **semantic_match**：生产 rerank 的正式合同化。payload builder 原样搬自
  judge.ts（请求字节不变，committed fixtures 字节级重放）；decisions 首次带上
  evidenceRefs、timings（prepare/judge/total 分开计量）、tokens、costUsd。
  executor 的 fuse/SHOWN 资格与排序权不变——capability 的 `matched`（noul≥0.5）
  是判断本身，不是产品资格线。
- **semantic_relation**：新能力。一个 subject 一题，批跑在同一条 noul 通道上；
  subject 无 evidence 时**发请求之前**就拒绝（`insufficient_evidence`），
  绝不让 Jev 凭记忆补关系。没有知识图谱——只有关系判断。
- **semantic_comparison**：新能力。score head（0-3）与离线 harness 的
  judgeGraded 同一 payload（逐字节）；相对结论 = decisions 按 score 排序，
  不是一段散文。谁比较、比什么、用什么证据、数据 cutoff，全部由 Atlas 决定。
- **evidence_explanation**：新能力。Jev 只从 Atlas 给的 evidence 候选中选出
  真正支持既有判断的条目；解释行 = 被选证据原文逐字引用。evidence 不足以
  支持判断 → 诚实返回 `insufficientEvidence`（空解释是答案，不是错误）。

## 5. Query Routing（确定性，不是 Planner）

`resolveJevCapability`（`lib/jev/capabilities/route.ts`）：查询命中**关系句法**
（供应链/产业链/供应商/供货/代工/配套/合作伙伴/上游/下游）→ `semantic_relation`；
其余一律 `semantic_match`（安全默认）。没有 intent classifier，没有模型参与，
句法表之外不猜。`runJevJudgement` 是生产入口：pipeline 的 rerank 与
market-first 的 subset scorer 都经它解析并执行——所以「英伟达供应商」这类
查询在生产路径上自动获得关系判断，而 residual 依旧原样传给 Jev，
**没有 query rewriting、没有同义词展开、没有语义归一**。

## 6. Failure Semantics（§18，无回落）

| 状态 | 含义 |
| --- | --- |
| `ok` | 判断全部应答 |
| `degraded` | Jev 不可用/超时；`failure` + `outcome` 说明原因。match 照旧返回中位数填充的对齐占位 decisions（executor 照旧退回确定性检索并标 DEGRADED）；relation/explanation 不产出 decisions；comparison 的 decisions 是占位值，消费方必须先看 status |
| `rejected` | Atlas 侧前置不满足（空 query、无 evidence、比较对象不足），**没有发生调用** |

`CapabilityFailure`：`jev_unavailable` / `capability_unsupported` /
`insufficient_evidence` / `invalid_capability_response` / `timeout` /
`invalid_request`。Jev 失败时 Atlas 诚实失败或退回确定性能力——
绝不偷偷换智能源。

## 7. Diagnostics（§13）

`lib/jev/diagnostics/capability.ts`：每次 capability run 记录
capability / contractVersion / runtimeModel / status / failure / outcome /
subject·evidence·decision 计数 / unexpectedAnswers / prepare·judge·total
延迟。永不记录：API key、环境变量、请求或应答 payload。
「Jev 升级后搜索质量变了」可以从这些记录回答：哪个 capability、哪个契约版本、
哪个运行时模型、什么规模的请求、何时变化。

## 8. API Surface（§12，向后兼容）

- `POST /api/discover` 与 `POST /api/search` 契约不变，仅新增**可选**
  `intelligence` 信封：`{provider, capability, contractVersion, runtimeModel,
  degraded}`。UI 不读它。
- `POST /api/intelligence`：内部/测试面（非产品端点）。registry 把门，
  未注册 capability → 400 + registry 全文；match/relation 由确定性路由解析；
  degraded/rejected 如实返回 200 + 状态。UI 不链接它。

## 9. Non-Goals（Phase 3.3 §21，全部未做）

Agent / orchestration / tool framework / MCP / workflow engine / 自主规划 /
multi-model routing / query decomposition LLM / RAG 框架替换 / corpus 重构 /
UI redesign / 训练 / Laya / 知识图谱 / 全产业链 ontology / embedding provider
abstraction。发现机会只进 backlog。

## 10. 新增 semantic intelligence 的判断顺序（AGENTS 摘要）

> 新增 semantic intelligence 前，优先判断它是否应成为 Jev Capability
> （进 registry、带契约版本、带 evidenceRefs）。不得通过添加通用 LLM、
> Planner、行业词典或概念映射绕过 Jev Capability Layer。
