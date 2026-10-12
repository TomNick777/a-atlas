# Atlas 与 a-share-trawler 一次交付合并计划

日期：2026-10-12。状态：工程已实施，按用户最新裁定准备正式切换。依据：[可行性评估](ATLAS_TRAWLER_MERGER_FEASIBILITY_2026_10_12.md)。

## 0. 用户最新裁定：工程合并与模型替代分开验收

2026-10-12 用户明确：Laya 质量需要继续调整训练，这本就是正式项目的一部分；目标是训练到可以替代 Jev。此裁定覆盖下文旧的“所有 Laya 质量问题必须在切换前解决”的要求，旧条款保留执行背景，不再作为工程合并的阻断条件。

正式切换要求统一运行、双 provider 显式选择、事实/证据/失败契约、身份与缓存隔离、独立训练/精确恢复、候选拒绝和故障恢复、数据迁移及 Harbor 登记可靠。使用已登记的原 v4.1 作为显式选择的现有基线，不称为已达到 Jev 质量；不合格新候选仍不晋升。原基线重新装载和实际 SHA 校验、失败候选拒绝与故障恢复是本次模型生命周期验收；合格新候选的真实晋升/跨版本回退随持续训练完成，不为演练伪造 qualified 报告。

两 provider 各两轮冻结质量测试、独立关系/解释准入与替代判定转入正式项目持续训练，不删除旧观察、不修改题目/标签、不降低候选晋升门槛。账户额度未耗尽；本轮用户预算为新增 Jev 费用 0，工程验收使用已有真实 Cloud 记录、未变化的云端 wire/契约测试和本地运行检查，不追加 Cloud 请求。日后模型替代验收另登记预算与冻结环境。

替代目标及训练纪律见 [Laya 持续训练目标](LAYA_REPLACEMENT_OBJECTIVE.md)。工程切换完成不表示 Laya 已替代 Jev；该质量目标仍保持未完成。

## 1. 交付定义

以 `D:\workspace\a-atlas` 为唯一开发与运行入口，最终只维护一个 Atlas 产品、一套前端、一套事实语料与查询/检索管线。Jev Cloud 和本地 Laya 显式可选，Laya 训练、断点恢复、评测、晋升及模型回退全部纳入同一工程。

**一步到位 = 一个合并分支完成全部工作，一次总验收，一次正式切换。** 下文是分支内的实施顺序，不拆成多个产品版本。正式切换前旧应用保持可用；验收不完整就继续在合并分支解决，不把缺失的适配留到上线后。最后归档 trawler 产品入口和旧运行登记，保留本地历史与回退快照。

用户可自由选择模型；两个模型判断质量可能不同，逐能力报告差异。两边必须遵守相同事实、证据、结果和故障契约。全部四个既有 capability 与 market eligibility 都须完成适配及验收，不能仅接普通搜索后宣称合并完成。

## 2. 最终产品与范围

| 面 | 最终行为 |
| --- | --- |
| `/` | 统一物理堆、LOGO/文字卡、自然语言发现、行情筛选结果与证据 peek；保持掉落、碰撞、拖拽和弹簧上浮 |
| 设置面板 | 选择 Jev / Laya，显示可用性、实际版本及当前选择；偏好保存，下一次搜索生效 |
| `/stock/:symbol` | 统一公司页：为什么匹配、简介、主营、市场快照与日 K、基础财务、公告、研报；保持单页纵向阅读 |
| `/company/:code` | 重定向到 canonical 公司页，保留可兼容的搜索上下文 |
| `/usage` 与 trace | 统一真实使用记录；显示选定/实际 provider、版本、延迟、缓存与费用口径，训练/验收流量单独标识 |
| 统一 CLI | 启停服务、训练、恢复、评测、登记候选、晋升、模型回退及环境检查 |

本次迁入两个项目已经存在的功能和明确要求的训练管理。trawler 尚未实现的自选、笔记、手动持仓、研究工作台不列为合并交付项；源端量比仍受原数据完整性条件约束。本次不扩展事实 surface、行业词典、查询重写或通用 LLM。

框架统一到 Atlas 当前 Next.js / React / TypeScript / Tailwind / Matter.js 版本，依赖以合并基线 lockfile 为准。Vela 保留 headless 用法、署名和 NOTICE；日 K 为前复权，数据时间及复权口径明确显示。实现前读取实际安装版本的 Next.js 本地指南。

## 3. 最终工程结构

保持 Atlas 根目录 Web 结构，完成下列责任划分。统一 framework 指共用 Web 与领域契约；Python 训练与推理独立于 Web 进程。

