# 行情发现 M3 验收记录

日期：2026-10-03。依据本人明确要求继续完成 M3。

M3.1–M3.3 已交付：作用域编译、沿行情顺序扫描业务资格、判断缓存及预算/未决呈现。
收盘固定快照上的工程验收通过。M2 仍为条件验收：盘中时效待开市实测，未经核验的源端量比仍禁用。
这次不承诺任意业务条件都能在预算内补齐 Top20，也不把 Jev 判断视为人工核实后的公司事实。

## 查询契约

- `今天涨幅最高的20家机器人公司` → `business-topk`：从本次固定快照的全部可排行公司排序，按行情顺序逐批判断，找到 K 家确认符合者或停止。不再取检索 Top120；语义分数不参与数值排序或同值排序。
- `全市场成交额前20中有哪些机器人公司` → `market-topn-subset`：行情排序后先截断前 N，再施加 postFilter/comparison 与业务判断，不从 N 之后补位。卡面保留原行情名次，例如 #1/#2/#7/#15/#20。
- 未声明数量的业务行情查询默认 K=20；阿拉伯、全角与既有中文数量词支持。纯业务发现仍走原检索系统，纯行情仍为零 Jev。
- 行情缺失/非有限排序值不能参与排行。同值只按 canonical code 升序。`complete` 只指已覆盖行情集合中的业务资格扫描完整，不能消除 M2 的行情覆盖限制，也不是语义准确率。

作用域以 `plan.selection` 为权威，版本 `market-selection-1`；grammar 升 `query-grammar-2`，没有加入行业/公司词。历史 `execution.order` 字段兼容保留；新执行不能从它推断实际扫描顺序。
历史 H/P/raw-payload 回放显式使用 `legacyReplay` / `compileLegacyHybridQuery`，输入及旧预期未重录；生产 API 不提供回放开关。质量 runner 继续跑当前编译器，环境 pin 增加 selection/eligibility 版本，旧 baseline 不冒充当前结果。

## 业务资格、缓存和预算

沿既有 semantic_match / semantic_relation capability seam 消费 Jev，不新增 judge、不改 prompt、不做业务词典或 query rewriting。
注册 `market-eligibility-1` 消费策略：必须 live、有应答身份、有效的原始回答、capability `matched`、有 evidenceRefs。低于原有 0.5 资格中点的弱相关不会因为超过 SHOWN=0.3 而入选；精确 0.5、缺失/越界/非有限回答、失败批次中位数填充均为 unknown。
底层决策新增兼容的 `known` 信息，原有评分契约和 wire 不变；严格资格策略独立版本化，不能用于偷偷改变纯语义发现的资格阈值。

确认/否定判断以原样业务残留 + corpus digest + 单公司完整 evidence/name/code 摘要 + routed capability contract + eligibility policy version + 配置/实际应答身份/endpoint 为键缓存。缓存与行情日期/digest/排序无关；行情答案缓存仍随市场快照/交易阶段失效。未知和故障不缓存。
缓存为单 Web 进程内有界 LRU，最多 20,000 个决定，TTL 6 小时；重启丢失，不建持久化服务。缓存命中保留证据与应答身份，不计为新 JEV_CALL。

默认每批 50 家，每请求最多扫描 1,000 家、20 批、30 秒、估算费用 US$0.05。capability 内做下一批费用准入与实际 token 估算结算；金额是估算约束，不是服务商结算账单的硬保证。整个扫描共用 deadline，断线/熔断停止，不换 judge、不把检索分数当资格。
`execution.selection` 保存请求数量、可扫描池、扫描数、确认数、高位未决数、缓存命中、批次、费用与停止原因；同样进入搜索 trace。达到 K 但其前面有 unknown 仍不完整；K 之后同批 unknown 不影响该 TopK。池遍历完且没有 unknown，可如实返回不足 K；预算停止则只能返回已确认部分。

## 离线与构建验收

