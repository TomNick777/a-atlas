# A 股公司发现

用一句话描述你要找的公司，匹配的公司牌会从物理堆里浮上来。

首页是一堆公司牌和一个搜索框；点开公司牌进入公司页。可以找某类业务的公司，也可以结合涨幅、成交量等行情条件发现公司。语义结果标的是**相关度**，不是上涨概率；行情结果显示原始名次、指标与快照时间。

## 运行

需要 Node.js 24、Python 3.12。公开仓库只包含代码，不包含公司数据、披露摘录、语料、向量、行情、训练数据、真实响应夹具和历史评测产物。Git LFS 不用于公开分发这些数据。本机已有数据保持原样；新克隆可以构建，但尚不能重现完整公司发现结果。

```powershell
npm ci
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env.local
```

在 `.env.local` 中配置 `TYPESAFE_API_KEY`。用两个终端分别启动 Data 与 Web，Data 终端需先激活 `.venv`：

```powershell
python -u services/stock-data/server.py --port 8920
```

```powershell
npm run dev -- --port 3400
```

打开 http://localhost:3400 。生产运行先 `npm run build`，再用 `npm run start -- --port 3400` 启动 Web，Data 启动方式相同。首次使用嵌入模型会下载文件到本地缓存。

`npm run data` 拉取全部 A 股上市公司（沪市主板、深市主板、创业板、科创板、北交所，约 5,5XX 家），生成 `data/companies.json`，再用 `bge-small-zh-v1.5` 做本地向量。第一次会下载模型，需要几分钟。已经缓存过的请求不会重抓；抓取按 `--shard i/n` 分进程跑（akshare 的 py_mini_racer 不能在单进程里并发）。

该命令用于维护原始数据，不会重建既有年报/公告证据扩展和冻结基线。取得并核对可使用的数据后，按 [本地数据准备说明](docs/PUBLIC_CODE_RELEASE.md) 恢复输入；更新发现语料走 `npm run corpus:update`。没有数据时首页如实提示缺少公司数据，不加载演示公司池。

公司名单来自交易所 A 股列表（`stock_info_a_code_name`，只有沪深京上市公司，不含 B 股、基金、债券、退市证券）；申万一级行业来自申万宏源「申万指数」成分表（`sw_index_first_info` + `index_component_sw`，**2021 版分类，31 个一级行业**）。申万指数不含北交所公司，次新股可能尚未入类——这些公司的 `swLevel1Industry` 是 `unknown`，不用其他行业分类（东财/同花顺/证监会）冒充。

没有 `TYPESAFE_API_KEY` 时搜索仍能跑：没有语义判断，结果直接由确定性检索排序给出，响应里 `degraded: true`、`judge.provider: "none"`、`decidedBy: "retrieval"`，页面上明示「语义判断服务暂不可用，当前结果使用基础检索排序」。A-Atlas **不回落任何本地判断模型**。Key 放在 `.env.local`，不要写进源码。

## 判断 provider：Jev Cloud（唯一）

`lib/jev/cloud.ts` 的 `JevCloudProvider` 是 A-Atlas 唯一的语义判断来源，端点 `https://api.typesafe.ai/v1/systemone`。配置只有四个变量：

```
TYPESAFE_API_KEY   唯一 key 来源（server-side，不进 bundle / 遥测 / 错误响应）
JEV_MODEL          模型别名，默认 jev-latest
JEV_DETAIL         每个候选送判的 profile 截断字数（默认 420；当前数据集 ≤337 字，实际不截断）
JEV_BASE_URL       仅 CI / 故障注入指向 scripts/jev_stub.mjs；生产不设
```

**别名不是身份。** 启动时 `identityProbe()` 打一次真实双候选请求，`verifyJudgeIdentity()` 把云端应答里的版本与契约 `JEV_PRODUCTION_MODEL = "jev-1.13.0"` 比对；别名底下换了模型就是 `MODEL_IDENTITY_MISMATCH` 事故。搜索缓存 key 带 judge 身份（`judgeCacheIdentity()`），云端换模型后旧缓存自动失效，不会长期回吐旧排序。

稳定性参数全部来自 `npm run jev:baseline` 的真实测量（不是猜的）：三预算分层 connect 2500ms / 单次调用 4000ms / 一次搜索全部 rerank chunk 合计 6000ms / classify 3500ms；只读判断最多重试 1 次（180→360ms 指数退避 ±25% jitter，尊重 `Retry-After`）；401/403 与 4xx 不重试；连续 3 次 provider 失败熔断 20s（坏 key 直接开 60s），熔断期间零网络调用；同时在途请求不超过 4 个（实测超过 4 之后云端自己开始排队）。

