"""Render V4.1 training pairs into tokenized Laya items (noul + score), saved as .pt.

Same production text shape as the V4 builder; --variant selects the pair file and,
for C, applies the §十二/§十三 dropouts at tokenization time:
  name dropout   p=0.30  name -> 某公司, code -> ******   (identity shortcut guard)
  tag dropout    p=0.25  drop the "| 标签:…" section       (non-core semantic tags)
  app dropout    p=0.15  drop the "| 应用:…" section       (non-core application tags)
The role/process evidence sections (工艺:) and the business lines (主营/产品) are
NEVER dropped (§十三 red line: real role/process evidence stays learnable).

Usage: .venv/Scripts/python scripts/build_laya_items_v4_1.py --variant B
  → data/train/v4_1_train_items_<V>.pt
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from build_laya_items import HOW, SCORE_LEVELS, SCORE_TARGETS  # noqa: E402
from build_laya_items_v3 import NOUL_P_V3  # noqa: E402

SEED = 20260925
DROP_EVENT = "v4.1-dropout-20260925"


def dropout_profile(profile: str, rng: random.Random) -> str:
    out = profile
    if rng.random() < 0.25:
        at = out.find(" | 标签:")
        if at != -1:
            out = out[:at]
    if rng.random() < 0.15:
        at = out.find(" | 应用:")
        if at != -1:
            out = out[:at]
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=["A", "B", "C"], required=True)
    args = parser.parse_args()
    rng = random.Random(SEED + hash(args.variant) % 1000)

    import torch
    from transformers import AutoTokenizer
    from laya.common import QTYPES, build_sequence
    from laya.agent import _fix_tokenizer_config
    from huggingface_hub import snapshot_download

    pairs = [json.loads(line) for line in
             (ROOT / f"data/train/v4_1_train_pairs_{'B' if args.variant == 'C' else args.variant}.jsonl").read_text(encoding="utf-8").splitlines()
             if line.strip()]
    apply_dropout = args.variant == "C"

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))

    items: list[dict] = []
    lengths: list[int] = []
    dropped = 0
    n_name_drop = n_tag_drop = n_app_drop = 0

    for row in pairs:
        label = int(row["label"])
        state = {"looking_for": row["query"][:300], "how_to_judge": HOW}
        profile = row.get("profileText") or row.get("judgeText") or ""
        name, code = row["name"], row["code"]
        if apply_dropout:
            if rng.random() < 0.30:
                name, code = "某公司", "******"
                n_name_drop += 1
            before = profile
            profile = dropout_profile(profile, rng)
            n_tag_drop += 1 if (" | 标签:" in before and " | 标签:" not in profile) else 0
            n_app_drop += 1 if (" | 应用:" in before and " | 应用:" not in profile) else 0
        instructions = {
            "company": {"name": name, "code": code, "profile": profile},
            "question": "company 是否符合 looking_for 要找的公司？",
            "yes": "主营业务就是这句话在找的，地域等硬条件也对得上。",
            "no": "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
        }
        meta = {
            "query_id": row["query_id"],
            "family": row["family"],
            "source": row.get("source", "rule"),
            "code": row["code"],  # true code kept in meta for analysis
            "label": label,
        }
        p_true = NOUL_P_V3[label]
        ins = json.dumps(instructions, ensure_ascii=False)
        seq, markers = build_sequence(tok, state, {"t": "noul", "ins": ins, "crit": {}}, 2048, 512)
        if len(markers) != 2:
            dropped += 1
            continue
        items.append({"ids": seq, "markers": markers, "qtype": QTYPES["noul"],
                      "target": [1 - p_true, p_true], "label": int(p_true >= 0.5), "meta": meta})
        lengths.append(len(seq))

        ins_s = json.dumps(
            {
                "company": {"name": name, "code": code, "profile": profile},
                "question": "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。",
            },
            ensure_ascii=False,
        )
        seq2, markers2 = build_sequence(tok, state, {"t": "score", "ins": ins_s, "crit": SCORE_LEVELS}, 2048, 512)
        if len(markers2) != 4:
            dropped += 1
            continue
        items.append({"ids": seq2, "markers": markers2, "qtype": QTYPES["score"],
                      "target": SCORE_TARGETS[label], "label": label, "meta": meta})

    lengths.sort()
    n = len(lengths) or 1
    stats = {"n_items": len(items), "dropped": dropped, "p50": lengths[n // 2], "p95": lengths[int(n * 0.95)],
             "max": lengths[-1], "variant": args.variant, "dropout_event": DROP_EVENT if apply_dropout else None,
             "dropout_counts": {"name": n_name_drop, "tag": n_tag_drop, "app": n_app_drop} if apply_dropout else None}
    torch.save(items, ROOT / f"data/train/v4_1_train_items_{args.variant}.pt")
    (ROOT / f"data/train/v4_1_items_stats_{args.variant}.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