```text
a-atlas/
  app/ components/                唯一前端与 API
  lib/atlas/                      公司身份、结果、证据、缓存
  lib/hybrid/ lib/planner/         原确定性查询编译与行情选择
  lib/search/                     唯一生产检索/融合管线
  lib/intelligence/
    capabilities/                 既有四能力 + market eligibility
    providers/jev/                云端调用、准入、重试、身份与费用
    providers/laya/               sidecar 调用、准入、身份与本地资源预算
    contracts.ts registry.ts      通用 provider 契约与请求 context
  services/stock-data/             行情、公司数据、日线 adapter
  services/laya/                   Python sidecar 与身份/模型装载
  training/laya/
    datasets/ trainers/ evaluation/ 训练、评测与恢复代码
    legacy/                       旧 ontology/profile/grader 实验回放
  scripts/                        统一 CLI、数据构建和迁移工具
  tests/ quality/                 工程测试与质量观察分开
  data/                           私有事实、语料、训练输入、运行记录
  models/                         私有权重及本机模型登记
  reports/ .local/                私有验收、训练与回退产物
```

生产 seam 统一为 `lib/intelligence/capabilities`；`components/` 只消费 Atlas presentation，零 intelligence import。旧 `lib/jev/` 生产导入一次性迁完，测试与脚本同步更新；历史 wire fixtures 的 request bytes 不因目录改名变化。旧训练规则只在 `training/laya/legacy` 内可达，架构测试禁止其进入生产。

环境分开：现有 Data `.venv` 保留；`.venv-laya` 管理 Laya 推理/训练依赖，提供固定依赖清单与环境检查。新增 artifact root 参数，迁移后的脚本不依赖旧 `D:\workspace\a-share-trawler` 或固定的 `parents[1]` 层级。

## 4. 双模型契约

### 4.1 选择与身份

引入 `provider: "jev" | "laya"`，服务器配置只接受已登记 provider/model ID。客户端可选 provider；key、endpoint 和实际 checkpoint 路径由服务端管理。默认使用 Jev，用户显式偏好优先；没有 key 不会自动替用户选择 Laya。

每次搜索建立不可变 context：`providerId`、请求模型版本、实际模型/权重摘要、adapter/prompt 版本、capability 契约版本、corpus digest、deadline、trace ID。身份未确认时先按明确探针核验；不复用模型身份未知的成功缓存。搜索中途若权重/云端身份改变，拒绝混合该请求的批次结果并记录原因。

禁止全局 mutable provider 开关。两个并发请求可以各用不同模型，批次、预算、telemetry 与缓存均绑定各自 context。Jev 与 Laya 不自动互相回落；选定模型故障时沿用诚实的 deterministic degradation，显示实际原因。

### 4.2 能力与分数

| 能力 | 共同语义 | 接入要求 |
| --- | --- | --- |
| semantic_match | 对给定事实判断主营是否符合查询；noul | 两边共用查询、事实与 prompt；Laya 校准或补训此头，保留 known 与阈值语义 |
| semantic_relation | 对给定披露事实判断关系；noul | 同时验收送样/候选/意向/供货等强度、方向和披露时点，不从公司名补关系 |
| semantic_comparison | 四档 0–3 相关程度；score | 采用既有四档契约；验证范围、缺失与异常值，不把 grade/3 当匹配概率 |
| evidence_explanation | 判断所给 evidence 是否支持已有判断；noul | 输出只能引用所选证据原文；原判断、provider、权重与事实版本绑定 |
| market eligibility | 复用 match/relation 的严格业务资格 | 按行情集合固定顺序扫描；unknown/失败填充/弱相关不冒充资格，不补位、不语义重排 |

首版保持 Atlas 已有能力语义、prompt 与生产检索/融合行为。Laya 旧 graded 搜索保留为历史实验入口；统一普通匹配使用现有 noul 契约。需要新增 adapter 或校准时独立版本化，不同时改 parser、语料规则或召回规则。

### 4.3 缓存、解释与遥测

发现答案、资格、解释三类缓存均包含 provider、实际模型/权重、adapter/prompt、capability 与 corpus/evidence 身份；发现缓存另含 parser/market 快照，资格缓存继续与行情快照解耦。失败和 unknown 不进入成功资格缓存。

旧结果以不可变 judgement ID/trace 引用原判断。用户换模型后打开旧结果的解释，仍使用原 provider 和原权重；原版本不可用时保留原事实和判断，明确解释暂不可用，不用新模型冒充。现有 query-only 解释查找同步改为精确判断引用，旧链接无法精确恢复时诚实说明。

