"""V4.2 eval metrics — fixed pools (SET A/B/C) and the 30-pool before/after.

Reads a pools file (labels) + one grades file per checkpoint arm and prints /
writes the §25 metric block:

  SET A: MaterialSubtypeAccuracy, MaterialSubtypeInversionRate
         + the §26 hard criterion: true-PR Top20-by-grade recovery (0/8 → ?)
  SET B: CommodityRoleAccuracy, ResourceVsProcessingInversion,
         ResourceVsFoilInversion
  SET C: ParaphraseMeanAbsGradeDelta, ParaphraseRankCorrelation,
         ParaphraseTop10Overlap, PairwiseOrderAgreement
  30-pool: per-pool mean grade by known band (photoresist true-PR vs
         interferers; copper foil vs mine) — the direct §34 before/after

Usage: .venv/Scripts/python scripts/analyze_v4_2_eval.py \
    --pools data/eval/v4_2_fixed_pools.json \
    --grades data/eval/v4_2_fixed_pools_grades_v41.json [--label v4.1] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

TRUE_PR = {"雅克科技", "鼎龙股份", "上海新阳", "南大光电", "飞凯材料", "容大感光", "晶瑞电材", "彤程新材"}
# §26 interferers (triage Case A list): non-PR companies that used to sit above true PR
PR_INTERFERERS = {"江丰电子", "欧晶科技", "有研硅", "金宏气体", "清溢光电", "安泰科技", "正帆科技", "沐邦高科"}


def spearman(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return float("nan")
    def rank(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        for pos, i in enumerate(order):
            r[i] = pos
        return r
    rx, ry = rank(xs), rank(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return num / den if den else float("nan")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pools", required=True)
    ap.add_argument("--grades", required=True)
    ap.add_argument("--label", default="arm")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    pools = json.loads(Path(args.pools).read_text(encoding="utf-8"))["pools"]
    grades = json.loads(Path(args.grades).read_text(encoding="utf-8"))

    out: dict = {"arm": args.label, "sets": {}}

    # ---------------- SET A / SET B: label-band metrics ----------------
    inv_stats = defaultdict(lambda: [0, 0])
    acc_a_n, acc_a_d = 0, 0
    for key, pool in pools.items():
        if pool["kind"] not in ("SET_A", "SET_B"):
            continue
        g = grades.get(key)
        if not g:
            continue
        labels = {c["code"]: c["grade"] for c in pool["candidates"]}
        names = {c["code"]: c["name"] for c in pool["candidates"]}
        scored = [(names[c["code"]], labels.get(c["code"]), c["grade"]) for c in g["grades"] if c["code"] in labels]
        threes = [s for _n, l, s in scored if l == 3]
        twos = [s for _n, l, s in scored if l == 2]
        lows = [s for _n, l, s in scored if l is not None and l <= 1]
        # accuracy@top1: the top-scored company is a true grade-3
        allscored = sorted(scored, key=lambda x: -x[2])
        band = "A" if pool["kind"] == "SET_A" else "B"
        if allscored:
            if band == "A":
                acc_a_d += 1
                acc_a_n += 1 if allscored[0][1] == 3 else 0
        for sa in threes:
            for sb in twos:
                inv_stats[f"SET{band}_3v2"][0] += 1 if sa < sb else 0
                inv_stats[f"SET{band}_3v2"][1] += 1
            for sb in lows:
                inv_stats[f"SET{band}_3v1"][0] += 1 if sa < sb else 0
                inv_stats[f"SET{band}_3v1"][1] += 1

    set_a3v2 = inv_stats["SETA_3v2"]
    set_a3v1 = inv_stats["SETA_3v1"]
    set_b3v2 = inv_stats["SETB_3v2"]
    set_b3v1 = inv_stats["SETB_3v1"]
    out["sets"]["SET_A"] = {
        "MaterialSubtypeAccuracy@top1": round(acc_a_n / max(1, acc_a_d), 4),
        "MaterialSubtypeInversionRate(3v2)": round(set_a3v2[0] / max(1, set_a3v2[1]), 4),
        "Grade3VsLowInversion(3v1)": round(set_a3v1[0] / max(1, set_a3v1[1]), 4),
        "pairs": {"3v2": set_a3v2[1], "3v1": set_a3v1[1]},
    }
    out["sets"]["SET_B"] = {
        "Grade3VsLowInversion(3v1)": round(set_b3v1[0] / max(1, set_b3v1[1]), 4),
        "SameCommodity3v2Inversion": round(set_b3v2[0] / max(1, set_b3v2[1]), 4),
        "pairs": {"3v1": set_b3v1[1]},
    }
    # Recompute SET B accuracy separately (the acc counter above mixed sets)
    accb_n = accb_d = 0
    for key, pool in pools.items():
        if pool["kind"] != "SET_B":
            continue
        g = grades.get(key)
        if not g:
            continue
        labels = {c["code"]: c["grade"] for c in pool["candidates"]}
        names = {c["code"]: c["name"] for c in pool["candidates"]}
        scored = [(names[c["code"]], labels.get(c["code"]), c["grade"]) for c in g["grades"] if c["code"] in labels]
        allscored = sorted(scored, key=lambda x: -x[2])
        if allscored:
            accb_d += 1
            accb_n += 1 if allscored[0][1] == 3 else 0
    out["sets"]["SET_B"]["CommodityRoleAccuracy@top1"] = round(accb_n / max(1, accb_d), 4)

    # ---------------- SET C: phrase robustness ----------------
    groups = defaultdict(dict)
    for key, pool in pools.items():
        if pool["kind"] != "SET_C":
            continue
        g = grades.get(key)
        if not g:
            continue
        pgid = key.split("::")[0]
        labels = {c["code"]: c["grade"] for c in pool["candidates"]}
        names = {c["code"]: c["name"] for c in pool["candidates"]}
        scores = {names[c["code"]]: c["grade"] for c in g["grades"] if c["code"] in labels}
        groups[pgid][key.split("::", 1)[1]] = scores
    deltas, rhos, overlaps, agree = [], [], [], [0, 0]
    for pgid, wordings in groups.items():
        ws = list(wordings.values())
        if len(ws) < 2:
            continue
        common = set(ws[0])
        for w in ws[1:]:
            common &= set(w)
        common = sorted(common)
        for i in range(len(ws)):
            for j in range(i + 1, len(ws)):
                a, b = ws[i], ws[j]
                for c in common:
                    deltas.append(abs(a[c] - b[c]))
                rhos.append(spearman([a[c] for c in common], [b[c] for c in common]))
                ta = {c for c, _ in sorted(a.items(), key=lambda kv: -kv[1])[:10]}
                tb = {c for c, _ in sorted(b.items(), key=lambda kv: -kv[1])[:10]}
                overlaps.append(len(ta & tb) / 10)
                for x in common:
                    for y in common:
                        if x == y:
                            continue
                        if (a[x] > a[y] and b[x] > b[y]) or (a[x] < a[y] and b[x] < b[y]) or (a[x] == a[y] and b[x] == b[y]):
                            agree[0] += 1
                        agree[1] += 1
    out["sets"]["SET_C"] = {
        "ParaphraseMeanAbsGradeDelta": round(sum(deltas) / max(1, len(deltas)), 4),
        "ParaphraseRankCorrelation": round(sum(r for r in rhos if r == r) / max(1, sum(1 for r in rhos if r == r)), 4),
        "ParaphraseTop10Overlap": round(sum(overlaps) / max(1, len(overlaps)), 4),
        "PairwiseOrderAgreement": round(agree[0] / max(1, agree[1]), 4),
        "groups": sorted(groups),
    }

    # ---------------- §26 hard criterion: true-PR Top20 recovery ----------------
    pr_report = {}
    for key, pool in pools.items():
        if "RESIST" not in key or pool["kind"] != "SET_A":
            continue
        g = grades.get(key)
        if not g:
            continue
        labels = {c["code"]: c["grade"] for c in pool["candidates"]}
        names = {c["code"]: c["name"] for c in pool["candidates"]}
        by_grade = sorted(g["grades"], key=lambda x: -x["grade"])[:20]
        top20_names = [names.get(x["code"], x["name"]) for x in by_grade]
        true_in = [n for n in top20_names if n in TRUE_PR]
        inter_in = [n for n in top20_names if n in PR_INTERFERERS]
        true_mean = [s for n, l, s in [(names.get(c["code"], c["name"]), labels.get(c["code"]), c["grade"]) for c in g["grades"]] if n in TRUE_PR]
        inter_mean = [s for n, l, s in [(names.get(c["code"], c["name"]), labels.get(c["code"]), c["grade"]) for c in g["grades"]] if n in PR_INTERFERERS]
        pr_report[key] = {
            "truePRinTop20": len(true_in),
            "truePRnames": true_in,
            "interferersInTop20": len(inter_in),
            "truePRmeanGrade": round(sum(true_mean) / max(1, len(true_mean)), 3),
            "interfererMeanGrade": round(sum(inter_mean) / max(1, len(inter_mean)), 3),
        }
    if pr_report:
        out["sets"]["SET_A"]["photoresistTop20"] = pr_report

    print(json.dumps(out, ensure_ascii=False, indent=1))
    if args.json:
        Path(args.json).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
