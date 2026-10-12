# 合并执行状态（2026-10-12）

状态：按用户最新裁定，工程合并已正式切换；Laya 替代 Jev 的持续训练与质量验收仍未完成。工程与模型目标分别记账，以下旧的整体质量阻断口径保留历史。

## 正式切换记录（2026-10-12）

用户明确 Laya 质量提升属于正式项目的持续训练，目标是替代 Jev。合并计划 §0 已据此覆盖旧“所有质量问题解决后才切换”的要求；没有降低候选晋升门槛或改写旧观察。

唯一开发/运行入口已切至 `D:/workspace/a-atlas` 的 master。原 Atlas M2 dirty 工作逐文件核对一致后，保留切换前工作快照及限定路径 stash，并快进合并；未清除成果。原 Harbor 的独立 UI dirty 工作未混入提交，原 trawler dirty 工作与模型全部保留。未推送远端。

- 私有迁移共核验 74,374 文件：复制 41,912、相同 32,462，三处冲突原记录与迁入记录均保留。冲突仅为 search log、telemetry incidents 和历史 stability 汇总。环境、权重、训练数据、报告和冻结观察已在正式目录，无日常 trawler 路径依赖。原 `.env.local` 字节未改变。
- 正式目录 626 项 TypeScript、65 项 Python 和公开子集 418 项 TypeScript、53 项 Python 通过；生产构建、corpus/market 确定性对账、公开发布检查通过。24 个构建 trace 审计，打包权重为 0。
- Web 3400、Data 8920、原 v4.1 Laya 8787 已在正式目录实际启动核验。Laya SHA 为 `2742affc3f677d7157863535502225537160b7a980fbde6ecb87715adf85f02c`，实际模型 `laya:v4.1@2742affc3f677d71/13e55bf47685d605`。当前基线不是替代质量已达标的宣称。
- 正式目录受控训练在第 1 步中断后恢复至 8 步；全部 loss 与连续训练参考逐项相同，权重 SHA 同为 `5c98e46631b79fcfa75221751ebe528a8f113b2cceb8704e52762bcd153ba37b`。Web/Data 停止前后训练 PID 保持存活；候选未自动晋升。
- Harbor 正式登记为一个 Atlas（Web/Data + 可选 Laya），原 trawler spec 已停用。正式目录真实 ensure-current/build/复用/重启/停止、冷可选组件不启动、热 Laya 重启后恢复通过。发现并修复绝对入口归属校验和显式 restart 丢失可选热组件状态的问题；548 tests（1 skipped）、typecheck/lint/build 及隔离 Electron smoke 通过。已重启原 Harbor 主程序加载新登记，未停止其他 detached 应用。
- 正式目录浏览器无 page error，Laya 搜索/缓存/独立 trace、无 key 的 Jev 降级、公司页、移动布局和卡面切换通过。牌堆拖动、碰撞扰动和释放落回经截图观察；未使用 CSS 位移。实际旧 Jev 搜索答案在切至 Laya 后仍绑定 jev-1.13.0，模型不可用时返回原事实与 unavailable，不让 Laya 重写旧解释。
- 本轮新增 Jev 云调用为 0；所有运行检查使用无云密钥的进程覆盖，原密钥文件保留。已有 Jev 真实调用记录和未变化的 wire/契约测试用于工程验收，新的云端重复质量验收仍延期。v7/v10 失败候选继续不晋升。

原始记录在 `.local/merger/cutover-2026-10-12/`，含完整迁移清单、环境/运行/训练/模型身份、测试、浏览器、Harbor 和回退基线。旧 trawler 已加归档入口说明，目录未删除。训练目标见 `LAYA_REPLACEMENT_OBJECTIVE.md`；下一阶段以训练侧验证/盲测的数据与机制诊断推进，不对冻结题逐条调参。

## 本轮继续（2026-10-12，本地验证）

用户澄清：Jev 账户额度未耗尽，但余额有限；先前 350 次停止是项目自行登记的验收上限。用户随后明确本轮新增 Jev 费用为 0。因此本轮不追加云端探针、教师标签或质量验收，不修改旧账和旧观察。

发现 v9 隔离数据的验证集关系/解释只有负例。已增加训练/验证/盲测的四能力正负标签覆盖校验，训练与 qualification 都拒绝覆盖不足、数据哈希变化或验收公司/证据进入训练的候选。分组分配仅使用训练标签与来源，确定性保留公司/来源/查询隔离；未读取冻结验收题来优化分配。负例来源不再固定取同一业务，避免单个共享查询组使其他 split 丢失全部负例。

新 v10 数据 562 项（train 498 / validation 32 / blind 32），源 SHA `350d2850add519dd36885ea2eb5daee208ec8ecee737fddd85df7170f32c68ca`；每能力、每 split 均含正负例。完成一轮 63 步本地 RLCD 续训，候选 SHA `a2977925f9b5439a7e4b7af2f9e50cd5dc029d88bdc2e9ee47fdd738a4b32fce`，按验证交叉熵选择 checkpoint，未按冻结题调参。

v10 独立 46 条复验：关系 10/20、证据解释 13/20，match/comparison/eligibility 各 2/2；机械契约及 trainingDataIntegrityIsolationCoverage 通过，边界与完整重复验收仍未通过，qualified=false。关系较 v7 退步，真实 promote 命令已拒绝，active 仍为原 v4.1。保留失败，未降低门槛、未覆盖旧结果，也未反复使用冻结题选超参数。

浏览器截图发现卡面切换后举牌被横向拉伸：绘制与刚体尺寸误共用牌堆比例。已将举牌正方形尺寸与牌堆卡面解耦，回堆恢复比例，局部轴缩放保留原旋转；未改变碰撞、重力、弹簧或引入 CSS 位移。新增命中区域和形状恢复回归通过。此前浏览器脚本的拖动操作未证明被拖动卡片实际位移，因此不把该项扩大记为完整拖拽验收。

当前交易日市场查询诚实显示目标 2026-10-09 快照缺失（现有 2026-10-08），无伪造补位。后续卡面检查使用无密钥的确定性检索结果，未用该检查声称行情/模型质量通过。最终构建、浏览器复查与测试结果以下述本轮本机原始记录为准。

本轮最终验证：626 项 TypeScript、65 项 Python 通过，公开子集 418 项 TypeScript、53 项 Python 通过；typecheck、相关 ESLint 和生产 build 通过。24 个 build trace 审计，打包模型权重 0。生产浏览器复查无 page error，截图确认文字/LOGO 卡面切换后举牌仍保持正方形、点牌进入 canonical 公司页。未以对已停泊举牌的拖动尝试宣称完整拖拽验收。原始记录为 `.local/merger/local-only-*` 和 `reports/laya-evaluation/merger-corpus-v10-8bef14c800530b51-local-only/`；本轮没有新增 Jev 云请求，旧登记账仍为 350 次，估算费用仍约 USD 0.517353。

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

## 切换前旧门槛下的状态（历史）

按照计划，总门槛全部通过后才切换。当前未停用原应用、未修改正式 Harbor 登记、未归档 trawler 入口、未将原正式 Atlas 覆盖为合并分支。质量问题与调用额度不能靠改变验收题、降低门槛、补行业规则或自动增加云调用绕过。

原始验收记录留在实施 worktree 的 `.local/merger/`、`quality/discovery/snapshots/` 和 `reports/laya-evaluation/` 私有目录；回退基线留在原 Atlas `.local/merger/2026-10-12/baseline/`。这些记录不进入公开 Git 历史。
