"""Aggregate eval errors for teacher review: per-category misses, focused case lists.

Usage: .venv/Scripts/python scripts/analyze_errors.py --json reports/laya_v1.json [--top 25]
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", required=True)
    parser.add_argument("--eval", default="data/eval/a_share_laya_eval.jsonl")
    parser.add_argument("--top", type=int, default=25)
    args = parser.parse_args()

    result = json.loads((ROOT / args.json).read_text(encoding="utf-8"))
    rows = [json.loads(line) for line in (ROOT / args.eval).read_text(encoding="utf-8").splitlines() if line.strip()]
    # evaluate_laya writes FP/FN exemplars only; recompute full error set from the
    # saved JSON is impossible (it has no per-row preds), so re-derive from report
    # exemplars + category stats, and print them for the teacher to classify.
    print(f"== {args.json} ==")
    print("overall:", json.dumps({k: result["overall"][k] for k in ("auc", "ap", "ece", "spearman_label", "mean_prob_level1")}, ensure_ascii=False))
    for cat, c in result["categories"].items():
        print(f"  {cat}: auc={c['auc']} ap={c['ap']} f1@050={c['050']['f1']} fp={c['050']['fp']} fn={c['050']['fn']} level1_mean={c['mean_prob_level1']}")

    print("\n== FALSE POSITIVES (label<2, high prob) — 按 family 计数 ==")
    fp_fam = Counter(fp["query"].split("::")[0] for fp in result["false_positives"])
    for fam, n in fp_fam.most_common():
        print(f"  {fam}: {n}")
    print("\n-- cases --")
    for fp in result["false_positives"]:
        print(f"  p={fp['prob']:.3f} [{fp['family']}] 「{fp['query']}」← {fp['name']}({fp['code']}) label={fp['label']} | {fp['evidence'][:50]}")

    print("\n== FALSE NEGATIVES (label>=2, low prob) — 按 family 计数 ==")
    fn_fam = Counter(fn["query"].split("::")[0] for fn in result["false_negatives"])
    for fam, n in fn_fam.most_common():
        print(f"  {fam}: {n}")
    print("\n-- cases --")
    for fn in result["false_negatives"]:
        print(f"  p={fn['prob']:.3f} [{fn['family']}] 「{fn['query']}」← {fn['name']}({fn['code']}) label={fn['label']} | {fn['evidence'][:50]}")


if __name__ == "__main__":
    main()
