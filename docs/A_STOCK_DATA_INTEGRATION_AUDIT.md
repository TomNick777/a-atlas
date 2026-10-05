# a-stock-data 集成审计（Refocus · Data Foundation）

> 审计对象：`simonlin1212/a-stock-data` @ `f814dcf`（v3.10.0，2026-09-22 发布线）。
> 只读上游 clone：`D:\workspace\a-stock-data`（不改上游；A-Atlas 的修改只发生在 vendor 快照、抽取脚本、generated 模块与 adapter）。
> 本文档回答 refocus §十六 的全部审计项，并给出 vendor 与 runtime 方式决策（§十八–§二十二）。

## 1. 上游是什么

**不是传统 pip SDK**——没有 `pyproject.toml`、没有 Python 包。它是一个「自包含 A 股数据 Skill」：

- `SKILL.md`（432 KB，~40 万字）是唯一载体：15 层 × 75 个编号入口（README 口径 87 入口 = 82 主 + 5 备胎；路由速查表 78 行）+ 34 个数据源，内嵌 ~94 个 ```python 围栏块（每块 = imports + 常量 + 函数 + `# 用法` 注释）。
- `tests/` 3 个文件：**测试的就是从 SKILL.md 里抽出来的代码**（「Test the Python shipped inside SKILL.md, not a second implementation」）。V3.9+ 块用 HTML 注释标记对（`<!-- v39-helpers:start/end -->` 等 19 对）定位；legacy 块用「唯一 `def <name>(` 正则定位 + AST 剪掉模块级示例调用」。
- Python 3.9+（测试用 AST 断言 3.9 兼容语法）；依赖 `requests pandas mootdx stockstats numpy baostock xlrd openpyxl`（akshare 自 V3.0 移除）。**A-Atlas 首批四类能力最小依赖只有 `requests`。**
- 版本节奏很快：6 个月 25 个 release，Layer 编号与源活性逐版变动 → **必须钉住 upstream commit**。
- Apache-2.0（Copyright 2026 Simon Lin），无 NOTICE 文件。

## 2. 首批四类能力的上游映射（refocus §十八）

### Quote（市场快照）
- 入口：§1.1 `tencent_quote(codes: list[str]) -> dict[str, dict]`，腾讯 `qt.gtimg.cn`（GBK，`~` 分隔 88 字段，文档注明不封 IP）。
- 返回字段覆盖需求：`name/price/change_pct/pe_ttm/pb/mcap_yi(亿)/turnover_pct` + 停牌/废码启发式 `is_stale/stale_reason`；非交易时段返回最近快照。
- 已知坑（上游自己标注）：43 位是振幅不是 PB（PB=46）；44/45 流通-总市值曾颠倒（2026-07-26 修正）；短行被静默跳过；符号必须是无后缀 6 位或 sh/sz/bj 前缀（`600519.SH` 会静默空结果）。

### Fundamentals（基础财务）
- 无单一入口给全五字段，取组合：
  - §6.4 `sina_financial_report(code, report_type="lrb", num=8)`：新浪利润表/资产负债表/现金流，按报告期倒序，值是原始字符串（需转型），含同比；**毛利率由营收-营业成本计算，ROE 由 lrb+fzb 计算**——计算发生在 adapter，不伪造字段。
  - 备选（不用）：§6.1 mootdx TCP 快照（eps/roe 现成但 7709 TCP 海外常失败）、§6.3 `eastmoney_stock_info`（只有股本/市值/行业，非利润表）。
- 语义：只报「已披露报告期」，区分空数据与源失败。

### Announcements（最近公告索引）
- 入口：§7.1 `cninfo_announcements(code, page_size=30)`，巨潮 `hisAnnouncement/query`；首次调用下载官方 `szse_stock.json` orgId 映射进内存缓存。
- 返回 `title/type/date/url`，正是契约字段。上游只有第 1 页、无日期窗口参数——第一阶段只做「最近公告索引」，够用。

### Research Reports（最近研报索引）
- 主源：§2.1 `eastmoney_reports(code, max_pages=5)`，东财 reportapi，经 `em_get` 节流（1s + 抖动，429/5xx 重试、403 故意不重试）。字段含 `title/publishDate/orgSName/infoCode(→PDF)/emRatingName(评级)/3 年 EPS 预测`——评级字段现成。
- 北交所老号段（43/83/87 开头）上游**抛 ValueError** 而非返回空——adapter 必须把它映射为「源不覆盖」而不是异常。
- 备源：§2.4 `sina_research_reports`（6s 强制间隔、无评级）——第一阶段不接，记录为备胎。

## 3. 错误语义（refocus §二十四 的上游依据）

上游两代约定并存，adapter 层统一：