降级只有一条路：检索基础排序 + 如实标注。命中缓存不再重新判断（`logCacheHit()` 落 `cacheReplay: true` 行，云端零调用），同一 query 并发去重。实测生产形态 200 候选 = 2 chunk 并发：p50 539ms、p95 1358ms，约 61k tokens ≈ $0.0026 / 次搜索。每次尝试与每次搜索都落遥测（`judge{provider,model,outcome}`、`rerankEvidence`、`productionTuple`），`/api/health` 的 `judge` 字段报 `configured` 与熔断状态——永远不报 key。

## Laya 归 a-share-trawler，不在本仓运行时里

A-Atlas 的本地运行时只有两个组件：**Web（`:3400`）与 Data（`:8920`，a-atlas-data 数据服务）**。**没有 Laya sidecar，没有 `LAYA_URL`，没有 GPU/VRAM 要求**；`:8787` 是 a-share-trawler 自己的实例，两个项目共享历史不共享运行时。

Refocus（2026-09-28）起，Phase 0–4 曾并入的 Vibe AStock 研究系统已从产品与运行时中完全退役（原 Research `:8910` 服务不复存在）；Phase 0–4 报告与历史文档原样保留作为当时架构的证据链，出处见 `THIRD_PARTY_NOTICES.md` 与 `docs/VIBE_REMOVAL_INVENTORY.md`。

本仓保留 Laya 的痕迹只作为历史证据链，不是可用能力：

- `reports/LAYA_*.md`（V1–V4.2 训练/评测/晋升报告）与 `reports/PHASE4_JEV_CUTOVER.md` 的切换记录保留在本机和历史归档，不随公开代码发布。
- `scripts/laya_*.py`、`scripts/train_laya*.py`、`scripts/laya_server.py`、`kaggle_laya_finetune/`——本仓没有 Laya 模型与训练依赖；运行步骤中的 `.venv` 用于 Data 服务。
- 其中 7 个会经 `lib/jev` 打到云端的脚本（`shadow_replay_v41` / `smoke_v41_promotion` / `build_ranking_candidates` / `organic_shadow_protocol` / `residual_triage` / `laya_v4_2_eval_grade` / `stage3_1_smoke`）加了 `requireLayaLane()` 硬闸，默认拒绝运行——否则「Laya 臂」会静默打在 Jev 云上，产出一份没发生过的对比。要到 trawler 跑同名脚本，或显式 `ATLAS_LAYA_LANE=1`（此时被测对象是 Jev）。

## 搜索是怎么做的

自然语言 → 语料检索粗召回（语义 + 字面：BM25 ⊕ bge 向量，都读 [Company Knowledge Corpus](docs/COMPANY_KNOWLEDGE_CORPUS.md) 的 `searchableText`）→ Jev Cloud 对候选人分批做是/否判断（noul 头，Top-200 分 2 chunk 并发，judge 读的也是同一份语料文档）→ 代码里融合成分数 → Matter.js 把对应的牌子从堆里弹上来。判断不可用时停在第三步之前：只用检索排序，并如实标 DEGRADED。

地域和「不要某类公司」这类硬条件在代码里执行，不交给 Jev。

## 行情发现：当前验收范围

当前按「收盘排行＋业务条件」收尾。可以查「今天涨幅前10的公司」「近20日相对放量前20的公司」「半导体公司里今天涨幅前5」「今天涨幅前20里做半导体的公司」。业务内前5沿整个可排行集合逐批检查业务资格；行情前20内的业务子集保持行情名次，不补位。

结果注明快照交易日、来源、覆盖与扫描完整性。扫描达到 1,000 家、20 批、30 秒或估算 US$0.05 的预算上限，或高位仍有未决资格时，如实标为不完整。没有 Jev 资格判断的公司不冒充业务匹配。

盘中真实时效仍待开市验收；源端量比基准未核验，相关排行保持禁用。「近20日相对放量」是明确的历史成交量口径，不替代源端量比。本人真实使用与反馈（M4）待完成，详见 [收尾记录](docs/MARKET_DISCOVERY_CLOSEOUT_2026_10_04.md) 与 [M3 契约](docs/MARKET_DISCOVERY_M3_REPORT.md)。

Data 服务按请求更新、校验并原子发布运行快照，Web 无需重启。盘后可手动刷新；命令使用当前 Python 环境，因此需先激活 `.venv`：

```powershell
npm run market:refresh
npm run market:prune                # 预览清理候选
npm run market:prune -- --apply      # 执行清理
```

发布成功后自动尝试清理：保留最近 7 天、至少最新 2 份、当前快照、仍被 Web 读取的快照及它们引用的历史快照。发布与清理共用锁；损坏文件、缺失引用或锁冲突使清理中止，保留已发布结果。`data/market-runtime/` 是本地运行数据；本地冻结的 `data/market/` 基线不清理。两者均不进公开Git历史。

## Company Knowledge Corpus（发现索引的语义层）

