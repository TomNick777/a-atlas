# vendor/a-stock-data — pinned upstream snapshot

- upstream: https://github.com/simonlin1212/a-stock-data
- commit: `f814dcfe209dd7958f4858f9d878d591ee85fb56`（v3.10.0 发布线）
- synced: 2026-09-28
- license: Apache-2.0（见 `LICENSE`，Copyright 2026 Simon Lin）
- 只读快照：本目录是上游文件快照（不含 .git），**不做任何手工修改**。
  A-Atlas 的改动只发生在：
  1. `scripts/extract_stock_data.py`（build-time 抽取器）
  2. `services/stock-data/generated/`（抽取产物，头部带 upstream commit，
     由抽取器机械生成，绝不手编）
  3. `services/stock-data/`（adapter 与服务包装）

## 上游更新流程

1. 在只读 clone（`D:\workspace\a-stock-data`）`git pull`，检定目标 commit；
2. 用新快照覆盖本目录（同上范围），更新 `scripts/extract_stock_data.py` 的
   `UPSTREAM_COMMIT` / `UPSTREAM_VERSION`；
3. `python scripts/extract_stock_data.py` 重新生成；
4. `python -m unittest tests.test_stockdata_extraction -v` 离线全绿；
5. 快速抽验（见 `docs/A_STOCK_DATA_INTEGRATION_AUDIT.md` §6 样本）。

## 为什么是抽取而不是运行时解析

SKILL.md 432 KB，运行时每请求 read→parse→exec 不是生产架构（refocus §二十一）。
抽取器复用上游测试自己的定位规则（唯一 `def <name>(` + AST 剪模块级示例调用），
产物可 diff、可重生成、provenance 头完整。详见
`docs/A_STOCK_DATA_INTEGRATION_AUDIT.md` §5。