每次请求记录选定来源和实际回答身份，保留 search trace 唯一性、缓存 replay 关系与观察者零新增调用纪律。新增通用 `JUDGE_CALL` schema；旧 `JEV_CALL` 保留原 schema 与 exporter 读取兼容，不改写历史事件。Jev 使用估算云端费用；Laya 记录 token、GPU/排队/推理耗时，云账单字段不套用 Jev 单价。

## 5. 数据、前端与兼容迁移

唯一生产事实层沿用 Atlas Company Corpus；公司身份以 6 位 canonical code 及 StockIdentity 为准。不拼接两个项目的 companies/profile 文件，不用训练派生标签补事实。

迁移工具先 dry-run 输出清单：源路径、目标路径、SHA-256、用途、冲突处置。执行按清单复制及校验，不覆盖同名不同内容；数据与权重完成二次哈希验证后才登记新路径。LOGO 与日线按 canonical code 合并，冲突另存并验证来源/时间，不凭 mtime 选择。

历史训练、评测和 ontology/profile 快照保留完整版本与来源，运行日志 append-only 保持原文；提供统一 CLI 读取旧记录，不伪造新 trace ID、不把历史成绩改称新 corpus 成绩。`.env.local` 保留已有配置，增加新变量时只输出变量名及配置状态。

Atlas `TrawlerExperience`、EvidenceView 和物理交互作为基线。迁入 trawler 的公司页日线、Vela 生命周期与需要的点击差异；统一 `/api/discover` 入口。旧 `/api/search` 与 `/api/bars` 如保留，均为同一实现的薄兼容入口，不维护第二条搜索/数据管线。

日线数据通过 Data adapter，明确 `OK / EMPTY / UNAVAILABLE / ERROR`，附来源、抓取时点、交易日、复权与币种/单位。验证代码、时间顺序、OHLC、成交量和复权口径，坏缓存与读失败不得显示“这家公司没有数据”。图表缺失不阻塞公司页其余内容，卸载销毁实例。

## 6. Laya 训练完整链路

### 6.1 输入与训练

提供历史回放模式与 Atlas corpus 模式，两种模式均可在统一工程运行，输入路径/manifest 显式固定。后续面向产品的训练使用冻结 corpus、对应 prompt 和能力版本；训练四能力所需任务样本，不以行业补丁替代能力适配。

真实失败 trace 进入待审核样本队列。标注必须绑定原文证据与任务定义，记录人工/既有教师/规则标签的来源；Jev 分数不自动当真值。训练、validation、独立盲测和冻结质量集隔离，整组同义表述及同一来源派生样本按组防泄漏。冻结 discovery query/anchor 不改、不进入训练。

复用 RLCD trainer 与既有 checkpoint，补齐统一配置和任务数据构建。继续微调加载权重；精确恢复同时保存 optimizer、scheduler、Python/NumPy/Torch/CUDA RNG、epoch、采样游标、数据 manifest、配置和软件版本。恢复输入身份不符时拒绝，避免“恢复”到另一份数据。

训练输出专属 run/candidate 目录，best/last/resume checkpoint 原子落盘；取消后保留最近完整恢复点。训练进程不写 active 权重、不更新生产 corpus，不被 Web 重启连带停止。任务状态至少包含 queued/running/checkpointing/completed/failed/cancelled，报告实际进度与错误。

### 6.2 推理与训练资源

Laya sidecar 用单实例装载固定 active 权重，GPU 推理有准入与截止时间。训练启动前检查 GPU 与正在使用的推理任务。

单卡操作提供明确的“使用 Jev 并训练 Laya”：用户执行该操作后，完成/截止已有 Laya 请求，停止 sidecar 释放显存，再启动 trainer。若用户保持 Laya，训练任务等待推理资源释放并明确状态；不偷偷换 judge、不无条件同时抢占 GPU。

训练完成不自动改变 provider 偏好或 active 版本。原 active 权重可重新启动；失败候选保留诊断，Web/Data 持续可用。无 CUDA 的环境可运行 Jev 产品，Laya 训练明确 unavailable。

### 6.3 评测、晋升与回退

本机模型登记至少包含 model ID、parent、artifact SHA-256、数据/prompt/capability 身份、评测出处、candidate/qualified/active 状态。V4.1 和 V4.2-B 保留原身份；合并不自动晋升 V4.2-B。

候选完成四能力与资格验收，报告相对 active 与 Jev 的逐能力差异。晋升动作先停止准入并排空在途调用，加载候选、核验实际 SHA 和能力健康，再原子更新 active 登记并使旧缓存失效；失败恢复原 active。旧版本保留，支持同一流程退回先前版本。冷装载造成的服务空窗如实显示，不声称双实例无缝热换。

