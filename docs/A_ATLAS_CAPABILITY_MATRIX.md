> **HISTORICAL / RETIRED（2026-09-28 Refocus）**
> 本文档描述的 Vibe AStock 集成架构已从当前产品与运行时中整体退役
> （`docs/VIBE_REMOVAL_INVENTORY.md`）。内容未经改写，仅作为当时真实发生过的
> 架构证据保留；当前事实以 `PROJECT_STATE.md` 文首「Refocus · Data Foundation」为准。

# A-Atlas — Capability Matrix（Phase 0 产出，Phase 2 收口增补 §7，Phase 3 增补 §8，Phase 4 增补 §9）

> 规则：**Vibe AStock 的每一项产品能力都必须出现在本表。不允许「没迁所以删掉」。**
> `DEFER-UI` 只表示暂时不作为显眼入口，绝不表示删除能力——其底层 service/代码原样保留。

**Disposition 图例**

| 标记 | 含义 |
|---|---|
| PRESERVE | a-share-trawler 现有能力，原样保留，禁止为整合而动 |
| SERVICE | Vibe Python 能力**原样保留为 service**（不重写其逻辑），A-Atlas 经 API 适配层调用 |
| ADAPT | 代码迁入 A-Atlas 并适配（统一 StockIdentity / 导航 / 视觉） |
| MERGE | 与 trawler 现有能力合并为统一 domain |
| DEFER-UI | 能力保留、Phase 1 不做显眼入口（service 与数据完好） |
| OUT-OF-SCOPE | 能力真实存在且未被删除，但**不在 A-Atlas 运行时内**——归属 a-share-trawler（独立项目、独立 sidecar）。是归属切分不是移除（Phase 4） |

Phase 列：P1 = 本轮；P2 = 下一轮（service 接线 + 主要页面）；P3 = 后续；P4 = Phase 4（Jev Cloud 切换 + 运行时解耦）。

**Phase 2 运行态标记**（§7 增补）：`LIVE` = UI + service 真实数据全链路（浏览器验收过）；
`SERVICE-LIVE` = service 真实可用、UI 未点亮；`UI-LIVE` = UI 已亮但仅部分子能力；
`DEFER-UI` / `P3` = 维持原 Phase 判定。逐项见文末 §7。

**Phase 4 运行态标记**（§9 增补）：判断类能力的现行状态一律写全称
`A-Atlas Discover: Jev Cloud — LIVE`（唯一的语义判断 provider）；已移出本仓运行时的写
`OUT-OF-SCOPE / separate project` 并指明归属项目。逐项见文末 §9。

---

## 1. 发现 Discover（来自 a-share-trawler，全部 PRESERVE / P1；判断 provider 的 Phase 4 现状见 §9）

| Capability | a-share-trawler 源 | Vibe 对应物 | A-Atlas 目标位置 | Backend | UI | Migration | Phase |
|---|---|---|---|---|---|---|---|
| 自然语言公司搜索（QuerySpec→RRF→Laya 重排 → **P4：Jev Cloud noul 重排**） | `lib/search/*`, `app/api/search` | — | `/` | Next API + ~~Laya sidecar~~ **Jev Cloud**（P4，见 §9；检索层零改动） | 现有 | **PRESERVE** | P1 |
| 5567 家公司池 + company profile | `data/companies.json`（371MB tracked） | `stock_info_a_code_name` 类散装源 | `/` + `/stock/:symbol` | 静态数据 | 现有 | **PRESERVE** | P1 |
| 物理堆（掉落/堆积/碰撞/拖拽/弹簧上浮） | `components/floor/*`（matter-js） | — | `/` | — | 现有 | **PRESERVE** | P1 |
| 公司牌（简称+代码+匹配度标签+申万行业色） | `components/floor/plates.ts` | — | `/` | — | 现有 | **PRESERVE** | P1 |
| Jev 判断（TypeSafe key / Laya sidecar / mock 三态 → **P4：Jev Cloud / DEGRADED 二态**） | `lib/jev/*` | Vibe provider 层（各自独立） | `/` 后端 | ~~laya_server.py~~ **A-Atlas Discover: Jev Cloud — LIVE**（`jev-1.13.0` 经 `identityProbe()` 核验；不可用=检索排序+如实 DEGRADED，**无本地回落**） | — | **PRESERVE**（能力）+ **ADAPT**（P4：provider 换云） | P1 |
| 搜索遥测 / search_log / organic shadow | `lib/telemetry/*` | — | 全产品 | Next API | — | **PRESERVE**（点击公司牌复用 `RESULT_OPEN_DETAIL`） | P1 |
| 卡片配色设置（经典米白/申万行业） | `components/SettingsPanel.tsx` | — | `/` 左下角（次级） | — | 现有 | **PRESERVE** | P1 |
| 健康检查 | `app/api/health` | `/api/health`（同名不同义） | `/api/health`（Next） | — | — | **PRESERVE**（Vibe 的归 Vibe service；P4 起字段含 `judge{provider,model,breaker,identity}`） | P1 |
| Laya 本地判断模型（:8787 sidecar、V4.1 checkpoint、训练/评测/晋升实验道） | a-share-trawler `scripts/laya_server.py` + `models/` | — | **不在 A-Atlas**（provenance 留在本仓 `reports/LAYA_*.md` 与 `scripts/laya_*`） | a-share-trawler 私有 | — | **OUT-OF-SCOPE**（P4 归属切分；会经 `lib/jev` 打到云的 7 个脚本由 `requireLayaLane()` 拦下） | P4 |

