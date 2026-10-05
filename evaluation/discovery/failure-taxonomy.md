# Discovery Failure Taxonomy（Phase 3C）

版本 v1（2026-09-28）。对「用户描述一种公司，A-Atlas 没捞对」做单一定因归类的分类法。
一次失败**只归主因**（对用户结果影响最大的一层）；次因写进 notes。归类依据必须来自
Discovery Inspector 的机械观测（corpus 证据词面、候选池成员、通道分数、judge 分、
fuse 置零原因、最终排名），不接受「感觉是检索的问题」。

判定顺序（从数据层往产品层走，第一个命中的即主因）：

```text
期望本身错了/含糊？ → F0 / F10
corpus 没有事实？   → F1
corpus 有但表达丢了？→ F2
排除/约束语义错误？ → F7
实体碰撞扰动？      → F8
没进候选池？        → F4
Jev 判错？          → F5
排序异常？          → F6
该空却硬凑/该出却空？→ F9
```

## 定义

### F0 — Benchmark / expectation issue
期望值本身错误（公司已更名、主营理解错、代码写错），或期望与数据集快照冲突。
证据：expected-evidence 审计失败、corpus 名称/主营与期望矛盾。
处置：修 benchmark，版本号不变、追加 errata 记录；**不算系统失败**。

### F1 — Corpus coverage failure
公司真实业务存在（外部可证），但 corpus 没有该事实：上游数据源没给（粗类目、字段缺失）、
或关系事实（客户/产业链）从未进入数据集。
机械信号：该公司的 corpus 文档（searchableText + 全部结构化字段）不含 query 的关键概念词，
且 expected-evidence.json 里 `corpusVerified:false`。
样本（v1 审计已知）：格力电器/美的集团文档无「空调」；时代电气无「IGBT」；拓普/三花与
特斯拉的供货关系。**不要归因给 Jev。**

### F2 — Corpus representation failure
原始数据/文档字段里有信息，但参与检索与 judge 的 `searchableText`（≤640 字预算）
没表达出来：截断丢段、措辞不利于匹配、优先级排序把关键产品挤出预算。
机械信号：结构化字段（products/business/themes）含关键词而 searchableText 不含；
或关键词只出现在 searchableText 的 420 字之后（judge 只读前 `jevDetail()` 字符）。

### F3 — Query understanding failure
QuerySpec 解析错误：must/expansion/exclusion/attr 与意图不符（该扩的没扩、不该排的排了、
硬约束误触发如「海外」误命中）。
机械信号：`parseQuerySpec(query)` 输出与意图明显不符，且错误影响了候选集构成。

### F4 — Candidate retrieval failure
corpus 有证据（searchableText 含关键词或强语义近邻）、query 合理，但正确公司没进
Top-200 候选池（或 pool 内排名使 judge 根本没认真读到它——200 全部送 judge，此子情形
并到 F4 的「pool 内 recallRank 靠尾」观察）。
机械信号：不在 `retrieveV3().candidates`，或该文档对 query 的 BM25/向量分均无通道命中；
F1/F2 已排除。

### F5 — Jev judgment failure
正确公司已在候选池、searchableText 的前 420 字（judge 可读部分）含有足够证据，
但 Jev 给出低分（显著低于阈值 0.3 或显著低于同池错答公司），导致没进 matches 或被压出 Top10。
机械信号：poolRank 靠前 + judge score 低 + score≥0.3 的错答存在。

### F6 — Ranking failure
召回、Jev 判分都对（strong 公司 judge 分不低、进了 matches），但最终排序明显异常
（Top1 是次相关，strong 落到 5 名开外；或 fuse 平分规则扰动）。
机械信号：inMatches 且 judgeScore 合理但 finalRank > 期望位次，且 Top1–Top3 明显更弱。

### F7 — Exclusion / negative constraint failure
「不要X」被忽略（X 类公司进 Top10）或「不是X」正向对照被过度应用（无罪公司被置零）。
机械信号：`expected.exclusions` 成员出现在 Top10；或候选因 `zeroReason` 被置零而
该置零与意图矛盾。**ontology 没有的排除类型（如「不是发电企业」）导致的失效也归 F7**，
它是排除覆盖缺口，不是 benchmark 错误。

### F8 — Entity collision
公司名/实体词与概念词竞争扰动结果：同名公司垄断或错答（卫星化学 for「卫星」）、
或确切公司名（中国软件）被语义近邻淹没。
机械信号：`expected.exclusions`（碰撞错答）进 Top10，或 exact-name strong 未进 Top10
而语义近邻占位。

### F9 — No-good-answer handling failure
池内本无好答案（I 类题），系统却给出高置信（score ≥ 0.3 进 matches、Top1 分数高）
的「看起来像」的错答；或反方向：存在合理稀疏答案时全零回避。
机械信号：I 类题的 matches 数、Top10 分数分布、错答身份。

### F10 — Evaluation ambiguity
期望与观测都有道理但无法归类（探索题的意图分歧、judge 分数在阈值边缘抖动、
云 judge 两次运行翻结果）。**这类必须记录，不许硬塞进其它类。**

## 与规格章节的对应

F1=§11、F2=§11、F3=§10、F4=§11、F5=§11、F6=§11、F7=§11、F8=§11、
F0/F9/F10=§10 的扩展（benchmark issue / no-good-answer handling / ambiguity）。
必要时可细分，但不失控；所有机械判定辅助在 `lib/discovery/failureTaxonomy.ts`，
最终归类由人工按判定顺序核对 Inspector 输出后写入评估报告。
