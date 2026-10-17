# 当前公司发现主线的离线测量

`search:quality` 直接观察 `runCompanyDiscovery`，不经过旧 hybrid executor，不读取行情或交易日历，不加载 `.env.local`、探测 judge、启动 Laya 或请求模型。该入口只支持离线模式；它不能产出 LIVE 模型质量结论。

## 输入与运行

在 gitignored 的 `reports/` 或 `.local/` 新建私有输入文件。查询逐字保留，不能自动 trim、改大小写或截断；当前工具接受 2–120 个 JavaScript 字符。`targetCodes` 是诊断探针，不是全池 gold；其真实依据另存案例报告。

```json
{
  "cases": [
    {
      "id": "case-001",
      "query": "用户原查询",
      "traceId": "s_original_abcdef",
      "targetCodes": ["000001"]
    }
  ]
}
```

示例 trace/code 仅说明结构，不是待执行案例。`retrieval-only` 的 trace/code 可省略；`saved-boundary-replay` 每条都必须有真实 trace。

```powershell
npm run search:quality -- --input reports/<case-file>.json --output reports/<new-retrieval-run> --mode retrieval-only
npm run search:quality -- --input reports/<case-file>.json --output reports/<new-replay-run> --mode saved-boundary-replay
```

输出目录必须不存在；失败记录也保留，禁止原位覆盖观察。预检要求本地 corpus、向量和暖好的 embedding 模型，模型缺失时失败，不下载、不伪造向量。网络 fetch 被禁止；任何出网尝试使运行不完整。工具只计算本地查询向量，不重建公司向量。

## 两种模式的含义

| 模式 | 实际执行 | 可证明 | 不能证明 |
| --- | --- | --- | --- |
| `retrieval-only` | 当前范围闸门 + 真实 corpus 检索 + `skipJev` | 当前候选池成员、诊断公司的候选名次、范围拒绝、诚实降级展示 | 模型判断、真实匹配、全池召回率 |
| `saved-boundary-replay` | 校验已保存答案的 envelope/hash/原查询；只把原行送入当前结果资格规则 | 原展示项是否会被当前资格规则排除，保留历史模型、原计算 id、原证据 | 当前召回/模型质量、当年未保存的候选与决策、原请求的精确传输字节 |

缓存 trace 里的答案可能仍带原计算 id：两者分别记录，不能把回放算作一次新模型观察。历史答案与证据文件只读；回放不调用证据解释、不更新原答案。

检索模式导出候选与通道的成员关系；旧 trace 的分数列不一定等于 V3 BM25/RRF 原值，因此不把它们包装成精确通道分数。降级混合值不作为模型决策导出。

## 产物与坐标

- `environment.json`：HEAD、完整 tracked diff 哈希、已跟踪与未跟踪文件内容清单/总哈希、输入哈希、公司/事实/corpus/向量哈希、本地 embedding 文件哈希、parser/grammar/capability/发现契约、Node/平台。
- `input.json`：本次原样案例。
- `results.jsonl`：逐条成功观察或错误，断点前已完成记录保留。
- `run.json`：模式、完整性、网络尝试数与 `qualityAccepted:false`。离线成功不能改成质量 PASS。

历史 benchmark 与 runner 保留独立身份。本入口不改冻结题、不读其锚点构造生产规则；不能把旧 hybrid 答案与当前主线观察混算。

## 来源审查与候选实验

`scripts/search_failure_audit.py` 只读本地 trace、已保存答案、事实、corpus、年报与官网快照，输出经过哈希验证的来源链。用已有证据解析环境运行：

```powershell
.\.venv-laya\Scripts\python.exe scripts/search_failure_audit.py --input reports/<audit-input>.json --output reports/<new-audit>.json
```

输入含 `traceIds`、`companyCodes` 与待查原文字面 `terms`。这些是研究侧输入，不能移入生产词典、训练集或冻结评测题。

`scripts/search-quality/product_evidence_preview.py` 是**候选实验**，不在 production corpus 生成路径。它按公司池与预登记 seed 选择已有年报样本，只输出带原文与出处的候选；不写事实库、corpus、向量，不推断型号所有权。首轮规则已因非型号编号和主体上下文噪声被拒绝，不能把“可运行”当成准入。实验登记、真实结果与审查留在私有报告中；后续版本须单独登记并使用独立验证样本。

```powershell
python scripts/search-quality/product_evidence_preview.py --registration reports/<registration>.json --output reports/<new-preview>.json
```

## 本轮验证范围

新增合成测试覆盖原查询/大小写、历史 envelope 完整性、原计算 id、缺分数拒绝、拒绝/缺证据过滤、降级回放、范围拒绝及私有路径限制。候选抽取的合成测试只证明原文/页码/去重与基础守卫，不证明抽取质量。

当前真实失败案例的诊断、候选否决原因与运行态验证见私有 `reports/SEARCH_QUALITY_NEXT_STAGE_2026_10_17/EXECUTION_REPORT.md`；阶段状态与后续顺序见 [下一阶段计划](SEARCH_QUALITY_NEXT_STAGE_2026_10_17.md)。
