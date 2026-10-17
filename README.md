# A 股公司发现

> Atlas / Trawler 工程合并及正式目录切换已完成。双模型、训练与数据私有契约见 [统一运行说明](docs/ATLAS_TRAWLER_MERGER_RUNTIME.md)。Laya 持续训练的目标是替代 Jev，质量目标仍未完成，见 [训练目标](docs/LAYA_REPLACEMENT_OBJECTIVE.md)。

用一句话描述你要找的公司，匹配的公司牌会从物理堆里浮上来。

首页是一堆公司牌和一个搜索框；用业务、产品或关系描述发现公司，点开查看匹配证据与公司业务资料。语义结果标的是**相关度**，不是上涨概率。2026-10-16 起以搜索质量为主线：行情/财务筛选与排行退出发现，公司页不展示图表、报价、财务、公告或研报列表。当前边界与质量工作流见 [搜索质量主线](docs/SEARCH_QUALITY_MAINLINE_2026_10_16.md)。

## 运行

需要 Git、Node.js 24、Python 3.12；不需要GPU、Laya或本地判断模型。公开仓库只包含代码，不包含公司数据、披露摘录、语料、向量、行情、训练数据、真实响应夹具和历史评测产物。Git LFS 不用于公开分发这些数据。**启动两个服务不等于已具备公司发现数据**：空仓库可以启动并显示缺少数据的提示，完整搜索还需准备下述输入。

首次克隆显式选择 `master`；已有正式项目直接进入原目录，不再克隆、不覆盖本机数据。以下命令以Windows PowerShell为例，全部从仓库根目录执行：

```powershell
git clone --branch master https://github.com/TomNick777/a-atlas.git
Set-Location a-atlas
node --version                       # 应为 v24.x
python --version                     # 应为 3.12.x
npm ci
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
git config core.hooksPath .githooks
```

`.env.local` 的 `ATLAS_DATA_URL` 保持 `http://127.0.0.1:8920`。`TYPESAFE_API_KEY` 可以留空，搜索如实退回确定性检索；用户提供自己的key时才启用Jev Cloud。保留已有 `.env.local`，不要打印key，日常启动不设置 `JEV_BASE_URL`。

有本机数据时先复用；若 `data/companies.json`、`data/company-corpus/companies.jsonl`、其 `manifest.json` 与 `data/vectors_corpus.f32` 是同一批完整输入，不要为了启动重新采集或改写它们。缺失数据有两条路径：恢复可使用的本地数据包（见 [数据准备说明](docs/PUBLIC_CODE_RELEASE.md)），或自行采集基础资料并构建基础发现索引。在已激活 `.venv` 的终端、确认需要联网采集后执行：

```powershell
npm run data                          # 公司基础资料与基础向量；访问数据源和模型下载站
npm run corpus:update                 # 确定性构建 corpus，再生成 corpus 向量
npm run corpus:check                  # 核对新生成语料
```

自行采集仅生成当次取得资料的索引，不恢复既有年报/公告/官网证据扩展、冻结质量结果或历史行情，不能宣称复现了原5567家公司基线。采集/下载失败时报告具体失败步骤和缺失输入，不造公司池、不写示例数字、不换判断模型。首次嵌入需取得 `Xenova/bge-small-zh-v1.5`，缓存位于 `.cache/huggingface/`；离线环境需预先准备完整兼容缓存，测试夹具不能当生产模型。

用两个终端启动服务，各自进入同一仓库根目录。终端A使用本仓虚拟环境启动Data：

```powershell
.\.venv\Scripts\python.exe -u services/stock-data/server.py --port 8920
```

终端B启动Web：

```powershell
npm run dev -- --port 3400
```

