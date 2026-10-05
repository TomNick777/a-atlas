"""Snapshot role-grader-v1 (pre-upgrade) grades for the three-arm regrade protocol.

Arm A of GRADER_FIX_BASELINE §8: v1 grader + CURRENT knowledge (stage3.2 enrichment),
computed BEFORE scripts/laya_v4_roles.py is upgraded to role-grader-v2. The v1
implementation remains reproducible from git (commit debd742).

Covers every distinct query in: v4/v4.1-A/v4.1-B train pairs, V4 role benchmark,
stage3_1 focus pools, residual triage pools. Output rows are (query, code) -> grade
with grade None recorded as null (company facts do not support grading).

Usage: .venv/Scripts/python scripts/regrade_label_v1.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_roles import (  # noqa: E402  (v1 — run this script BEFORE the v2 upgrade)
    AMBIGUOUS_CODES,
    company_caps,
    grade_caps,
    load_enrichment,
    parse_intent,
)

OUT = ROOT / "data/eval/grader_fix_v1_fresh_labels.json"


def queries_from_train() -> set[str]:
    qs: set[str] = set()
    for f in ("v4_train_pairs.jsonl", "v4_1_train_pairs_A.jsonl", "v4_1_train_pairs_B.jsonl"):
        for line in (ROOT / "data/train" / f).read_text(encoding="utf-8").splitlines():
            if line.strip():
                qs.add(json.loads(line)["query"])
    return qs


def queries_from_eval() -> set[str]:
    qs: set[str] = set()
    for f in ("v4_role_benchmark.jsonl", "stage3_semiconductor_benchmark.jsonl", "v3_search_benchmark.jsonl"):
        for line in (ROOT / "data/eval" / f).read_text(encoding="utf-8").splitlines():
            if line.strip():
                qs.add(json.loads(line)["query"])
    for f in ("stage3_1_focus_pools.json", "v4_1_cross_domain_queries.json", "residual_triage_pools.json"):
        d = json.loads((ROOT / "data/eval" / f).read_text(encoding="utf-8"))
        vals = list(d.values()) if isinstance(d, dict) else d
        for v in vals:
            if isinstance(v, dict) and "query" in v:
                qs.add(v["query"])
            elif isinstance(v, list):
                qs.update(x.get("query") for x in v if isinstance(x, dict) and "query" in x)
    return qs


def main() -> None:
    enrichment = load_enrichment()
    codes = sorted(c for c in enrichment if c not in AMBIGUOUS_CODES)
    all_queries = sorted(queries_from_train() | queries_from_eval())
    out: dict[str, dict[str, int | None]] = {}
    dist = Counter()
    for q in all_queries:
        intent = parse_intent(q)
        grades: dict[str, int | None] = {}
        for code in codes:
            grade, _ = grade_caps(intent, company_caps(enrichment[code]))
            grades[code] = grade
            if grade is not None:
                dist[grade] += 1
        out[q] = grades
    doc = {
        "graderVersion": "role-grader-v1",
        "snapshotCommit": "debd742 (pre-upgrade worktree, grader file SHA16 e814fb31dda9b629)",
        "knowledge": "stage3.2-semiconductor-v1 (data/enrichment/semiconductor/enrichment.json as of 2026-09-26)",
        "note": "Arm A of the three-arm regrade protocol: v1 ruler + current knowledge. "
                "Diff vs frozen dataset labels isolates knowledge drift (stage3.1→3.2); "
                "diff vs role-grader-v2 labels isolates the grader fix.",
        "queries": len(all_queries),
        "gradeDist": dict(sorted(dist.items())),
        "labels": out,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT}: {len(all_queries)} queries x {len(codes)} gradeable companies; dist {dict(sorted(dist.items()))}")


if __name__ == "__main__":
    main()
