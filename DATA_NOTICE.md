# 数据来源与发布范围

项目根目录的 Apache-2.0 许可适用于 A-Atlas 原创代码。第三方代码继续遵守各自的许可证；数据、披露摘录和派生产物的权利归原权利人，不因采集器或本项目采用 Apache-2.0 而自动获得同一许可。

2026-10-05用户确认尚未核实数据授权，选择只公开代码。当前运行和审计数据保持本机原样，完整旧Git历史在本地归档；公开Git历史和LFS均不含这些数据。下表的Git/LFS存储描述仅对应迁移前的本地历史，不代表当前公开范围。

| 内容 | 来源/用途 | 存储 | 再分发状态 |
|---|---|---|---|
| `data/companies.json`、search profiles、enrichment | 公司名单、公司简介、主营介绍、分类和证据派生 | Git | 未核实全体上游授权范围 |
| `data/source_facts/` | 公司资料、主营构成、巨潮年报/公告摘录、官网产品事实；逐条 provenance | facts.jsonl 使用 LFS，其余 Git | 未核实批量再分发范围 |
| `data/company-corpus/` | 上述事实的确定性发现语料，唯一 builder 可重建 | Git | 继承输入数据的限制，未统一授权 |
| `data/market/` | 通达信盘后包、腾讯行情快照及确定性计算 | Git | 未核实数据源再分发范围 |
| `*.f32`、`data/train/`、`data/eval/` | 从公司数据生成的向量、历史训练与审计材料 | f32/pt 使用 LFS，其他 Git | 派生产物不能代替输入数据授权核实 |
| `data/market-runtime/`、search logs、telemetry、模型缓存与 `.env.local` | 本机运行数据与配置 | gitignored | 不随本仓上传 |

公司语料、行情、向量、训练/评测数据、`reports/`、冻结质量结果与真实响应夹具均不随代码发布。未来拟公开数据时需另行核对来源许可，并明确批准变更发布范围。当前没有取得统一数据开源许可证，不能宣称所有数据可按 Apache-2.0 复用。本地数据准备与公开验收范围见 `docs/PUBLIC_CODE_RELEASE.md`。

数据契约、provenance 和重建方法分别见 `docs/COMPANY_KNOWLEDGE_CORPUS.md`、`docs/EVIDENCE_COVERAGE_EXPANSION.md`、`docs/EVIDENCE_SURFACE_EXPANSION.md`；第三方代码见 `THIRD_PARTY_NOTICES.md`。