## 2. 市场 Market（来自 Vibe，UI 收口到 `/market`）

| Capability | Vibe 源（route / API） | A-Atlas 目标位置 | Backend | UI | Migration | Phase |
|---|---|---|---|---|---|---|
| 盘面数据（大盘指数/隔夜外围/自选行情/乐咕+东财双口径情绪/成交 TOP20/板块资金趋势/资金轮动/解禁日历/自动刷新） | `/daily-review`；`/api/indices` `/api/market/overseas` `/api/market/emotion` `/api/market/live-emotion` `/api/market/overview` `/api/market/turnover-top` `/api/lockup-calendar` | `/market` · 盘面 | Vibe FastAPI `vr/`+`duanxian/` | 重建于 A-Atlas | **SERVICE**+UI ADAPT | P2 |
| 实时动态·盯盘（3 秒异动流/持仓/自选/500 亿大票/昨日成交前十/星标） | `/watch`；`/api/monitor/watch` `/api/monitor/snapshot`（`vr/watchtower.py` 线程） | `/market` · 实时动态 | 同上 | 重建 | **SERVICE** | P2 |
| 昨日梯队（连板分组 + 今日表现） | `/yesterday-ladder`（`vr/previous_ladder.py`） | `/market` · 昨日梯队 | 同上 | 重建 | **SERVICE** | P2 |
| 盘中核验（竞价强弱/今日情绪路径/手动快照） | `/agent/intraday`；`/api/intraday/auction` `/api/intraday/path` `/api/intraday/capture` + 60 秒调度线程 | `/market` · 盘中核验 | 同上 | 重建 | **SERVICE** | P2 |
| 每日复盘 AI 报告（生成/重生成/取消、历史归档、引用证据、上期核验、验证项、Agent 追问） | `/agent/review`；`/api/review-agent/daily*` `/api/review/latest|dates|expected-date|capture` `/api/verification/*` `/api/observations/*` `/api/review-agent/turns|conversations` | `/market` · 每日复盘 | Vibe `review_agent/`（SQLite/冻结输入/grounding 原样） | 重建 | **SERVICE** | P2–P3 |
| 首板分析（首板表+涨停原因+逐股 AI 深入+批量） | `/first-board`；`/api/market/first-board`（`vr/firstboard.py`+问财） | `/market` · 首板分析 | 同上 | 重建 | **SERVICE** | P2 |
| 近 5 日热度 + 龙头谱系 | `/heat`；`/api/weekly` `/api/weekly/refresh`（`duanxian/weekly.py`） | `/market` · 近 5 日热度 | 同上 | 重建 | **SERVICE** | P2 |
| 历史统计（涨停样本 20/30/60/90 天回测/封板时间曲线/归档与漂移） | `/backtest`；`/api/backtest*` `/api/archive/summary` `/api/drift*` | `/market` · 历史统计 | 同上 | 重建 | **SERVICE** | P2 |
| 资讯雷达（12 轨 RSS + AI 摘要 + 自选公告/新闻聚合） | `/intel`；`/api/radar` `/api/radar/refresh`（`vr/newsradar.py`） | `/market` · 资讯 | 同上 | 重建 | **SERVICE** | P2 |
| 事件概率（Kalshi/Polymarket 宏观事件定价） | `/intel` tab；`/api/review-agent/macro-probability`（`research_data/sources/probability.py`） | `/market` · 资讯 | 同上 | 重建 | **SERVICE** | P2–P3 |
| 行业涨跌排名 | `/api/industry`（已定义、Vibe 页面未引用） | `/market` 内部数据源 | 同上 | — | **SERVICE**（DEFER-UI） | P2 |
| K 线（日/周/月/60 分，mootdx 可选） | `/api/kline`（缺依赖返回 501） | 个股研究内部 | 同上 | DEFER-UI | **SERVICE**（DEFER-UI） | P3 |
| Vibe 首页 feature grid + 每页「问 AI」工作台对话 | `/` Home + `WorkspaceChat` + `AskAiButton` | 分散并入各 A-Atlas 页面（Phase 3 统一 AI 入口） | `review_agent/chat-jobs` | 重建 | **MERGE** | P3 |