终端C或浏览器检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8920/health
Invoke-RestMethod http://localhost:3400/api/health
```

两个响应的 `service` 应分别为 `a-atlas-data`、`a-atlas-web`。Web的HTTP 200只证明Web活着，还要检查 `status` 和 `components`；没有key时Jev降级符合预期。打开 http://localhost:3400 ，有数据时应能看到公司牌、搜索并打开 `/stock/<6位代码>`，无数据时应看到缺少公司数据提示。当前公司发现和公司页不请求 Data 行情/资讯；上述两服务启动与探活方式保留给既有受管运行时，不能将健康检查当作搜索质量验收。

生产模式使用 `npm run build`，然后 `npm run start -- --port 3400`；Data命令相同。停止本次启动的进程用对应终端的Ctrl+C；若端口被占，先确认占用者和项目身份，不结束无关进程。

公司发现不需要交易日历或行情快照。旧行情维护已独立，见 [维护入口](docs/MARKET_MAINTENANCE.md)。

`npm run data` 拉取全部 A 股上市公司（沪市主板、深市主板、创业板、科创板、北交所，约 5,5XX 家），生成 `data/companies.json`，再用 `bge-small-zh-v1.5` 做本地向量。第一次会下载模型，需要几分钟。已经缓存过的请求不会重抓；抓取按 `--shard i/n` 分进程跑（akshare 的 py_mini_racer 不能在单进程里并发）。

该命令用于维护原始数据，不会重建既有年报/公告证据扩展和冻结基线。取得并核对可使用的数据后，按 [本地数据准备说明](docs/PUBLIC_CODE_RELEASE.md) 恢复输入；更新发现语料走 `npm run corpus:update`。没有数据时首页如实提示缺少公司数据，不加载演示公司池。

公司名单来自交易所 A 股列表（`stock_info_a_code_name`，只有沪深京上市公司，不含 B 股、基金、债券、退市证券）；申万一级行业来自申万宏源「申万指数」成分表（`sw_index_first_info` + `index_component_sw`，**2021 版分类，31 个一级行业**）。申万指数不含北交所公司，次新股可能尚未入类——这些公司的 `swLevel1Industry` 是 `unknown`，不用其他行业分类（东财/同花顺/证监会）冒充。

## 可直接交给 Agent 的启动任务

复制下面这段作为Agent任务。详细规则以本仓 `AGENTS.md` 为准，执行现有命令即可，不需要改产品或搜索算法：

```text
请把 A-Atlas 在本机跑起来，并验证实际可用程度。先读 AGENTS.md、README.md
和 docs/PUBLIC_CODE_RELEASE.md。已有项目用原目录；新环境克隆
https://github.com/TomNick777/a-atlas.git 的 master 分支。检查 Git、Node 24、
Python 3.12 和 git status；在仓库根目录 npm ci，建立/复用 .venv，安装
requirements.txt。只在缺失时从 .env.example 建立 .env.local，保留已有配置。
默认不添加 Jev key，不运行 LIVE benchmark；只有用户提供key并要求启用时
才使用 TYPESAFE_API_KEY，不输出key，不设置生产 JEV_BASE_URL。

公开仓库没有真实数据。先检查 companies.json、company-corpus 的JSONL/manifest
与 vectors_corpus.f32 是否完整且对应，优先复用本机数据。缺失时先验证空应用
可启动并如实报告；用户要求准备基础公司发现数据时，在激活 .venv 的终端依次
执行 npm run data、npm run corpus:update、npm run corpus:check。联网/模型缓存
不可用则说明阻塞及缺失输入；不要伪造数据、改语料、改检索或添加判断回落。
这些命令不重建原冻结基线；公司发现无需行情数据或交易日历。

保持两个服务运行：Data用 .venv/Scripts/python.exe -u
services/stock-data/server.py --port 8920；Web用 npm run dev -- --port 3400。
两个进程的工作目录都是仓库根目录。探测 :8920/health 和 :3400/api/health，
核对service身份、components和status；打开首页，数据齐备时用一次不带行情
条件的公司发现查询验证公司牌和公司页，没有key时应明确显示检索降级。
不得把HTTP 200、空首页或代码测试通过当作完整公司发现验收。

