# 搜索质量主线

2026-10-16 用户明确要求：“以搜索质量作为主线，把行情等其他功能剥离开”。唯一工作目录是本机 `D:\workspace\a-atlas`。本记录覆盖旧行情里程碑的当前产品范围；历史完成状态、数据、真实响应和原答案不重写。

## 产品与数据流

自然语言 → 现有 corpus 检索 → 明确选择的 Jev / Drex / Laya 判断 → 有证据的公司结果 → 公司业务资料。

只保留发现 `/` 与公司 `/stock/:symbol`。物理堆及交互不变。公司页保留搜索记录、证据、简介、主营业务/产品与原有标签，移除图表、市场快照、财务、公告列表和研报列表。公告和年报作为事实来源仍然保留，去掉展示不等于删除 corpus 证据。

## 梳理与分类

| 分类 | 文件/入口 | 处理与依据 |
| --- | --- | --- |
| mainline | `lib/search/pipeline.ts`、`lib/corpus/`、`lib/intelligence/capabilities/` | 保留事实、召回和显式 judge seam；不换算法、模型或训练数据 |
| mainline | `lib/discovery/query.ts`、`app/api/discover/route.ts`、`app/api/search/route.ts` | 独立公司发现入口，原文交检索；不再执行行情与混合查询 |
| mainline | `lib/atlas/discoverCache.ts`、`lib/telemetry/discover.ts` | 去掉行情/交易日历读取；新契约隔离旧答案缓存，继续保存每次 trace |
| mainline | `components/TrawlerExperience.tsx`、公司页、证据组件 | 直接呈现服务端公司顺序、证据与失败语义 |
| compatibility | `lib/hybrid/execute.ts`、`lib/hybrid/discoverCacheKey.ts`、旧合成测试与冻结回放 | 保留旧工程与榜单契约；冻结回放不能替代当前产品质量验收 |
| maintenance | `lib/market/`、`app/api/market/`、`app/api/bars/`、`market:*`、`hybrid:query` | 独立维护，退出搜索链；不自动执行，不继续扩建 |
| compatibility | `CompanyDataSections`、`DailyChart`、`lib/stockdata/`、Data service | 从公司页解除挂载，保留外部调用与旧测试；确认所有调用方迁移后才能物理删除 |
| maintenance | Web + Data 受管启动与探活、Harbor 配套 | 当前不变；本轮不操作外部登记或停止已有进程 |
| support | Laya 训练、provider 升级预检、内部 `/usage` | 保留独立支撑能力；其工程完成不等于发现质量改善 |
| runtime-output | `data/`、`reports/`、模型/训练/遥测/答案缓存 | 原位保留且不公开；不迁移、不清理真实数据 |

维护成本集中在行情时点、排序集合、资格扫描、预算完整性与跨页行情恢复；这些不再是当前产品迭代对象。旧源码不立即批量删除，避免破坏 CLI、冻结回放、受管服务与未完成的既有工作。

## 本轮改动与验证设计

1. 主线使用原 grammar 作范围闸门。行情/混合条件原样拒绝，不去掉条件后搜索业务残留；无法编译的指标比较亦拒绝，原有不支持原因保留。编译不读行情、不请求模型。
2. 使用原 `runSearch`，保留候选、分数与服务端顺序。展示层只保留已有截取范围内 `matched=true` 且携带证据引用的 live 行；不补位、不改分、不重新选择证据。无匹配返回诚实空结果；DEGRADED 仍显示基础检索且无伪造 judgement。
3. 产品缓存钉 `company-discovery-1`、corpus、judge、parser 与原查询，大小写不同不混用。历史持久化答案原样读取，新缓存不回吐旧行情或九张填充结果。
4. 公司页不挂载外部数据组件；新搜索不展示行情指标。旧 trace 的行情内容仅作为历史记录可读，不调用当前 Data 或重新搜索。

