"""Three-arm relabel of the V4/V4.1 training data with role-grader-v2 (spec §十/§十一).

NO TRAINING, NO dataset overwrite. For every distinct (query, code) row of
v4_train_pairs.jsonl (the inherited base), v4_1_train_pairs_A/B corrections:

  C = labelOriginal   frozen label in the dataset (v1 ruler @ stage3.1 knowledge,
                      or cross-domain grader / curated for non-role rows)
  A = labelV1Fresh    role-grader-v1 + stage3.2 knowledge (snapshot
                      data/eval/grader_fix_v1_fresh_labels.json, taken before the
                      v2 upgrade) — A-C isolates knowledge drift
  B = labelV2         role-grader-v2 + stage3.2 knowledge — B-A isolates the
                      grader fix (this round's product)

Preview file data/train/v4_1_regraded_preview.jsonl: `label` is relabeled to B
ONLY on grader-origin rows (category v4-role-contrast — the ruler's own rows);
every other row keeps its original label with B recorded in labelV2 for audit.

Also writes data/eval/grader_fix_label_diff.json (transition matrices, per-family
and per-query breakdowns) consumed by reports/GRADER_FIX_LABEL_DIFF.md.

Usage: .venv/Scripts/python scripts/regrade_train_pairs.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_roles import GRADER_VERSION, company_caps, grade_caps, load_enrichment, parse_intent  # noqa: E402

V1_FRESH = ROOT / "data/eval/grader_fix_v1_fresh_labels.json"
OUT_PREVIEW = ROOT / "data/train/v4_1_regraded_preview.jsonl"
OUT_DIFF = ROOT / "data/eval/grader_fix_label_diff.json"

# grader-origin row categories: the v1/v2 role ruler is the label authority here
GRADER_CATEGORIES = {"v4-role-contrast"}

FAMILY_RULES: list[tuple[str, str]] = [
    ("光刻胶", "photoresist"),
    ("前驱体", "precursor"),
    ("靶材", "target_material"),
    ("抛光液", "CMP_slurry"),
    ("抛光垫", "CMP_pad"),
    ("刻蚀液", "etchant"),
    ("清洗液", "cleaning_chemical"),
    ("外延片", "epi_wafer"),
    ("湿电子化学品", "wet_chemicals"),
    ("试剂", "wet_chemicals"),
    ("特气", "electronic_special_gas"),
    ("硅片", "silicon_wafer"),
    ("掩膜版", "photomask"),
    ("载板", "package_substrate"),
    ("引线框架", "lead_frame"),
]


def family_of(query: str) -> str:
    for token, fam in FAMILY_RULES:
        if token in query:
            return fam
    return "other"


def load_rows() -> dict[str, dict]:
    """distinct (query, code) -> row dict with variant membership."""
    rows: dict[tuple[str, str], dict] = {}
    for fname, variant in (("v4_train_pairs.jsonl", "V4-base"),
                           ("v4_1_train_pairs_A.jsonl", "V4.1-A"),
                           ("v4_1_train_pairs_B.jsonl", "V4.1-B")):
        for line in (ROOT / "data/train" / fname).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            key = (r["query"], r["code"])
            if key in rows:
                rows[key]["variants"].add(variant)
            else:
                r = dict(r)
                r["variants"] = {variant}
                r["_src_file"] = fname
                rows[key] = r
    return rows


def main() -> None:
    enrichment = load_enrichment()
    v1 = json.loads(V1_FRESH.read_text(encoding="utf-8"))["labels"]
    rows = load_rows()

    preview = []
    transitions = Counter()            # grader-origin rows only (label authority = this ruler)
    by_family: dict[str, Counter] = {}
    by_query: dict[str, Counter] = {}
    other_transitions = Counter()      # non-grader-origin rows: divergence census, no relabel
    other_by_query: dict[str, Counter] = {}
    transitions_v1_fresh = Counter()   # A vs C (knowledge drift), grader-origin rows
    changed_grader_origin = 0
    grader_origin_total = 0
    no_v1_snapshot = 0

    for (query, code), row in rows.items():
        original = int(row["label"])
        v1_fresh = v1.get(query, {}).get(code)
        if v1_fresh is None and code not in v1.get(query, {}):
            no_v1_snapshot += 1
        intent = parse_intent(query)
        v2, _reason = grade_caps(intent, company_caps(enrichment.get(code)))
        is_grader_origin = row.get("category") in GRADER_CATEGORIES
        preview_row = dict(row)
        preview_row["variants"] = sorted(row["variants"])
        preview_row["labelOriginal"] = original
        preview_row["labelV1Fresh"] = v1_fresh
        preview_row["labelV2"] = v2
        preview_row["graderVersion"] = GRADER_VERSION
        preview_row["graderOriginRow"] = is_grader_origin
        if is_grader_origin and v2 is not None:
            preview_row["label"] = int(v2)
            preview_row["relabelReason"] = "role-grader-v2 (grader-origin row)"
            grader_origin_total += 1
            if v2 != original:
                changed_grader_origin += 1
            key2 = f"{original}->{v2}"
            transitions[key2] += 1
            fam = family_of(query)
            by_family.setdefault(fam, Counter())[key2] += 1
            by_query.setdefault(query, Counter())[key2] += 1
            if v1_fresh is not None:
                transitions_v1_fresh[f"{original}->{v1_fresh}"] += 1
        else:
            preview_row["relabelReason"] = "kept (label authority is not the role grader)"
            if v2 is not None and v2 != original:
                other_transitions[f"{original}->{v2}"] += 1
                other_by_query.setdefault(query, Counter())[f"{original}->{v2}"] += 1
        preview.append(preview_row)

    preview.sort(key=lambda r: (r["query_id"], r["code"]))
    OUT_PREVIEW.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in preview) + "\n", encoding="utf-8")

    def top(counter: Counter, n: int = 25) -> dict:
        return dict(counter.most_common(n))

    doc = {
        "generatedBy": "scripts/regrade_train_pairs.py",
        "graderVersion": GRADER_VERSION,
        "protocol": "C=original frozen label; A=v1 grader+stage3.2 knowledge; B=v2 grader+stage3.2 knowledge; B-A = grader-fix effect, A-C = knowledge drift",
        "totalRows": len(preview),
        "graderOriginRows": grader_origin_total,
        "graderOriginRelabeled": changed_grader_origin,
        "rowsMissingV1Snapshot": no_v1_snapshot,
        "previewFile": "data/train/v4_1_regraded_preview.jsonl",
        "transitions_v2_vs_original_graderOrigin": top(transitions),
        "transitions_v1fresh_vs_original_graderOrigin": top(transitions_v1_fresh),
        "transitions_nonGraderOrigin_divergence": top(other_transitions, 15),
        "topQueries_nonGraderOrigin_divergence": {k: top(v, 6) for k, v in
                                                  sorted(other_by_query.items(), key=lambda kv: -sum(kv[1].values()))[:15]},
        "byFamily_graderOrigin": {k: top(v) for k, v in sorted(by_family.items())},
        "byQuery_graderOrigin": {k: top(v, 12) for k, v in sorted(by_query.items())},
    }
    OUT_DIFF.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: doc[k] for k in ("totalRows", "graderOriginRows", "graderOriginRelabeled", "rowsMissingV1Snapshot")}, ensure_ascii=False))
    print("top v2 transitions (grader-origin):", json.dumps(doc["transitions_v2_vs_original_graderOrigin"], ensure_ascii=False))


if __name__ == "__main__":
    main()
