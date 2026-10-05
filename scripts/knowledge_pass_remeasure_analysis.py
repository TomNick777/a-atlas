# -*- coding: utf-8 -*-
"""Knowledge Pass re-measure analysis (spec §25-§32).

Compares the Phase-1 frozen 30-pool V4.1 grades (before) against the post-
Knowledge-Pass run (after, tag=kp1). Same queries, same retrieval settings,
same checkpoint 2742affc3f677d71, same role-grader-v2 targets — the ONLY
changed variable is the knowledge/profile layer.

Outputs data/eval/knowledge_pass_remeasure.json + a stdout digest covering:
  A photoresist : true-PR vs interference grades/ranks per pool, top-20-by-grade
  B thermal     : representative company grades per query (中石/捷邦/金富/英维克...)
  C copper      : resource vs processing band separation, 罗平锌电 case
  E family      : bank query family-subtype observation
  D2 phrase     : mean|Δgrade| over the three frozen rewrite pairs
"""
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding="utf-8")

BEFORE_POOLS = json.load(open(ROOT / "data/eval/residual_triage_pools.json", encoding="utf-8"))
BEFORE_GRADES = json.load(open(ROOT / "data/eval/residual_triage_grades_v41.json", encoding="utf-8"))
AFTER_POOLS = json.load(open(ROOT / "data/eval/residual_triage_pools_kp1.json", encoding="utf-8"))
AFTER_GRADES = json.load(open(ROOT / "data/eval/residual_triage_grades_v41_kp1.json", encoding="utf-8"))

TRUE_PR = {"300054": "鼎龙股份", "300236": "上海新阳", "300346": "南大光电", "300398": "飞凯材料",
           "300576": "容大感光", "300655": "晶瑞电材", "603650": "彤程新材", "002409": "雅克科技"}
INTERFERE_PR = {"300666": "江丰电子", "688712": "清溢光电", "603533": "有研硅", "688549": "中巨芯",
                "300429": "强力新材", "603078": "江化微", "603931": "格林达", "688019": "安集科技"}
COPPER_RESOURCE = {"600362": "江西铜业", "601899": "紫金矿业", "000630": "铜陵有色", "000878": "云南铜业",
                   "000737": "北方铜业", "601212": "白银有色", "000060": "中金岭南", "603993": "金诚信", "603993x": ""}
COPPER_FOIL = {"688388": "嘉元科技", "600110": "诺德股份", "301511": "德福科技", "301217": "铜冠铜箔", "301150": "中一科技"}
COPPER_WATCH = {"002114": "罗平锌电", "300618": "寒锐钴业", "600988": "赤峰黄金", "603800": "洪田股份"}
THERMAL_WATCH = {"300684": "中石科技", "301326": "捷邦科技", "003018": "金富科技", "002837": "英维克",
                 "301489": "思泉新材", "002272": "川润股份", "301157": "华塑科技", "301667": "纳百川",
                 "920693": "阿为特", "002126": "银轮股份", "301389": "隆扬电子", "603186": "华正新材"}


def grade_map(grades, key):
    g = grades.get(key)
    return {row["code"]: {"grade": row["grade"], "rrfRank": row["rrfRank"], "name": row["name"]} for row in (g or {}).get("grades", [])}


def pool_size(grades, key):
    return (grades.get(key) or {}).get("poolSize", 0)


def rank_by_grade(gm):
    order = sorted(gm.items(), key=lambda kv: (-kv[1]["grade"], kv[1]["rrfRank"]))
    return {code: i + 1 for i, (code, _r) in enumerate(order)}


def topk_by_grade(gm, k=20):
    return set(code for code, _r in sorted(gm.items(), key=lambda kv: (-kv[1]["grade"], kv[1]["rrfRank"]))[:k])


out = {"pools": {}, "phrase_pairs": {}, "summary": {}}

# ---------------------------------------------------------------- photoresist
pr_pools = [k for k in BEFORE_GRADES if k.startswith("photoresist::")]
pr_rows = []
for key in pr_pools:
    bm = grade_map(BEFORE_GRADES, key)
    am = grade_map(AFTER_GRADES, key)
    bq, aq = rank_by_grade(bm), rank_by_grade(am)
    row = {"pool": key, "poolSize": pool_size(AFTER_GRADES, key), "true": {}, "interfere": {}}
    for code, name in TRUE_PR.items():
        if code in bm or code in am:
            row["true"][code] = {"name": name, "before": bm.get(code), "after": am.get(code),
                                 "beforeGradeRank": bq.get(code), "afterGradeRank": aq.get(code)}
    for code, name in INTERFERE_PR.items():
        if code in bm or code in am:
            row["interfere"][code] = {"name": name, "before": bm.get(code), "after": am.get(code),
                                      "beforeGradeRank": bq.get(code), "afterGradeRank": aq.get(code)}
    true_top20_before = len([c for c in TRUE_PR if c in topk_by_grade(bm)])
    true_top20_after = len([c for c in TRUE_PR if c in topk_by_grade(am)])
    row["trueInTop20ByGrade"] = {"before": true_top20_before, "after": true_top20_after}
    out["pools"][key] = row
    pr_rows.append(row)

