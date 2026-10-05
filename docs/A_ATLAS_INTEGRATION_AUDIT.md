> **HISTORICAL / RETIRED（2026-09-28 Refocus）**
> 本文档描述的 Vibe AStock 集成架构已从当前产品与运行时中整体退役
> （`docs/VIBE_REMOVAL_INVENTORY.md`）。内容未经改写，仅作为当时真实发生过的
> 架构证据保留；当前事实以 `PROJECT_STATE.md` 文首「Refocus · Data Foundation」为准。

# A-Atlas — Integration Grand Audit（Phase 0 产出）

审计时间：2026-09-27。本文件是整合前两个项目的基线事实记录。

> **Phase 4 修订（2026-09-28）**：下面的 §0/§A 数值是**审计时刻的实测快照**，当时 A-Atlas
> 确实经 `LAYA_URL` 复用 `:8787` 的 Laya sidecar——这些测量保持原样，不改写历史。
> 但**其中关于 Laya 的「运行时关系」已全部失效**：A-Atlas 的语义判断现在只有 Jev Cloud
> （`https://api.typesafe.ai/v1/systemone`）一个来源，没有本地回落；A-Atlas 本地运行时
> 恰好两个组件（Web :3400 + Research :8910），Laya sidecar / `models/` / checkpoint /
> GPU 归 a-share-trawler。逐条现状以本文件的 §D（已按 Phase 4 改写）与
> `reports/PHASE4_JEV_CUTOVER.md` 为准；凡标注「**Phase 4 失效 / 更正 / 作废**」的段落
> 都是「历史事实原文 + 现行更正」两层结构，原文一字未删。

## 0. 安全基线（§十六要求，审计时刻实测）

| 项 | 值 |
|---|---|
| trawler HEAD | `e9869ffe3157c2c99f9d4a32c8c56c4a07f388e8`（master，= a-atlas clone 起点） |
| trawler dirty | `git status --porcelain` 0 行，stash 0 —— 干净，无需保护分类 |
| Laya sidecar | PID 38500，`scripts/laya_server.py`，`127.0.0.1:8787`，CUDA；`/health` 自证 checkpoint `models/a-share-laya-v4.1/checkpoint_best`，sha16 **2742affc3f677d71**（V4.1 生产）。**Phase 4 失效**：该实例仍在原地，但它是 a-share-trawler 的运行时；A-Atlas 不读 `LAYA_URL`、不探活、不回落 |
| 残留进程 | PID 30512（`.venv` 的 laya_server.py，未绑定端口=bind 失败的重复实例）。**未清理、未触碰**，仅记录 |
| trawler dev server | PID 46056，node next start-server，`:3000`，运行中 |
| 端口规划 | 3000=trawler dev（不动）；8787=Laya sidecar（不动；**Phase 4 起与 A-Atlas 无关**）；**3400=A-Atlas dev**；8910=未来 Vibe FastAPI（Phase 2）。Phase 4 现状：A-Atlas 只占 3400 + 8910，出网访问 Jev Cloud |
| 禁令遵守 | 不 reset / 不 stash / 不删 checkpoint（`models/` 完全未动）/ 不删数据 / 不重训 / 不破坏运行时 |

## A. a-share-trawler（产品 DNA / 主壳）

**技术栈**：Next.js **16.3.5**（App Router，typed routes `PageProps<'/...'>`/`LayoutProps<'/...'>`，
params 为 Promise；注意 `node_modules/next/dist/docs/` 内置文档与旧训练知识有破坏性差异），
React 19，TypeScript strict，Tailwind（暗色 `#070806` 底、`#12140f` 面板、white/15 边框、5px 圆角），
matter-js 物理引擎，vitest + Python unittest。

**结构**（585 tracked 文件，data/ 371MB 全部 git 跟踪）：

- `app/`：`layout.tsx`（根布局+metadata）、`page.tsx`（首页=物理堆）、`api/{health,search,telemetry/event}/route.ts`
- `components/`：`TrawlerExperience`（搜索编排）、`CompanyFloor`（canvas 物理堆，FloorApi: shake/select/release）、
  `SearchComposer`（唯一输入控件，`/` 聚焦快捷键）、`SettingsPanel`（左下角 devtools 风格弹层：卡片配色）、
  `floor/{bounds,forces,matches,plates,scene,theme,layout,debug}`、`debug/Inspector`
