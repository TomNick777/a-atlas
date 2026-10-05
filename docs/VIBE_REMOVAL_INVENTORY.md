# Vibe Removal Inventory（Refocus · Data Foundation）

> 状态：**生效中**（refocus 分支 `atlas/refocus-data-foundation` 执行依据）。
> 本文档是删除动作的完整清单：先建立 inventory，再动手删除。删除的每一项都回答四个问题——
> 删的是什么、从哪里删、历史证据保留在哪、用户数据是否受影响。
>
> 原则：
> 1. 删除的是**当前产品集成**，不是历史证据——Phase 0–4 报告、tag、`docs/` 集成期文档原样保留（必要时加 `HISTORICAL / RETIRED` 标注）。
> 2. **不删用户历史数据**：`~/.duanxian-agents/`、`~/.vibe-astock-agent/`、`data/user/`、`data/atlas-jobs/` 只停止引用，文件留在磁盘上。
> 3. **不删 Vibe 外部原仓**（`D:\workspace\vibe-astock`）与其 git 历史。
> 4. `services/vibe-research` 的 git 历史通过本仓历史保留（删除提交的 parent 链完整可溯）。

基线（2026-09-28，master `b10c59c`）实测：

| 项 | 值 |
|---|---|
| A-Atlas HEAD | `b10c59c`（master），dirty 仅 `services/vibe-research/README-ATLAS.md` + `server.py`（UTF-8 修复遗留） |
| 分支 | `atlas/refocus-data-foundation`（自 master 新建） |
| Harbor | `D:\workspace\harbor` master `71de093`，自身 5 项 WIP（apps/quota/settings/protocol + 未跟踪 quota-balance）——Harbor 侧改动不与其混提 |
| Vibe 外部原仓 | `D:\workspace\vibe-astock` main `bd96df4`，clean，不动 |
| a-share-trawler | master `e9869ff`，23 项 dirty（10 项 Laya/Jev 比赛 WIP），**禁止改动** |
| :3400 | A-Atlas Web 存活（HTTP 200） |
| :8910 | `a-atlas-research` v1.1.3（Vibe Research Service）存活 |
| Phase 4 milestone | `A_ATLAS_JEV_PRODUCTION_READY`；Discover 已切 Jev Cloud 唯一 judge |

---

## 一、产品页面（app/）

| Component | Current location | Remove from runtime | Remove code | Preserve history | User data |
|---|---|---|---|---|---|
| Market Workspace | `app/market/page.tsx` | 是（整页删除，URL 404） | 是 | `reports/PHASE2_CLOSEOUT.md` 等 Phase 报告 | 无 |
| Research Workspace | `app/research/page.tsx` | 是（整页删除，URL 404） | 是 | 同上 | 无 |
| My Workspace | `app/my/page.tsx` | 是（整页删除，URL 404） | 是 | 同上 | 无 |
| 一级导航（发现/市场/研究/我的） | `components/atlas/AppNav.tsx`（挂载于 `app/layout.tsx`） | 是（layout 移除挂载） | 是（文件删除；layout 内联极简 wordmark） | AGENTS.md 旧条款、PROJECT_STATE.md | 无 |
| `/stock-data` 旧跳板 | `app/stock-data/route.ts`（308 → `/stock/:symbol`） | **保留**——目的地公司页仍是有效产品面，服务旧书签 | 否 | — | 无 |

旧 URL 处置（refocus §十四）：`/market`、`/research`、`/my` 删除后由 Next 如实 404；不设假壳、不设隐藏导航。产品内已无指向它们的链接（导航与所有入口组件同批删除，见 §二）。

## 二、组件（components/）

