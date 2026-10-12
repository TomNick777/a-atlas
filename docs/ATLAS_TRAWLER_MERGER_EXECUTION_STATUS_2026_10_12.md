# 合并执行状态（2026-10-12）

状态：工程集成已落地；总验收未通过，尚未正式切换。不能记为“一步到位交付完成”。

实施位于 `C:/Users/tomra/.codex/worktrees/atlas-trawler-merge/a-atlas` 的 `codex/atlas-trawler-merge` 分支，工程冻结提交 `06e49e0d880aa9d69579cf501a7c2c6d636384d0`。Harbor 配套位于同目录 `harbor` worktree，提交 `52326c5`。冻结提交包含已备份的原 M2 工作快照；原正式目录及未提交工作、旧应用登记、原模型和回退包继续保留。未推送远端。

## 已落地及验证

- 统一 Next/React 前端、物理堆与 canonical 公司页，接入 Vela 日线；中性 intelligence capability seam、显式 Jev/Laya 请求身份、证据与历史解释隔离、按实际模型身份隔离缓存。
- 统一运行 CLI、独立 Data/Laya Python 环境、受管 sidecar、GPU FIFO 队列、候选评估与拒绝晋升机制；Harbor 单应用登记管理 Web/Data/可选 Laya。
- 私有数据、报告、模型及 Python 环境已复制并核验哈希；原件保留。模型许可证、源码许可证和数据公开范围分别记录。Logo 审计无冲突；四个非 canonical 元数据文件保留在私有区。
- corpus 模式两个候选真实完成权重更新。最新受控验证中，中断恢复与连续训练的 8 项 loss 完全一致，权重 SHA 同为 `5c98e46631b79fcfa75221751ebe528a8f113b2cceb8704e52762bcd153ba37b`。历史回放 24 个 token/target 项与原 3040-item 快照对应项一致。停止 Web/Data 不停止独立训练；队列取消未启动任务已验证。
- Atlas 最终完整工程验证为 625 项 TypeScript 和 60 项 Python 测试通过；公开子集 417 项 TypeScript、47 项 Python 通过，新增退出竞态另有 5 项 lifecycle 回归通过。最终费用展示改动有 48 项 telemetry 回归、typecheck 和相关 ESLint 通过。未把原仓已有的全量 lint 问题记为通过。
- 最终 Webpack 生产构建通过，24 个 trace 经私有路径排除审计，打包模型权重数为 0。corpus 5567 文档、market 5561 行确定性对账通过；publication 检查未发现私有路径进入可达 Git 历史。
- Harbor typecheck/lint/build、547 项测试（1 skipped）及隔离 Electron smoke 通过。真实运行 harness 验证冷启动、重启、停止及独立训练存活；该 harness 的身份和构建编排另由单元测试与构建验证，不能混称全部真实运行覆盖。

## 未通过的准入

网络已解决：Node 使用本机既有代理后，Jev 实际身份核验为 `jev-1.13.0`。域名根路径 `Not Found` 不表示模型接口不可用。此前 HTTP 451 失败观察保留。

训练前冻结的独立 46 条边界样本保持原题和原标签；标签由 Agent 对照披露原文审核，未声称有人类签字。Jev 关系 14/20、证据解释 18/20；Laya v7 关系 13/20、证据解释 13/20；两者 match/comparison/eligibility 各 2/2。存在声称强于证据的错误，未达到计划要求，不能用普通排序差异掩盖。Laya 新候选未 qualified、未晋升，active 保持原 v4.1。v5/v7 数据集仅公司分组，不能声称满足最终表达/来源分组隔离；新分组 builder 的工程检查通过，不等于旧候选补获准入。

冻结 55 条发现查询的 Jev 第一轮完整结束：54 ok、1 不完整、129 wire attempts、零 unexpected attempts/strict gradient violations。该不完整来自既有 M3 资格扫描停止与未知公司，需与接口故障分开审查；当前候选资格汇总对 degraded 的严格拒绝仍保留，未为过关修改规则。

Jev 第二轮保留 53 条部分观察，H02 在预算耗尽时 degraded，H03/H04 未运行；没有完整 run receipt。共享账本已到 350/350 次，估算费用约 USD 0.517353（未声称为实际账单），未超过 USD 0.75 费用上限。计划 §9.2 明确“达到上限停止，报告未完成部分。不得为补统计自动追加云请求”，因此停止追加。后续本地验证不增加云请求。

Laya v7 两轮各完成 55 条：均为 54 ok、1 M3 扫描范围不完整、129 wire attempts，零 unexpected attempts/strict gradient violations。两轮实际身份均为 `laya:merger-corpus-v7@3ba1974c674d013e/ed34f7179f5b592d`。稳定性观察 overlap@5/@10/@20 均约 91%，must-agree 100%，status flips 0；这不代替质量准入。边界失败仍为失败。

最后停止检查发现 Windows 退出进程短暂保留 PID、无命令行的竞态。已修复为归属校验和停止操作完成后等待其消失，持续未核验状态仍报失败；操作前不放宽归属校验。5 项 lifecycle 回归通过，首次失败记录保留。

最终 v7 独立复验记录在 `reports/laya-evaluation/merger-corpus-v7-8bef14c800530b51-final-retry/qualification.json`：contractValid/capabilityCoverage 为 true，boundaries/benchmarkRepeats 为 false，qualified 为 false；未改题、标签或门槛。已重新加载原 v4.1 并核验实际 SHA。最终浏览器检查无 page error，移动端无横向溢出，Laya 搜索正常、缓存命中且生成独立 trace、缺失旧解释诚实 unavailable、无 key 的 Jev 如实 degraded；canvas 拖动已执行，但不宣称完成所有物理交互视觉审查。

预算执行偏差必须单独记录：最终 QA 使用空字符串隔离密钥，但 Windows 子进程未保留空变量，Next 重新加载本机配置，出现计划预算外的一次 Jev 搜索（2 个成功 chunk、0 retry，估算 USD 0.00474）及身份探针；身份探针不在该 telemetry 账中，实际费用未知。发现后立即停止该 Web，改用经 trim 判定为空的空白变量重启，无 key 检查通过。原 350 次登记账不重写、不把额外请求藏入其中，异常证据留在 `.local/merger/qa-cloud-budget-exception.json`。因此不能声称整轮调用严格守住预登记上限。

第二轮测量期间费用观察层发生未提交改动；实际模型管线未改，但必须保留 dirty 环境记录，不能宣称两轮都满足同一干净提交的冻结要求。完整候选晋升/跨版本回退、最终人工质量裁定、部分物理交互的视觉审查尚未完成；失败晋升拒绝与加载失败恢复验证不能代替一次合格候选真实晋升。

## 正式切换

按照计划，总门槛全部通过后才切换。当前未停用原应用、未修改正式 Harbor 登记、未归档 trawler 入口、未将原正式 Atlas 覆盖为合并分支。质量问题与调用额度不能靠改变验收题、降低门槛、补行业规则或自动增加云调用绕过。

原始验收记录留在实施 worktree 的 `.local/merger/`、`quality/discovery/snapshots/` 和 `reports/laya-evaluation/` 私有目录；回退基线留在原 Atlas `.local/merger/2026-10-12/baseline/`。这些记录不进入公开 Git 历史。