- `lib/`：`companies.ts`（数据加载缓存：companies.json+vectors.f32+profiles+manifest）、`types.ts`（Company/SearchResult…）、
  `env.ts`（TYPESAFE_API_KEY / LAYA_URL / JEV_MODEL；**Phase 4 更正：A-Atlas 侧只留
  TYPESAFE_API_KEY / JEV_MODEL / JEV_DETAIL / JEV_BASE_URL，`LAYA_URL` 与 `layaUrl()` 已删**）、
  `jev/*`（判断三态 → Phase 4 起 A-Atlas 只剩两态：`jev` / `none`）、`search/*`（pipeline/retrieve/score/querySpec/v3…）、
  `telemetry/*`（证据层：事件契约 `CLIENT_EVENT_TYPES`、organic、store、rollup）
- `search/`：ontology（半导体/机器人/热管理/大宗/应用/概念/产业链）、profile derive/schema、knowledge
- `data/`：companies.json、enrichment/、vectors*.f32、search_index_manifest{,_v2}.json、search_profiles{,_v2,_v3}.json、ontology、train/、eval/、health.json
- `scripts/`：`laya_server.py`（sidecar）、fetch_companies.py、build_* 系列、eval_* 系列、train_laya*.py、organic_shadow_protocol.ts…
- `tests/`：vitest（search/jev/telemetry/theme/model-version/semiconductor-knowledge）+ unittest（laya_identity/version/v4_roles_v2）
- `models/`（**gitignored**）：Laya checkpoints；`laya_lab/`、`reports/`、`data/eval/` 部分为 untracked 交付物（记忆在案）

> **Phase 4 更正（这三行只描述 trawler）**：A-Atlas **从来没有** `models/` 也没有 `.venv`，所以
> 历史 search_log 里的 `rerankerSha` 全部为 null——旧的「本地权重归因」其实一直是空的，改成云端
> 返回的模型身份后第一次有了可核验身份。A-Atlas 保留 `scripts/laya_*` 与 `kaggle_laya_finetune/`
> 作为 `reports/LAYA_*.md` 的出处链，但 `laya_identity/version/v4_roles_v2` 等 unittest 已退出
> `npm test` 与 CI；7 个会经 `lib/jev` 打到云的脚本由 `requireLayaLane()` 硬闸拦下
> （`ATLAS_LAYA_LANE=1` 才放行），防止「Laya 臂」静默打在 Jev 上产出一份没发生过的对比。

**公司 schema（lib/types.ts `Company`）**：code/name/fullName/exchange(SH|SZ|BJ)/board/listedAt/industry/
**swLevel1Industry**（申万 2021，31 类，北交所可能 "unknown"）/businessDescription/mainProducts[{name,revenueShare}]/
concepts/region{province,city}/companyDescription/searchableText/judgeText/searchProfileText/judgeTextEn/marketCap/overseasRevenueShare。

**Search pipeline**：POST `/api/search` → LRU 缓存（dataset 版本键）→ `runSearch`（QuerySpec→约束→
BM25+向量 RRF 召回→Jev 判分→matches）→ trace + searchId + 遥测；degraded 三态如实标注。
sidecar 契约：无 key 时 `LAYA_URL`（SystemOne 线格式），均不可用才 mock 且响应标 degraded。
> **Phase 4 更正（A-Atlas 侧）**：上面这句 sidecar 契约对 A-Atlas 已废止——judge 只有
> `lib/jev/provider.ts` + `lib/jev/cloud.ts` 的 JevCloudProvider 一个实现（双路由点
> `lib/jev/client.ts` 已删），无 key 或云端故障时只剩「确定性检索基础排序 + 如实 DEGRADED」一条路，
> 没有 `laya` 分支也没有 mock 判断；缓存键在数据集版本之外再带 judge 身份
> （`judgeCacheIdentity()`），命中缓存不再向云端重复付费。该 sidecar 契约作为 **trawler 现状**
> 继续成立（trawler 仍读 `LAYA_URL`）——两仓共享历史不共享运行时。