| 代 | 约定 | 代表 |
|---|---|---|
| V3.9+ | 「确实没有数据」→ 空表/`ValueError`；「接口坏了」→ `RuntimeError`（结构变化、翻页断裂、契约字段缺失）；每行附 `source/source_url/fetched_at` provenance | `_v39_*` 家族 |
| legacy（本批四类所在） | 不一致：有的失败返回 `[]`、有的静默跳行/零填充、有的抛异常 | `tencent_quote`、`sina_financial_report`、`cninfo_announcements`、`eastmoney_reports` |

因此 **A-Atlas 数据服务在 legacy 函数外包一层分类器**：把「空列表/空载荷」→ `EMPTY`，「超时/HTTP 错误/结构异常」→ `ERROR`，「上游声明不覆盖（如 BSE 老号段 ValueError）」→ `UNAVAILABLE`。绝不把源故障渲染成「该公司没有研报」。

## 4. 其他审计项

- **节流**：东财全家经 `em_get`（模块级 session、1s 间隔 + 抖动、重试白名单）；腾讯/新浪财报/巨潮无内建节流 → 数据服务侧自加 per-source 最小间隔 + 结果 TTL 缓存。
- **磁盘写/配置/key**：四类能力零 key、零配置、零磁盘写（唯一写盘的 `download_pdf()` 不接）。
- **符号规范**：上游有 `norm_ticker`/`get_prefix`（拒`600519.SH` 与 7 位串、绝不猜市场），但仅部分入口内建调用。**A-Atlas canonical 仍是 `StockIdentity` 6 位码**；adapter 在服务入口统一归一（腾讯加 sh/sz/bj 前缀、东财走 norm_ticker、巨潮用 6 位），A-Atlas UI 永远只见 canonical。
- **测试**：上游 tests 全部离线（mock HTTP），live 模式 opt-in env。A-Atlas 复用其「标记对 + 唯一 def 抽取」机制做 build-time extraction，并为四类 legacy 函数补上游缺失的离线 parser 测试。
- **`docs/`、`.github/`**：上游集成档案与赞助文件，不 load-bearing，vendor 快照一并保留以完整 provenance。

## 5. Vendor / runtime 决策

**Vendor 方式（refocus §二十一/§二十二）**：

```text
D:\workspace\a-stock-data          只读上游 clone（不进 a-atlas 仓）
vendor/a-stock-data/               钉 commit 的完整快照（SKILL.md/README/CHANGELOG/LICENSE/tests/docs）
scripts/extract_stock_data.py      build-time 抽取：标记对 + 唯一 def 定位 + AST 剪示例
services/stock-data/generated/     抽取产物（入库，头部带 upstream commit/version/抽取日期）
```

- 不在运行时解析 432 KB Markdown（每请求 read→parse→exec 是反面教材）；
- 不手抄散落函数（失去 provenance）；
- upstream 更新 = 更新快照 + 重跑抽取脚本 + 重跑离线测试，generated 模块头部 sha 可 diff。

**Runtime 方式（refocus §二十八/§二十九/§三十）**：

```text
Browser → A-Atlas Web :3400 ── /api/search ── Jev Cloud
                        └── lib/stockdata（服务端直连）→ A-Atlas Data Service :8920 → a-stock-data generated → 腾讯/新浪/巨潮/东财
```

- **常驻薄服务**（`services/stock-data/server.py`，标准库 ThreadingHTTPServer，非 FastAPI）：Python 数据逻辑不可重写成 TS（refocus 明令禁止），Next.js 内嵌/逐请求 spawn Python 在 Windows 上慢且脆；~百行 stdlib HTTP 包装零新增依赖。
- 端口 **:8920**（不复用 :8910）：旧 Vibe Research 必须可被证明「彻底死了」——:8910 上不再有任何监听就是最硬的证据；新旧服务身份完全不同（`a-atlas-data` vs `a-atlas-research`），无混淆。
- Harbor 拓扑：`A-Atlas = Web(:3400) + Data(:8920)` 两个受管组件——Data 需要常驻 Python 进程，不是为「多服务看起来专业」制造的进程。
- 服务内置 per-(能力,代码) TTL 缓存 + per-source 最小间隔；Web 侧 `lib/stockdata/client.ts` 服务端直连（公司页是 server component，不需要新 BFF 路由）。

## 6. 契约与验收预告

- 四类契约 `StockQuote / StockFundamentals / StockAnnouncement / StockResearchReport`，统一带 `symbol / source / asOf / fetchedAt / available`，`available ∈ EMPTY | UNAVAILABLE | ERROR | OK`（refocus §二十三/§二十四）。
- 验收样本（refocus §三十五）：`600519`(SH) / `688138`(STAR) / `000001`(SZ) / `300750`(ChiNext) / BJ 取池内实码；源不覆盖的格如实 `UNAVAILABLE`。
