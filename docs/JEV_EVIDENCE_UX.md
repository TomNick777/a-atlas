# Jev Evidence UX（Phase 3.4，2026-09-29）

> **Atlas builds the rails. Jev provides the intelligence.**
> **Atlas owns facts. Jev owns judgement.**
> **Judgement without inspectable evidence is incomplete UX.**
> **Every important judgement should be inspectable.**

Phase 3.3 把 Jev 的智能合同化为四个 capability；Phase 3.4 把已经产生的
judgement / evidenceRefs / relation decision / grounded explanation 转化为
前端可见、可理解、可追溯的 Evidence UX。本阶段**零新增 intelligence**：没有新
capability、没有 LLM、没有 reranker/ embedding/prompt 改动、没有 planner/agent。
只做一件事：让现有智能可见、可查、可信。

前置：`docs/JEV_CAPABILITY_LAYER.md`（Phase 3.3，tag
`A_ATLAS_JEV_CAPABILITY_LAYER_2026_09_29`）、`docs/JEV_FIRST_ARCHITECTURE.md`（Phase 3.2）。

## 1. 审计结论（为什么要在服务端修）

Phase 3.4 之前的真实链路：

```text
Jev decision {score, matched, evidenceRefs}
  → pipeline.ts / execute.ts 只取 decision.score   ← evidenceRefs 在服务端即丢
  → /api/discover row {probability, semantic.matchedFacts, hero}
  → UI 只读 {code, name, probability, industry, hero}
  → 点击 → /stock/:code?q&m →「为什么匹配本次搜索」= query + 百分比，无证据
```

- **evidenceRefs 丢失点**：`lib/search/pipeline.ts`（semantic-only 路径）与
  `lib/hybrid/execute.ts` 的 subset scorer（market-first 路径）把 decision 降为裸 score。
- 用户看得到 score，看不到：Jev 判断所依据的文本、确定性词面命中
  （`semantic.matchedFacts` 一直在响应里，UI 从不读）、capability 种类
  （match vs relation）、任何解释与来源。
- 可直接形成 evidence UX 的已有数据：decision.evidenceRefs（ref =
  `judge-profile:{code}`，回指= judge 读到的同一份文本）、matchedFacts
  （query 词在档案文本中的逐字命中，Atlas 事实）、intelligence 信封、relationLabel。
- 卡片是 canvas 位图，已有 hero 行通道（Phase 2）——Level 1 hint 走同一槽位，
  卡面仍是 名称/代码/一行，物理零改动。

## 2. Three-Level Evidence Model

| Level | 表面 | 内容 | 来源 |
| --- | --- | --- | --- |
| **L1 Evidence Hint** | 结果卡底部一行（hero 槽位，无 hero 时） | `semantic.matchedFacts` 前 2 项逐字 ` · ` 连接，弱化墨色 | Atlas 事实（词面命中），**仅 judgment-backed 卡片显示**；degraded 卡与 market hero 卡不显示 |
| **L2 Evidence Peek** | hover 结果卡（DOM 浮层，pointer-events-none） | score（语义匹配/关系匹配 N）+ 判断的关系（relation）+ 1–2 条证据摘录（110 字）+ 来源标签 | 后端 resolve 好的 EvidenceView，前端只查表 |
| **L3 Evidence Inspector** | 公司页「为什么匹配本次搜索」块（统一 shell） | score + capability 标签 + 「语义相关度，不是概率」+ 资料依据（全文逐字）+ 来源/provenance + 按需「为什么」按钮 → Jev 解释 + 折叠技术细节 | facts 由公司页 server 端 resolve；explanation 按需调 `/api/explain` |

交互原则：搜索体验是第一幕（物理堆、波浪举牌不动），证据是第二幕。
explanation 只在 L3 按需调用（成本 + 噪音控制）；L1/L2 从不调 Jev。

## 3. EvidenceView 契约（`lib/atlas/evidence.ts`，`evidence-view-1`）

UI 消费 EvidenceView，不消费 corpus 行、profile 文件或 Jev wire 形状：

```ts
type EvidenceView = {
  ref: string;                  // "judge-profile:688017"
  kind: "judge_profile";        // 当前唯一闭合种类
  label: string;                // 闭合映射：公司档案
  text: string;                 // 逐字 Atlas 事实（UI 只可截断，不可改写）
  provenance: { source: string; recordedAt: string | null };
};
```

- resolve 路径：`judge-profile:{code}` → `findCompany` → `judgeProfileText` —— 与
  capability 层 subjects 用的是**同一函数**，所以「这是判断所依据的文本」逐字为真。
- **All-or-null**：一个 ref 解析失败，整条 evidence list 为 null（绝不部分展示）。
- presented 响应（`/api/discover`、`/api/search` 在 cache 之后统一 present）：
  每行/hit 附 `judgement`（live decision：capability/query/score/matched/
  relationLabel/evidenceRefs）+ `evidence: EvidenceView[] | null`。
  **degraded 的中位数填充 decisions 不是 judgement，永不 surfaced**；
  judgement 存在但 refs 解析失败 → `evidence: null`，UI 显示「证据暂不可用」。
