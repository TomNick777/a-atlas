"""§34 same-30-pool before/after: V4.1+KP vs V4.2+KP (only the checkpoint moves).

Hard criteria measured on the EXACT Knowledge Pass re-measure pools:
  §26 photoresist: true-PR Top20-by-grade in 光刻胶 / 半导体光刻胶 / 国产光刻胶材料
      (V4.1 = 0/8 in all three); phrase-form 做光刻胶的公司 must stay 8/8.
  §27 copper: 铜资源 / 铜资源公司 — grade margin between copper:mine companies
      and copper foil/processing companies (V4.1: same band 2.76 vs 2.79).
      Reverse 铜箔-related pools must not break.
  §28 phrase: mean |Δgrade| for the three frozen pairs (V4.1: 0.524/0.208/0.498).

Usage: .venv/Scripts/python scripts/analyze_30pool_v42.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

TRUE_PR = {"雅克科技", "鼎龙股份", "上海新阳", "南大光电", "飞凯材料", "容大感光", "晶瑞电材", "彤程新材"}
PR_FOCUS_POOLS = ["光刻胶", "半导体光刻胶", "国产光刻胶材料", "做光刻胶的公司", "给晶圆厂卖光刻胶的"]
PHRASE_PAIRS = [("光刻胶", "做光刻胶的公司"), ("服务器散热", "服务器散热公司"),
                ("数据中心液冷", "给数据中心做液冷散热的公司")]
COPPER_RES_POOLS = ["铜资源", "铜资源公司", "有铜矿的公司", "上游铜矿"]


def mine_vs_foil_margin(pool, grades_by_code, profiles):
    """max grade among PURE copper:mine companies vs PURE processing companies.

    Integrated miners (江西铜业/紫金矿业 hold mine+smelting+processing tags) are
    resource-side by their mine tag; counting them as processors would poison
    procMax (triage's own comparison used PURE foil makers 嘉元/诺德/德福/铜冠/中一).
    pure-mine = has copper:mine, no foil/processing/clad tag
    pure-proc = has foil/processing/clad, no copper:mine tag
    """
    by_c = {}
    for code, p in profiles.items():
        rungs = {d["value"].split(":", 1)[1] for d in p.get("derived", [])
                 if d.get("dimension") == "commodityExposure" and d.get("value", "").startswith("copper:")}
        if rungs:
            by_c[code] = rungs
    res = {c for c, r in by_c.items() if "mine" in r and not (r & {"foil", "processing", "clad"})}
    proc = {c for c, r in by_c.items() if (r & {"foil", "processing", "clad"}) and "mine" not in r and "smelting" not in r}
    g_res = [grades_by_code[c] for c in res if c in grades_by_code]
    g_proc = [grades_by_code[c] for c in proc if c in grades_by_code]
    return (max(g_res) if g_res else None, max(g_proc) if g_proc else None,
            sum(g_res) / len(g_res) if g_res else None, sum(g_proc) / len(g_proc) if g_proc else None)


def main() -> None:  # mp11 variant: knowledge residual-knowledge-pass-v1.1 pools
    pools = json.loads((ROOT / "data/eval/residual_triage_pools_mp11.json").read_text(encoding="utf-8"))
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    arms = {}
    for tag, path in (("v4.1+MP11", "data/eval/residual_triage_grades_v41_mp11.json"),
                      ("v4.2+MP11", "data/eval/residual_triage_grades_v42B_mp11.json")):
        arms[tag] = json.loads((ROOT / path).read_text(encoding="utf-8"))

    report = {}
    for tag, grades in arms.items():
        rep = {"photoresist": {}, "copper": {}, "phrase": {}}
        # §26 photoresist pools: Top20 BY GRADE
        for q in PR_FOCUS_POOLS:
            key = f"photoresist::{q}"
            g = grades.get(key)
            if not g:
                continue
            by_name = {c["name"]: c["grade"] for c in g["grades"]}
            top20 = sorted(g["grades"], key=lambda x: -x["grade"])[:20]
            true_in = [c["name"] for c in top20 if c["name"] in TRUE_PR]
            rep["photoresist"][q] = {
                "truePRinTop20": len(true_in),
                "truePRnames": true_in,
                "truePRmean": round(sum(by_name[n] for n in TRUE_PR if n in by_name) / 8, 3),
            }
        # §27 copper pools
        for q in COPPER_RES_POOLS + ["不要铜加工", "铜资源不要铜加工"]:
            key = f"copper::{q}"
            g = grades.get(key)
            if not g:
                continue
            by_code = {c["code"]: c["grade"] for c in g["grades"]}
            mx_res, mx_proc, mn_res, mn_proc = mine_vs_foil_margin(key, by_code, profiles)
            rep["copper"][q] = {
                "mineMax": round(mx_res, 3) if mx_res is not None else None,
                "procMax": round(mx_proc, 3) if mx_proc is not None else None,
                "mineMean": round(mn_res, 3) if mn_res is not None else None,
                "procMean": round(mn_proc, 3) if mn_proc is not None else None,
                "margin": round(mx_res - mx_proc, 3) if mx_res is not None and mx_proc is not None else None,
            }
        # reverse: foil companies must rank high under... the copper set has no foil
        # query (V4.1 gap); checked via SET_B instead. Record foil grade under 铜资源.
        # §28 phrase pairs
        for q1, q2 in PHRASE_PAIRS:
            k1, k2 = f"photoresist::{q1}" if q1 == "光刻胶" else f"thermal::{q1}", \
                     f"photoresist::{q2}" if q2 == "做光刻胶的公司" else f"thermal::{q2}"
            g1, g2 = grades.get(k1), grades.get(k2)
            if not g1 or not g2:
                # 数据中心液冷 lives in thermal::, 光刻胶 in photoresist::
                g1 = g1 or grades.get(f"thermal::{q1}")
                g2 = g2 or grades.get(f"thermal::{q2}")
            if not g1 or not g2:
                continue
            s1 = {c["code"]: c["grade"] for c in g1["grades"]}
            s2 = {c["code"]: c["grade"] for c in g2["grades"]}
            common = sorted(set(s1) & set(s2))
            deltas = [abs(s1[c] - s2[c]) for c in common]
            rep["phrase"][f"{q1} ↔ {q2}"] = {
                "meanAbsDelta": round(sum(deltas) / max(1, len(deltas)), 3),
                "n": len(common),
            }
        report[tag] = rep

    print(json.dumps(report, ensure_ascii=False, indent=1))
    (ROOT / "data/eval/v4_2_30pool_compare_mp11.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
