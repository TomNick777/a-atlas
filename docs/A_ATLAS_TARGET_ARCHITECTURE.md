> **HISTORICAL / RETIRED（2026-09-28 Refocus）**
> 本文档描述的 Vibe AStock 集成架构已从当前产品与运行时中整体退役
> （`docs/VIBE_REMOVAL_INVENTORY.md`）。内容未经改写，仅作为当时真实发生过的
> 架构证据保留；当前事实以 `PROJECT_STATE.md` 文首「Refocus · Data Foundation」为准。

# A-Atlas｜A股星图 — Target Architecture（Phase 0 产出）

> 状态：Phase 0 定稿，Phase 1 按 §4 实施。
> **Phase 4 修订（2026-09-28）**：语义判断 provider 由本地 Laya sidecar 切换为 **Jev Cloud**，
> A-Atlas 运行时对 Laya 的依赖清零（§2/§5 已按现状改写，证据见 `reports/PHASE4_JEV_CUTOVER.md`）。
> 本地运行时只有 Web（:3400）+ Research（:8910）两个组件；Laya 实验道归 a-share-trawler。
> 原则：**能力完整，界面克制。发现是入口，公司是核心，市场和研究是纵深。**

## 1. 产品定位

A-Atlas = 从自然语言发现 A 股公司（现 a-share-trawler 的全部能力），延伸到理解公司、研究公司、
理解市场、积累个人研究（Vibe AStock 的全部能力）。以现有 A股公司发现为产品 DNA 与主壳，
吸收 Vibe AStock 完整研究系统。**不是 Vibe 换皮，也不是两个应用的链接拼接。**

## 2. 一级信息架构

```
A-Atlas
│
├── 发现 Discover  (/)                      ← 产品英雄体验，保持克制
│   ├── Company Corpus   data/companies.json（5567 家池，含 profile/enrichment）
│   ├── Jev Cloud        api.typesafe.ai/v1/systemone（Phase 4：唯一判断 provider，无本地回落）
│   └── Search Ranking   lib/search/* + search/ontology + search/profile（不动）
│
├── 公司 Company Domain   /stock/:symbol     ← 第二核心，canonical StockIdentity
│   └── 统一 StockIdentity（见 §3）：公司发现池 ↔ Vibe 研究能力 的稳定边界
│
├── 市场 Market   (/market)
│   ├── quotes    盘面数据 / 实时动态 / 昨日梯队 / 盘中核验
│   ├── watch     首板分析 / 近 5 日热度
│   ├── review    每日复盘 / 历史统计
│   └── intel     资讯雷达 / 事件概率
│
├── 研究 Research   (/research)
│   ├── financial 财务 / 估值 / 财报速览 / 估值分位
│   ├── valuation 研报 / 新闻 / 公告 / 投资者问答
│   ├── reports   报告归档 / AI 深度分析 / 多空辩论
│   ├── events    龙虎榜 / 解禁 / 分红 / 大宗交易 / 融资融券
│   ├── capital   资金流 / 板块 / 热门概念
│   ├── deepdive  个股深挖（四维分析师 + 多空辩论 + 证据冻结）
│   └── backtest  策略回测 / 历史统计回测
│
├── 我的 My   (/my)
│   ├── watchlist 自选（Vibe: localStorage vr-watchlist）
│   ├── portfolio 持仓（Vibe: 交易日志聚合，单一事实源）
│   ├── journal   交易日志 / 风控规则 / 模式卡
│   └── notes     研究记录 / 已保存报告
│
└── AI
    ├── providers  Jev Cloud（`TYPESAFE_API_KEY`，Discover 判断的唯一来源）+ Vibe provider 层（MiMo / OpenAI 兼容 / Codex 订阅 / Claude / CodeBuddy）
    ├── agents     复盘 Agent / DeepDive Agent / 页面问答（chat-jobs）
    ├── tasks      job 轮询 + request_id 幂等 + 取消（Vibe review_agent 模式）
    └── evidence   SHA256 冻结输入 / 引用契约 / 归档（Vibe grounding 架构）
```

**AI 原则不变**：事实数据 → 确定性计算/搜索 → 结构化结果 → AI 阅读/解释/对比/研究。
公司发现始终由现有检索系统负责；大模型不做行情或事实数据源。

## 3. Company Domain — canonical `StockIdentity`

```ts
// lib/atlas/stockIdentity.ts
type StockExchange = "SH" | "SZ" | "BJ";
type StockBoard = "main" | "b" | "chinext" | "star" | "bse";

type StockIdentity = {
  symbol: string;        // canonical：6 位数字代码，如 "688017"
  exchange: StockExchange; // "SH" | "SZ" | "BJ"
  board: StockBoard;       // "main" | "b" | "chinext" | "star" | "bse"
};
```

映射规则（`exchangeFor` / `boardFor`，纯函数、有测试锁定）：

| 代码前缀 | exchange | board | 例 |
|---|---|---|---|
| 60 | SH | main（沪主板） | 600519 |
| 688 / 689 | SH | star（科创板） | 688017 |
| 900 | SH | b（沪 B） | 900948 |
| 000 / 001 / 002 / 003 | SZ | main（深主板，含原中小板） | 000001 |
| 200 | SZ | b（深 B） | 200002 |
| 300 / 301 / 302 | SZ | chinext（创业板） | 300750 |
| 43 / 83 / 87 / 88 / 92 | BJ | bse（北交所） | 830799, 920002 |

- **URL 形态**：`/stock/688017`（canonical symbol 即 URL）。
- `normalizeSymbol(input)`：接受 `688017`、`688017.SH`、`SH688017`、`sh688017` 等输入，
  归一为 6 位代码；非法输入返回 null → 404。
