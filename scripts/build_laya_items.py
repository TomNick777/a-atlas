"""Render training pairs into tokenized Laya items (noul + score), saved as .pt.

Sequences are built with laya.common.build_sequence using the production sidecar
settings (max_len 2048, head_max_len 512) and the exact state/instructions shape
lib/jev/judge.ts sends, so training and inference see identical inputs.

Usage: .venv/Scripts/python scripts/build_laya_items.py
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

# 与 lib/jev/judge.ts 一致的判断说明
HOW = (
    "looking_for 是一个人用自己的话说想找的公司。"
    "每一题是一家候选公司，profile 是它的公开业务资料。"
    "判断这家公司的主营业务是否就是这句话在找的东西。"
    "概念标签沾边但主营无关，回答要低。"
    "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。"
    "几家公司可以同时符合。"
)

# 二值化概率:3 直接相关→1.0,2 部分相关→0.5,1 沾边→0.1,0 无关→0.0
NOUL_P = {3: 1.0, 2: 0.5, 1: 0.1, 0: 0.0}
SCORE_LEVELS = [
    "0=无关:主营业务与查询要找的无关",
    "1=沾边:概念/名字/大类相邻,主营业务并不符合",
    "2=部分相关:产业链上下游,或组合条件只满足一半",
    "3=直接相关:主营业务就是查询要找的东西",
]
# 轻度标签平滑:主峰 0.7-0.8,近邻分摊
SCORE_TARGETS = {
    3: [0.02, 0.03, 0.15, 0.80],
    2: [0.02, 0.13, 0.70, 0.15],
    1: [0.10, 0.70, 0.15, 0.05],
    0: [0.80, 0.15, 0.03, 0.02],
}


def main() -> None:
    import torch
    from transformers import AutoTokenizer
    from laya.common import QTYPES, build_sequence
    from laya.agent import _fix_tokenizer_config
    from huggingface_hub import snapshot_download
    import laya

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))

    pairs = [json.loads(line) for line in (ROOT / "data/train/laya_train_pairs.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    items: list[dict] = []
    lengths: list[int] = []
    dropped = 0

    for row in pairs:
        label = int(row["label"])
        state = {"looking_for": row["query"][:300], "how_to_judge": HOW}
        instructions = {
            "company": {"name": row["name"], "code": row["code"], "profile": row["judgeText"]},
            "question": "company 是否符合 looking_for 要找的公司？",
            "yes": "主营业务就是这句话在找的，地域等硬条件也对得上。",
            "no": "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
        }
        meta = {"query_id": row["query_id"], "family": row["family"], "category": row["category"], "code": row["code"], "label": label}

        # --- noul(生产判定路径,主目标)
        # 生产 sidecar 在调 laya.Agent.predict 前用 ensure_ascii=False 预序列化
        # instructions(见 scripts/laya_server.py 的 sidecar_ins),模型读到原生中文。
        ins = json.dumps(instructions, ensure_ascii=False)
        p_true = NOUL_P[label]
        seq, markers = build_sequence(tok, state, {"t": "noul", "ins": ins, "crit": {}}, 2048, 512)
        if len(markers) != 2:
            dropped += 1
            continue
        items.append({"ids": seq, "markers": markers, "qtype": QTYPES["noul"], "target": [1 - p_true, p_true], "label": int(p_true >= 0.5), "meta": meta})
        lengths.append(len(seq))

        # --- score(0-3 相关度,辅助目标,供 graded 信号与表征共享)
        ins_s = json.dumps({"company": {"name": row["name"], "code": row["code"], "profile": row["judgeText"]}, "question": "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。"}, ensure_ascii=False)
        seq2, markers2 = build_sequence(tok, state, {"t": "score", "ins": ins_s, "crit": SCORE_LEVELS}, 2048, 512)
        if len(markers2) != 4:
            dropped += 1
            continue
        items.append({"ids": seq2, "markers": markers2, "qtype": QTYPES["score"], "target": SCORE_TARGETS[label], "label": label, "meta": meta})

    lengths.sort()
    n = len(lengths)
    stats = {"n_items": len(items), "dropped": dropped, "p50": lengths[n // 2], "p95": lengths[int(n * 0.95)], "max": lengths[-1]}
    torch.save(items, ROOT / "data/train/train_items.pt")
    (ROOT / "data/train/items_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
