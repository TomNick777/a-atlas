"""Build V4.2 frozen eval pools (SET A / SET B / SET C) — fixed company sets.

Fixed pools (LAYA_V4_2 BASELINE §5): every candidate is graded by the same
deterministic grader that produced the training labels, so the ONLY variable
between checkpoints is the model score (§34 discipline). The pools are written
in the residual_triage pool schema (candidates carry profile text) so the
sidecar grading path is identical to the 30-pool protocol.

SET A  material subtype    — full graded pool per intent (role-grader-v2)
SET B  commodity role      — all exposure companies per intent (rubric)
SET C  phrase groups       — one pool, N wordings, ONE set of labels; xdom
         groups get domain-core + 12 anchors + 12 sampled others (seeded)

Labels come from the graders only; no company-specific logic. Deterministic
(SEED 20260926). Output: data/eval/v4_2_fixed_pools.json

Usage: .venv/Scripts/python scripts/build_v4_2_eval_pools.py
"""

from __future__ import annotations

import json
import random
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_roles import company_caps, grade_caps, load_enrichment, parse_intent
from laya_v4_2_commodity_roles import grade_commodity, load_exposure, parse_commodity_intent
from laya_v4_1_cross_domain import ANCHOR_CODES, company_evidence, grade_cross_domain

SEED = 20260926
OUT = ROOT / "data/eval/v4_2_fixed_pools.json"
EVAL_QUERIES = ROOT / "data/train/v4_2_eval_queries.json"
RUBRIC_VERSION = "commodity-role-rubric-kp1"
GRADER_V2 = "role-grader-v2"
XDOM_GRADER = "xdomain-grader-v1"


def main() -> None:
    rng = random.Random(SEED)
    enrichment = load_enrichment()
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    companies = {c["code"]: c for c in json.loads(
        (ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    exposure = load_exposure(profiles)
    evalq = json.loads(EVAL_QUERIES.read_text(encoding="utf-8"))

    pools: dict = {}
    meta_rows = []

    def put(key: str, query: str, kind: str, graded: list[tuple[str, int]], grader: str) -> None:
        cands = []
        for code, g in sorted(graded):
            c = companies.get(code)
            if c is None:
                continue
            cands.append({
                "code": code, "name": c["name"], "grade": int(g),
                "profile": (profiles.get(code) or {}).get("searchText") or c.get("judgeText") or "",
            })
        pools[key] = {"query": query, "kind": kind, "grader": grader,
                      "poolSize": len(cands), "candidates": cands}
        meta_rows.append({"key": key, "poolSize": len(cands),
                          "label3": sum(1 for x in cands if x["grade"] >= 3),
                          "label2": sum(1 for x in cands if x["grade"] == 2),
                          "label01": sum(1 for x in cands if x["grade"] <= 1)})

    # ---------------- SET A: material subtype ----------------
    for row in evalq["sets"]["SET_A_material_subtype"]:
        ref = None
        for wording in row["queries"]:
            it = parse_intent(wording)
            if not it.gradeable:
                raise SystemExit(f"SET A wording not gradeable: {wording}")
            wd = {}
            for code, rec in enrichment.items():
                g, _ = grade_caps(it, company_caps(rec))
                if g is not None:
                    wd[code] = g
            if ref is None:
                ref = wd
            elif wd != ref:
                raise SystemExit(f"SET A wording labels diverge: {row['family']} {wording}")
            put(f"{row['family']}::{wording}", wording, "SET_A", list(wd.items()), GRADER_V2)

    # ---------------- SET B: commodity role ----------------
    for row in evalq["sets"]["SET_B_commodity_role"]:
        ref = None
        for wording in row["queries"]:
            ci = parse_commodity_intent(wording)
            if not ci.gradeable:
                raise SystemExit(f"SET B wording not gradeable: {wording}")
            wd = {}
            for code, vals in exposure.items():
                g, _ = grade_commodity(ci, vals)
                if g is not None:
                    wd[code] = g
            if ref is None:
                ref = wd
            elif wd != ref:
                raise SystemExit(f"SET B wording labels diverge: {row['family']} {wording}")
            put(f"{row['family']}::{wording}", wording, "SET_B", list(wd.items()), RUBRIC_VERSION)

    # ---------------- SET C: phrase groups (one pool, N wordings) ----------------
    for row in evalq["sets"]["SET_C_phrase"]:
        w1 = row["queries"][0]
        if row["canonicalIntent"] in ("robot_reducer", "industrial_automation"):
            graded = {}
            for code in companies:
                ind_fields, prof = company_evidence(code, companies, profiles)
                g, _ = grade_cross_domain(row["canonicalIntent"], ind_fields, prof)
                graded[code] = g
            core = [(c, g) for c, g in sorted(graded.items()) if g >= 2]
            anchors = [(c, graded[c]) for c in ANCHOR_CODES if c in graded]
            rest = [c for c in sorted(graded) if graded[c] < 2 and c not in ANCHOR_CODES]
            items = core + anchors + [(c, graded[c]) for c in rng.sample(rest, min(24, len(rest)))]
            for wording in row["queries"]:
                put(f"{row['paraphraseGroupId']}::{wording}", wording, "SET_C", items, XDOM_GRADER)
            continue
        ci = parse_commodity_intent(w1)
        if ci.gradeable:
            graded = {code: g for code, vals in exposure.items()
                      for g, _ in [grade_commodity(ci, vals)] if g is not None}
            zeros_pool = [c for c in companies if c not in exposure]
            grader = RUBRIC_VERSION
        else:
            intent = parse_intent(w1)
            if not intent.gradeable:
                raise SystemExit(f"SET C wording not gradeable: {w1}")
            graded = {}
            for code, rec in enrichment.items():
                g, _ = grade_caps(intent, company_caps(rec))
                if g is not None:
                    graded[code] = g
            zeros_pool = None
            grader = GRADER_V2
        items = list(graded.items())
        if zeros_pool:
            items += [(c, 0) for c in rng.sample(zeros_pool, min(12, len(zeros_pool)))]
        for wording in row["queries"]:
            put(f"{row['paraphraseGroupId']}::{wording}", wording, "SET_C", items, grader)

    OUT.write_text(json.dumps({
        "version": "v4_2-fixed-pools-v1", "seed": SEED,
        "pools": pools, "summary": meta_rows,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[done] pools={len(pools)} → {OUT.name}")
    for m in meta_rows:
        print("  ", m["key"], m["poolSize"], f"3:{m['label3']} 2:{m['label2']} 0-1:{m['label01']}")


if __name__ == "__main__":
    main()