## 3. 研究 Research（来自 Vibe，入口收口到 `/research` 与 `/stock/:symbol`）

| Capability | Vibe 源（route / API） | A-Atlas 目标位置 | Backend | UI | Migration | Phase |
|---|---|---|---|---|---|---|
| 个股研究（行情+估值指标 26E EPS/前向 PE/PEG、财报速览、PE/PB 五年分位、财务关键指标、研报 PDF、公告、新闻、融资融券/股东户数/主力资金/派息/大宗、龙虎榜席位、解禁 90 天+历史、板块/概念归属+热门概念命中、互动易问答；分源优雅降级+缺口如实列表） | `/stock-data`；`/api/quote /api/valuation /api/valuation/percentile /api/financials /api/reports /api/news /api/announcements /api/margin /api/block-trade /api/holders /api/dividend /api/fund-flow /api/dragon-tiger /api/lockup /api/blocks /api/hot-concepts /api/investor-qa`（`vr/astock.py` 882 行数据层） | `/stock/:symbol` 研究区 tabs + `/research` · 个股研究 | Vibe FastAPI 原样 | 重建于公司页 | **SERVICE**+UI ADAPT（symbol 统一为 canonical） | P2 |
| 多空辩论 / 个股深挖（四维分析师+正反辩论+裁判、冻结资料 sha256、逐节追问、最近报告） | `/agent/deepdive`；`/api/review-agent/deepdive*`（`duanxian/deepdive/` graph + review_agent job） | `/stock/:symbol` · AI 分析 tab + `/research` · 多空辩论 | 同上 | 重建 | **SERVICE** | P2 |
| 策略回测（自然语言→条件确认→回测、权益曲线、成交导出 zip、报告列表、恢复中断请求） | `/backtest-agent`；`chat-jobs(task_kind=backtest)` + `backtest/` 引擎 + `research_data/fetch_backtest`（baostock/yahoo） | `/research` · 回测 | 同上 | 重建 | **SERVICE** | P2–P3 |
| 全球股票（美股/港股行情+关键财务） | `/stock-data` global view；`/api/global/stock` `/api/global/indices`（`vr/gstock.py`） | `/research`（Phase 3 决定入口形态；A-Atlas 主聚焦 A 股） | 同上 | **DEFER-UI** | **SERVICE**（DEFER-UI） | P3 |
| 复盘证据/归档基础设施（永久归档+字段漂移+SHA256 冻结输入+引用契约） | `duanxian/archive.py`、`review_agent/{grounding,evidence}.py` | 随复盘/深挖一起经 service 暴露 | 同上 | — | **SERVICE**（PRESERVE 语义） | P2 |

## 4. 我的 My（来自 Vibe，收口到 `/my`）

