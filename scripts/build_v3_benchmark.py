"""Build the V3 search benchmark: per-query graded relevance over the full pool.

Sources: EV families (topics_v3.py) + every TEST/VAL/TRAIN family. For each query we
label ALL 5,567 companies with the family's rule (levels 0-3, None=missing) and store
the relevant sets (3/2), the label-1 沾边 rows, and curated excludes — the retrieval and
ranking benchmarks then share one ground truth. Deterministic; nothing here trains.

Outputs:
  data/eval/v3_search_benchmark.jsonl   one row per query (relevant sets + excludes)
  data/eval/v3_benchmark_review.txt     full label dump for teacher review

Usage: .venv/Scripts/python scripts/build_v3_benchmark.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_benchmark import label_company
from laya_lab import data as ld
from laya_lab.topics import TEST_TOPICS, VAL_TOPICS
from laya_lab.topics_train import TRAIN_TOPICS
from laya_lab.topics_v3 import EV_FAMILIES, ev_queries


def label_rows(topic: dict, companies: dict[str, dict]) -> dict[int, list[dict]]:
    by_level: dict[int, list[dict]] = {0: [], 1: [], 2: [], 3: []}
    for code, c in companies.items():
        labeled = label_company(topic, c)
        if labeled is None:
            continue
        level, evidence = labeled
        by_level[int(level)].append({"code": code, "name": c["name"], "evidence": evidence})
    return by_level


def main() -> None:
    companies = ld.load_companies("train")
    print(f"pool: {len(companies)} sha={ld.companies_sha('train')}")

    # family registry: EV + all existing families (TEST/VAL/TRAIN rules reused for
    # retrieval-benchmark queries only — the internal RANKING benchmark scores EV queries)
    families: dict[str, dict] = {}
    for fam in EV_FAMILIES:
        families[fam["family"]] = fam
    for split, topics in (("test", TEST_TOPICS), ("val", VAL_TOPICS), ("train", TRAIN_TOPICS)):
        for t in topics:
            if t["family"] in families:
                raise SystemExit(f"family collision: {t['family']}")
            families[t["family"]] = {**t, "split": split}

    fam_labels: dict[str, dict[int, list[dict]]] = {}
    rows_out: list[dict] = []
    for fam in families.values():
        fam_labels[fam["family"]] = label_rows(fam, companies)

    for q in ev_queries():
        fam = families[q["family"]]
        by_level = fam_labels[q["family"]]
        rel3 = sorted(by_level[3], key=lambda r: r["code"])
        rel2 = sorted(by_level[2], key=lambda r: r["code"])
        hard1 = sorted(by_level[1], key=lambda r: r["code"])
        curated0 = [
            {"code": code, "evidence": (fam.get("curated") or {})[code][1]}
            for code in sorted(fam.get("curated") or {})
            if (fam.get("curated") or {}).get(code) and (fam.get("curated") or {})[code][0] == 0
        ]
        # curated 0 分两桶:查询明确排除的(known_excludes)与同类不同种硬负例(HARDNEG)
        known_hard = [
            {"code": code, "name": companies[code]["name"], "evidence": (fam.get("curated") or {})[code][1]}
            for code in sorted(fam.get("curated") or {})
            if (fam.get("curated") or {}).get(code) and str((fam.get("curated") or {})[code][1]).startswith("HARDNEG")
        ]
        known_hard_names = {e["code"] for e in known_hard}
        curated0 = [e for e in curated0 if e["code"] not in known_hard_names]
        # 规则判出的"查询排除"0(证据里带"查询排除")也是已知排除对象,与 curated 合并
        rule_excluded = [
            {"code": e["code"], "name": e["name"], "evidence": e["evidence"]}
            for e in sorted(by_level[0], key=lambda r: r["code"])
            if "查询排除" in e["evidence"] or "被排除" in e["evidence"] or "明确排除" in e["evidence"]
        ]
        seen_codes = {e["code"] for e in curated0}
        rule_excluded = [e for e in rule_excluded if e["code"] not in seen_codes]
        rows_out.append(
            {
                **q,
                "benchmark": "ranking" if fam["family"].startswith("EV-") and not fam.get("external_only") else ("external-only" if fam.get("external_only") else "ev"),
                "n_relevant3": len(rel3),
                "n_relevant2": len(rel2),
                "n_hard1": len(hard1),
                "relevant3": rel3,
                "relevant2": rel2,
                "hard1": hard1,
                "known_hard_negatives": known_hard,
                "known_excludes": curated0 + rule_excluded,
            }
        )

    # retrieval benchmark: every query from TEST/VAL/TRAIN too (retrieval is not a
    # trained model — no isolation issue; gives 200+ queries for Recall@K)
    retrieval_extra = []
    for split, topics in (("test", TEST_TOPICS), ("val", VAL_TOPICS), ("train", TRAIN_TOPICS)):
        for t in topics:
            by_level = fam_labels[t["family"]]
            for qi, query in enumerate(t["queries"]):
                retrieval_extra.append(
                    {
                        "query_id": f"{t['family']}::q{qi}",
                        "family": t["family"],
                        "category": t["category"],
                        "split": split,
                        "query": query,
                        "benchmark": "retrieval",
                        "n_relevant3": len(by_level[3]),
                        "n_relevant2": len(by_level[2]),
                        "n_hard1": len(by_level[1]),
                        "relevant3": sorted(by_level[3], key=lambda r: r["code"]),
                        "relevant2": sorted(by_level[2], key=lambda r: r["code"]),
                        "hard1": sorted(by_level[1], key=lambda r: r["code"]),
                        "known_excludes": [],
                    }
                )

    out_path = Path("data/eval/v3_search_benchmark.jsonl")
    all_rows = rows_out + retrieval_extra
    out_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in all_rows), encoding="utf-8")

    # review dump for the EV families (teacher reads these before trusting the benchmark)
    with (Path("data/eval") / "v3_benchmark_review.txt").open("w", encoding="utf-8") as fh:
        for fam in EV_FAMILIES:
            by_level = fam_labels[fam["family"]]
            fh.write(f"\n===== {fam['family']} ({fam['category']}) =====\n")
            for query in fam["queries"]:
                fh.write(f"  Q: {query}\n")
            for level, tag in ((3, "相关(3)"), (2, "部分(2)"), (1, "沾边(1)"), (0, "无关/排除(0)")):
                entries = by_level[level]
                shown = entries if level != 0 else entries[:12]
                fh.write(f"  [{tag}] {len(entries)}\n")
                for e in shown:
                    fh.write(f"      {e['code']} {e['name']} — {e['evidence']}\n")

    manifest = {
        "generatedAt": "2026-09-23",
        "pool_sha256_16": ld.companies_sha("train"),
        "ranking_queries": sum(1 for r in rows_out if r["benchmark"] == "ranking"),
        "external_only_queries": sum(1 for r in rows_out if r["benchmark"] == "external-only"),
        "retrieval_queries": len(all_rows) - sum(1 for r in rows_out if r["benchmark"] != "retrieval"),
        "total_queries": len(all_rows),
        "ev_families": [f["family"] for f in EV_FAMILIES],
        "isolation": "EV families/query texts 不得进入任何训练集;TEST/VAL/TRAIN 家族仅用于 retrieval-benchmark 查询",
    }
    (Path("data/eval") / "v3_benchmark_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=1))

    for r in rows_out:
        if r["benchmark"] != "ranking":
            continue
        print(f"{r['query_id']:<28} rel3={r['n_relevant3']:<3} rel2={r['n_relevant2']:<3} hard1={r['n_hard1']:<3}  {r['query'][:36]}")


if __name__ == "__main__":
    main()
