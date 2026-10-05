"""Post-hoc repeat-offender scan (spec §二十三) over saved eval_v4_1 JSONs.

The in-eval scan used default-label-0 rows, which on sparse-truth pools
(stage3/v4role/ev label only a handful of companies per query) conflates
"explicitly irrelevant" with "unlabeled". This analyzer re-joins the frozen
label sources and counts ONLY explicitly labeled rows:
  label 0  (exclusion / domain mismatch watch)  → offender signal
  label 1  (hard negative band)                 → offender signal (weaker)
Reports per company: explicit Top20 appearances, mean rank, mean score, domain
diversity (distinct query families), and label mix. Deterministic; no GPU.

Usage: .venv/Scripts/python.exe -u scripts/analyze_repeat_offenders.py \
    --evals reports/v4_1_eval/eval_v3.json reports/v4_1_eval/eval_v4.json \
            reports/v4_1_eval/eval_v41-A.json --out reports/v4_1_eval/repeat_offenders.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from eval_role_ranking import load_stage3_truth, load_v4_truth, load_ev_truth  # noqa: E402
from laya_v4_1_cross_domain import labels_for_pool  # noqa: E402


def explicit_labels():
    """{query: {code: label}} across all frozen pools (explicit only)."""
    out = {}
    for loader in (load_stage3_truth, load_v4_truth, load_ev_truth):
        for query, (labels, _extra) in loader().items():
            out.setdefault(query, {}).update(labels)
    doc = json.loads((ROOT / "data/eval/v4_1_cross_domain_ranking_candidates.json").read_text(encoding="utf-8"))
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    enrichment = {r["code"]: r for r in json.loads(
        (ROOT / "data/enrichment/semiconductor/enrichment.json").read_text(encoding="utf-8"))["records"]}
    for q in doc["queries"]:
        out.setdefault(q["query"], {}).update(
            {c: v["label"] for c, v in labels_for_pool(q, companies, profiles, enrichment).items()})
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evals", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    labels = explicit_labels()
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    result = {}
    for path in args.evals:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
        per: dict[str, dict] = defaultdict(lambda: {"n": 0, "ranks": [], "scores": [], "families": set(),
                                                    "l0": 0, "l1": 0})
        for q in doc["queries"]:
            qlab = labels.get(q["query"], {})
            for item in q["top20"]:
                code = item["code"]
                if code not in qlab or qlab[code] > 1:
                    continue  # explicit irrelevance only
                o = per[code]
                o["n"] += 1
                o["ranks"].append(item["rank"])
                o["scores"].append(item["score"])
                o["families"].add(q["family"])
                o["l0" if qlab[code] == 0 else "l1"] += 1
        rows = sorted(
            ({"code": c, "name": companies.get(c, {}).get("name", "?"), "top20ExplicitIrrelevant": o["n"],
              "meanRank": round(statistics.mean(o["ranks"]), 1) if o["ranks"] else None,
              "meanScore": round(statistics.mean(o["scores"]), 3) if o["scores"] else None,
              "nQueryFamilies": len(o["families"]),
              "label0": o["l0"], "label1": o["l1"]}
             for c, o in per.items()),
            key=lambda x: (-x["top20ExplicitIrrelevant"], x["meanRank"] or 99),
        )
        result[doc["summary"]["tag"]] = rows
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    for tag, rows in result.items():
        print(f"== {tag} (explicit-irrelevant Top20 appearances) ==")
        for r in rows[:10]:
            print(f"  {r['name']:<10} n={r['top20ExplicitIrrelevant']:<3} meanRank={r['meanRank']:<6} "
                  f"meanScore={r['meanScore']:<6} families={r['nQueryFamilies']} l0={r['label0']} l1={r['label1']}")
    print("saved", args.out)


if __name__ == "__main__":
    main()