拟交付统一命令，名称在本次实现中固定：

```text
npm run atlas:doctor
npm run atlas:start / atlas:stop
npm run laya:serve / laya:status
npm run laya:data -- --mode=corpus --manifest=<id>
npm run laya:train -- --config=<file> --init=<model-id>
npm run laya:resume -- --run=<run-id>
npm run laya:cancel -- --run=<run-id>
npm run laya:evaluate -- --candidate=<id>
npm run laya:promote -- --candidate=<id>
npm run laya:rollback -- --to=<model-id>
```

统一命令解析实际 Python 环境、路径和模型身份，失败退出码可靠；旧脚本转为有明确模式的入口或历史回放包装，移除 `ATLAS_LAYA_LANE=1` 可把 Laya 实验误打到 Jev 的逃逸路径。

## 7. 运行、Harbor 与公开发布

Atlas 只登记一个应用：Web `3400`、Data `8920`、可选 Laya `8787`。训练是独立任务，不是常驻健康服务。Jev 为外部依赖。Web/Data 的核心健康与选定判断来源的健康分列；不用未选择的 Laya 故障把 Jev 模式标坏，也不用 HTTP 200 冒充模型身份/数据完整性。

修改启动脚本、健康/runtime API 与 Harbor 的 AppRuntimeSpec，按选择启停 Laya，确认 service 身份及 PID 所属。trawler 原 `7488` 登记在总验收通过后的正式切换中停用。Harbor 仓库变更是完整交付的配套依赖；若本次环境无法验证登记，整体切换待完成，不写“已合并”。

Atlas 原创代码 Apache-2.0 及数据私有范围维持；选择性迁代码，不 merge trawler 旧 refs/history。补齐模型、恢复状态、dataset manifest 及真实响应的私有路径/后缀审计，保留第三方许可与 Vela/Laya notices。完整本地验收与无私有数据的公开 CI 都可运行；公开 CI 无 LIVE 调用。

## 8. 分支内实施顺序

拟用 `codex/atlas-trawler-merge` 集成分支。建立分支前区分、保存现有未提交成果；迁移基线包括 Atlas 盘中修复和 trawler 公司页工作，不能只取 HEAD。

| 顺序 | 工作包 | 必须形成的可审查产物 |
| --- | --- | --- |
| 1 | 固定输入与回退点 | 两仓 HEAD/dirty inventory、私有文件哈希、运行登记/配置备份、迁移 dry-run、验收 preregistration |
| 2 | 中性 intelligence seam | 请求 context、两个 adapter、四能力/资格贯通；Jev payload 与旧结果回放对账 |
| 3 | 缓存/解释/telemetry | 并发及模型切换隔离；精确 judgement 引用；新旧 trace schema 兼容 |
| 4 | 统一前端与数据 | 设置模型选择、canonical URL、日 K adapter、物理/证据回归；重复生产实现清理 |
| 5 | 训练与模型生命周期 | corpus 数据构建、历史回放、微调、恢复、取消、独立评测、晋升/回退与资源协调 |
| 6 | 全能力质量收尾 | Laya 需要的适配/校准/补训；固定环境两轮比较；所有问题在分支内完成 |
| 7 | 配套与总验收 | startup/health/Harbor、许可与发布审计、文档/规则更新、可运行总包和回退演练 |
| 8 | 一次正式切换 | 合入主线、启动统一应用、旧入口停用归档、最后一次端到端核验及交付报告 |

实现可以有多个内部提交，但不给用户留下多套需要手动同步的产品仓库或半成品发布。旧代码删除以迁移清单和唯一调用链验证为依据，历史私有数据不随清理删除。

## 9. 总验收门槛

### 9.1 工程与不变量

以下全部通过；每项至少具备适当的自动验证或可回指的端到端记录：

- 有 key + Laya 同时可用时两边都能明确选择；无 key、无 GPU、sidecar 未启动均显示准确状态。
- Jev/Laya 并发、多批次与切换请求不会串用模型、预算、缓存或 trace；身份漂移拒绝混合结果。
- 四能力的字段、分数范围、known、evidenceRefs 与失败状态正确；解释逐字引用，不编造关系、出处或数值。
- 业务内 TopK/行情 TopN 子集保持原 M3 契约；超预算、高位未知及失败批次如实不完整。
- 老结果在换模型/权重后解释仍绑定原判断；版本缺失可审查，不产生另一模型解释。
- 图表与公司数据区分 EMPTY/UNAVAILABLE/ERROR，正常/损坏/不存在/无覆盖输入均验证。
- 物理堆、举牌排序、hover、点击与拖拽、卡面切换和响应布局通过浏览器检查。
- 一次 corpus 模式受控训练真实完成权重更新；故障/取消后恢复点可用，恢复身份一致；既有历史任务可回放。
- 一次受控候选晋升和模型回退均核验 active 实际 SHA；失败加载恢复旧版本，不留下半写 registry。
- 训练资源协调、Web/Data 停启、可选 Laya 和 Harbor 应用登记通过真实运行验证。
- 完整本地测试、Python Data 与 Laya 子集、typecheck、生产 build、corpus/market 对账、公开测试子集及 publication 检查通过。

