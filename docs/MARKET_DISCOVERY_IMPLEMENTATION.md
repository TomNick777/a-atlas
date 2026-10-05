# 行情发现落地任务

日期：2026-10-02。需求依据：本人明确要求“当天涨跌、成交额、放量等排行，并能叠加业务条件”，
以及实际失败查询“今天领涨的公司”。本轮已授权制定方案并开始实施。
设计依据：`docs/PERSONAL_MARKET_DISCOVERY_PLAN.md`。

## 交付顺序

| 任务 | 实现落点 | 完成判据 | 状态 |
|---|---|---|---|
| M1.1 目标交易日与盘后可用性 | `lib/market/session.ts`、`data/market-calendar/`、query/executor | 休市/盘前用上一交易日；盘中不拿旧盘后包回答当天；收盘后当日包缺失明确未更新；未知年度拒绝猜日期 | 已完成 |
| M1.2 独立运行时更新 | `scripts/refresh_market.ts`、fetch/build 的 `--data-dir` | 只抓缺少日期，重建与 check 成功后原子切换；失败不动当前快照；历史基线不变 | 已完成 |
| M1.3 缓存与请求固定快照 | state、discoverCache、prevday | 同日 digest 变化失效；开盘/收盘/跨日失效；一次请求始终读同一快照；无须因更新数据重启 Web | 已完成 |
| M1.4 回放隔离及本地上线 | quality runner、H/P/grounding 回放、Web | 历史回放明确注入 committed 输入；生产 API 使用新快照；纯行情零 Jev | 已完成 |
| M2.1 时点来源试采 | 既有 vendor 同步/机械抽取、Data adapter、试采脚本 | 源端日期/时点与金额/量的单位可回指；缺失不能补造；SH/SZ/BJ 全覆盖试验有报告 | 收盘试采通过；盘中待实测；源端量比被闸门阻断 |
| M2.2 日内全池 snapshot | Data service 内共享刷新及快照契约 | 源端时间、采集起止、覆盖、停牌/缺失/错误分别记录；跨日拒绝；固定快照数值与排序对账 | 已实现并上线；盘中真实延迟待开市验收 |
| M2.3 排行呈现 | 现有卡片/提示，无新增一级页面 | 显示实际值、名次、时点及覆盖；源端量比与 20 日相对成交量分开；部分覆盖不可标完整全市场 | 已完成；未核验的量比明确不可用 |
| M3.1 集合与 TopN 作用域 | 确定性 parser/plan 契约 | “业务集合内前 K”与“全市场前 N 中的业务子集”分别编译；行业词不入 grammar | 已完成，收盘快照范围 |
| M3.2 行情顺序扫描业务资格 | executor + 既有 Jev capability seam | 数值排序后顺序分批判定；候选池外的高行情业务公司能被发现；未决/预算结束显示不完整 | 已完成；预算/未决明确不完整 |
| M3.3 判断缓存及质量/成本验收 | capability 契约缓存、targeted LIVE | 不把弱相关当确认符合；有 evidenceRefs；按 corpus/query/身份/契约缓存；受影响 family 验证 | 已完成；两轮冷LIVE + 暖缓存验证 |
| M4 本人使用验收 | 实际搜索 trace 与反馈 | 实际查涨幅/成交额/放量及业务组合，逐条核实任务是否完成 | 交付后真实使用 |

每项由当前项目实现并验收，不额外建设 Agent、scheduler 或第三个常驻组件。
M1 已完成；M2 工程实现已上线，收盘实测通过，盘中实测及源端量比基准仍未通过验收。
不得把它标成无条件的实时行情 milestone PASS。M3 业务内全池顺序扫描与 TopN 子集已交付，受每请求扫描预算约束。
M2 详细记录见 `docs/MARKET_DISCOVERY_M2_REPORT.md`；M3 见 `docs/MARKET_DISCOVERY_M3_REPORT.md`。

## M1 实现与运行

运行：`npm run market:refresh`。命令按照已核验交易日历准备最近 60 个交易日，
复用已捕获的日线，仅下载缺少的文件，然后抓取最新交易日的 quote 并执行 coherence audit。
quote 不达标可缺失，不能冒充可用。派生与 `--check` 均通过后才发布 pointer。
当前运行快照同交易日已就绪时直接复用；`--force` 会重新抓整个窗口，日常不需要。

