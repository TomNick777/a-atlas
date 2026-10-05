# Observed Capability Backlog（观察登记簿）

自 Product Usage Baseline（`A_ATLAS_PRODUCT_USAGE_BASELINE_2026_09_30`）起生效的项目规则：

> **没有真实 Search Trace、明确用户需求或数据完整性问题支撑的问题，不自动晋升为新的 capability phase。**

发现问题时：**记录**，不顺手修——除非它阻止 Usage Baseline 本身成立。
只有真实使用数据（trace 显示某类问题反复影响产品体验）才把它晋升为正式 phase。

## 晋升条件（全部满足才立项）

1. 真实 trace（organic，非 benchmark）反复出现该类失败/缺口，频率或影响可量化；
2. 已在 Product Usage Review 中归因（parser / data / retrieval / Jev / ranking / UX 中哪一层）；
3. 修复方案符合既有冻结纪律（capability 走 registry、事实走通用机制、不加通用 LLM / 第二 judge / 行业词典）。

## 在册条目

| # | 候选 | 来源（冻结时已知，尚无真实使用证据） | 记录位置 |
|---|---|---|---|
| B1 | IR 活动/互动问询面（IR 活动记录表无稳定 API；互动问答 3.6 已裁定不做） | Phase 3.7 收口 | `SOURCE_SURFACE_GAP` 失败类别、`docs/EVIDENCE_SURFACE_EXPANSION.md` |
| B2 | JS 渲染官网的产品页通道 | Phase 3.7 收口 | 同上 |
| B3 | Jev synonym bridge（词形差导致的相关结果丢失） | Phase 3.5 baseline | `docs/JEV_DISCOVERY_QUALITY_BASELINE.md` |
| B4 | 新闻面 | Phase 3.7 收口 | `SOURCE_SURFACE_GAP` |
| B5 | 行情查询的时间口径与数据刷新 | 2026-10-02 本人明确反馈：行情搜索准确率差；实际查询「今天领涨的公司」 | 见下方使用问题记录；无原搜索 trace，不伪造 id |

## 使用问题记录：B5（2026-10-02）

用户原句：**「今天领涨的公司」**。本人反馈行情相关搜索结果准确率较差。

本地 CLI 复现（`npm run hybrid:query -- --json "今天领涨的公司"`）：
Parser 正确编译为 `market-only` / `pctChange desc`；无语义残留、无 Jev 调用。
实际 `execution.marketDate = 2026-09-28`，manifest 仅物化该日；返回前 20 项。
原因：`LATEST_TRADING_DAY` 取本地已捕获窗口的最后一天，查询时不刷新行情。
当前路径是盘后快照查询，不是盘中实时行情。

对该快照全部 5,561 行复算 `(close / prevClose - 1) * 100`，与派生涨跌幅零差异；
返回头部与快照降序一致。`market_query` / `market_derive` 离线测试 33/33 通过。
这些检查只证明快照内计算与排序，不证明当日数据新鲜或完整。

初步归因：**data freshness / 产品时间契约**。当用户预期当日或最新交易日行情时，
任意旧快照作为「今天」的替代会产生错误体验。尚无原始搜索 trace，不能判断用户当次
请求日期、预期榜单或其余行情查询；不将该结论推广为全部行情问题的唯一根因。

近期优先：明确盘后与盘中能力边界、确认目标交易日与更新链、让未更新状态显式可见。
数据刷新修复与盘中实时能力扩建分别评估，不借此自动开启新 parser、judge 或 ranking phase。

## 记录方式

真实使用中发现的任何新问题：

1. 若是数据缺口 → 该次搜索的 trace 里如实记（degradedReason / 空结果 / SOURCE_SURFACE_GAP），不改产品；
2. 在本表下追加一行（候选描述 + 首个 trace id + 日期）；
3. **不建分支、不开 phase、不改 grammar/corpus/capability**。
