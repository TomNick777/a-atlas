# A-Atlas Discovery Benchmark

版本：**v1**（2026-09-28 冻结）。Phase 3 — Discovery Quality 的基准数据集与评估契约。

## 这是什么

回答一个问题：**当用户用自然语言描述一种公司时，A-Atlas 能否把相关公司从全 A 股（5567 家）里捞出来？捞不出来时，是哪一层的问题？**

- `benchmark.v1.json` — 82 条 query 与可审计的期望（strong / acceptable / exclusions + requiredEvidence）。
- `expected-evidence.json` — 每个期望公司在 corpus 里的**词面证据审计**（机械抽取，可回指原文）；`corpusVerified: false` 的条目是已知的语料缺口或外部知识期望，全部保留、如实标注。
- `failure-taxonomy.md` — F0–F10 失败分类定义。
- 评估工具：`scripts/discovery_benchmark.ts`（全量跑分）与 `scripts/discovery_inspect.ts`（任意 query 全链路追踪，DEV-only）。

## Ground truth 方法（完整性声明）

1. 期望值由撰写者**领域知识**成稿，成稿时不运行任何搜索系统（git 历史可证：基准先于 baseline 提交）。
2. 成稿后用 `scripts/build_expected_evidence.ts` 对 corpus 做**机械证据审计**：requiredEvidence 词面是否出现在该公司的 `searchableText`（检索/嵌入/judge 三者共读的同一文本）与结构化字段。
3. 审计中发现的选词偏差只按「语料的自然措辞变体」修正（如 煤矿→煤炭/煤机、医美→医疗美容、悬架→悬挂），**不因系统输出改动期望**。
4. 已知语料缺口（如 格力电器/美的集团文档中无「空调」、汇川技术无「伺服」、时代电气无「IGBT」、晶盛机电无「光伏」、customer 关系如 特斯拉 供货）**保留在期望里**，`corpusVerified:false` 标注——这些正是 benchmark 要度量的 coverage/representation 事实，不为分数美化。

### 禁止（Benchmark Integrity，Phase 3 规格 §6）

- 因当前 Top1 是什么就把它写成 ground truth；
- 根据模型结果倒推正确答案；
- 为让 benchmark 变绿硬编码股票代码或 query-specific 规则；
- 把 benchmark query 塞进 prompt / ontology / 语料来作弊。

## 类别与数量（82 题）

| 类别 | 题数 | 测什么 |
|---|---|---|
| A direct_business | 14 | 明确主营/产品描述 |
| B paraphrase | 10 | 普通人口语表达，不用证券术语 |
| C product_first | 12 | 只说产品名 |
| D industry_chain | 9 | 产业链/客户关系（corpus 若无此类事实，如实诊断为 coverage limitation） |
| E multi_condition | 8 | 组合条件（业务+属性/业务+排除） |
| F exclusion_contrast | 9 | 「不要X」排除语义 + 正向对照（F08 无排除词） |
| G ambiguous_exploration | 6 | 无唯一答案的探索意图（rubric 人工评） |
| H entity_collision | 7 | 公司名与概念词冲突（机器人/卫星/长城/中国软件/视觉/芯片/紫光） |
| I negative_no_answer | 7 | A 股池可能没有好答案；系统应允许空/低置信，不许硬凑 |

## 期望 schema

```ts
type BenchmarkCase = {
  id: string                    // 类别前缀+序号，唯一稳定
  category: string              // 9 类之一
  query: string                 // 用户原话，不改写
  expected?: {
    strongMatches?: string[]    // 主营即所问（6 位 canonical 码）
    acceptableMatches?: string[]// 次级主营/同大类内可接受
    exclusions?: string[]       // 出现在 Top10 即失败信号（实体碰撞/排除未生效）
  }
  requiredEvidence?: string[]   // 匹配结果应能引用的语料词面（OR 语义的变体集）
  noUniqueAnswer?: boolean      // true = G/I 题，不进 Recall 指标，rubric 人工评
  notes?: string
}
```

自动指标只对**有期望的题**计算（strong/acceptable 非空）；G/I 只记录完整 top10 + 分数 + 证据供人工 rubric（Relevant / Plausible / Diverse / Unsupported / Clearly Wrong）。

## 怎么跑

```bash
# 全量 baseline（真实 Jev Cloud，约 82 次搜索）
npx tsx scripts/discovery_benchmark.ts --out reports/PHASE3_DISCOVERY_BASELINE/baseline.json

# 任意 query 的全链路追踪（Inspector，DEV-only）
npx tsx scripts/discovery_inspect.ts "做汽车座椅的公司" --expect 603085,603997
```

复现所需 identity（git commit / corpus digest / retrieval / judge / embedding 版本）记录在每次输出的 `identity` 块中。

## 词汇审计快照（v1 冻结时）

- 期望符号 252 个，全部存在于 companies.json 且与 corpus 名称一致；
- `corpusVerified`（requiredEvidence 词面在 searchableText）227/252 = **90%**；
- 已知缺口样本：格力电器/美的集团（无「空调」，上游主营构成用「消费电器」粗类目）、汇川技术/禾川科技/信捷电气（无「伺服」）、时代电气（无「IGBT」，用「新兴装备板块」）、冰轮环境（无「制冷」）、晶盛机电（无「光伏」，呈现为半导体装备）、海康威视（无「视觉」，用「视频技术」）、普冉股份（无「存储」，用「芯片收入」）、中牧股份（无「疫苗」，用「动物保健品」）、拓普/三花与特斯拉的客户关系。