在激活 .venv 的终端运行 npm run test:public、npm run typecheck 和
npm run publication:check；公开克隆不要运行依赖私有数据的完整 npm test。
如需生产运行，再 npm run build 并 npm run start -- --port 3400。
最后报告目录、分支、服务地址/进程、探活结果、数据及模型准备情况、Jev是否
启用、通过的检查和仍不可用的功能。不上传私有数据、不启动Laya/GPU服务、
不重启无关进程；清理本次临时验证产物，保留需要继续使用的服务。
```

没有 `TYPESAFE_API_KEY` 时搜索仍能跑：没有语义判断，结果直接由确定性检索排序给出，响应里 `degraded: true`、`judge.provider: "none"`、`decidedBy: "retrieval"`，页面上明示「语义判断服务暂不可用，当前结果使用基础检索排序」。A-Atlas **不回落任何本地判断模型**。Key 放在 `.env.local`，不要写进源码。

## 判断 provider：明确选择

所有生产判断只经 `lib/intelligence/capabilities`，每次请求明确选择 Jev、Drex 或 Laya，互不回落。Jev 默认固定 `jev-1.13.0`，凭证为服务端 `TYPESAFE_API_KEY`；Drex 默认固定 `drex-v1.5`，凭证为 `NACE_API_KEY`；Laya 只使用私有 registry 的 active。密钥不进入源码、浏览器、日志或错误响应，生产不设置用于故障注入的 `JEV_BASE_URL`。

**配置不是实际身份。** 实际应答必须通过固定版本/装载身份核验。搜索缓存绑定 judge 身份、corpus、parser、公司发现契约与原查询，模型或产品契约变化不复用旧排序；历史答案仍使用原身份和证据。

选定模型缺配置、超时或准入失败时，搜索明确 DEGRADED，仅用确定性检索排序。模型升级、训练与质量测量分开验收；当前版本与预算纪律见 [升级准备](docs/JUDGE_MODEL_UPGRADE_2026_10_16.md) 和 [运行契约](docs/ATLAS_TRAWLER_MERGER_RUNTIME.md)，不以历史延迟数字或工程接入宣称当前搜索质量。

## 统一模型与训练运行时

A-Atlas 现有受管运行时为 **Web（`:3400`）与 Data（`:8920`）**；可选 **Laya（`:8787`）** 归统一工程。设置里显式选择 Jev、Drex 或 Laya，下一次搜索生效；请求不静默换模型。公司发现不需要 GPU，Laya 本地推理与训练需要匹配的 CUDA 环境。当前公司发现和公司页不调用 Data 行情/资讯；受管服务登记保持原契约。

Refocus（2026-09-28）起，Phase 0–4 曾并入的 Vibe AStock 研究系统已从产品与运行时中完全退役（原 Research `:8910` 服务不复存在）；Phase 0–4 报告与历史文档原样保留作为当时架构的证据链，出处见 `THIRD_PARTY_NOTICES.md` 与 `docs/VIBE_REMOVAL_INVENTORY.md`。

训练、精确恢复、评估、候选晋升和回退由统一 CLI 提供，Data 使用 `.venv`，Laya 使用 `.venv-laya`。active 只从 `models/registry.json` 装载；失败候选不晋升，训练不会自动改变模型选择。原 v4.1 是可选基线，质量差距继续如实记录。

- `reports/LAYA_*.md`（V1–V4.2 训练/评测/晋升报告）与 `reports/PHASE4_JEV_CUTOVER.md` 的切换记录保留在本机和历史归档，不随公开代码发布。
- 历史脚本保留在 `training/laya/legacy/`；日常用 `npm run laya:train|laya:resume|laya:evaluate|laya:promote|laya:rollback`，参数见统一运行说明。旧实验入口不作为新的生产工作流。
- 权重、数据、报告、恢复状态、真实应答留在本机，不进入公开 Git 历史；日常操作不依赖 trawler 的绝对路径或进程。

## 搜索是怎么做的

自然语言 → 公司发现范围检查 → 语料检索粗召回（语义 + 字面：BM25 ⊕ bge 向量，都读 [Company Knowledge Corpus](docs/COMPANY_KNOWLEDGE_CORPUS.md) 的 `searchableText`）→ 明确选择的 judge 对候选分批判断并引用证据 → 保留有证据的匹配及服务端顺序 → Matter.js 把对应的牌子从堆里弹上来。判断不可用时只用检索排序，并如实标 DEGRADED。

地域和「不要某类公司」这类硬条件在代码里执行，不交给 Jev。

## 搜索质量与本地诊断

主线入口不读取行情快照或交易日历。确定性 grammar 只作范围检查：行情排行、价格/财务筛选或混合条件诚实拒绝，不删除条件后回答部分查询。业务原文进入现有检索；模型明确拒绝或缺证据的公司不为凑数展示。judge 不可用时仍可看基础检索结果，明确标为降级。

```powershell
npm run search:query -- --explain "做伺服电机的公司"       # 只解析，不请求模型
npm run search:query -- --retrieval-only "做伺服电机的公司" # 召回诊断，不调用 judge
npm run telemetry:inspect -- <search_trace_id>             # 真实搜索的完整链路
```

质量改进逐条区分事实覆盖、候选召回、judge 判断、排序/展示与运行失败。工程测试通过不代表搜索好用，模型训练/升级也不能代替真实需求验收。旧行情代码、API、CLI 与快照留作 [独立维护](docs/MARKET_MAINTENANCE.md)，不再是产品发现功能；旧 benchmark 回放不能冒充当前产品入口的质量结果。

## Company Knowledge Corpus（发现索引的语义层）

本机冻结基线的 `data/company-corpus/companies.jsonl` 有5567份 `CompanyKnowledgeDocument`（schema 1.0.0）：身份、别名（含明示曾用名）、简介、主营业务、主营构成、证据回指的主题、规则在案的排除标签、逐字段 provenance。唯一 canonical builder（`npm run corpus:build`）从本地事实确定性生成，同输入重建逐字节相同。公开CI没有这些输入，不执行全池 `corpus:check`；本地完整验收继续执行，`generatedAt` 不污染 contentDigest。

纪律：缺失就是缺失（没有公告语义、没有研报观点、没有概念炒作标签、没有 LLM 富化）；每条主题必须回指原文词面；Jev 只负责判断，不做数据清洗。搜索日志每行如实记录当时读的 corpus digest。设计与覆盖率详见 [docs/COMPANY_KNOWLEDGE_CORPUS.md](docs/COMPANY_KNOWLEDGE_CORPUS.md)。

## 搜索 Universe 与物理堆是两回事

搜索索引覆盖全部 A 股公司；底部物理堆只放一个固定抽样（`PHYSICS_POOL_SIZE`，默认 300，同一份数据每次加载是同一批——稳定种子抽样，不是随机刷新）。搜索命中的公司即使不在池里，也会动态生成刚体浮上来，松手后落回堆里。

卡片配色有两套主题，左下角可切换，默认是确认过的米白基线：

- `classic`：原始米白卡片，一个字节都没变。
- `sw-industry`：同一张米白卡上极轻的申万一级行业色偏（`components/floor/theme.ts` 的 `SW_LEVEL1_COLOR_MAP`）。颜色只表示行业，与匹配度无关；行业名文字只在搜索结果的放大牌上出现，堆里的小牌只靠颜色。

## 数据底座：a-stock-data（refocus 后新增）

独立维护的市场快照 / 基础财务 / 公告 / 研报能力来自 [simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)（Apache-2.0，vendor 快照钉在 `vendor/a-stock-data/`），已从公司页解除挂载：

- **build-time 抽取**：`scripts/extract_stock_data.py` 按「唯一 `def` 块 + AST 剪示例」从 SKILL.md 机械抽取四类能力入口到 `services/stock-data/generated/`，绝不运行时解析 432 KB Markdown，绝不手抄函数。
- **常驻薄服务**：`services/stock-data/server.py`（stdlib HTTP，:8920）做 canonical 6 位码归一、TTL 缓存、EMPTY / UNAVAILABLE / ERROR 三态分类——**没有数据 ≠ 数据源坏了**。
- **数据契约**：`lib/stockdata/contracts.ts` 保留兼容线格式与失败语义；现有维护调用仍区分数据为空、未覆盖和服务故障。
- **克制原则**：底层能力存在，不构成展示理由；当前产品只消费公司事实与搜索证据。

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