| Capability | Vibe 源（route / API） | A-Atlas 目标位置 | Backend | UI | Migration | Phase |
|---|---|---|---|---|---|---|
| 自选股（批量加码、行情总览、AI 读自选；现 localStorage `vr-watchlist` ≤100） | `/watchlist`；`/api/quote?codes=` | `/my` · 自选 | 自选列表 ADAPT 迁 A-Atlas 持久层；行情走 Vibe service | 重建 | **ADAPT** | P2 |
| 持仓（由交易日志成交聚合=单一事实源；legacy portfolio.json 导入） | `/portfolio` `/my-stocks`；`/api/positions` `/api/positions/import-legacy` | `/my` · 持仓 | Vibe service 原样 | 重建 | **SERVICE** | P2 |
| 交易日志（记一笔/计划退出/成交明细/费率/自我体检/交易流水） | `/journal`；`/api/journal/*`（`duanxian/journal.py`） | `/my` · 交易日志 | 同上 | 重建 | **SERVICE** | P2–P3 |
| 个人风控（规则宪法/在险资金/权益曲线/MFE-MAE/归因四象/违规收件箱/风控报告/「纪律值多少钱」） | `/journal` 内；`/api/risk/*`（`duanxian/risk.py` 等） | `/my` · 风控 | 同上 | 重建 | **SERVICE** | P3 |
| 模式卡（打法版本+分版本统计+对比） | `/api/modes*` | `/my` · 打法 | 同上 | 重建 | **SERVICE** | P3 |
| 研究记录（本地 AI 笔记：搜索/重读/导出 JSON/删除；localStorage `vr-notes`） | `/notes` | `/my` · 研究记录 | 笔记 ADAPT 迁 A-Atlas 持久层 | 重建 | **ADAPT** | P2 |
| 已上传研报（用户 PDF + index） | `/api/myreports*`（`vr/myreports.py`） | `/my` · 已存报告 | 同上 | 重建 | **SERVICE** | P3 |
| 旧持仓 portfolio.json 双轨数据 | `vr/portfolio.py`（启动备份守卫） | 仅作为导入源 | 同上 | — | **MERGE**（并入日志聚合持仓，保留导入器） | P3 |

## 5. AI 与平台（Vibe provider / job / evidence / 运维）

| Capability | Vibe 源 | A-Atlas 目标位置 | Migration | Phase |
|---|---|---|---|---|
| AI provider 接入（订阅 Codex/Claude/CodeBuddy + API 兼容 DeepSeek/GLM/Kimi/Qwen/OpenAI/硅基流动/…/自定义；测试连接 job；OAuth 登录流） | `/settings`；`/api/review-agent/access*` `/api/review-agent/status` `/api/subscriptions/*`（`review_agent/runtime.py` 固定 Codex 引擎 + `runtime/bridge`） | A-Atlas 设置（次级位置，Phase 3 收口为统一 AI Connection） | **ADAPT**（UI 收口、provider 层不动） | P3 |
| 受限 Agent 运行时（只读沙箱/MCP 白名单工具/引擎看门狗/单任务准入/取消/恢复） | `review_agent/{runtime,api,engine_guard}.py` | Vibe service 内原样 | **SERVICE**（PRESERVE 语义） | P2 |
| 任务/job 机制（request_id 幂等、SQLite 会话、轮询、720s 恢复、events 轨迹） | `review_agent/{store,chat_jobs,daily}.py` | 同上 | **SERVICE** | P2 |
| 交易建议网关（product_policy 正则闸门） | `review_agent/product_policy.py` | 同上（A-Atlas 延续「不是投资建议」披露） | **SERVICE** | P2 |
| 旧版复盘/深挖 CLI（`main.py`、LangGraph 5 分析师图） | `main.py` + `duanxian/review_graph.py` | Vibe service 兼容保留（Web 主流程已是 review_agent） | **SERVICE**（DEFER-UI） | P3 |
| 旧 API 兼容语义（`/api/chat`、`/api/review/run`、`/api/deepdive/run|chat` = 409 升级桩） | `server.py` | Vibe service 原样（合并所有权规则不变） | **SERVICE** | P2 |
| 安全中间件（host 白名单/Origin 校验/Bearer `VR_API_KEY`/单实例锁/96KB 正文限幅） | `server.py` + `review_agent/api.py` | 同上 | **SERVICE** | P2 |
| 盘中调度线程（6 槽快照 09:25→15:00）+ watchtower 3 秒轮询 | `server.py` lifespan + `vr/watchtower.py` | 同上 | **SERVICE** | P2 |
| Windows 启动器/doctor/setup（`scripts/manage.py`） | `启动 Vibe AStock.cmd/.command` | 并入 A-Atlas Harbor AppRuntimeSpec（多 service 拓扑） | **ADAPT** | P2 |
| 评测资产（evals/review_agent*.json、回放脚本、~800 pytest、前端 browser-acceptance） | `evals/` `tests/` `frontend/test/` | 随 service 保留；A-Atlas 增补集成冒烟 | **SERVICE** | P2 |
| CI（windows-runtime.yml：全新安装+doctor+冒烟） | `.github/workflows/` | A-Atlas 建等效 workflow（Phase 2） | **ADAPT** | P3 |

## 6. 覆盖核对