新增 28 项 M3 检查，覆盖作用域/数量、旧 120 候选之外的成员、高位未决、K 后未决、预算/取消、池耗尽、不补位、原行情名次、同值代码排序、缺失数值、弱相关、缺失/异常答案、失败填充、缓存的 query/fact/corpus/identity 隔离。
全量 `npm test`：597 项 TypeScript + 46 项 Python 通过；后补的两项数量边界与同文件其余检查一起通过，最终 M3 文件 28 项通过。
`npm run build` 通过，保留原有 19 个动态文件 tracing 警告。本次相关文件 ESLint 为 0 error；全仓 ESLint 仍有既存 37 errors（含 .local 历史脚本、debug Inspector、旧研究脚本），未顺手清理。
vendor、corpus、55-query benchmark 和录制答案均未因结果修改。

## Targeted LIVE 与成本

同一 2026-09-30 收盘快照，5,556 可排行行；quote snapshot `2026-09-30_quote_0affe944-ed74-43b3-9492-8c842d508726`，market digest `df7cdc1321b81595`。
身份探针应答 `jev-1.13.0`。两次清空资格缓存的冷重复，各自追加一次暖执行；不是 organic 使用，也不是重跑/替换旧 55-query baseline。

| 查询 | 两次冷执行 | 冷执行调用/耗时 | 每次估算费用 | 暖执行 |
|---|---|---|---|---|
| 涨幅最高的5家机器人公司 | 均扫描550家，完整返回相同5家 | 各11调用；judge 4.67/3.92秒 | US$0.013075 | 0调用/0token |
| 全市场成交额前20中的机器人公司 | 均扫描20家，完整空结果，不补位 | 各1调用；0.31/0.30秒 | US$0.000484 | 0调用/0token |
| 明显放量的机器人公司 | 均扫描1000家，返回9/8家，明确不完整 | 各20调用；7.24/7.27秒 | US$0.023854 | 0调用/0token；仍不完整 |

六次冷执行共 64 次 capability 调用、1,781,744 tokens、估算 US$0.074826；身份探针另有两次（首次脚本把成功探针的 `ok` 误读为 `live`，修正后重跑，不能把这两次隐去）。原始结果与逐项 EvidenceView 保存于 `.local/m3-live.json`。
人工读取输出的主营/主要产品：涨幅前5均有机器人业务原文；放量结果包含业务宽度边界，富佳股份首次得分0.51、第二次未入选。这是 Jev 在资格边缘的重复差异，记录而不添加公司规则、提高阈值或重录结果。M4 应据本人意图区分“包含该业务”与“业务纯度高”；这次不声称所有公司均符合本人最终偏好。

## 本地生产验收

Web/Data 已以最新生产构建运行，保持 :3400 / :8920 两个组件。API smoke 原始件 `.local/m3-api.json`：

| 查询 | Trace | 结果 |
|---|---|---|
| 今天领涨的公司 | `s_murjdp98_5d6610` | 20行，market-only，无Jev |
| 涨幅最高的5家机器人公司 | `s_murjdpng_abd93a` | 扫描550家，5行完整 |
| 全市场成交额前20中的光模块公司 | `s_murjdv12_320d34` | 5行，原行情名次1/2/7/15/20，未补位 |
| 明显放量的机器人公司 | `s_murjdvgt_c0f17b` | 扫描1000家，8行、不完整；复用此前363个业务判断 |

上述 trace 均为 smoke，不计入 M4 本人真实使用验收。下一阶段是 M4：本人实际搜索与反馈；继续保留 M2 的开市时效验收和源端量比基准缺口。

最终数量边界修正后的生产构建已重新启动 Web；再次查询涨幅前5的 trace 为 `s_murjk7ex_281adf`，同样扫描550家、完整返回相同5家。Data `/health` 为 `a-atlas-data` / `ok:true`。最终原始件 `.local/m3-final-api.json`。
