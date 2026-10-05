"""V4.1 real-search shadow replay audit (spec §6-§12): deterministic, evidence-backed.

Merges the two per-arm replay files + the frozen holdout and computes, per entry
and aggregated:

  harness validity   V3-arm top20 vs the logged production V3 top20 (overlap k/20)
  top20 churn        |intersection(V3Top20, V4.1Top20)| / 20
  entrants / exits   new in V4.1 top20 / dropped from it, each with the company's
                     enrichment facts (role/process/subtype), both arms' grades and
                     the frozen deterministic grader's verdict where facts allow
  large movement     |rankDelta| >= 10 (pool-wide, both directions)
  anchor intrusion   the 12 V4.1 anchor-pool semiconductor companies inside the
                     top20 of NON-semiconductor queries (CROSS_DOMAIN_PRIOR check)
  repeat offender    per company: top20 appearances across all entries, query
                     domain diversity, mean rank, mean grade (both arms)
  exclusion check    top20 rows whose judgeText matches the query's own exclusion
                     patterns from the generated ontology (ExclusionViolation)

Outcomes (V4_1_BETTER / V3_BETTER / EQUIVALENT / UNCERTAIN) are NOT assigned
here — this script produces the evidence; the audit report attaches them.

Usage: .venv/Scripts/python.exe scripts/analyze_v41_shadow.py
"""

from __future__ import annotations

import json
import re
import statistics
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

HOLDOUT = ROOT / "data/eval/v4_1_real_search_holdout.json"
V3 = ROOT / "reports/v4_1_eval/v41_real_shadow_replay.v3.json"
V41 = ROOT / "reports/v4_1_eval/v41_real_shadow_replay.v41.json"
ONTOLOGY = ROOT / "data/search_ontology.json"
COMPANIES = ROOT / "data/companies.json"
OUT = ROOT / "reports/v4_1_eval/v41_real_shadow_analysis.json"

ANCHOR_CODES = {
    "688012": "中微公司", "002371": "北方华创", "688072": "拓荆科技", "688082": "盛美上海",
    "688120": "华海清科", "688037": "芯源微", "300666": "江丰电子", "002409": "雅克科技",
    "300054": "鼎龙股份", "688019": "安集科技", "301611": "珂玛科技", "605358": "立昂微",
}
SEMANTIC_DOMAINS = {"semiconductor-equipment", "semiconductor-material"}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def cap_summary(enrichment: dict, code: str) -> dict:
    record = enrichment.get(code)
    caps = []
    for cap in company_caps(record):
        subtype = cap.get("equipmentType") or cap.get("materialType") or cap.get("componentType")
        role = cap.get("role") or (
            "equipment_supplier" if cap.get("equipmentType") else (
                "material_supplier" if cap.get("materialType") else (
                    "component_supplier" if cap.get("componentType") else None)))
        caps.append({"process": cap.get("process"), "role": role, "subtype": subtype})
    return {"roles": (record or {}).get("roles") or [], "processCapabilities": caps}


def deterministic_grade(query: str, code: str, enrichment: dict) -> dict:
    """Frozen role grader on the frozen enrichment. grade None = facts cannot grade."""
    if code in AMBIGUOUS_CODES:
        return {"grade": None, "reason": "AMBIGUOUS"}
    caps = company_caps(enrichment.get(code))
    if not caps:
        return {"grade": None, "reason": "no_enriched_capability"}
    grade, reason = grade_caps(parse_intent(query), caps)
    return {"grade": grade, "reason": reason}


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    at = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[at]


