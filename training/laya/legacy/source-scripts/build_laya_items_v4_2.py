"""Render V4.2 training pairs into tokenized Laya items, plus frozen VAL items.

Same production text shape as the V4/V4.1 builders (§§ unchanged). Variants:
  A → data/train/v4_2_train_pairs_A.jsonl → v4_2_train_items_A.pt
  B → data/train/v4_2_train_pairs_B.jsonl → v4_2_train_items_B.pt
(variant C trains on B's items + the consistency objective at training time.)

VAL items (score head only) for the pre-registered §31 selection rule, built
from the frozen V4.2 val wordings (data/train/v4_2_eval_queries.json):
  VAL_M  material-subtype pools  (role-grader-v2, full graded pool, no caps)
  VAL_C  copper-role pools       (commodity-role-rubric-kp1, graded pool)
  VAL_P  phrase groups           (both wordings, SAME pool + SAME labels —
         the wording pair shares one grading, so any |Δ| the model shows is
         pure model instability, never label noise)
meta carries kind/query/family/pgid/code/label for the trainer's metrics.

Usage: .venv/Scripts/python scripts/build_laya_items_v4_2.py --variant A
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from build_laya_items import HOW, SCORE_LEVELS, SCORE_TARGETS  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts"))
from laya_v4_roles import company_caps, grade_caps, load_enrichment, parse_intent  # noqa: E402
from laya_v4_2_commodity_roles import grade_commodity, load_exposure, parse_commodity_intent  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=["A", "B"], required=True)
    args = parser.parse_args()

    import torch
    from transformers import AutoTokenizer
    from laya.common import QTYPES, build_sequence
    from laya.agent import _fix_tokenizer_config
    from huggingface_hub import snapshot_download

    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    enrichment = load_enrichment()
    exposure = load_exposure(profiles)
    evalq = json.loads((ROOT / "data/train/v4_2_eval_queries.json").read_text(encoding="utf-8"))

    pairs = [json.loads(line) for line in
             (ROOT / f"data/train/v4_2_train_pairs_{args.variant}.jsonl").read_text(encoding="utf-8").splitlines()
             if line.strip()]

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))

    # ---------------- training items (identical shape to V4.1) ----------------
    items: list[dict] = []
    lengths: list[int] = []
    dropped = 0
    for row in pairs:
        label = int(row["label"])
        state = {"looking_for": row["query"][:300], "how_to_judge": HOW}
        profile = row.get("profileText") or row.get("judgeText") or ""
        name, code = row["name"], row["code"]
        meta = {
            "query_id": row["query_id"], "family": row["family"],
            "source": row.get("source", "rule"), "code": code, "label": label,
            "pgid": row.get("paraphraseGroupId"),
        }
        from build_laya_items_v3 import NOUL_P_V3  # noqa: E402
        p_true = NOUL_P_V3[label]
        ins = json.dumps({
            "company": {"name": name, "code": code, "profile": profile},
            "question": "company 是否符合 looking_for 要找的公司？",
            "yes": "主营业务就是这句话在找的，地域等硬条件也对得上。",
            "no": "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
        }, ensure_ascii=False)
        seq, markers = build_sequence(tok, state, {"t": "noul", "ins": ins, "crit": {}}, 2048, 512)
        if len(markers) != 2:
            dropped += 1
            continue
        items.append({"ids": seq, "markers": markers, "qtype": QTYPES["noul"],
                      "target": [1 - p_true, p_true], "label": int(p_true >= 0.5), "meta": meta})
        lengths.append(len(seq))

        ins_s = json.dumps({
            "company": {"name": name, "code": code, "profile": profile},
            "question": "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。",
        }, ensure_ascii=False)
        seq2, markers2 = build_sequence(tok, state, {"t": "score", "ins": ins_s, "crit": SCORE_LEVELS}, 2048, 512)
        if len(markers2) != 4:
            dropped += 1
            continue
        items.append({"ids": seq2, "markers": markers2, "qtype": QTYPES["score"],
                      "target": SCORE_TARGETS[label], "label": label, "meta": meta})

    lengths.sort()
    n = len(lengths) or 1
    stats = {"n_items": len(items), "dropped": dropped, "p50": lengths[n // 2],
             "p95": lengths[int(n * 0.95)], "max": lengths[-1], "variant": args.variant}
    torch.save(items, ROOT / f"data/train/v4_2_train_items_{args.variant}.pt")
    (ROOT / f"data/train/v4_2_items_stats_{args.variant}.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False))

    # ---------------- frozen VAL items (score head only) ----------------
    def score_item(query: str, code: str, name: str, profile: str, label: int, meta: dict) -> dict | None:
        state = {"looking_for": query[:300], "how_to_judge": HOW}
        ins_s = json.dumps({
            "company": {"name": name, "code": code, "profile": profile},
            "question": "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。",
        }, ensure_ascii=False)
        seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins_s, "crit": SCORE_LEVELS}, 2048, 512)
        if len(markers) != 4:
            return None
        return {"ids": seq, "markers": markers, "qtype": QTYPES["score"],
                "target": SCORE_TARGETS[label], "label": label, "meta": meta}

    val_items: list[dict] = []
    # VAL_M material subtype
    for row in evalq["val"]["VAL_M_material"]:
        intent = parse_intent(row["query"])
        if not intent.gradeable:
            raise SystemExit(f"VAL_M wording not gradeable: {row['query']}")
        for code, rec in enrichment.items():
            g, _ = grade_caps(intent, company_caps(rec))
            if g is None:
                continue
            profile = (profiles.get(code) or {}).get("searchText") or ""
            it = score_item(row["query"], code, rec.get("name") or code, profile, g,
                            {"kind": "VAL_M", "query": row["query"], "family": row["family"],
                             "pgid": None, "code": code, "label": g})
            if it:
                val_items.append(it)
    # VAL_C copper role
    for row in evalq["val"]["VAL_C_copper"]:
        ci = parse_commodity_intent(row["query"])
        if not ci.gradeable:
            raise SystemExit(f"VAL_C wording not gradeable: {row['query']}")
        for code, vals in exposure.items():
            g, _ = grade_commodity(ci, vals)
            if g is None:
                continue
            profile = (profiles.get(code) or {}).get("searchText") or ""
            it = score_item(row["query"], code, (profiles.get(code) or {}).get("identity", {}).get("name") or code,
                            profile, g, {"kind": "VAL_C", "query": row["query"], "family": row["family"],
                                         "pgid": None, "code": code, "label": g})
            if it:
                val_items.append(it)
    # VAL_P phrase groups — one grading, two wordings, one pool
    for row in evalq["val"]["VAL_P_phrase"]:
        w1, w2 = row["queries"]
        ci = parse_commodity_intent(w1)
        if ci.gradeable:
            graded = {}
            for code, vals in exposure.items():
                g, _ = grade_commodity(ci, vals)
                if g is not None:
                    graded[code] = g
        else:
            intent = parse_intent(w1)
            graded = {}
            for code, rec in enrichment.items():
                g, _ = grade_caps(intent, company_caps(rec))
                if g is not None:
                    graded[code] = g
        for wi, wording in enumerate((w1, w2)):
            for code, g in graded.items():
                profile = (profiles.get(code) or {}).get("searchText") or ""
                name = (profiles.get(code) or {}).get("identity", {}).get("name") or code
                it = score_item(wording, code, name, profile, g,
                                {"kind": "VAL_P", "query": wording, "family": row["paraphraseGroupId"],
                                 "pgid": row["paraphraseGroupId"], "code": code, "label": g})
                if it:
                    val_items.append(it)
    torch.save(val_items, ROOT / "data/train/v4_2_val_items.pt")
    from collections import Counter
    kinds = Counter(it["meta"]["kind"] for it in val_items)
    print(f"[val] {len(val_items)} items {dict(kinds)}")


if __name__ == "__main__":
    main()