- Vibe 前端 20 条路由全部入表（§2–§5；`/my-stocks`=`/portfolio`+`/watchlist` 合并行）。
- Vibe 后端三层 API（server.py / vr / review_agent）的全部端点组均映射到行内「Vibe 源」列。
- 未被 Vibe 页面引用但后端存在的能力（`/api/industry`、`/api/kline`、legacy `/api/portfolio`、`/api/myreports`）单列，不因「没展示」消失。
- **Phase 1 结束时没有任何 Vibe 代码被删除或修改**——Vibe 原仓库 `D:\workspace\vibe-astock` 完整保留，所有迁移均为 Phase 2+ 的「复制进 A-Atlas + 记来源」，删除只可能发生在 capability 明确 MERGE 且有替代实现的场合。

---

## 7. Phase 2 收口逐项状态（2026-09-27，全部经 §24 浏览器验收/活栈契约检查实证）

Research Backend = `services/vibe-research/`（vendored Vibe 后端，:8910，`ATLAS_SERVICE_NAME=a-atlas-research`）。
BFF = `/api/atlas/*`（错误模型九码、canonical symbol、短缓存、来源时间戳）。

### 发现 Discover（§1 全表）

| Capability | Phase 2 状态 |
|---|---|
| 自然语言公司搜索（QuerySpec→RRF→Laya 重排） | LIVE（走查：光刻胶 90 牌上浮，点牌直达） |
| 5567 家公司池 + company profile | LIVE |
| 物理堆 / 公司牌 / Jev 三态 / 遥测 / 设置 / 健康检查 | LIVE（PRESERVE 未动） |

### 市场 Market（§2 全表）

| Capability | Phase 2 状态 |
|---|---|
| 盘面数据（indices/overseas/emotion/overview/turnover-top/lockup-calendar） | LIVE（`/market`·概览；数据时点如实展示） |
| 实时动态·盯盘（watchtower 快照） | UI-LIVE（快照已亮；盯盘规则编辑等仍走 service） |
| 昨日梯队 | UI-LIVE（昨日涨停+连板分布；分组交互从简） |
| 盘中核验（intraday auction/path/capture） | SERVICE-LIVE（端点在 BFF POST 白名单，UI 未建） |
| 每日复盘 AI 报告 | UI-LIVE（归档可读+job 启动/轮询/取消/恢复；追问 UX 归 P3） |
| 首板分析 | UI-LIVE（梯队分区展示首板表；逐股 AI 深入归 P3） |
| 近 5 日热度 + 龙头谱系 | LIVE（`/market`·热度，龙头点牌直达公司页） |
| 历史统计（涨停样本回测/封板曲线/漂移） | SERVICE-LIVE（DEFER-UI 维持，P3） |
| 资讯雷达 | UI-LIVE（12 轨 RSS 已亮；AI 摘要与自选聚合部分依赖雷达刷新） |
| 事件概率（Kalshi/Polymarket） | SERVICE-LIVE（DEFER-UI 维持，P3） |
| 行业涨跌排名 | SERVICE-LIVE（BFF 白名单内有，DEFER-UI） |
| K 线 | SERVICE-LIVE（DEFER-UI 维持，P3） |
| Vibe 首页 feature grid + WorkspaceChat | P3（MERGE 维持） |

### 研究 Research（§3 全表）

| Capability | Phase 2 状态 |
|---|---|
| 个股研究 17 数据端点 | LIVE（公司页七 tab：行情/估值+五年分位/财务/研报/公告/新闻/两融/大宗/股东户数/派息/龙虎榜/解禁/板块/热门概念/互动问答；分源独立失败、缺口如实列表） |
| 多空辩论 / 个股深挖 | LIVE（公司页 AI研究 tab：job 全生命周期+冻结证据+§10 版式+刷新恢复） |
| 策略回测 | SERVICE-LIVE（引擎随 service 就绪，UI P3） |
| 全球股票 | SERVICE-LIVE（DEFER-UI 维持，P3） |
| 复盘证据/归档基础设施 | LIVE（随复盘/深挖真实运行，SHA256 冻结输入实证） |

### 我的 My（§4 全表）

