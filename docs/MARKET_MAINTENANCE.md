# 行情维护入口

自 2026-10-16 用户收束产品起，行情排序/筛选、混合发现与公司页行情/财务/资讯展示退出产品主线。当前产品与质量入口见 `SEARCH_QUALITY_MAINLINE_2026_10_16.md`。

保留 `lib/market/`、`lib/hybrid/execute.ts`、`/api/market`、`/api/bars/:code` 与 Data service，供旧调用方、冻结回放和显式维护使用。它们不会由公司发现或当前公司页触发。不在本轮物理删除源码、快照、交易日历、旧报告或既有依赖；也不主动运行这些命令。

```powershell
npm run market:check               # 冻结基线对账，离线
npm run market:query               # 旧查询 CLI，使用方式见 scripts/market_query.ts
npm run hybrid:query -- --explain "今天涨幅前10的公司" # 旧语法检查，非产品执行
npm run market:refresh             # 显式维护，会请求数据源
npm run market:prune               # 只预览
npm run market:prune -- --apply     # 显式执行已有保留策略
```

维护仍遵守源端时点、固定快照、覆盖/预算/扫描不完整、EMPTY / UNAVAILABLE / ERROR 与证据事实纪律。盘中时效、源端量比、本人使用等未完成验收不因退出主线而补记通过。详细历史契约与操作见 `MARKET_DISCOVERY_CLOSEOUT_2026_10_04.md`、`MARKET_DISCOVERY_IMPLEMENTATION.md`、`MARKET_DISCOVERY_M3_REPORT.md` 与 `MARKET_DISCOVERY_M5.md`。

Data 仍由原受管运行时启动/探活，Harbor 登记本轮不变。移除其产品必需组件身份或停用外部入口，需要另行完成调用方迁移与配套验证。