| Component | Current location | Remove from runtime | Remove code | Preserve history | User data |
|---|---|---|---|---|---|
| Shell（Phase 1 死代码，零引用） | `components/atlas/Shell.tsx` | 是 | 是 | — | 无 |
| 6 位代码跳转框 | `components/atlas/SymbolJump.tsx`（仅 ResearchWorkspace 用） | 是 | 是 | — | 无 |
| AppNav 一级导航 | `components/atlas/AppNav.tsx` | 是 | 是 | — | 无 |
| AskAI 统一问 AI 面板 | `components/atlas/ai/AskAIPanel.tsx` | 是 | 是 | Phase 3 报告 | 无 |
| 公司页 7-Tab 研究控制器 | `components/atlas/company/CompanyResearch.tsx` | 是（公司页整体改单页纵向阅读） | 是 | — | 无 |
| Hero 行情条 | `components/atlas/company/QuoteStrip.tsx` | 是（由 a-stock-data 市场快照替代） | 是 | — | 无 |
| 数据块骨架 / KV 表 | `components/atlas/company/ResearchBlock.tsx`、`DataView.tsx` | 是 | 是 | — | 无 |
| DeepDive（AI研究）面板 | `components/atlas/company/DeepDivePanel.tsx` | 是 | 是 | Phase 3 报告 | 任务记录在 `data/atlas-jobs/`、`~/.duanxian-agents/`，保留不删 |
| 研究工作台快捷 chips | `components/atlas/company/ResearchActions.tsx` | 是 | 是 | — | 无 |
| 自选按钮 | `components/atlas/company/WatchlistButton.tsx` | 是 | 是 | — | `data/user/watchlist.json` 保留不删 |
| Market Workspace（8 Tab，含盘中核验/历史统计/事件概率/复盘） | `components/atlas/market/MarketWorkspace.tsx` 等该目录全部 | 是 | 是 | Phase 2/3 报告 | 无 |
| Research Workspace / Backtest | `components/atlas/research/*.tsx`（2 文件） | 是 | 是 | Phase 3 报告 | 无 |
| My Workspace（Journal/Risk/模式卡/研报） | `components/atlas/my/*.tsx`（5 文件） | 是 | 是 | Phase 3 报告 | `data/user/notes.json`、`report-links.json` 保留不删 |

保留的核心组件（不受影响）：`TrawlerExperience`、`SearchComposer`、`SettingsPanel`（卡片主题）、`CompanyFloor`、`components/floor/*`（物理引擎 8 文件）、`components/debug/Inspector.tsx`。

## 三、BFF 路由（app/api/atlas/，27 个 route.ts）

| Component | Current location | Remove from runtime | Remove code | Preserve history | User data |
|---|---|---|---|---|---|
| research 健康透传 | `app/api/atlas/health/route.ts` | 是 | 是 | — | 无 |
| 公司页 16 类资源代理 | `app/api/atlas/stock/[resource]/route.ts` | 是 | 是 | — | 无 |
| 市场资源代理 | `app/api/atlas/market/[resource]/route.ts` | 是 | 是 | — | 无 |
| My：journal(+fees-schema)/modes/notes/positions/reports(+file)/risk/watchlist(+import) | `app/api/atlas/my/**`（9 文件） | 是 | 是 | — | 对应 `data/user/*.json` 保留 |
| Research：deepdive(+[id]+cancel+report)/daily(+archive+cancel)/backtest(+[id]+cancel+reports)/chat(+[id]+cancel) | `app/api/atlas/research/**`（13 文件） | 是 | 是 | Phase 3 报告 | 任务记录保留于 `data/atlas-jobs/` |

保留的核心路由：`/api/search`、`/api/telemetry/event`、`/api/health`、`/api/runtime`（后两者在 §五 去掉 research 探针后保留）。

## 四、lib 层

| Component | Current location | Remove from runtime | Remove code | Preserve history | User data |
|---|---|---|---|---|---|
| 研究服务 BFF 客户端（`ATLAS_RESEARCH_URL` 默认 `http://127.0.0.1:8910`，stale-if-error，VR_API_KEY） | `lib/atlas/research/client.ts` | 是 | 是 | — | 无 |
| 结果信封/错误模型/响应助手 | `lib/atlas/research/{contracts,errors,respond}.ts` | 是 | 是 | — | 无 |
| 浏览器侧并发受限 fetch | `lib/atlas/research/browser.ts` | 是 | 是 | — | 无 |
| stock/market/my 资源白名单 | `lib/atlas/research/{stock,market,my}.ts` | 是 | 是 | — | 无 |
| DeepDive/Daily/Chat 任务编排 | `lib/atlas/research/jobs.ts` | 是 | 是 | Phase 3 报告 | 队列 `data/atlas-jobs/queue.json` 保留 |
| 任务准入队列（启动重放） | `lib/atlas/research/admission.ts` + `instrumentation.ts` 的 `restoreQueue()` | 是 | 是 | Phase 4 报告 | 同上 |
| 自选/笔记持久化 | `lib/atlas/userStore.ts` | 是 | 是 | — | `data/user/*.json` 保留 |
| AI 面板上下文契约 | `lib/atlas/aiContext.ts` | 是 | 是 | — | 无 |
| 写幂等 | `lib/atlas/idempotency.ts` | 是 | 是 | — | 无 |
| 研报-公司关联 | `lib/atlas/reportAssociation.ts` | 是 | 是 | — | `data/user/report-links.json` 保留 |
| 健康/运行时模型（含 research 组件判定） | `lib/atlas/runtime.ts` | **改写**：移除 research 组件，保留进程指标 + Jev/数据组件 | 部分 | — | 无 |
| 研究健康探针 `probeResearchHealth()` | `lib/telemetry/runtime.ts` | **改写**：探针改为 a-atlas-data（:8920） | 部分 | — | 无 |
| 公司解析器 / 6 位代码身份 | `lib/atlas/company.ts`、`lib/atlas/stockIdentity.ts` | **保留**（核心） | 否 | — | 无 |

