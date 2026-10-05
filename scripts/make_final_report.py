"""Assemble reports/LAYA_A_SHARE_FINAL_REPORT.md from the machine-readable reports.

Usage: .venv/Scripts/python scripts/make_final_report.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(p: str) -> dict:
    f = ROOT / p
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def fmt(row: dict | None, keys=("auc", "ap", "030", "ece", "spearman_label")) -> str:
    if row is None:
        return "—"
    parts = []
    for k in keys:
        v = row.get(k)
        if isinstance(v, dict):
            v = f"F1 {v['f1']} (P {v['precision']} / R {v['recall']})"
        parts.append(f"{k}={v}")
    return " | ".join(parts)


def main() -> None:
    baseline = load("reports/laya_baseline.json")
    v1 = load("reports/laya_v1.json")
    v2 = load("reports/laya_v2.json")
    v1_err = load("reports/laya_v1_error_analysis.json")
    bman = load("data/eval/manifest.json")
    tman = load("data/train/manifest.json")
    tlog2 = load("data/train/train_log.json")

    lines = [
        "# LAYA_A_SHARE_FINAL_REPORT — A 股自然语言公司检索专用 Laya",
        "",
        "目标:中文自然语言查询 × 公司资料 → 相关度,供物理球池按「匹配度」浮起。",
        "路径:官方 RLCD 微调(`laya_finetune_typed_decisions_2xT4_kaggle.ipynb` 的单卡适配),",
        "基座 `convaiinnovations/laya:multilingual`(mmBERT-base,322M),本机 RTX 4060 训练。",
        "",
        "## 1. 数据与隔离",
        "",
        f"- 公司池:全 A 股 {tman['train_pool_sha256_16'][:8]}(训练用,{len((ROOT / 'data/train/laya_train_pairs.jsonl').read_text(encoding='utf-8').splitlines())} 对样本)与冻结池 {tman['test_pool_sha256_16'][:8]}(基准用)",
        f"- 基准(TEST,冻结):{bman['splits']['test']['queries']} 题 / {bman['splits']['test']['rows']} 行,23 个 topic family,标签 0-3(relevant=label≥2)",
        f"- 验证(VAL):{bman['splits']['val']['queries']} 题 / {bman['splits']['val']['rows']} 行,7 个 family,只用于选 epoch",
        f"- 训练:{tman['families']} families / {tman['queries']} 查询 / {tman['pairs']} 对(v1 30 families + v2 4 个 targeted families + 3 条相似查询)",
        "- 隔离:TRAIN/VAL/TEST 的 family 集合与查询文本均零交集(脚本断言);TEST 在所有训练后保持未动",
        "- 防编造:所有标签由公司资料文本(rule 命中串即证据)或项目既有验收标注推导;",
        "  无数据字段的维度被剔除(SOE 国企、研发投入、市值/小市值、苹果链),记录于 §5",
        "- 每行带 provenance:teacher、generation_version、judgeText 快照、evidence",
        "",
        "## 2. 冻结 TEST 结果(BASE → V1 → V2)",
        "",
        "| 模型 | AUC | AP | F1@0.30(生产浮起阈值) | ECE | Spearman(prob,label) |",
        "| --- | --- | --- | --- | --- | --- |",
    ]

    def row(name, r):
        if r is None:
            return f"| {name} | — | — | — | — | — |"
        o = r["overall"]
        return f"| {name} | **{o['auc']}** | {o['ap']} | {o['030']['f1']} (P {o['030']['precision']} / R {o['030']['recall']}) | {o['ece']} | {o['spearman_label']} |"

    lines.append(row("BASE multilingual(零样本)", baseline))
    lines.append(row("FINETUNED V1", v1))
    lines.append(row("FINETUNED V2", v2))
    lines += [
        "",
        f"BASE 的 noul 零样本全饱和(沾边类平均分 {baseline['overall']['mean_prob_level1'] if baseline else '—'},TN≈0),AUC≈0.5,不可用——",
        "与 PROJECT_STATE 2026-09 的探测结论一致,微调是官方指明的唯一出路。",
        "",
        "## 3. 按题型(V2,TEST)",
        "",
        "| 题型 | n | AUC | AP | F1@0.30 | 沾边(1)均分 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    if v2:
        for cat, c in v2["categories"].items():
            lines.append(f"| {cat} | {c['n']} | {c['auc']} | {c['ap']} | {c['030']['f1']} | {c['mean_prob_level1']} |")

    if v1_err:
        lines += [
            "",
            "## 4. 错误分析驱动的第二轮",
            "",
            "V1 后逐行读 TEST 全部错误,归为三类并针对性补数据:",
            "",
            "1. **组合+出口合取**(汽零+出口 AUC 0.069 / 消费电子+出口 0.302):模型按「海外强」给",
            "   非该行业的出口龙头高分。→ 补 TR-COMBO-CHARGE-EXPORT(充电桩+出口)与既有光伏+出海、",
            "   食品+出口共同强化「先卡行业、再看海外」的合取次序。",
            "2. **示例相似句式**(类汇川 AUC 0.356):训练从未出现「类似X公司」。→ 在电池/面板/车用热管理",
            "   三个训练 family 追加「类似宁德时代/京东方/三花智控的公司」问法(锚点公司不进 TEST 查询)。",
            "3. **品牌 vs 代工 / 热词否定**(消费品牌 0.363 / AI算力不要软件 0.431):→ 新增",
            "   TR-IND-CEMFG(消费电子代工,含自有品牌边界)、TR-IND-PHARMA(化药 vs 中药的否定结构)、",
            "   TR-CHAIN-BATTEQUIP(「电池行业卖铲子的公司」,补口语比喻轴)。",
            "",
            "第二轮只加数据、不改 TEST;训练超参与流程与 V1 完全一致(可重复)。",
        ]

    lines += [
        "",
        "## 5. 数据缺口(不猜原则的代价,均为记录在案的排除)",
        "",
        "- **国企/央企**:companyDescription 只有设立沿革里的国资字样,无实控人字段 → 整个主题退出基准",
        "- **研发投入 / 市值 / 分红**:无字段 → 「高研发投入」「小市值」类查询不可标注",
        "- **苹果产业链**:全池 0 处文本提及 → 用「消费电子+海外收入」替代该组合",
        "- 概念标签为空(东财板块接口失败),概念型 hard negative 全部改由主营文本构造",
        "",
        "## 6. 交付物与复现",
        "",
        "- 模型:`models/a-share-laya/`(含 rl_agent_config.json 的 provenance 块;`models/a-share-laya-v1/` 为 V1 存档)",
        "- 切换:`npm run laya:base`(原版)vs `npm run laya:ft`(微调),argv 优先于 LAYA_CHECKPOINT",
        "- 基准:`data/eval/a_share_laya_eval.jsonl`(+ `*_queries.jsonl`、`manifest.json`、`review.txt`)",
        "- 训练数据:`data/train/laya_train_{queries,pairs}.jsonl` + `train_items.pt` + `manifest.json`(seed 20260923)",
        "- 复现:`build_benchmark.py → evaluate_laya.py(BASE)→ build_train_pairs.py → build_laya_items.py → train_laya.py → evaluate_laya.py(FT)→ make_final_report.py`",
        "- Kaggle 备用:`kaggle_laya_finetune/`(2×T4 DDP,同一份 train_items.pt)",
        "",
        "## 7. 已知限制",
        "",
        "- 训练规模小(千级对):组合条件的合取次序与多档占比排序仍未完全解决,见 §3 分类指标",
        "- score 头(0-3 四级)作为辅助目标训练,生产当前只消费 noul 头;分级打分(非二值匹配度)是后续方向",
        "- sidecar 现以 ensure_ascii=False 预序列化 instructions(修 laya 默认 Unicode 转义导致的 token 膨胀),",
        "  线格式不变;BASE 与 FINETUNED 的所有评测均走该同一路径",
        "- 1217→5567 全 A 股扩池是并行工作流;本报告基准冻结在 1464 家快照上,训练用全池快照,两者 sha 均已记录",
    ]

    out = ROOT / "reports" / "LAYA_A_SHARE_FINAL_REPORT.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