**运行时**：`npm run dev`（:3000）；`npm run laya`（sidecar :8787，需 .venv + models/）；构建 `next build`；
测试 `npm test`（vitest + unittest）。**Harbor contract**：仅「应用登记」——Harbor 按 AppRuntimeSpec
启动/探活/停止本项目，无数据交换（2026-09-23 决定；repo 内无 AppRuntimeSpec 文件实例，契约在 Harbor 侧）。
> **Phase 4 更正（A-Atlas 侧）**：A-Atlas 已删 `laya` / `laya:*` / `build:v41:*` / `eval:v41` /
> `eval:roleab` 全部 npm 入口（它们依赖本仓不存在的 `.venv`/`models/`，留着就是伪装可用能力），
> `npm test` 的 python 部分只剩 vendor 兼容测试；启动脚本 `scripts/atlas_start.cmd` 不再检查、
> 启动或验证任何本地判断模型。本段 trawler 描述照旧成立。

## B. Vibe AStock（被吸收方，clone 于 `D:\workspace\vibe-astock`，Apache-2.0）

**版本**：v1.1.3（product.json）。LICENSE=Apache-2.0（版权行占位未填）；含已迁移 Research 代码的
第三方上游许可证 `docs/upstream/Research-LICENSE.txt`。**迁移任何 Vibe 代码必须保留两者。**

**前端**（`frontend/`，React 19+TS+Vite 6+react-router-dom 7+Tailwind 3；声明了 Zustand/ECharts 但
实际零使用——状态是 Context+localStorage，图表是手写 SVG；dev :5910 代理 `/api`→`:8910`）：
20 条路由，侧边栏 7 组（首页/盯盘/复盘/资讯雷达/个股研究/回测/我的股票）。全部路由与每页能力清单见
`A_ATLAS_CAPABILITY_MATRIX.md` §2–§5 的「Vibe 源」列。

**后端**（单进程 FastAPI :8910，启动时合并三层路由）：

1. `server.py` 自有层：复盘/日志/风控/持仓/模式/归档漂移 + 安全中间件（host 白名单、Origin 校验、
   Bearer `VR_API_KEY`、单实例文件锁）+ 盘中 6 槽快照调度线程 + 旧 API 409 桩（`/api/chat`、
   `/api/review/run`、`/api/deepdive/*`）。
2. `vr/`（Vibe-Research 兼容层）：市场/情绪/首板/turnover/全球股/行业 + 个股研究 17 个 `?code=` 端点
   （东财 push2*/datacenter/np-anotice/reportapi、腾讯 qt.gtimg、akshare、问财+mini-racer、巨潮 irm）+
   watchtower 3 秒盯盘线程 + RSS 雷达 + legacy portfolio/myreports + 流式 NDJSON 聊天（合并时跳过）。
3. `review_agent/`（受限复盘 Agent，最新架构）：固定 OpenAI Codex CLI 0.153.4 引擎（`runtime/`），
   只读沙箱+MCP 白名单（`mcp_server.py` 官方 SDK），SQLite 会话（WAL/0600/request_id 幂等/720s 恢复），
   daily/deepdive/chat-jobs/backtest 任务（1200s/600s 截止、阶段进度轮询、取消）、grounding 引用契约
   （宿主持有全部数字，模型文本纯定性）、SHA256 冻结输入、交易建议网关、Claude/CodeBuddy Node 桥、
   OAuth 接入流。**无 SSE/WebSocket，全部轮询。**

**业务层** `duanxian/`（短线）：LangGraph 复盘图（5 分析师+裁判，legacy）、deepdive 图（4 分析师+辩论）、
fetchers/data/pool_source/emotion_metrics/market_facts/theme_tree/trade_calendar（唯一日历权威）/intraday/
weekly/reflection/verification/archive/journal/positions/risk/modes/backtest、MiMo LLM 层（langchain-openai，
可切换任意 OpenAI 兼容端点）。

**研究回测** `backtest/`（Portfolio-Studio 风格引擎：ChinaA/GlobalEquity、可回测性门、约束、风险 X 光、
run card）+ `research_data/`（baostock/yahoo/概率源、东财文件锁限速、原始响应 SHA256 证据）。

**存储**：`ASTOCK_DATA_HOME=~/.duanxian-agents/`（reviews/reflections/weekly/journal/modes/risk/
verification/intraday/archive/cache）；`ASTOCK_AGENT_HOME=~/.vibe-astock-agent/`（conversations.sqlite3、
daily 任务信封、codex-home、runs）；`VR_DATA_DIR=~/.vibe-astock-agent/market-data/`（portfolio.json、
myreports/、monitor/、radar 缓存）。watchlist/notes/theme 等 11 个 localStorage 键 + 5 个 sessionStorage
恢复键（前端私有）。