运行产物：`data/market-runtime/snapshots/<snapshotId>/`，
当前指针：`data/market-runtime/current.json`，均 gitignored。
Web 在每次请求读 pointer/manifest，行缓存以目录+日期+digest 为键并校验 SHA-256。
一次请求保存 manifest 对象对应的目录，之后即使 pointer 更新也不混读。
答案缓存包含日历日、交易阶段、目标交易日及完整行情 digest。
更新互斥锁防止两次 refresh 同时发布；失败删除本次未发布目录，保留旧指针。
若进程被强制终止，须先检查遗留 `refresh.lock` 后清理，不能自动抢锁。

committed `data/market/` 继续作为历史回放基线；`npm run market:check` 检查该基线。
quality runner 与冻结 H/P/grounding 测试通过显式注入固定 manifest/rows 回放，
不跟随运行时 pointer。生产执行仍用相同 parser/capability，不增加 benchmark 规则。
初次装入这次代码变更需要更新生产构建并重启一次 Web；后续行情文件刷新不需要重启。

2026 日历已分别核验 SH/SZ/BJ 的年度公告，来源 URL 保存在 JSON 中。
年度日历属于显式维护的交易规则；未知年份及跨到未核验年份不推断。
M1 仅支持盘后事实，9:15–15:00（包含午间）拒绝用盘后数据回答当天排行；
M2 将接管日内快照与更细的交易阶段。休市/盘前分别标记收盘榜单。
收盘后日线包未发布时明确未更新，下一次 refresh 重试。

## 本轮验收证据

- 从历史 2026-09-28 增量抓取 09-29、09-30 两个日线包，各 5,561 行。
- 09-30 quote 返回 5,567 行；可比较行的前收/收盘/涨跌幅 coherence 比例均为 1.0。
- 发布状态 5,561 行，digest `c757580f2ca71716f83351c4242c678300256badc5ab4568fc6db006a9aae69d`。
- 公司池为 5,567 家。日线只保留可用正收盘行；6 家无可用日线，不宣称全池无缺失。
  M2 将在产品结果明确展示覆盖/缺失；当前保存于 ingest/manifest。
- 历史 09-28 基线仍为 `4eada12b5858983d`，`market:check` 重建字节一致。
- 新生产 API smoke trace：`s_muqge7mg_676e7b`。查询“今天领涨的公司”，
  `market-only`、日期 09-30、20 个结果、非 degraded，caption 为
  “今日休市 · 2026-09-30 收盘 · 按涨跌幅排序 · 全市场”。此为工程探针，不是本人真实使用。
- `npm test`：38 个 TypeScript 测试文件，566 项通过；Python 38 项通过。
- `npm run typecheck`、生产 `npm run build` 通过。定向 ESLint 0 errors，
  两处原有未使用 import warnings；构建有动态文件扫描 warnings。
- 新增 6 项测试覆盖节假日/调休周末、盘前/盘中/收盘未发布、未知年度、
  进程热读取/固定快照/回放隔离/坏 digest、同日及阶段变化的答案缓存失效。
- 本轮零真实 Jev 调用，未修改 semantic eligibility、parser grammar 或业务排序。

## 下一项：M2.1 的具体步骤与停止条件

1. 查验 pinned upstream/已同步上游是否已有源端时间字段，按 VENDOR 同步流程机械抽取；
   当前 `tencent_quote` 未保留源端时点，不能把 `fetchedAt` 改名充数。
2. 先选覆盖 SH/SZ/BJ、ST、停牌、上市新股的公司池样本，记录源端日期/时点、
   采集起止、原始响应 hash、价格/前收/累计金额/累计量/换手率/源端量比及字段单位。
   样本以公司池属性机械选取，不用搜索 benchmark 或点名公司做规则。
3. 样本通过后再一次全池试采：身份不得串市场，日期必须可核验，
   成交股票缺时间不得入当天有效排行，批次跨交易日不发布，覆盖缺口逐类统计。
4. 先预注册快照最大年龄、批次跨度和覆盖门槛，再依据实测写入配置；
   没有报告前不承诺 30 秒或 60 秒全池更新，不把“请求成功”当成源端及时。
5. 源端时间、量比口径或全池稳定性达不到门槛时保留盘后能力，记录失败与替代源验证任务。
   日内 snapshot 未通过前，不进入 M3 的实时业务内 TopK 承诺。

M3 的首个必测反例：行情排名很高、但原语义候选池之外的符合业务公司；
另测高位业务未决、预算提前结束、TopN 内业务不足 N 不补位。
Jev 契约变更须独立记录，先离线机械验证，再按受影响 family targeted LIVE；不重录旧基线掩盖问题。