- **边界契约**：
  - 现有公司池 `data/companies.json` 的 `code` 字段 = canonical symbol（零转换成本）。
  - Vibe 后端 API 的 `?code=` 参数 = 同一个 6 位代码（Vibe 前端也是纯 6 位，`688017.SH` 只是
    输入端剥后缀）——A-Atlas 的 `/stock/:symbol` 直接可拼 Vibe 研究数据 URL。
  - 老的 `/stock-data?symbol=XXXXXX` 兼容层：Vibe 前端迁移时（Phase 2+）提供 redirect
    `/stock-data?symbol=688017` → `/stock/688017`；Phase 1 不删任何 Vibe 代码。

## 4. Phase 1 骨架（本轮实施范围）

| Route | 内容 |
|---|---|
| `/` | 现 A股公司发现首页原样（YC-indexor 布局 + 物理堆），仅加：① 一级导航条 ② 点公司牌 → `/stock/:symbol`（复用遥测 `RESULT_OPEN_DETAIL`） |
| `/stock/[symbol]` | 统一公司页：name/code/行业/板块/简介/主营/主营产品构成/概念/地区/市值快照；从 Discover 进入时带 `?q=&m=` 显示「为什么匹配本次搜索」；行情/财务/估值/事件 = 诚实占位（Phase 2 接 Vibe 数据）；「更多研究」入口（个股研究/多空辩论/回测/报告） |
| `/market` | Market shell：Vibe 市场能力全量映射为分组导航，Phase 2 接数据 |
| `/research` | Research shell：个股研究（支持输入代码跳 `/stock/:symbol`）+ 多空辩论/回测/报告入口 |
| `/my` | My shell：自选/持仓/交易日志/研究记录/已存报告映射 |
| 导航 | 一级只显示 发现/市场/研究/我的；设置留在发现页左下角（现有 devtools 风格面板），导航右侧次级入口指回发现页 |

Phase 1 **不做**：视觉重构、重写搜索、重训 Laya、复制 Vibe 页面代码、行情假数据。
（Phase 4 起 Laya 整体移出 A-Atlas 运行时，「不重训」升级为「不拥有」——见 §5。）
所有占位一律如实标注「Phase 2 接入」，不伪造数据（产品原则：真实数据或如实说明缺失）。

## 5. 运行时拓扑（Phase 4 实际运行）

```
浏览器
  └─ A-Atlas Next.js (a-atlas, dev :3400 / prod 单进程)
        ├─ 页面：/ /stock/:symbol /market /research /my
        ├─ /api/search → lib/search/pipeline（RRF 检索 + Jev Cloud noul 重排）
        └─ HTTPS → Jev Cloud  https://api.typesafe.ai/v1/systemone
             key = TYPESAFE_API_KEY（server-side only）· 别名 = JEV_MODEL(jev-latest)
             在岗身份 = 云端应答的 jev-1.13.0（identityProbe() 核验，漂移即事故）
             预算/重试/熔断/准入 = lib/jev/provider.ts（实测 p50 539ms、p95 1358ms）
             不可用 → 确定性检索排序 + 如实标 DEGRADED（**没有任何本地回落**）

Phase 2+ 追加：
  A-Atlas API 适配层 (/api/market/*, /api/research/*)
    └→ Vibe FastAPI (server.py, :8910，独立 Python 服务原样保留)
        ├─ vr/（市场/个股数据源：东财/腾讯/akshare/问财/巨潮）
        ├─ duanxian/（短线业务层：复盘/情绪/日志/风控）
        └─ review_agent/（受限 AI 任务：SQLite 会话/证据冻结/job 轮询）
```

- **本地组件恰好两个**：Web（:3400）与 Research（:8910）。Jev Cloud 是外部 SaaS 依赖，
  不是本机 service（Harbor 启停不了它，所以不进 service 列表）。GPU/VRAM 不再是 A-Atlas
  的运行时要求——那是 Laya 道的属性，归 a-share-trawler。
- **Harbor**：A-Atlas 以**一个 Harbor 应用**登记（AppRuntimeSpec 描述上面两个受管 service）；
  Inspector 如实分列各 service 状态，不做 fake single-process。定稿见 AUDIT 文档 §D。
- **「双 Laya 禁令」概念消失**：A-Atlas 不再有 Laya 运行时，也就没有「起第二个 sidecar」
  这件事可禁。`:8787` 与 V4.1 checkpoint 由 a-share-trawler 自己持有；A-Atlas 既不检查、
  不启动、也不验证任何本地判断模型（`scripts/atlas_start.cmd` 契约第 1 步只校验 Jev 配置，
  缺 key 不阻塞启动）。

## 6. 数据归属

| 数据 | 归属 | 说明 |
|---|---|---|
| `data/companies.json` + vectors/manifest/profiles | Discover（a-atlas 仓库内，git 跟踪） | 5567 家池，搜索语义资料 |
| 证券身份（code/name/exchange/board/industry） | Company Domain | StockIdentity，全产品共享 |
| Vibe 业务数据 `~/.duanxian-agents/`、`~/.vibe-astock-agent/` | Market/Research/My（Python 服务私有） | reviews/journal/risk/agent SQLite，**不并入 Next 仓库** |
| Vibe 用户数据 `VR_DATA_DIR`（portfolio.json/myreports/monitor） | My（经适配层暴露） | 迁移期保留原路径，Phase 2 决定是否搬家 |
| watchlist / notes（Vibe 前端 localStorage） | My | Phase 2 迁到 A-Atlas 持久层（服务端），避免仅存浏览器 |