| Capability | Phase 2 状态 |
|---|---|
| 自选股 | LIVE（A-Atlas 持久层 data/user/watchlist.json + legacy vr-watchlist 显式导入、旧键保留可回滚 + 行情总览） |
| 持仓 | LIVE（/api/positions 透传，成交日志=唯一事实源；空仓如实说明） |
| 交易日志 | UI-LIVE（只读入口；完整记账 UI 归 P3） |
| 个人风控 / 模式卡 | SERVICE-LIVE（P3 维持） |
| 研究记录 | LIVE（A-Atlas 持久层 notes.json + legacy vr-notes 显式导入） |
| 已上传研报 | SERVICE-LIVE（P3 维持） |
| 旧持仓 portfolio.json 双轨 | SERVICE-LIVE（导入源保留） |

### AI 与平台（§5 全表）

| Capability | Phase 2 状态 |
|---|---|
| AI provider 接入 | UI-LIVE（DeepDive/复盘 provider 服务端 env 注入；provider 管理 UI P3） |
| 受限 Agent 运行时 / job 机制 / 交易建议网关 | LIVE（service 原样；Codex 0.153.4 引擎已装，订阅未登录时走 api-compatible） |
| 旧版复盘/深挖 CLI、旧 API 409 桩 | SERVICE-LIVE |
| 安全中间件 / 调度线程 / watchtower | LIVE（原样随 service 运行） |
| Windows 启动器/doctor/setup | ADAPT 完成（Harbor AppRuntimeSpec a-atlas 注册 + scripts/atlas_start.cmd 六步契约） |
| 评测资产（pytest/evals） | LIVE（vendored 保留；baseline 上游 993✓/28 环境失败，vendored 零回归） |
| CI workflow | P3 维持 |

### Harbor 拓扑（§21 定稿）

`a-atlas` 应用已登记 `desktop/src/services/apps.ts`：web（managed :3400，health expectService=a-atlas-web）
+ research（managed :8910，health expectService=a-atlas-research）双组件；laya external :8787
（由 a-share-trawler 卡承载，双 Laya 禁令写进 spec 注释）。**注意：Harbor 仓库侧因存在他人在途
改动（inkwave 注册），本轮以工作区补丁形式交付、未代为提交。**

---

## 8. Phase 3 收口逐项状态（2026-09-28，浏览器四旅程 + 活栈契约 + CI 实证）

标记沿用 §7。**SERVICE-LIVE → UI-LIVE 本轮点亮 8 项**；Harbor 拓扑从「工作区补丁」转「正式提交」。

### 发现 Discover（§1）

| Capability | Phase 3 状态 | 变化 |
|---|---|---|
| 自然语言公司搜索 + 物理堆 | LIVE（不变） | — |
| 公司牌 secondary action「加入自选」 | LIVE | **新增**（右键牌面；主点击/物理零改动） |
| 公司页「加入自选」 | LIVE | **新增**（WatchlistButton，已在自选可移除） |
| 统一 AI 入口（问 AI + AtlasAIContext） | UI-LIVE | **新增**（显式上下文 chip；chat-jobs task_kind=page） |

### 市场 Market（§2）

| Capability | Phase 2 → Phase 3 |
|---|---|
| 概览/动态/梯队/热度 | LIVE（不变） |
| 复盘 | LIVE（**升级**：首份真实复盘归档 2026-09-24，真实 provider 全链路） |
| 盘中核验 | SERVICE-LIVE → **UI-LIVE**（竞价/路径/手动采集；快照不缓存不补造） |
| 历史统计 | SERVICE-LIVE → **UI-LIVE**（字段漂移/统计日历/归档覆盖；空档如实） |
| 事件概率 | SERVICE-LIVE → **UI-LIVE**（资讯 tab 内；Kalshi/Polymarket 快照+免责） |

### 研究 Research（§3）

| Capability | Phase 2 → Phase 3 |
|---|---|
| DeepDive | LIVE（**升级**：真实 provider 验收 fixture 688138/600519 双样本；报告尾部追问） |
| Research Workspace | DEFER-UI → **LIVE**（最近回测/最近 DeepDive/复盘归档/从自选进入） |
| 策略回测 | SERVICE-LIVE → **UI-LIVE**（AI 整理条件→确认→确定性执行→报告/导出/免责） |
| 报告归档 | SERVICE-LIVE → **UI-LIVE**（回测归档表 + 复盘 dates） |

### 我的 My（§4）

