"""Render V3 training pairs into tokenized Laya items (noul + score), saved as .pt.

Differences from the V2 builder (build_laya_items.py):
  - profile text is the production searchProfile searchText (judgeText + DERIVED tag
    line) — the exact text the V3 reranker reads at inference;
  - noul targets are softened (0.92/0.55/0.12/0.03) to stop the yes-logit saturation
    documented in the root-cause audit; SCORE_TARGETS were already soft and stay;
  - rows carry query_id so the trainer can form same-query batches for the pairwise
    ranking loss.

Usage: .venv/Scripts/python scripts/build_laya_items_v3.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
ROOT = Path(__file__).resolve().parents[1]
sys_path = str(ROOT / "scripts")
import sys  # noqa: E402

if sys_path not in sys.path:
    sys.path.insert(0, sys_path)

from build_laya_items import HOW, SCORE_LEVELS, SCORE_TARGETS  # noqa: E402

# 软化标签:不再把 label-3 顶到 1.0(V2 饱和根因之一),留出排序分辨率。
NOUL_P_V3 = {3: 0.92, 2: 0.55, 1: 0.12, 0: 0.03}


def main() -> None:
    import torch
    from transformers import AutoTokenizer
    from laya.common import QTYPES, build_sequence
    from laya.agent import _fix_tokenizer_config
    from huggingface_hub import snapshot_download

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))

    pairs = [json.loads(line) for line in (ROOT / "data/train/v3_train_pairs.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    items: list[dict] = []
    lengths: list[int] = []
    dropped = 0

    for row in pairs:
        label = int(row["label"])
        state = {"looking_for": row["query"][:300], "how_to_judge": HOW}
        profile = row.get("profileText") or row.get("judgeText") or ""
        instructions = {
            "company": {"name": row["name"], "code": row["code"], "profile": profile},
            "question": "company 是否符合 looking_for 要找的公司？",
            "yes": "主营业务就是这句话在找的，地域等硬条件也对得上。",
            "no": "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
        }
        meta = {
            "query_id": row["query_id"],
            "family": row["family"],
            "source": row.get("source", "rule"),
            "code": row["code"],
            "label": label,
        }
        p_true = NOUL_P_V3[label]
        ins = json.dumps(instructions, ensure_ascii=False)
        seq, markers = build_sequence(tok, state, {"t": "noul", "ins": ins, "crit": {}}, 2048, 512)
        if len(markers) != 2:
            dropped += 1
            continue
        items.append({"ids": seq, "markers": markers, "qtype": QTYPES["noul"], "target": [1 - p_true, p_true], "label": int(p_true >= 0.5), "meta": meta})
        lengths.append(len(seq))

        ins_s = json.dumps(
            {
                "company": {"name": row["name"], "code": row["code"], "profile": profile},
                "question": "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。",
            },
            ensure_ascii=False,
        )
        seq2, markers2 = build_sequence(tok, state, {"t": "score", "ins": ins_s, "crit": SCORE_LEVELS}, 2048, 512)
        if len(markers2) != 4:
            dropped += 1
            continue
        items.append({"ids": seq2, "markers": markers2, "qtype": QTYPES["score"], "target": SCORE_TARGETS[label], "label": label, "meta": meta})

    lengths.sort()
    n = len(lengths)
    stats = {"n_items": len(items), "dropped": dropped, "p50": lengths[n // 2], "p95": lengths[int(n * 0.95)], "max": lengths[-1]}
    torch.save(items, ROOT / "data/train/v3_train_items.pt")
    (ROOT / "data/train/v3_items_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
