# 仅公开代码 · 2026-10-05

用户尚未核实真实数据的公开再分发授权，因此当前发布范围为原创代码、测试代码、架构文档与合法保留的vendor代码。默认主线保持 `master`；同一正式目录开发并同步GitHub，不维护另一份生产源码。

2026-10-05首次代码发布已推送至 [TomNick777/a-atlas 的 master](https://github.com/TomNick777/a-atlas/tree/master)，提交 `9406ed5`。[首次GitHub Windows CI](https://github.com/TomNick777/a-atlas/actions/runs/37255245244)全部通过。本地主线已跟踪 `origin/master`；远端默认分支仍暂为初始化的main，需要在仓库Settings → General → Default branch选择master，避免首页仍展示初始化README。

## 留在本地

- 全部 `data/`：公司池、事实与披露摘录、语料、行情/交易日历、向量、训练/评测、原始快照及运行数据。
- 全部 `reports/` 与 `quality/discovery/` 中的JSON、snapshots、reviews：历史实验及冻结质量输入/结果；runner源码与README继续公开。
- `evaluation/discovery/` 中的JSON：冻结发现查询集和从公司语料抽取的证据审计留在本地。
- `tests/fixtures/semantic/` 的JSON、judge与retrieval，以及stockdata响应夹具：真实公司资料与响应回放不发布。
- API key、模型缓存、日志、依赖安装产物、`.local/` 与 `.next/`。

以上文件只停止Git跟踪，磁盘内容不移动、不删减、不改写。包含它们的旧提交不能作为公开主线的祖先；完整历史保存在 `D:\workspace\a-atlas-archive-2026-10-05/`，更早迁移的历史在2026-10-04归档。新主线从GitHub仅含README/LICENSE的初始化提交开始，叠加当前代码。不能向公开仓库推送旧refs、bundle或旧LFS对象。

手写的合成测试数据只用于离线测试，不进入产品。7条录制查询嵌入只含查询文本向量及模型hash，不含公司资料或行情，继续用作测试工具夹具。

## 准备本地数据

本机正式项目已有完整输入，继续按既有builder和数据契约维护，并备份私有数据。新克隆先按README安装依赖；没有公司数据时首页显示缺失提示，搜索不能复现既有全池结果。

`npm run data` 可采集公司名单/基础资料及基础向量；使用前按来源条件取得数据。它不等于恢复已冻结的年报、公告、官网证据扩展或行情基线，也不等于授予数据再分发许可。完整重现需要另行取得可使用的私有输入及其manifest/digest：`data/companies.json`、source_facts、corpus与向量、market/calendar，以及需要重放的质量输入与响应夹具。

恢复一致输入后运行 `npm run corpus:check`、`npm run market:check`、`npm test`。更新事实只改builder并运行 `npm run corpus:update`，不手改语料、不伪造缺失数据。公开仓库不提供下载私有数据的自动步骤。

## 验收和维护

公开CI执行 `npm run publication:check`（索引及全部可达历史都不含私有路径）、`npm run test:public`、typecheck和生产build，不调用Jev、不抓取公司数据。`vitest.public.config.ts` 明列21个依赖私有公司池、交易日历、证据或响应夹具的测试文件；完整 `npm test` 保持原行为，缺失输入会失败，不静默跳过。

Python公开子集包括extraction、market_fetch、service三个模块；`test_stockdata_snapshot.py` 依赖私有交易日历，继续在本地完整验收执行。

2026-10-05干净公开副本（无私有数据、`.env.local`和模型缓存）通过405项TypeScript、38项Python测试、类型检查和Next.js生产构建。本机692个私有文件SHA-256全部不变；corpus 5567份、market 5561行对账通过，digest分别保持 `a5db7e5d994e1c04` 和 `4eada12b5858983d`。本轮没有Jev调用或生产服务重启。

公开子集不代表全池发现、冻结质量、真实响应回放或浏览器搜索验收通过。本机保留原完整测试和数据对账。未来代码修改后应按影响运行完整本地验证，再用公开检查和代码子集检查发布。

数据不会随 `git push` 更新；用独立的本地备份保存。代码正常commit/push/pull；忽略规则和发布检查共同守住边界，禁止强制添加私有数据。未来改变范围需核实授权并明确作出新的发布决定。

正式目录已配置 `core.hooksPath=.githooks`，推送前自动执行同一发布检查。新克隆可用 `git config core.hooksPath .githooks` 启用；仍需保留Python环境。不要用 `--no-verify` 跳过数据边界检查。
