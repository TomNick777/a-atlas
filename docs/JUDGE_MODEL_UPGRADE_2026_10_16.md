# Jev / Drex 升级准备

本轮是本地工程准备，Cloud 调用为 0；不宣告候选质量通过，不改变用户选定的 judge，也不启动训练。生产 Jev 默认与预期身份仍为 `jev-1.13.0`，Drex 默认仍为 `drex-v1.5`。固定 Jev 请求的实际应答身份不符即拒绝。

## 已核实的外部能力

- [Jev 1.14 官方发布](https://typesafe.ai/blog/jev-1-14)：多语言改进是当前中文发现最相关的候选收益；图片、box 和长上下文为实验能力。图片和长上下文也可用于 1.13，box 要求 1.14。本轮不启用这些实验功能。
- [Drex 官方版本表](https://console.nace.ai/docs/drex/reference/models)：2.0 已发布，文本 SystemOne 决策契约可复用；不将 Nace Perception 文档服务算成 Drex 输入能力。
- [Laya 多语言模型卡](https://huggingface.co/convaiinnovations/laya-multilingual)：训练侧重点检查输入预算、分数校准、score 位置偏差和 noul 响应；上游观察不能直接作为私有微调模型的质量结论。

## 新费用估算

按 2026-10-16 核实的 [Jev 价表](https://docs.typesafe.ai/models) 和 [Drex 价表](https://console.nace.ai/docs/drex/reference/pricing)：Jev 1.13/1.14 为 $0.042/M 输入 tokens，Drex 1.5 为 $0.05/M，Drex 2.0 为 $0.06/M；输出免费。`lib/intelligence/pricing.ts` 以 provider + 固定版本查价，未知身份和本地计算成本为 null。

capability 的 `tokens` 保持输入加输出的原定义；`costUsd`、provider 统计和私有预算账本只按输入计费，均为估算，不冒充发票。历史 telemetry、答案和 fixture 不重算、不改身份。Drex 的 M3 美元准入使用自己的单价，未知价格拒绝该扫描；原有时间、批次与完整性契约保持。

## 本地预检

```powershell
npx tsx scripts/judge_upgrade_preflight.ts --output .local/<unique-run>/preflight.json
.\.venv-laya\Scripts\python.exe training/laya/diagnose_inputs.py --manifest data/train/<dataset>/source.json --output reports/laya-evaluation/<unique-diagnostic>.json
```

预检不联网，记录代码状态、corpus、行情和冻结 benchmark 坐标，并检查 golden evidence；不自动改语料或题目。dirty diff 与未跟踪源码另记哈希；正式重复测量仍应在同一可复现代码状态执行。Laya 诊断只加载本地 tokenizer，不加载模型权重、不预测、不训练；按 split/capability 汇总两套预算下的截断和 marker 结果。私有结果不提交公开历史。

## 后续 LIVE 的显式入口

先另行登记调用次数和 USD 上限，预算文件必须绑定 provider 与固定版本；零、缺失、非有限预算均拒绝。新建输出目录，禁止覆盖观察。下例仅说明入口，本轮不执行：

```powershell
npm run quality:discovery -- --provider jev --expected-model jev-1.14.0 --acceptance-budget .local/<jev-plan>/budget.json --label <unique-jev-run>
npm run quality:discovery -- --provider drex --expected-model drex-v2.0 --acceptance-budget .local/<drex-plan>/budget.json --label <unique-drex-run>
```

预算 JSON 形状：

```json
{
  "judge": { "provider": "jev", "model": "jev-1.14.0" },
  "quality": { "cloudMaxCalls": 0, "cloudMaxCostUsd": 0 }
}
```

这里的零表示未授权、不可运行，不是免费调用承诺。身份探针、重试和质量调用均纳入同一个私有账本。先完成本地坐标检查，再允许探针。候选通过 `--expected-model` 仅设置当前测量进程，不修改生产预期身份或 `.env.local`。

比较至少覆盖旧 Jev 基线与两个候选，同一代码/corpus/market/query 坐标、各至少两轮，分别输出质量与稳定性；保留关系强度、方向、披露时点及解释原文的人工审查。冻结题不参与训练、改写或调参，公开榜单不替代 Atlas 发现验收。预算耗尽保留部分结果，不能宣布通过；下一阶段预算批准前不运行 LIVE。

## Laya 后续训练

先读私有输入诊断和训练侧错误分析，再预登记实验。区分类别比例、缺失中间等级、数据事实与模型错误；只使用独立训练侧样本补缺口。校准、选项换序检查和模型更新分别记录。训练成功不等于晋升；active 与默认选择按既有 registry、独立准入和用户决定执行。目标保持替代 Jev，见 `LAYA_REPLACEMENT_OBJECTIVE.md`。