| Capability | Phase 2 → Phase 3 |
|---|---|
| 自选 / 持仓 / 研究笔记 | LIVE（不变；自选获得公司页/牌面双入口） |
| 交易日志 | UI-LIVE → **LIVE**（记一笔/成交/费用试算/编辑/删除/退出计划字段；写后 journal+positions 双刷新，持仓派生可见） |
| 个人风控 | SERVICE-LIVE → **UI-LIVE**（账户风控/归因/基准/在险/MFE-MAE/违规收件箱/规则） |
| 模式卡 | SERVICE-LIVE → **UI-LIVE**（My → 交易方法：卡片 CRUD + 版本化统计 + latest_vs_prev） |
| 已上传研报 | SERVICE-LIVE → **UI-LIVE**（索引/状态/公司关联/查看/删除；只建索引不复制内容） |

### AI 与平台（§5）

| Capability | Phase 2 → Phase 3 |
|---|---|
| AI provider 接入 | UI-LIVE → **LIVE**（真实 provider 验收：codex-private/gpt-6-astra 订阅直连；DeepDive 七项检查 + 首份真实复盘） |
| 北交所行情 | SERVICE-LIVE 缺口 → **LIVE**（真因=vendor get_prefix 前缀 bug，92 误归 sh；修正后腾讯全覆盖，东财 fallback 兜底，行级 source + meta.fallbackUsed 如实标注；BJ 估值同链路解锁） |
| 评测资产 | LIVE（升级：vendor pytest ownership 四分类冻结清单 + CI 强制） |
| CI workflow | P3 → **LIVE**（windows-runtime 三 job：web/research-strict/live-stack smoke） |
| Harbor 拓扑 | 工作区补丁 → **正式提交**（harbor@fa5e8c3 inkwave / 5567381 a-atlas 双 ownership 收口，436 测试+smoke exit 0） |
| 统一 AI 入口 | P3 → **UI-LIVE**（AskAIPanel + AtlasAIContext 显式上下文契约；DeepDive 追问已接，全站铺开留 follow-up） |

### 明确未做（§26 冻结维持）

Company Compare / 关系图谱 / Otter 联动 / 自动交易 / 券商 API / Laya 重训 / Discover ranking
重构 / Vibe Python 重写 / 微服务拆分 / 全站 DB 迁移 / Electron 壳 / WinUI+Rust——零变动。

---

## 9. Phase 4 收口逐项状态（2026-09-28，判断 provider 切换 + 运行时解耦）

证据：`reports/PHASE4_JEV_CUTOVER.md`（切换与解耦全记录）+ `reports/PHASE3_FREEZE.md`（切换前基线）。
标记沿用 §7/§8。**本轮只动两件事：判断智能由谁提供、本机跑几个组件。**
Discover 检索系统（QuerySpec / BM25 / vector / RRF / ontology 硬过滤 / Top-200 候选池 / 物理堆 /
行业色）、canonical `StockIdentity`、BFF、Vibe Research Service、Company / Market / My、
DeepDive 生命周期、Harbor 多受管组件契约——按 §3 冻结边界零改动。

### 判断 provider（§1「Jev 判断」行的现状）

| Capability | Phase 4 状态 | 变化 |
|---|---|---|
| 语义判断（Discover rerank） | **A-Atlas Discover: Jev Cloud — LIVE**（`JevCloudProvider` @ `https://api.typesafe.ai/v1/systemone`，noul 二分类头，Top-200 = 2 chunk 并发） | Laya sidecar → Jev Cloud。同池同检索只换 judge：光刻胶从「SET C 残差、top8 无一家真光刻胶商」修成 10 家里 8 家主营含光刻胶，绿的谐波 #7→#1；200 候选 2728-3054ms → **1140ms** |
| 判断身份 | LIVE（别名 `JEV_MODEL=jev-latest` **不是**身份；在岗身份 `jev-1.13.0` 由 `identityProbe()` 从应答体取得并经 `verifyJudgeIdentity()` 比对，漂移即 `MODEL_IDENTITY_MISMATCH`） | 新增（云上等价于 §47 纪律：身份由答题者给出） |
| 降级 | LIVE，且**只有一条路**：确定性检索基础排序 + `degraded:true` + 页面明示「语义判断服务暂不可用，当前结果使用基础检索排序」；key 缺失不阻塞启动 | `judgeSource()` 的 `laya` 分支删除；`lib/jev/mock.ts` 不再是「第三个判断后端」，只产检索混合分并明写「It is not a judgment」。响应里 `judge.provider` 只剩 `jev` / `none` 两态。**给 Jev 加 Laya 回落 = 禁止** |
| 稳定性护栏 | LIVE（`JEV_TIMING`：connect 2500 / 单次 4000 / rerank 合计 6000 / classify 3500 ms；只读判断重试 1 次、180→360ms jitter、尊重 `Retry-After`；401/403 与 4xx 不重试；连续 3 次 provider 失败熔断 20s（坏 key 开 60s），OPEN 期间零网络调用；在途上限 4） | 新增，数字全部来自 `npm run jev:baseline` 实测（45 次真实调用），不是估的 |
| 缓存与成本 | LIVE（cache key = `数据集版本 : judgeCacheIdentity() : query`，云端换模型旧缓存自动失效；命中缓存不再判断（`logCacheHit()` 记 `cacheReplay:true`）、同 query 并发去重） | 新增。实测 ≈61k tokens ≈ **$0.0026 / 次搜索**；重复请求 2275ms → 5-91ms 且云端零调用 |
| Laya 本地判断模型（:8787、`models/` checkpoint、训练/评测/晋升、GPU/VRAM） | **OUT-OF-SCOPE / separate project**——归属 **a-share-trawler**（自有 sidecar :8787、V4.1 checkpoint）。A-Atlas 不读 `LAYA_URL`、不探活、不启动、**不回落** | 从 A-Atlas 运行时剥离：删 `LAYA_URL`/`LAYA_CHECKPOINT`/`layaUrl()`/`lib/jev/client.ts`/sidecar 探活/`rerankerSha16()`+`modelVersion.ts`/「双 Laya 禁令」/全部 `laya:*` npm 入口。trawler 侧未改动（HEAD 仍 `e9869ff`） |

