# Third-Party Notices

## a-stock-data（当前数据底座，Refocus 2026-09-28 引入）

- upstream: https://github.com/simonlin1212/a-stock-data
- 版本/commit: v3.10.0 @ `f814dcfe209dd7958f4858f9d878d591ee85fb56`（同步日期 2026-09-28）
- License: **Apache License 2.0**（全文见 `vendor/a-stock-data/LICENSE`，Copyright 2026 Simon Lin；
  上游无 NOTICE 文件）
- 使用方式: `vendor/a-stock-data/` 为钉 commit 的只读快照（含原 LICENSE 与 README/CHANGELOG）；
  `services/stock-data/generated/stock_data.py` 由 `scripts/extract_stock_data.py` 从快照
  SKILL.md 机械抽取生成（文件头保留 upstream 出处与版权说明），修改发生在 adapter 与
  服务包装层，不在快照内。
- 更新流程: `vendor/a-stock-data/VENDOR.md`。

## Vibe AStock（已退役 / RETIRED）

Phases 0–4 曾将 **Vibe AStock** (https://github.com/simonlin1212/vibe-astock,
Apache License 2.0) 的研究系统整体并入本仓（`services/vibe-research`）。
Refocus（`atlas/refocus-data-foundation`）已将该集成从产品与运行时中完全移除：

- 代码出处链保留在统一仓库迁移前的完整 Git 历史归档（见 `docs/UNIFIED_REPOSITORY_2026_10_04.md`）与 Phase 0–4 报告
  （`reports/PHASE*.md`、`reports/PHASE*_RUNTIME/`、`docs/A_ATLAS_*.md`）中；
- 上游原仓与其历史未被改动；
- 用户历史数据（`~/.duanxian-agents/`、`~/.vibe-astock-agent/`、`data/user/`）
  未被删除，只是停止引用。

若从历史归档中检出该阶段的代码，须继续遵守其 Apache-2.0 与
`docs/upstream/Research-LICENSE.txt`（Vibe 仓内）义务。

## Vela / LuxAlgo（统一公司页日线）

使用 `@luxalgo/vela` 0.8.1 的 headless core；Apache-2.0，完整 LICENSE/NOTICE 位于 `third_party/vela/`。保留 Vela™ 署名和图表组件原有版权呈现；不引入 AGPL 的 vela-pinets。

## Laya 软件运行库（可选本地 judge 与训练）

迁移环境使用 Laya 0.3.5；软件发行包 LICENSE 为 Apache-2.0，副本与出处位于 `third_party/laya/`。模型权重、tokenizer、底座模型和私有训练数据继续保留其原许可与来源，软件许可不能代替这些产物的许可。权重和模型登记不进入公开 Git 历史。