def main() -> None:
    holdout = load(HOLDOUT)
    entries = {e["entryId"]: e for e in holdout["queries"]}
    v3_rows = {r["entryId"]: r for r in load(V3)["results"]}
    v41_rows = {r["entryId"]: r for r in load(V41)["results"]}
    enrichment = load_enrichment()
    ontology = load(ONTOLOGY)
    companies = {c["code"]: c for c in load(COMPANIES)["companies"]}

    per_entry: list[dict] = []
    churns, v3_repro = [], []
    latency: dict[str, list[float]] = {"v3": [], "v41": []}
    anchor_intrusions: list[dict] = []
    exclusion_violations: list[dict] = []
    # §11 repeat offender: track every top20 company on both arms
    offender: dict[str, dict] = {}

    def track(arm: str, entry_id: str, domain: str, code: str, rank: int, grade: int) -> None:
        slot = offender.setdefault(code, {"name": companies.get(code, {}).get("name") or ANCHOR_CODES.get(code, code)})
        slot.setdefault(arm, {"appearances": 0, "domains": set(), "ranks": [], "grades": [], "entries": set()})
        slot[arm]["appearances"] += 1
        slot[arm]["domains"].add(domain)
        slot[arm]["ranks"].append(rank)
        slot[arm]["grades"].append(grade)
        slot[arm]["entries"].add(entry_id)

    for entry_id, hold in entries.items():
        v3, v41 = v3_rows[entry_id], v41_rows[entry_id]
        v3_arm, v41_arm = v3["arms"]["v3"], v41["arms"]["v41"]
        query = hold["normalized"]
        domain = hold["domainTag"]
        v3_top = [row["code"] for row in v3_arm["top20"]]
        v41_top = [row["code"] for row in v41_arm["top20"]]
        name_of = lambda code: next((r["name"] for r in v3_arm["top20"] if r["code"] == code), None) or \
            next((r["name"] for r in v41_arm["top20"] if r["code"] == code), None) or ANCHOR_CODES.get(code, code)
        common = set(v3_top) & set(v41_top)
        churns.append(len(common) / 20)

        logged_top = [row["code"] for row in hold["v3Top20"]]
        v3_repro.append(len(set(v3_top) & set(logged_top)) / max(len(logged_top), 1))

        latency["v3"].append(v3_arm["rerankMs"])
        latency["v41"].append(v41_arm["rerankMs"])

        for rank, code in enumerate(v3_top, 1):
            track("v3", entry_id, domain, code, rank, v3_arm["gradeById"].get(code) or 0)
        for rank, code in enumerate(v41_top, 1):
            track("v41", entry_id, domain, code, rank, v41_arm["gradeById"].get(code) or 0)

        def detail(code: str) -> dict:
            return {
                "name": name_of(code),
                "v3Rank": v3_arm["rankById"].get(code),
                "v41Rank": v41_arm["rankById"].get(code),
                "v3Grade": v3_arm["gradeById"].get(code),
                "v41Grade": v41_arm["gradeById"].get(code),
                "deterministicGrade": deterministic_grade(query, code, enrichment),
                "enrichment": cap_summary(enrichment, code),
                "isAnchor": code in ANCHOR_CODES,
                "business": (companies.get(code, {}).get("businessDescription") or "")[:200],
            }

        entrants = [code for code in v41_top if code not in set(v3_top)]
        exits = [code for code in v3_top if code not in set(v41_top)]
        movers = [
            {"code": code, "name": name_of(code),
             "v3Rank": v3_arm["rankById"].get(code, 201), "v41Rank": v41_arm["rankById"].get(code, 201),
             "rankDelta": v3_arm["rankById"].get(code, 201) - v41_arm["rankById"].get(code, 201)}
            for code in set(v3_arm["rankById"]) | set(v41_arm["rankById"])
            if abs(v3_arm["rankById"].get(code, 201) - v41_arm["rankById"].get(code, 201)) >= 10
        ]
        movers.sort(key=lambda row: -abs(row["rankDelta"]))

        # CROSS_DOMAIN_PRIOR: anchor companies in NON-semiconductor queries' top20
        if domain not in SEMANTIC_DOMAINS:
            for code in set(v3_top) | set(v41_top):
                if code in ANCHOR_CODES:
                    anchor_intrusions.append({
                        "entryId": entry_id, "query": query, "domainTag": domain,
                        "code": code, "name": ANCHOR_CODES[code],
                        "v3Rank": v3_arm["rankById"].get(code), "v41Rank": v41_arm["rankById"].get(code),
                        "v3Grade": v3_arm["gradeById"].get(code), "v41Grade": v41_arm["gradeById"].get(code),
                    })

        # ExclusionViolation: top20 rows whose judgeText hits the query's own exclusions
        for exclusion_type in hold["querySpec"].get("exclusions") or []:
            patterns = ontology["exclusions"].get(exclusion_type, {}).get("company_patterns") or []
            for arm_id, arm, top in (("v3", v3_arm, v3_top), ("v41", v41_arm, v41_top)):
                for code in top:
                    judge_text = companies.get(code, {}).get("judgeText") or ""
                    hit = next((p for p in patterns if re.search(p, judge_text)), None)
                    if hit:
                        exclusion_violations.append({
                            "entryId": entry_id, "query": query, "arm": arm_id,
                            "code": code, "name": name_of(code), "exclusionType": exclusion_type,
                            "pattern": hit, "rank": arm["rankById"].get(code),
                            "grade": arm["gradeById"].get(code),
                        })

        per_entry.append({
            "entryId": entry_id,
            "query": query,
            "domainTag": domain,
            "era": hold["era"],
            "harnessV3Reproduction": round(len(set(v3_top) & set(logged_top)) / max(len(logged_top), 1), 3),
            "top20Churn": round(len(common) / 20, 3),
            "entrants": {code: detail(code) for code in entrants},
            "exits": {code: detail(code) for code in exits},
            "largeMovements": movers[:12],
            "v3Top20": [{"code": c, "name": name_of(c)} for c in v3_top],
            "v41Top20": [{"code": c, "name": name_of(c)} for c in v41_top],
            "latency": {"v3Ms": v3_arm["rerankMs"], "v41Ms": v41_arm["rerankMs"]},
        })

    offender_out = {}
    for code, slot in offender.items():
        offender_out[code] = {"name": slot["name"]}
        for arm in ("v3", "v41"):
            data = slot.get(arm)
            offender_out[code][arm] = {
                "top20Appearances": data["appearances"],
                "distinctQueries": len(data["entries"]),
                "domainDiversity": sorted(data["domains"]),
                "meanRank": round(statistics.mean(data["ranks"]), 1),
                "meanGrade": round(statistics.mean(data["grades"]), 2),
            } if data else None

    result = {
        "counts": {
            "entries": len(entries),
            "meanTop20Churn": round(statistics.mean(churns), 3),
            "minChurn": round(min(churns), 3),
            "maxChurn": round(max(churns), 3),
            "entriesWithChurnBelowHalf": sum(1 for c in churns if c < 0.5),
            "meanHarnessV3Reproduction": round(statistics.mean(v3_repro), 3),
        },
        "latency": {
            "v3": {"p50Ms": round(percentile(latency["v3"], 0.5)), "p95Ms": round(percentile(latency["v3"], 0.95))},
            "v41": {"p50Ms": round(percentile(latency["v41"], 0.5)), "p95Ms": round(percentile(latency["v41"], 0.95))},
        },
        "anchorIntrusionsNonSemi": anchor_intrusions,
        "exclusionViolations": exclusion_violations,
        "repeatOffenders": offender_out,
        "entries": per_entry,
    }
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["counts"], ensure_ascii=False))
    print(json.dumps(result["latency"], ensure_ascii=False))
    print(f"anchorIntrusions: {len(anchor_intrusions)}  exclusionViolations: {len(exclusion_violations)}")


if __name__ == "__main__":
    sys.exit(main())