## 五、Web 健康契约（Harbor 依赖，改写不删除）

| Component | Current location | 变更 |
|---|---|---|
| `/api/health` | `app/api/health/route.ts` | 移除 research 探针；健康模型只剩 search/judge + （commit 6 起）stock-data；仍 200 + `service:"a-atlas-web"` |
| `/api/runtime` | `app/api/runtime/route.ts` | 同上，`runtimeSnapshot` 去掉 research 维度 |
| 启动钩子 | `instrumentation.ts` | 删除 `restoreQueue()` 一行；保留 embedding 预热、Jev 身份核验、rollup 补账 |

## 六、Vibe Research Service 本体（services/vibe-research，188 个跟踪文件）

| Component | Current location | Remove from runtime | Remove code | Preserve history | User data |
|---|---|---|---|---|---|
| FastAPI 包装层 | `services/vibe-research/server.py`（:8910，`ATLAS_SERVICE_NAME=a-atlas-research`） | 是（服务不再启动；:8910 退役） | 是 | `README-ATLAS.md` 的偏差清单描述了当时架构；Phase 4 报告 | 无 |
| duanxian 引擎（daily/deepdive/journal/risk/modes/复盘图） | `services/vibe-research/duanxian/`（54 文件） | 是 | 是 | Phase 2/3 报告 | `~/.duanxian-agents/`、`~/.vibe-astock-agent/` 用户数据保留不删 |
| vr 市场层（quotes/newsradar/portfolio/myreports/watchtower/chat） | `services/vibe-research/vr/`（15 文件） | 是 | 是 | — | 同上 |
| review_agent 任务引擎（daily/deepdive/backtest/chat/mcp） | `services/vibe-research/review_agent/`（22 文件） | 是 | 是 | — | 同上 |
| 回测引擎 | `services/vibe-research/backtest/`（32 文件） | 是 | 是 | — | 无 |
| 研究数据源（baostock/yahoo/probability） | `services/vibe-research/research_data/`（11 文件） | 是 | 是 | — | 无 |
| 上游测试/评测/脚本/固定 Codex harness | `services/vibe-research/{tests,evals,scripts,runtime}/` | 是 | 是 | upstream 原仓 `D:\workspace\vibe-astock` 完整保留 | 无 |
| 本地 `.venv/`、`runtime/node_modules/`、日志 | `services/vibe-research/.venv` 等（未跟踪） | 是（磁盘删除；属可再生工具产物，非用户数据） | — | — | 无 |

## 七、脚本（scripts/）

| Component | Current location | 处置 |
|---|---|---|
| 启动契约 | `scripts/atlas_start.cmd` | **改写**：只启 data service（commit 6 起）+ Web :3400，不再启 server.py |
| CI LLM stub（DeepDive :8931） | `scripts/atlas_llm_stub.py` | 删除 |
| BFF 契约检查 | `scripts/atlas_contract_check.ts`、`run_contract_check.mjs` | 删除 |
| 综合冒烟（含 stub DeepDive） | `scripts/ci_smoke.mjs` | **改写**为 Refocus 冒烟（发现+公司页+Jev stub） |
| vendor pytest 所有权强制 | `scripts/vendor_pytest_ci.py` | 删除（连同 `tests/vendor/` 冻结清单） |
| 本地探针 | `scripts/local_my_probe.mjs`、`local_console_probe.mjs` | 删除 |
| 自选性能 | `scripts/watchlist_benchmark.mjs`、`watchlist_transition_probe.mjs` | 删除 |
| Phase 走查（1/2/3/4、混沌、perf） | `scripts/phase*_browser_walk.mjs`、`phase4_chaos_walk.mjs`、`phase4_perf_baseline.mjs`、`acceptance.ts` | 删除（结论已在 `reports/PHASE*_RUNTIME/`，脚本引用的 URL 全部即将消失，留着必然是死代码） |
| **保留** | Laya 车道（`laya_*`、`train_*`、`build_laya_*`、`require-laya-lane.ts`、`laya_lab/`、`kaggle_laya_finetune/`）、数据构建（`fetch_companies.py`、`build_profiles.ts` 等）、Jev stub（`jev_stub.mjs`、`assert_jev_stub.mjs`）、搜索/遥测体检脚本 | 不动——Laya 是 a-share-trawler 历史出处链，受 AGENTS 保护 |

