"""Freeze the V4 role-aware held-out benchmark labels (spec §17/§22/§31).

Labels = deterministic role grader over the frozen Stage 3.1 enrichment, plus the
tiny documented 公知 override table (PUBLIC_KNOWLEDGE_OVERRIDES), same discipline
as the Stage 3 benchmark ("标签=冻结时点行业公知公司事实,与被测 enrichment 独立").
AMBIGUOUS audit-residual companies (23家) are excluded from every label list and
from role-inversion statistics (§31).

Outputs (frozen once; re-runs require a version bump):
  data/eval/v4_role_benchmark.jsonl          one row per query with label lists
  data/eval/v4_role_benchmark_manifest.json  freeze rule + counts + provenance

Usage: .venv/Scripts/python scripts/build_v4_role_benchmark.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_roles import (  # noqa: E402
    AMBIGUOUS_CODES,
    company_caps,
    grade_caps,
    load_enrichment,
    parse_intent,
)

POOLS = ROOT / "data/eval/v4_role_ranking_candidates.json"
QUERIES = ROOT / "data/eval/v4_role_queries.json"
OUT_JSONL = ROOT / "data/eval/v4_role_benchmark.jsonl"
OUT_MANIFEST = ROOT / "data/eval/v4_role_benchmark_manifest.json"
VERSION = "v4-role-benchmark-v1"

CAP_REL3, CAP_REL2, CAP_HARD1, CAP_WATCH = 12, 12, 20, 20

# override subtype → (role, process): synthesized as an extra evidenced capability
OVERRIDE_CAPS = {
    "ALD_equipment": ("equipment_supplier", "deposition"),
}


def main() -> None:
    pools = json.loads(POOLS.read_text(encoding="utf-8"))
    qdoc = json.loads(QUERIES.read_text(encoding="utf-8"))
    enrichment = load_enrichment()
    overrides = qdoc.get("overrides") or {}

    rows_out = []
    counts = Counter()
    overrides_applied = []
    for q in pools["queries"]:
        intent = parse_intent(q["query"])
        if not intent.gradeable:
            raise SystemExit(f"held-out query not gradeable: {q['query']}")
        by_grade: dict[int, list[str]] = {3: [], 2: [], 1: [], 0: []}
        for cand in q["candidates"]:
            code = cand["code"]
            if code in AMBIGUOUS_CODES:
                continue
            caps = [dict(c) for c in company_caps(enrichment.get(code))]
            for subtype, target in (overrides.get(code) or {}).items():
                role, process = OVERRIDE_CAPS[subtype]
                if role == "equipment_supplier" and subtype in intent.equipment_subtypes:
                    caps.append({"process": process, "role": role, "equipmentType": subtype})
                    overrides_applied.append({"query": q["query"], "code": code, "subtype": subtype, "grade": target})
            grade, reason = grade_caps(intent, caps)
            if grade is not None:
                by_grade[grade].append(code)
        # deterministic caps: keep grader order (enrichment order is stable), no shuffle
        rel3 = by_grade[3][:CAP_REL3]
        rel2 = by_grade[2][:CAP_REL2]
        hard1 = by_grade[1][:CAP_HARD1]
        watch = by_grade[0][:CAP_WATCH]
        counts["queries"] += 1
        counts["rel3"] += len(rel3)
        counts["rel2"] += len(rel2)
        counts["hard1"] += len(hard1)
        counts["watch"] += len(watch)
        if not rel3:
            counts["queries_without_rel3"] += 1
        rows_out.append({
            "query_id": q["query_id"], "family": q["family"], "split": q["split"],
            "category": "v4-role-holdout", "benchmark": VERSION, "expect": q["expect"],
            "query": q["query"],
            "relevant3": rel3, "relevant2": rel2, "hard1": hard1, "negativeWatch": watch,
        })

    manifest = {
        "benchmark": VERSION,
        "freezeRule": "标签=确定性角色grader(Stage3.1 enrichment 事实)+微量公知修正(北方华创ALD),AMBIGUOUS 23家全部排除;池=生产检索冻结Top200",
        "frozenFrom": {"pools": POOLS.name, "queries": QUERIES.name,
                       "enrichment": "stage3.1-semiconductor-v1 / s3-derive-v2"},
        "counts": dict(counts),
        "splits": dict(Counter(r["split"] for r in rows_out)),
        "overridesApplied": overrides_applied,
        "isolation": "TRAIN 查询文本零重叠(laya_v4_query_sets.isolation_check);EV/Stage3 族不受影响",
    }
    OUT_JSONL.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows_out) + "\n", encoding="utf-8")
    OUT_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
