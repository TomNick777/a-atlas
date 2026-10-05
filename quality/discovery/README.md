# quality/discovery — Jev Discovery Quality Benchmark（Phase 3.5）

**Measure first. Improve later.** **Corpus gaps are not Jev failures.**
**A benchmark is an observation instrument, not a target to overfit.**

本目录是 Atlas 第一套长期稳定的 Jev Discovery Quality Baseline 的家：
客观测量当前 Atlas + Jev 擅长什么、不擅长什么，并给未来 Jev 升级一把可重复的尺子。
权威文档 `docs/JEV_DISCOVERY_QUALITY_BASELINE.md`；冻结报告 `reports/JEV_DISCOVERY_QUALITY_BASELINE/REPORT.md`。

与 `tests/` 的分工：普通测试回答「系统有没有坏」；本目录回答「搜索质量怎么样」。
与 `evaluation/discovery/` 的关系：那是 Refocus 前 Phase 3 的期望排序 benchmark（82 题、
strong/acceptable 期望表）；本目录是 Phase 3.5 的证据导向坐标系（锚点克制、证据回指、
无总分）。两者互不替代。

## 布局

```
benchmark-v1.json      冻结数据集：8 个 family × 55 query + 克制锚点
golden-evidence.json   §29 旗舰证据：10 条 query→公司→逐字语料事实（预检断言）
runner/                运行器（benchmark schema / env pin / accounting / metrics / run / review / compare）
snapshots/<label>/     每次运行的原始工件 environment.json · run.json · results.jsonl · metrics.json · report.md
reviews/               人工 review 面（review.md + labels.json）
```

## 运行

```bash
npm run quality:discovery -- --label r1              # LIVE 正式 run（identity probe + golden 预检）
npm run quality:discovery -- --label r2 --family relation,comparison
npm run quality:discovery -- --label debug --offline # 只为调试管道，永远不是 baseline（§30）
npm run quality:discovery:review  -- --from r1       # 生成 review sheet + labels 模板
npm run quality:discovery:review  -- --from r1 --labels reviews/r1-labels.json
npm run quality:discovery:compare -- --base r1 --target r2   # diff（§35）
npm run quality:discovery:compare -- --stability r1 r2 r3    # 稳定度（§21/§22）
```

## 锚点语义（§13）

- `mustInclude`：只用于语料中存在直接、强、无争议证据的旗舰样本（每条都注明已核依据）。
  healthy run 下 miss 是记录在案的失败，**冻结后不许因结果不好偷偷删除**（§28）。
- `shouldInclude`：合理候选，不要求固定排名，缺失只是观察。
- `negative`：明显无关对照；进入 TopK 且 matched 或 score ≥ 0.6 记为 intrusion。

Query 一旦冻结不得改写（§27）：原始用户表达本身就是测试资产。锚点纠错必须
document correction + benchmark version bump。

## 质量标签（§19，人工 review 专用）

| 标签 | 定义 |
|---|---|
| `DIRECT` | Evidence 明确直接支持 query |
| `VALID` | 非逐字直接命中，但业务语义合理且证据充分 |
| `WEAK` | 存在关联，但不足以支撑当前排名 |
| `UNSUPPORTED` | Evidence 不支持 judgement |
| `CONTRADICTORY` | Evidence 实际与 judgement 冲突 |
| `UNCERTAIN` | 现有 corpus 无法可靠判断 |

禁止 `good/bad/great/terrible` 一类模糊评价。报告必须区分
`mechanically evaluated / human reviewed / unreviewed`（§37）。

## 失败归因（§25）

机械先归类（`JEV_SEMANTIC_MISS` / `PARSER_UNSUPPORTED` / `RUNTIME_ERROR` /
`EXPECTED_REJECTION` / `NEGATIVE_INTRUSION`…，见 runner/metrics.ts 的
`mechanicalHint`），人工 review 给最终归属（labels.json 的 `attribution`）。
核心原则（§26）：**Jev 没有足够事实可判断时记 `CORPUS_MISSING_FACT`，
不许记成 semantic failure。**

## 纪律

- 不引入第二个 judge 给 Jev 打分（§15）：机械指标 + 人工锚点 + 证据检查。
- 不生产单一总分（§23）：输出 family × capability 矩阵。
- 稳定 ≠ 正确（§22）：quality 与 stability 分开报告。
- runner 不改生产语义（§43）：只观察；corpus/market digest 漂移即退出（exit 2）。
- 正式 baseline 必须 LIVE（§30）：identity probe + golden 预检 + wire 记账，
  unexpected attempts ≠ 0 即失败。