**质量**：pytest ~800 用例（conftest 断网、monkeypatch 强制）+ backtest/research_data 包测试 + 前端
Python 验收脚本 + evals 固定锚点回归；CI windows-runtime.yml 全新安装冒烟。

## C. 关键整合判定（Phase 0 结论）

1. **主壳方向**：trawler 是产品 DNA（首页/搜索/物理交互/公司池原样保留）；Vibe 以 **Python service
   原样保留 + UI 重建** 为默认迁移方式——不重写 Vibe 已验证的逻辑，不在第一轮大规模复制改名。
2. **稳定边界 = 6 位代码**：trawler `Company.code` ≡ Vibe `?code=` ≡ `/stock/:symbol`。两侧 symbol
   约定天然一致（Vibe 输入端的 `.SH` 后缀在归一化层处理），canonical `StockIdentity` 落
   `lib/atlas/stockIdentity.ts`（见 TARGET_ARCHITECTURE §3）。
3. **两套公司详情不并存**：Vibe `/stock-data` 的能力在 Phase 2 起重建为公司页研究区 tabs；
   Vibe 前端迁移时加 `/stock-data?symbol=X` → `/stock/X` 兼容重定向。Phase 1 Vibe 代码零改动。
4. **AI 原则统一**：trawler 的「检索系统负责发现、Jev 只判分」+ Vibe 的「宿主持有数字、模型文本定性、
   交易建议网关」是同一条原则的两个实例，A-Atlas 全产品沿用。
5. **Laya 唯一实例**：A-Atlas 经 `LAYA_URL` 复用生产 sidecar；a-atlas clone 自带 vectors/manifest
   （具备独立服务能力）但 Phase 1 不启动第二个 sidecar。
   > **Phase 4 作废本条**：判定不再成立，且方向相反——A-Atlas 与 Laya 之间没有任何运行时关系，
   > 唯一判断 provider 是 Jev Cloud，缺 key/故障即 DEGRADED（检索排序）而非回落本地模型。
   > 「唯一实例」「禁止起第二个」这类约束随 Laya 一起移出本仓，只在 a-share-trawler 内部有意义。
   > 保留本条原文是为了让 Phase 0–3 的决策链可追溯。
6. **风险登记**：① Next 16 与旧训练知识差异——写路由前必须读 `node_modules/next/dist/docs/`；
   ② Vibe 数据目录在用户主目录（与 repo 无关），A-Atlas 迁移期不改其路径；③ trawler 上存在 PID 30512
   残留 laya 进程（bind 失败），与本整合无关，未处置；④ `Company.swLevel1Industry` 北交所可能为
   "unknown"——公司页必须如实展示而非编造行业。

## D. A-Atlas AppRuntimeSpec（Harbor 登记；Phase 2 草案 → Phase 4 定稿）

> 草案原文含 `web.env.LAYA_URL` 与一条 `id: laya / kind: external / :8787` 的 service，
> 且 research 位置写作 `<vibe-service 位置待 Phase 2 定>`。Phase 2 把它落成了 vendored
> `services/vibe-research/`，Phase 4 再把 Laya 那条整体删除——A-Atlas 的本地运行时**恰好**
> web + research 两个受管 service，云端 Jev 是外部依赖（Harbor 启停不了，故不登记为 service）。

```yaml
app: a-atlas
displayName: A-Atlas｜A股星图
services:
  - id: web
    kind: nextjs
    dir: D:\workspace\a-atlas
    start: npm run start        # prod；dev 用 npm run dev -- -p 3400
    port: 3400
    env: { TYPESAFE_API_KEY: <server-side only>, JEV_MODEL: "jev-latest" }   # 无 LAYA_URL
    health: /api/health         # 报 service=a-atlas-web + judge{provider,model,breaker,identity}
  - id: research                # vendored Vibe FastAPI（Phase 2 起在仓库内）
    kind: fastapi
    dir: D:\workspace\a-atlas\services\vibe-research
    start: python -m uvicorn server:app --host 127.0.0.1 --port 8910
    port: 8910
    health: /api/health         # canonical；/health 是 404
# 已注销：id: laya / external / http://127.0.0.1:8787（Phase 4——该实例归 a-share-trawler）
externalDependencies:
  - id: jev-cloud               # 唯一语义判断 provider；不可用 = Discover DEGRADED，不是 web 不可用
    kind: saas-https
    url: https://api.typesafe.ai/v1/systemone
contract: 仅应用登记；与 Harbor 不交换数据（2026-09-23 决定继续有效）
```
