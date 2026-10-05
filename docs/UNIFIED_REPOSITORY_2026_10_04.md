# 统一正式仓库 · 2026-10-04

2026-10-05发布范围修订：用户选择只公开代码，真实数据留在本地。下文保留2026-10-04迁移背景（含LFS准备方案）；当前公开历史、数据存储和CI范围以 `docs/PUBLIC_CODE_RELEASE.md` 为准，包含数据的准备提交不进入公开主线。

用户选择统一正式仓库，项目原创代码采用 Apache-2.0。正式开发目录保持 `D:\workspace\a-atlas`，默认分支保持 `master`，计划 GitHub 远端为 `https://github.com/TomNick777/a-atlas.git`。

本轮以已验收的 `2a45dcae95b811206bc940cac08d6293734474de` 为输入创建干净初始提交。迁移前的全部 Git refs/提交已打包并验证，完整归档在本机 `D:\workspace\a-atlas-archive-2026-10-04/history.bundle`；`migration-input.json` 记录1117个原受跟踪文件的SHA-256。旧Git目录也保留在该归档目录，可恢复历史。归档不是活跃开发仓，后续不在旧历史上修改代码。

历史报告、质量基线和 trace 中的旧 commit/hash 不改写；它们指向迁移前的完整历史，不指向新初始提交。冻结结果仍按原环境解释，不能把新 HEAD 冒充旧 benchmark 环境。语料、事实、向量、行情与历史审计数据内容保持逐字节一致。

新历史不包含退役 `codex.exe` 及旧安装产物。`data/source_facts/facts.jsonl`、`*.pt`、`*.f32` 改由 Git LFS 保存原始内容，仍是版本化输入。克隆和 CI checkout 必须还原 LFS；仅获得 pointer 的 clone 无法运行数据验证。GitHub Actions 两个 job 使用 `lfs: true`，各自安装 Data 所需Python依赖。

发布准备还包含 Next.js/eslint-config-next 从16.3.5升级并钉到16.3.8。`typecheck` 先执行 `next typegen`，解决首次克隆无 `.next` 时 `LayoutProps` 缺失。数据与冻结质量产物的属性设为 `-text`，防止Windows换行转换破坏digest；原有专门的字节保护规则保留。

干净副本暴露6项离线测试依赖本机模型缓存的问题。7条查询的真实bge向量已从既有本地模型录制为 `tests/fixtures/query_embeddings.json`，带模型文件SHA-256和向量digest；测试只回放这些向量，未知查询即拒绝，不用零向量或散列值填充。显式维护命令 `npm run test:embeddings:record -- --query <实际查询>` 只用本地模型、禁止远端下载，不调用Jev。生产嵌入、检索、判断、语料与排行代码均未修改。

## 验证与公开前剩余事项

- 新安装依赖、无 `.env.local`、无模型缓存：612项TypeScript＋47项Python测试通过；类型检查通过。
- `corpus:check`：5,567份，digest `a5db7e5d994e1c04`；`market:check`：5,561行，digest `4eada12b5858983d`，逐字节重建一致。
- 从新Git索引和LFS实际checkout回工作目录后，305个data/quality文件与迁移前SHA-256完全一致；再次通过语料和行情对账。
- 原1117个文件中，1108个在迁移编辑前后逐字节不变；9个有意修改为属性、CI、文档、package与测试配置。新增文件为许可/数据说明/迁移说明和查询向量夹具/维护脚本。
- 新历史只有当前版本的初始提交，可达普通Git blob无超过100 MiB的文件；`git lfs fsck`通过。
- Next.js16.3.8生产构建通过，7项动态文件tracing警告。新增/修改测试工具ESLint零警告、零错误。现有历史文件的空白与vendor排版原样保留，只对本轮新增/修改内容执行diff检查。
- `npm audit --omit=dev`：0项。开发工具仍有braces无已发布补丁的栈溢出公告，以及需升级Vitest主版本才能修复的mocker公告；5 high＋2 moderate为依赖传播计数，不是7个独立漏洞。不使用可接收外部pattern的工具服务或Vitest browser/mocker开发服务器。公告：[braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)、[Vitest](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)。Next补丁来源：[上游公告](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j)。
- 本机真实key的精确匹配扫描未命中受跟踪文件；本轮零Jev调用。

2026-10-05已验证 `TomNick777/a-atlas` 远端存在且为公开仓库，默认分支暂为 `main`；初始化提交 `0d3eaf87281fade21ba3d92ed667afb93ee4ccef` 仅包含README与Apache-2.0许可证。正式 `master` 合并保留该初始化历史，README使用本地完整版本，根许可证采用远端标准文本并填入项目版权信息，不覆盖第三方许可证。本地迁移记录中的“单个初始提交”描述合并前的准备结果，合并后同时保留GitHub初始化历史。

2026-10-05已将仅公开代码的主线提交 `9406ed58da6aef883813e0be852def01fd3b30bd` 推送至 `origin/master`，本地master已跟踪该远端分支；Git使用本机凭据完成推送，`gh`独立登录状态不作为Git推送成功与否的依据。首轮GitHub Windows CI（run `37255245244`）全部通过。公开历史不包含私有数据，范围见 `docs/PUBLIC_CODE_RELEASE.md`。远端默认分支仍为初始化的main；浏览器控制连接不可用，默认分支切换至master尚待完成。

临时模型缓存的递归删除曾被自动审批以 `blocked by policy` 拒绝；已可恢复地移至历史归档目录的 `recording-model-cache`，不是运行依赖，也不进正式Git仓。原正式目录的模型缓存与运行数据未移动。生产服务不在本轮重新部署或重启。

## 日常维护

只在正式目录开发、测试和提交。`git push origin master` 将Git提交和LFS对象同步至GitHub；公开端的PR在同一仓库合并，再 `git pull --ff-only` 拉回。不使用手工导出目录、不维护第二条生产源码主线、不用 mirror 推送迁移前的历史refs。

首次换机：安装Git LFS、克隆、`git lfs install`、`git lfs pull`，再按README准备Node/Python环境。日常修改LFS数据后正常 `git add` 和 `git commit`；不要把模型缓存、运行快照、用户日志或API key加入Git。

完整数据再分发状态见根目录 `DATA_NOTICE.md`。代码许可、数据许可和GitHub认证分别核对；本地仓库统一不代表已经公开推送。