## 八、测试

| Component | Current location | 处置 |
|---|---|---|
| BFF 任务契约 | `tests/atlas-research.test.ts` | 删除 |
| 准入队列 | `tests/atlas-queue.test.ts` | 删除 |
| 写幂等 | `tests/idempotency.test.ts` | 删除 |
| 研报关联 | `tests/report-association.test.ts` | 删除 |
| vendor pytest | `tests/test_vr_bj_quote.py`、`tests/test_vr_stale_cache.py`、`tests/vendor/`（4 个冻结清单） | 删除 |
| 遥测运行时（断言 research 探针） | `tests/telemetry_runtime.test.ts` | **改写**为 data 探针语义 |
| 核心保留 | `search / stockIdentity / jev-provider / semiconductor-knowledge / theme / telemetry_{logging,organic,search} / atlas-company` + Laya 历史 py（`test_laya_identity/v4_roles_v2/version`） | 不动 |

## 九、配置、CI、文档

| Component | Current location | 处置 |
|---|---|---|
| env | `.env.example` 的 `ATLAS_RESEARCH_URL/API_KEY`、`ATLAS_DEEPDIVE_*`；`.env.local` 同 | **改写**：删除上述变量，新增 `ATLAS_DATA_URL`（:8920） |
| CI | `.github/workflows/windows-runtime.yml`：`research-tests` job（vendor pytest）+ live-stack 内 vendor deps / codex harness / llm stub / research 启动 / contract check | **改写**：Web build + 搜索 vitest + Jev stub 搜索验证 + 数据抽取离线测试 + Refocus 冒烟；真实云端 Jev 与公网数据源不作为硬依赖 |
| package.json | `"test:py": "python -m unittest tests.test_vr_bj_quote"` | 改写为数据抽取/服务测试入口 |
| .gitignore | `services/vibe-research/*` 4 条 | 删除（目录不存在了） |
| THIRD_PARTY_NOTICES | 「Vibe AStock」段（Apache-2.0 + Research-LICENSE 义务） | 随代码移除删除该段；新增 a-stock-data 段 |
| 产品叙事 | `AGENTS.md`、`README.md`、`PROJECT_STATE.md` | **改写**为 Refocus 后事实；不篡改历史章节表述 |
| 历史集成文档 | `docs/A_ATLAS_CAPABILITY_MATRIX.md`、`A_ATLAS_INTEGRATION_AUDIT.md`、`A_ATLAS_TARGET_ARCHITECTURE.md` | **保留**，文件头加 `HISTORICAL / RETIRED` 标注 |
| Phase 报告 | `reports/PHASE*_CLOSEOUT.md` 等、`reports/PHASE*_RUNTIME/`、tags | **原样保留** |

## 十、运行时状态与用户数据（只停止引用，一律不删）

| 路径 | 性质 | 处置 |
|---|---|---|
| `data/user/watchlist.json`、`notes.json`、`report-links.json` | A-Atlas 期用户数据（未被 git 跟踪） | 停止引用，文件留在磁盘 |
| `data/atlas-jobs/queue.json` | 任务队列持久化（未被 git 跟踪） | 停止引用，文件留在磁盘 |
| `~/.duanxian-agents/` | Vibe 用户数据 home | 不碰 |
| `~/.vibe-astock-agent/` | Vibe agent home（含共享 codex-home） | 不碰 |
| `D:\workspace\vibe-astock` | 上游原仓 | 不碰 |
| `D:\workspace\a-share-trawler` | 独立项目（23 项 dirty WIP） | 不碰 |

## 十一、删除后的验证标准（refocus §四十一/§四十二）

全仓扫描 `vibe|deepdive|daily-review|backtest-agent|journal|portfolio|mode-card|review_agent|duanxian`（大小写不敏感），分类计数：

1. 当前 runtime 引用（app/lib/components/scripts/CI/env）→ **必须为 0**；
2. 当前产品 UI 引用 → **必须为 0**；
3. 历史 docs/report / 本 inventory / 收口报告 → 允许；
4. THIRD_PARTY provenance → Vibe 段随代码删除；a-stock-data 段新增。

运行时验证：不启动 Vibe Research 的前提下，A-Atlas 正常 startup / search / company page / Jev / stock data / Harbor Inspector。