| 核心能力 | 验证路径 | 完成判据 |
| --- | --- | --- |
| 范围闸门 | `company_discovery.test.ts`、CLI `search:query -- --explain` | 行情与混合请求无检索/判断调用，业务原文不改写 |
| 匹配资格/空结果/降级 | `company_discovery.test.ts` | 明确拒绝及缺证据不填充；降级有标记且无 judgement |
| 缓存隔离 | `company_discovery_cache.test.ts` | 不 import 行情 state，corpus/judge/原文变化使 key 变化 |
| API 与历史别名 | `discovery_route.test.ts` | 接入独立执行器，每次 trace，缓存回放零执行，异常可追踪 |
| 公司资料与原证据 | `search_context.test.ts`、`search_context_persistence.test.ts` | 数据组件不可用时页面仍可读，历史答案/证据不被当前环境替换 |
| 旧维护能力 | 原 market/hybrid/parser/telemetry 测试 | 保留旧契约与回放，不把其 PASS 记为新发现质量 |
| 构建/发布 | typecheck、相关 lint、build、publication:check | 无类型/构建/私有发布问题 |

## 工作区归属

本轮开始前工作区已有模型升级/Drex 接入、M5 历史搜索恢复、训练输入诊断等未提交内容，包括 `AGENTS.md`、`PROJECT_STATE.md`、发现/缓存/公司页与模型/telemetry 文件。本轮以这些成果为基础进行定点修改，不回滚、不暂存、不提交、不推送已有成果。新增主线模块、CLI、测试与本文档属于本轮；原有训练诊断、模型配置和本机产物保留独立归属。没有因瘦身删除真实数据、模型、历史报告或依赖包。

## 搜索质量如何推进

以真实失败为输入，逐条记录原查询/trace、期望公司及可靠依据，然后沿事实是否存在、是否进入候选、judge 是否判对、返回/展示是否合理、是否运行失败进行归因。修复通用机制，不把期望名单写进生产词典。重点观察应发现公司的召回、前列证据是否直接、无答案时是否诚实；不合成掩盖局部问题的单一总分。

本轮去掉无匹配填充，只修正结果资格与产品范围；没有补产品事实、重建语料/向量、训练或升级模型，不能宣称之前的真实漏召回已经修好。冻结 benchmark 保留原题与回放坐标；若要证明当前产品质量改善，必须显式使用当前入口与固定环境，不能将兼容执行器结果冒充主线验收。Cloud 调用仍为 0，LIVE 的预算纪律继续有效。

## 验证结果

- 全量 Vitest：53 个文件、678 项通过；Python 原有数据/训练隔离/生命周期/准入测试共 65 项通过。旧 M5 `searchContext.ts` 已获授权的保留模块补入 Refocus 白名单，原研究栈隔离仍通过。
- 新主线测试覆盖范围拒绝、指标比较拒绝、原文传递、拒绝结果不填充、缺判断/证据、降级、缓存/大小写/模型隔离、trace/cache replay、旧 API 别名，以及 Data 展示组件不可用时公司页仍可读。
- 实际 `runSearch` 使用本机 corpus 与已有本地模型向量记录跑通一次完整离线召回，不替换生产 embedding、不生成假向量、不调用 judge 或行情服务。另核对 `search:query -- --explain` 的业务/行情两条 CLI 输出。
- `npm run typecheck`、本轮相关 ESLint（0 warning）、`npm run build`、`npm run publication:check`、`git diff --check` 通过。生产构建审计 24 个 trace，打包模型产物 0。
- `corpus:check`：5,567 份公司文档，digest `a5db7e5d994e1c04`，逐字节一致。维护侧 `market:check`：冻结 2026-09-28 共 5,561 行，digest `4eada12b5858983d`，逐字节一致；不代表当前实时行情验收。
- Cloud 调用 0；未重建语料/向量、刷新行情、训练、切换 active、启动/重启应用或修改 Harbor 登记。未做运行态浏览器走查或 LIVE 搜索质量验收；已完成的离线/构建检查不冒充这些验收。
- 工作区原有改动保留，未暂存、提交或推送；本轮没有遗留临时诊断文件。
