# Jev Discovery Quality Baseline（Phase 3.5 冻结，2026-09-29）

> **Measure first. Improve later.**
> **Corpus gaps are not Jev failures.**
> **A benchmark is an observation instrument, not a target to overfit.**

本文件是 Jev Discovery Quality Baseline 的权威描述。前置：`docs/JEV_EVIDENCE_UX.md`（Phase 3.4，
tag `A_ATLAS_JEV_EVIDENCE_UX_2026_09_29`）、`docs/JEV_CAPABILITY_LAYER.md`（Phase 3.3）、
`docs/JEV_FIRST_ARCHITECTURE.md`（Phase 3.2）。目录契约见 `quality/discovery/README.md`；
冻结报告 `reports/JEV_DISCOVERY_QUALITY_BASELINE/REPORT.md`；里程碑 tag
`A_ATLAS_JEV_DISCOVERY_QUALITY_BASELINE_2026_09_29`。

## 1. 目的（Phase 3.5 §0/§48）

Phase 3.2–3.4 冻结了 Jev-First 查询架构、Capability Layer 与 Evidence UX。Phase 3.5
**不是优化阶段**：不修 benchmark、不为分数改生产语义，唯一目标是

> 客观测量当前 Atlas + Jev 擅长什么、不擅长什么，并建立未来 Jev 升级时可以重复运行的稳定质量坐标系。

成功标准不是「Jev 得分很高」，而是第一次能准确回答 Atlas 搜索质量处于什么水平，
并且下一次 Jev 升级时用同一把尺子重新测量。

## 2. Benchmark 哲学（§2/§13/§23/§26/§40）

- **Benchmark 不是标准答案表。** A 股自然语言发现不存在大量绝对唯一答案
  （「做人形机器人减速器」≠ 只有绿的谐波正确）。评价的是发现质量，不要求 Jev 背答案。
- **锚点克制。** `mustInclude` 只用于语料中存在直接、强、无争议证据的旗舰样本；
  `shouldInclude` 是合理候选；`negative` 是明显无关对照。禁止 expectedRanking。
- **证据导向。** 每个结果检查 company / score / judgement / evidenceRefs / resolved
  evidence / capability 六元组，不只看公司名。
- **无总分。** 输出 family × capability 矩阵（什么可靠 / 有限可靠 / 当前失败），
  不生产「Atlas 87 分」。
- **Corpus gap ≠ Jev failure。** Jev 没有足够事实可判断时记 `CORPUS_MISSING_FACT`，
  不许记成 semantic failure（Source Closure 的老教训系统化）。

## 3. 目录与数据集（§3/§27/§28/§29）

```
quality/discovery/
  benchmark-v1.json      冻结数据集（discovery-quality-v1）：8 families × 55 query
  golden-evidence.json   10 条旗舰 query→公司→逐字语料事实（每次 run 预检）
  runner/                benchmark schema · env pin · accounting · metrics · run · review · compare
  snapshots/<label>/     run 工件：environment.json · run.json · results.jsonl · metrics.json · report.md
  reviews/               人工 review 面 + labels.json
```

与 `tests/` 分工：普通测试回答「系统有没有坏」，quality benchmark 回答「搜索质量怎么样」。
与 Refocus 前 `evaluation/discovery/`（82 题期望排序 benchmark）互不替代。

**Query Freeze（§27）**：query 是冻结的用户原始表达——跑出来不好不许换说法重跑，
任何修改 = benchmark-v2。**Anchor Freeze（§28）**：锚点不许因 Jev 没搜到而偷偷删除；
纠错必须 document correction + version bump。**Golden Evidence（§29）**：10 条旗舰
逐字事实在每次 run 前机械预检（corpus 仍存在足够强的事实），corpus 漂移即 exit 2。

## 4. Query Families（§4–§12）

| Family | id 前缀 | 数量 | 测什么 |
|---|---|---|---|
| A Explicit Product | A01–A10 | 10 | 明确主营产品（人形机器人减速器、IGBT、K线软件…） |
| B Broad Semantic | B01–B06 | 6 | 普通语言业务方向（让机器看懂图像…），原样交 Jev |
| C Relation | C01–C07 | 7 | semantic_relation 路由（苹果供应链、美的供应链…），证据支持为评价对象 |
| D Comparison | D01–D05 | 5 | semantic_comparison 相对一致性（谁更偏伺服…），不要求绝对赢家 |
| E Composite | E01–E06 | 6 | 确定性 grammar + Jev semantic residual 协作（AND/OR/否定/市值约束） |
| F Ambiguous | F01–F10 | 10 | 模糊输入的诚实处理；**正确拒绝也是质量**（expectedHonestRejection） |
| G Weak Concept | G01–G07 | 7 | 概念股词汇（低空经济、新质生产力…）与真实业务相关性的边界 |
| H Negative Control | H01–H04 | 4 | must/negative 锚点对照，检查明显无关对象的异常高分 |