- 域层（pipeline/execute）只携带 judgement+refs；EvidenceView 在 API 边界
  resolve —— 转换逻辑属于 Atlas domain/API（`lib/atlas/evidence.ts`）。

## 4. Judgement / Fact / Explanation 在 UI 上的区分

- **Fact**：`资料依据（逐字）`——Atlas 语料原文，逐字展示。
- **Judgement**：score 行（`语义匹配 83` / `关系匹配 95` + `判断的关系：「苹果供应链」`）——
  relationLabel 是 Atlas 提供的原句，不是 Jev 发明的关系词；页面标注
  `语义相关度，不是概率`（score 语义，§13）。
- **Explanation**：`Jev 解释（逐字引用所选证据）`——来自
  `evidence-explanation-1`，每行 = 所选证据逐字引用；解释性文字在机械上
  不可能超出证据。UI 文案用「Jev 解释」，不用「AI 认为」。

## 5. `/api/explain`（grounded explanation 的产品面）

```
POST /api/explain { q, code }
POST /api/explain { mode: "comparison", q, codes[2..4] }   // 内部面，UI 不链接
```

- judgement 从 **discover 缓存里用户看到的那次答案**读回——不重判、不信客户端
  断言；evidence 由服务端 resolve；Jev 只挑支持判断的证据。
- 状态：`ok`（lines 逐字引用）/ `insufficient_evidence`（证据不足——这是与低分
  不同的语义，单独展示）/ `unavailable`（reason: `search_expired` /
  `not_judged` / `not_in_answer` / Jev failure——**绝不伪造解释**，事实部分照常返回）。
- 小 LRU（key 含 judge identity）防止重复点击重复计费；degraded 不缓存，
  Jev 恢复后下次点击即得。
- comparison：2–4 家具名公司，Atlas 定对象与证据，decisions 按 score 排序即
  相对结论，每方证据一并列出；degraded 时 decisions 是占位值，消费方必须先看 status。

## 6. Failure states（§12）

| 状态 | UI |
| --- | --- |
| Strong match + evidence | 正常三层展示 |
| judgement + `evidence: null`（refs 解析失败） | 「证据暂不可用」 |
| judgement + 空 refs（生产不应发生） | 同上；grounding 测试钉 `evidenceRefs.length > 0` |
| explanation `insufficientEvidence` | 「证据不足：所给资料不足以支持这个判断」（不是低分） |
| explanation `unavailable` | 「解释暂不可用（原因）。依据见上方资料。」绝不伪造 |
| Jev unavailable（搜索期） | 既有 DEGRADED banner 不变；卡片无 hint、无 judgement、无证据声明 |

## 7. Provenance / payload / score 策略

- **Provenance**：L1 不显示；L2 只显示来源标签（`来源：公司档案`）；L3 显示
  source（corpus digest / profile edition）+ recordedAt + 折叠的 contract/runtime。
- **Payload**（§19 实测，2026-09-29，未压缩字节）：judgement+evidence 内联后
  `/api/discover` 增加 ~14KB（9 行）～ 68KB（42 行「未来教育」），占比 75–79%；
  证据文本极短（judge profile ≤640 字），gzip 后增量 ~3–15KB，且 LRU 命中零增量。
  结论：**主响应内联 resolve**（L2/L3 零延迟），不为 REST 漂亮拆 detail endpoint。
- **Score 语义**：0..1 语义相关度，不是概率。UI 显示 `语义匹配 83` 形式并标注
  「语义相关度，不是概率」；本文档为权威说明。

## 8. 边界（机械测试钉死，`tests/architecture_boundary.test.ts`）

- `components/**` **零 import lib/jev**（连 seam 也不行——judgement 只经 presented
  response 进入 UI）；lib/search|hybrid|market|planner 只准作为 type import。
- 解释散文只能在 capability 内部合成；`EvidenceWhy` 只渲染 capability 状态，
  文件内不得出现判分逻辑（noul / looking_for / 阈值比较）。
- 证据来源标签是 `lib/atlas/evidence.ts` 内的闭合映射，组件不得硬编码。
- grounding（`tests/evidence_grounding.test.ts`、`tests/evidence_explain.test.ts`、
  `tests/evidence_view.test.ts`）：displayed evidence 全部可解析且逐字；
  explanation lines ⊆ evidenceRefs 且 quote 逐字；无 orphan judgement
  （H10 真实适配器重放）；degraded 无 judgement。

## 9. Forbidden（Phase 3.4 §23/§24）

前端不得：推导 semantic relation、自选「最相关证据」、按字段内容重算 match、
生成 explanation、把证据拼成新事实。前端只 present / expand / inspect / navigate。
新增 semantic intelligence 前仍按 Phase 3.3 判断顺序（进 registry、带契约版本、
带 evidenceRefs）。**Any UI explanation of Jev judgement must be grounded in
evidenceRefs supplied by the Jev Capability Layer. Frontend code must not
recreate semantic judgement or semantic evidence selection.**
