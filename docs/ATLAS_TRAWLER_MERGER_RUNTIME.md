# Atlas / Trawler 统一运行契约

状态：集成分支实施中，尚未完成总验收和正式切换。执行依据为 `ATLAS_TRAWLER_MERGER_PLAN_2026_10_12.md`；本说明不将工程测试通过等同于模型质量准入。

## 唯一生产调用链

Next / React / Matter.js 前端 → `/api/discover` → 原确定性 parser、检索及 M3 行情选择 → `lib/intelligence/capabilities` → 本次请求明确选择的 Jev 或 Laya adapter。四能力和 `market-eligibility-1` 共用契约。浏览器只消费 EvidenceView，不导入 intelligence。

模型偏好在浏览器设置中保存，每次请求携带 `provider`。AsyncLocalStorage 固定请求上下文；实际应答身份漂移时拒绝混合结果。选定模型不可用时如实 DEGRADED，另一模型不会自动接管。公司页 canonical 为 `/stock/:symbol`；旧公司 URL 重定向并保留搜索出处。

每次搜索生成独立 trace ID，答案及所用事实快照保存到私有 `data/discovery-answers/`。换模型后的解释仍读取原答案身份和证据；原版本不可用时保留事实并说明解释不可用。JUDGE_CALL 为通用记录，Jev 另保留旧 JEV_CALL schema；统计按 callId 去重。Laya 记录本地耗时、GPU 快照，云费用为 null。

日线从 Data adapter 读取迁移后的本机缓存，标注源、采集时点、交易日、qfq、币种和成交量单位。EMPTY、UNAVAILABLE、ERROR 分别表示空数据、无覆盖、读取/结构故障。Vela 只作 headless 图表，保留许可署名并在卸载时销毁实例。

## 安装与启动

从统一仓库根运行；保留已有 `.env.local` 和私有输入，不从 trawler 绝对路径加载任何日常依赖。Node/npm 使用仓库锁文件，Data 与 Laya Python 环境独立。

```powershell
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services/stock-data/requirements.lock.txt
# 仅在使用本地推理/训练时准备 Laya 环境与有权使用的登记模型。
python -m venv .venv-laya
.\.venv-laya\Scripts\python.exe -m pip install -r services/laya/requirements.lock.txt
npm run atlas:doctor
npm run build
npm run atlas:start -- --provider jev
npm run atlas:stop
```

核心服务是 Web 3400、Data 8920；Laya 8787 为可选服务。设置中选择 Laya 会请求启动已登记的固定入口，冷加载期间显示等待；训练占用时明确失败。`atlas:stop` 不终止独立训练任务。CLI 启动验证 service 身份与 readiness，失败收回本次启动的组件，不接管未知端口进程。

生产构建使用 Next 支持的 Webpack 模式。Turbopack 在本机读取动态文件路径时遍历到大型私有模型并失败；Windows trace 排除匹配还会漏掉反斜杠路径。构建后的 `check_web_artifacts.py` 规范化并移除部署依赖追踪里的私有运行文件引用，复核无模型二进制被打包；它不删除本机输入。应用从已安装仓库运行，不把私有模型、Python 环境和数据打进 Web 部署包。

健康入口 `/api/health?provider=jev|laya`、`/api/runtime?provider=jev|laya` 分列核心服务、选定 judge 与两 adapter 的可用性。未选择的 Laya 不影响 Jev 核心健康。HTTP 200 仅证明 Web 能应答，仍须查看身份和状态。

## 训练、评测与登记

生产语义事实只来自冻结 corpus；标签记录 human-reviewed、existing-teacher、deterministic-rule 或 agent-reviewed 来源，教师分数不自动成为真值。source manifest 在分词前封存 SHA，分组隔离及证据原文核对失败即拒绝。历史回放保留原 query、profile、标签、教师和来源 SHA，不改称当前 corpus 成绩。

```powershell
npm run laya:data -- --mode corpus --manifest data/train/<dataset>/source.json
npm run laya:train -- --provider jev --config .local/<config>.json --init <model-id> --run <unique-id>
npm run laya:resume -- --provider jev --run <unique-id>
npm run laya:cancel -- --run <unique-id>
npm run laya:evaluate -- --candidate <unique-id> --manifest .local/<sealed-acceptance>.json
npm run laya:promote -- --candidate <unique-id>
npm run laya:rollback -- --to <previous-active-id>
npm run laya:status
```

`--provider jev` 是明确的释放本地推理 GPU 操作：排空并停止 Laya 后训练。该 CLI 操作不篡改浏览器偏好；该命令同时发布一次明确的 Jev 切换指令；已打开的发现页在两秒内消费指令，只改变后续搜索，不改在途请求。`train/resume` 必须显式选择 `--provider jev|laya`，不猜测 GPU 策略。`--provider laya` 在 GPU 被推理或训练占用时进入可取消 FIFO 队列，资源释放后自动启动。训练不会改变 active 或 provider 偏好。

RLCD trainer 写独立 run，保存 optimizer、scheduler、Python/NumPy/Torch/CUDA RNG、采样顺序、游标、数据/配置/软件身份。恢复身份不一致即拒绝。取消在 optimizer 边界保留完整恢复点；best 按独立 validation loss 选择，last 和 resume 均保留。validation loss 不是产品质量准入。

`models/registry.json` 固定 active ID、parent、权重与配置/tokenizer 全产物哈希、评测出处。候选不自动晋升。晋升要求不可篡改的完整准入报告、同一实际 adapter/config 身份；排空、加载核验后才原子更新指针，失败恢复原模型。旧模型及追加日志不删除。

## 交付门槛

冻结 discovery 集两个 provider 各两轮，同一代码/corpus/market/query 坐标；关键关系强度、方向、披露时点和证据解释另走预注册样本。质量失败不改题、不降门槛、不加生产特例。LIVE 使用预登记的共享私有调用/费用账本，预算耗尽即停止。

代码、许可和通用测试可以公开；data、reports、models、恢复状态、真实应答、冻结标签、`.local` 与环境留在本机。`publication:check` 同时检查 index 与全部 reachable refs。Harbor 配套更改只登记一个 Atlas 应用，旧 trawler 登记在总验收通过的正式切换中停用；当前仍保留原正式入口及回退材料。


## 装载、候选隔离与网络

Laya 0.3.5 会修正 tokenizer metadata，因此装载使用私有临时副本，随后复核原登记产物完整性。实际模型 ID 同时包含权重、有效配置、运行 tokenizer、adapter 源码和依赖版本。请求 CUDA 时不可用即失败，不接受依赖隐式回落 CPU。

未晋升候选只开放 evaluation lane。普通 Web 请求无法使用候选；评测器必须显式设置 `ATLAS_LAYA_EVALUATION=1`，并在请求中标识评测用途。晋升或回退只有在登记指针原子更新后，服务才开放 production lane。重复评测使用新的 `--label`，保留以前的观察文件。

统一 CLI 与 Harbor 启动 Node 时启用本机已有 HTTP/HTTPS 代理，并将 loopback 加入 NO_PROXY。当前验证环境为 Node 24.15.0；代理地址和凭证不写入代码或报告。直接运行 `npm start` 时，需要在启动 Node 前按本机网络设置启用 `NODE_USE_ENV_PROXY=1`。

新产品训练任务校验 company/source/query-family 三类组不跨 train、validation、blind，且各 split 覆盖四能力。此前仅按公司划分的诊断数据不作为正式准入依据。续训与恢复还绑定完整 parent artifact、trainer/helper、软件及 CUDA 环境；旧状态缺少这些字段时不能冒充精确恢复。