### 运行时与 Harbor 拓扑（§21「定稿」的 Phase 4 修订）

| 项 | Phase 4 状态 |
|---|---|
| A-Atlas 本地组件 | **恰好两个**：web（managed :3400，`expectService=a-atlas-web`）+ research（managed :8910，`expectService=a-atlas-research`）。§7「Harbor 拓扑」里的 `laya external :8787` 与「双 Laya 禁令写进 spec 注释」**已注销**（那两行是 Phase 2 事实，保留不回改） |
| Jev Cloud | 外部 SaaS 依赖，**不是** service：Harbor 启停不了它，云端故障也不把 web 变成不可用（`/api/health` 恒 `ok:true`，Jev 状态是字段不是状态码） |
| GPU / VRAM | 不再是 A-Atlas 运行时要求（属 Laya 道） |
| 启动契约 `scripts/atlas_start.cmd` | 第 1 步 = 校验 Jev 配置：缺 key 只 WARN、Discover 如实 DEGRADED，不阻塞启动；不再检查/启动/验证任何本地判断模型 |
| CI `windows-runtime.yml` | 无 `LAYA_URL`、无 laya unittest 套件；`JEV_BASE_URL` 指向 `scripts/jev_stub.mjs` 确定性 stub，`scripts/assert_jev_stub.mjs` 断言 |
| 解耦回归测试 | LIVE（`tests/jev-provider.test.ts > runtime decoupling` 逐文件断言不出现 `LAYA_URL|LAYA_CHECKPOINT|layaUrl|8787|laya_server`，并断言 `lib/jev/client.ts` 已不存在、judge 模块导出不含任何 fallback / second-provider 形态） |

### 历史不回改 + provenance 保留

§1（除已就地加注的三行）、§7、§8 里出现的 Laya 字样是 **Phase 0–3 的真实事实**：当时 Discover
的判断确实由 :8787 的 Laya V4.1 提供（`reports/PHASE3_FREEZE.md` 记着冻结时刻 `judge:"laya"`）。
这些历史逐项状态**不回改**；本轮的更正一律以「原文 + Phase 4 注记」或新增 §9 的形式**加**进来。
`scripts/laya_*`、`scripts/train_laya*.py`、`scripts/laya_server.py`、`kaggle_laya_finetune/`、
`reports/LAYA_*.md` 全数保留为出处链；其中 7 个会经 `lib/jev` 打到云的脚本
（`shadow_replay_v41` / `smoke_v41_promotion` / `build_ranking_candidates` / `organic_shadow_protocol` /
`residual_triage` / `laya_v4_2_eval_grade` / `stage3_1_smoke`）由 `requireLayaLane()` 硬闸拒绝运行
（`ATLAS_LAYA_LANE=1` 显式放行，或改到 a-share-trawler 跑同名脚本）——否则「Laya 臂」会静默打在
Jev 云上，产出一份没发生过的对比。