本机冻结基线的 `data/company-corpus/companies.jsonl` 有5567份 `CompanyKnowledgeDocument`（schema 1.0.0）：身份、别名（含明示曾用名）、简介、主营业务、主营构成、证据回指的主题、规则在案的排除标签、逐字段 provenance。唯一 canonical builder（`npm run corpus:build`）从本地事实确定性生成，同输入重建逐字节相同。公开CI没有这些输入，不执行全池 `corpus:check`；本地完整验收继续执行，`generatedAt` 不污染 contentDigest。

纪律：缺失就是缺失（没有公告语义、没有研报观点、没有概念炒作标签、没有 LLM 富化）；每条主题必须回指原文词面；Jev 只负责判断，不做数据清洗。搜索日志每行如实记录当时读的 corpus digest。设计与覆盖率详见 [docs/COMPANY_KNOWLEDGE_CORPUS.md](docs/COMPANY_KNOWLEDGE_CORPUS.md)。

## 搜索 Universe 与物理堆是两回事

搜索索引覆盖全部 A 股公司；底部物理堆只放一个固定抽样（`PHYSICS_POOL_SIZE`，默认 300，同一份数据每次加载是同一批——稳定种子抽样，不是随机刷新）。搜索命中的公司即使不在池里，也会动态生成刚体浮上来，松手后落回堆里。

卡片配色有两套主题，左下角可切换，默认是确认过的米白基线：

- `classic`：原始米白卡片，一个字节都没变。
- `sw-industry`：同一张米白卡上极轻的申万一级行业色偏（`components/floor/theme.ts` 的 `SW_LEVEL1_COLOR_MAP`）。颜色只表示行业，与匹配度无关；行业名文字只在搜索结果的放大牌上出现，堆里的小牌只靠颜色。

## 数据底座：a-stock-data（refocus 后新增）

公司页的市场快照 / 基础财务 / 最近公告 / 最近研报来自 [simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)（Apache-2.0，vendor 快照钉在 `vendor/a-stock-data/`）：

- **build-time 抽取**：`scripts/extract_stock_data.py` 按「唯一 `def` 块 + AST 剪示例」从 SKILL.md 机械抽取四类能力入口到 `services/stock-data/generated/`，绝不运行时解析 432 KB Markdown，绝不手抄函数。
- **常驻薄服务**：`services/stock-data/server.py`（stdlib HTTP，:8920）做 canonical 6 位码归一、TTL 缓存、EMPTY / UNAVAILABLE / ERROR 三态分类——**没有数据 ≠ 数据源坏了**。
- **数据契约**：`lib/stockdata/contracts.ts` 是 Web 侧唯一线格式；公司页按块如实降级，provenance（源 + 时间）轻量可见。
- **克制原则**：底层 87 个能力入口存在，不构成展示它们的理由（refocus §四十六）——目前只暴露四类，新数据能力必须由真实使用需求驱动。

## 验收

公开克隆运行 `npm run publication:check`、`npm run test:public`、`npm run typecheck`、`npm run build`。公开CI只验收不依赖私有数据的代码；全池发现、证据、真实响应回放、冻结质量基线和浏览器搜索烟测需要本地数据，仍走完整验收，不把公开子集冒充完整功能验收。

下面命令用于已准备完整数据的本地正式项目：

```bash
npm run corpus:build     # 重建语料 artifact（确定性，离线，~1.3s）
npm run corpus:vectors   # 增量 embedding（hash16 复用）
npm run corpus:check     # 本地同输入重建逐字节对账
npm run market:check     # 本地冻结行情基线确定性对账
npm run eval:retrieval   # 只有召回，Jev 的对照基线（不调云端）
npm run eval             # 完整路径。没有 key 时是纯检索排序且标 DEGRADED，不会偷偷换成别的判断
npm run jev:baseline     # 真实云端延迟分布，稳定性预算的数字来源
npm test
npm run typecheck
npm run build
```

## 边界

不做交易、持仓、收益预测或投资建议。搜索覆盖全部 A 股；画面里的堆是固定抽样池，不追求「几千张牌同时堆在屏幕上」。

## 开发与同步

本仓是唯一正式开发仓，默认分支 `master`。修改、测试、提交后先执行 `npm run publication:check`，再用 `git push origin master` 同步 GitHub；公开端的改动通过 `git pull --ff-only` 拉回，不维护手工同步副本。`data/`、`reports/`、冻结质量结果和真实响应夹具保持本地，并另行备份，不用 `git add -f` 或LFS绕过发布范围。

项目原创代码采用 [Apache-2.0](LICENSE)，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；数据范围与再分发状态见 [DATA_NOTICE.md](DATA_NOTICE.md)。旧提交与冻结报告的出处对应关系见 [统一仓库迁移记录](docs/UNIFIED_REPOSITORY_2026_10_04.md)。