## 5. 质量标签（§19）

人工 review 只用有限标签：`DIRECT`（证据明确直接支持 query）/ `VALID`（非逐字命中但
业务语义合理、证据充分）/ `WEAK`（有关联但不足以支撑当前排名）/ `UNSUPPORTED`
（证据不支持 judgement）/ `CONTRADICTORY`（证据与 judgement 冲突）/ `UNCERTAIN`
（corpus 无法可靠判断）。禁止 good/bad 一类模糊评价。报告区分
`mechanically evaluated / human reviewed / unreviewed`（§37）——不声称看过没看过的结果。

## 6. 指标（§16–§18）

**机械指标**（无语义判断，可自动）：query_success_rate（含 expected honest refusal）、
judged_result_rate、evidence_coverage_rate、orphan_judgement_rate、must_include_recall@5/10/20、
negative_anchor_intrusion@5/10/20、insufficient_evidence_rate、capability_failure_rate、
unexpected_error_rate、latency p50/p95、wire_calls。

**证据指标**：evidence_ref_resolution_rate（应≈100%）、verbatim_grounding_rate 与
explanation_grounding_rate（**必须 100%**——系统完整性指标，不是 Jev 智力指标）、
direct/weak_evidence_rate（requiredEvidence 词面探针是 review 提示，不是判决）。

**排序指标**：Anchor Recall@K、Negative Intrusion@K、Evidence-Weighted Precision
（仅当存在人工 labels；权重 DIRECT=1 / VALID=0.75 / WEAK=0.3 / 其余=0）。
**没有单一 accuracy，没有总分。**

## 7. 失败归因（§25）

机械先归类，人工 review 给最终归属：
`JEV_SEMANTIC_MISS` / `JEV_RANKING_MISS` / `CORPUS_MISSING_FACT` / `CORPUS_WEAK_FACT` /
`RELATION_EVIDENCE_MISSING` / `PARSER_UNSUPPORTED` / `PARSER_AMBIGUOUS` /
`CAPABILITY_UNSUPPORTED` / `EVIDENCE_PIPELINE_ERROR` / `RUNTIME_ERROR` /
`EXPECTED_REJECTION`（+ `NEGATIVE_INTRUSION` 机械信号）。
「美的供应链」搜不到必须能区分是 Jev 不认识，还是 corpus 根本没有供应关系事实。

## 8. 可重复性与稳定度（§20–§22/§30–§32）

- **环境钉死**：每次 run 记录 git commit、Atlas tag、Jev 在岗身份（identityProbe，契约
  `jev-1.13.0`）、corpus digest（`41a0995d…`）、market digest（`4eada12b…`，2026-09-28）、
  benchmark 版本+摘要、grammar（`query-grammar-1`）、parser（`hybrid-parser-v2`）、
  capability registry（`jev-capability-registry-1`）与四契约版本、retrieval/knowledge 版本。
- **LIVE only（§30）**：正式 baseline 必须真云——identity probe + golden 预检 + wire 记账
  （unexpected attempts ≠ 0 即失败）；`--offline` 只调试管道，工件标 offline-debug 永非 baseline。
- **≥2 次重复**：record company overlap@K、rank movement、score drift、
  must-anchor presence agreement、attribution flips。
- **Stability is not correctness（§22）**：quality 与 stability 分开报告，永不合成一个数。

## 9. Diff 与升级协议（§35/§39）

`quality:discovery:compare -- --base r1 --target r2` 输出 new/lost TopK、must anchor
lost、new negative intrusions、rank movement、status flips、metric deltas。
未来 Jev 升级（1.13 → 1.14 → 2.x）统一走：旧版本跑 baseline → 新版本跑 baseline
（Atlas commit / corpus / market 不变）→ compare + stability → family-level 决策是否升级
生产 runtime。不靠「感觉新版更聪明」。

## 10. Anti-overfitting 与生产不变量（§1/§40/§43）

AGENTS.md 新增原则：**Discovery benchmark failures must not be fixed by adding
query-specific, company-specific, industry-specific, or benchmark-specific production
rules.** Phase 3.5 结束时必须确认 corpus digest / market digest / grammar / parser
语义 / capability contracts / 生产排序与阈值全部未变——若生产搜索行为改变，
measurement purity 失败。benchmark 暴露的问题一律进 backlog，本阶段不修。

## 11. Non-Goals（Phase 3.5 §1，全部未做）

Jev prompt/request/score/ranking tuning、synonym expansion、行业词典、概念本体、
硬编码公司名、benchmark-specific parser 规则、corpus enrichment、Source Coverage 修补、
Laya/reranker 训练、通用 LLM/Planner/Agent/MCP/knowledge graph、UI redesign、
第二个 LLM judge（§15——不给 Jev 找裁判）。修复全部进 backlog。