# mean grade of true vs interference (noun-style pools)
def band(rows, codes):
    vals = []
    for code in codes:
        b = rows.get("true", {}).get(code) or rows.get("interfere", {}).get(code)
        if not b:
            continue
        for side in ("before", "after"):
            if b.get(side):
                vals.append((side, b[side]["grade"]))
    return vals

# ------------------------------------------------------------------- thermal
th_pools = [k for k in BEFORE_GRADES if k.startswith("thermal::")]
for key in th_pools:
    bm = grade_map(BEFORE_GRADES, key)
    am = grade_map(AFTER_GRADES, key)
    row = {"pool": key, "poolSize": pool_size(AFTER_GRADES, key), "watch": {}}
    for code, name in THERMAL_WATCH.items():
        if code in bm or code in am:
            row["watch"][code] = {"name": name, "before": bm.get(code), "after": am.get(code)}
    out["pools"][key] = row

# -------------------------------------------------------------------- copper
cu_pools = [k for k in BEFORE_GRADES if k.startswith("copper::")]
for key in cu_pools:
    bm = grade_map(BEFORE_GRADES, key)
    am = grade_map(AFTER_GRADES, key)
    row = {"pool": key, "poolSize": pool_size(AFTER_GRADES, key), "watch": {}}
    for code, name in {**COPPER_RESOURCE, **COPPER_FOIL, **COPPER_WATCH}.items():
        if code == "603993x" or code not in bm and code not in am:
            continue
        row["watch"][code] = {"name": name, "before": bm.get(code), "after": am.get(code)}
    # band separation: max resource grade vs max foil grade
    def maxg(m, codes):
        vals = [m[c]["grade"] for c in codes if c in m]
        return max(vals) if vals else None
    row["bands"] = {
        "resourceBefore": maxg(bm, COPPER_RESOURCE), "resourceAfter": maxg(am, COPPER_RESOURCE),
        "foilBefore": maxg(bm, COPPER_FOIL), "foilAfter": maxg(am, COPPER_FOIL),
    }
    # resource presence in Top200 (protection recall)
    row["resourceInTop200"] = {"before": len([c for c in COPPER_RESOURCE if c in bm]),
                               "after": len([c for c in COPPER_RESOURCE if c in am])}
    out["pools"][key] = row

# ---------------------------------------------------------------- distribution
for key in [k for k in BEFORE_GRADES if k.startswith("distribution::")]:
    bm = grade_map(BEFORE_GRADES, key)
    am = grade_map(AFTER_GRADES, key)
    row = {"pool": key, "poolSize": pool_size(AFTER_GRADES, key), "watch": {}}
    for code, name in {"601162": "天风证券", "835337": "华林证券"}.items():
        if code in bm or code in am:
            row["watch"][code] = {"name": name, "before": bm.get(code), "after": am.get(code)}
    # top-10 by grade names (bank family observation)
    row["top10ByGradeAfter"] = [{"code": code2, "name": am[code2]["name"], "grade": am[code2]["grade"]}
                                for code2, _r in sorted(am.items(), key=lambda kv: (-kv[1]["grade"], kv[1]["rrfRank"]))[:10]] if key.endswith("银行") else None
    out["pools"][key] = row

# --------------------------------------------------------------- phrase pairs
PAIRS = [("photoresist::光刻胶", "photoresist::做光刻胶的公司"),
         ("thermal::服务器散热", "thermal::服务器散热公司"),
         ("thermal::数据中心液冷", "thermal::给数据中心做液冷散热的公司")]
for a, b in PAIRS:
    ga, gb = grade_map(BEFORE_GRADES, a), grade_map(BEFORE_GRADES, b)
    ga2, gb2 = grade_map(AFTER_GRADES, a), grade_map(AFTER_GRADES, b)
    common = set(ga) & set(gb)
    dbefore = [abs(ga[c]["grade"] - gb[c]["grade"]) for c in common] or [0]
    common2 = set(ga2) & set(gb2)
    dafter = [abs(ga2[c]["grade"] - gb2[c]["grade"]) for c in common2] or [0]
    out["phrase_pairs"][f"{a} <-> {b}"] = {
        "before": {"n": len(common), "meanAbsDelta": round(statistics.mean(dbefore), 3),
                   "ge1": sum(1 for d in dbefore if d >= 1)},
        "after": {"n": len(common2), "meanAbsDelta": round(statistics.mean(dafter), 3),
                  "ge1": sum(1 for d in dafter if d >= 1)},
    }

with open(ROOT / "data/eval/knowledge_pass_remeasure.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

print("pools compared:", len(out["pools"]))
for k, v in out["phrase_pairs"].items():
    print("PAIR", k)
    print("   before", v["before"], " after", v["after"])