测试聚焦本次高影响边界，不给每个目录搬迁或相同包装编写重复测试。与本次无关的 M2 源端量比/持续盘中条件保留原状态，不因合并记为 PASS。

### 9.2 模型质量

沿用现有冻结 benchmark 及版本，逐 family/capability 输出，不生产总分。固定 Atlas commit/corpus、market 输入、query/anchor、prompt、能力版本与实际模型身份；两 provider 各跑至少两次，记录稳定性、错误类型及人工标签。

关系强度、方向、披露时点、证据解释另用训练前冻结的独立验收样本，包含缺事实、相邻业务、意向/候选/送样与已执行关系等边界。确定性输出约束必须零违规；人工发现输出声称强于证据、引用不支持判断、关键任务出现系统性盲区时，该 candidate 不晋升，先处理后重验。普通排序差异逐族报告；不以两个模型必须给同一排序作为通过条件。

样本清单、规模、人工裁定规则与能力准入门槛在调用模型及训练前预注册，绝不看结果后删题、降门槛或换标签。现有冻结 benchmark 仅观察，不能通过 query/company/industry 特定生产规则修结果；新训练样本与冻结验收表达按组隔离。

LIVE 仅在分支内最终模型行为验收使用，设置明确费用/调用上限并逐请求落账；达到上限停止，报告未完成部分。不得为补统计自动追加云请求。质量差异不隐去；若 Laya 某能力未完成准入，整体仍未达到本计划的一次交付标准。

## 10. 正式切换与回退

总验收前准备本机完整回退包：旧代码/构建、未提交成果、两应用登记、非敏感配置描述与本机配置备份、active registry、路径映射、私有文件哈希。旧数据和旧权重不搬空；先验证复制，再将统一应用引用改向新路径。

正式切换顺序：停止旧应用准入 → 等待/截止在途请求 → 备份最后增量日志与状态 → 停止确认属于两旧应用的进程 → 启动统一 Data/Web 及需要的 Laya → 核验身份/版本/数据/公司页与双模型搜索 → 更新应用登记并归档 trawler 开发入口。切换失败恢复已验证的旧启动方式与登记。

回退只还原代码、配置与 active 指针，不回滚删除追加日志或新训练产物；回退应用读自己的独立状态目录。演练覆盖“新服务起不来”“模型身份错误”“候选装载失败”，记录操作及结果。现有未提交内容不通过 reset/覆盖丢失。

## 11. 文档与规则同步

同一次交付更新 `AGENTS.md`、README、PROJECT_STATE、启动说明、公开发布说明、数据声明和第三方 notices；明确修改 Jev-only、Laya 归属、运行服务数量与共用 capability seam。将 Jev-First 原则表述为 Atlas owns facts / selected judge owns judgement，保留原确定性 parser 与事实纪律。

旧冻结文档保留历史，增加指向合并契约的现行说明；architecture tests 固定新边界。修正仍把 Research `8910` 当现状的入口文档，旧实验报告与 commit 引用原样保存。配套 Harbor 文件与验收记录一起列入交付清单。

## 12. 工作量与完成标准

对比此前评估的一般工程整合，本计划增加了完整能力准入、精确恢复、迁移/回退验证和 Harbor 配套。粗估 **工程工作 10–15 个工作日**，另加 Laya 必要补训、标注与质量验收时间；后者尚无可靠上限。一步到位约束交付完整性，不把研究不确定性改写成工期承诺。

最终必须能在 Atlas 目录完成：安装/检查环境 → 启动唯一应用 → 两模型完整切换 → 展示可审查结果 → 从冻结语料继续训练/恢复 → 评测候选 → 晋升/回退 → 停止服务。日常操作零依赖 trawler 的绝对路径和开发进程。

交付包包含代码变更、迁移 manifest、逐项总验收、逐能力质量矩阵、模型/数据身份、训练恢复及晋升回退记录、Harbor 登记与切换记录、公开发布检查。以上未齐全时任务保持未完成，不以“开关已能用”替代合并完成。
