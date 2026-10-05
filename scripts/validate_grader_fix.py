"""Grader-only benchmark for role-grader-v2 (spec §十五) — no model, no Laya call.

Same frozen query + frozen Search Profile truth → target grade, under v1 and v2:

  LabelAccuracy                v2 grade vs frozen V4 role benchmark truth (32 queries),
                               split into unaffected vs affected-by-defect queries;
                               v1-fresh grades as the baseline column
  MaterialSubtypeAccuracy      photoresist triage pools: TRUE(8家) vs interferer sets,
                               mean grade + per-query direction pass, v1 vs v2
  ProcessVsMaterialConfusion   corpus queries where v1 attached PROCESS semantics to a
                               material-noun query and v2 does not
  EquipmentVsMaterialConfusion same for equipment-subtype semantics

v1 semantics are replicated from the FROZEN v1 tables embedded in
scripts/grader_lexeme_collision_audit.py; v1 grades come from the pre-upgrade
snapshot data/eval/grader_fix_v1_fresh_labels.json.

Usage: .venv/Scripts/python scripts/validate_grader_fix.py
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

from grader_lexeme_collision_audit import (  # noqa: E402  (frozen v1 tables snapshot)
    COMPONENT_SUBTYPE_PATTERNS as V1_COMPONENT,
    EXCLUDED_ROLE_PATTERNS as V1_EXCL,
    MATERIAL_SUBTYPE_PATTERNS as V1_MAT,
    PROCESS_PATTERNS as V1_PROC,
    ROLE_PATTERNS as V1_ROLE,
    SEMI_DOMAIN_PATTERNS as V1_DOMAIN,
)
from laya_v4_query_sets import PUBLIC_KNOWLEDGE_OVERRIDES  # noqa: E402
from laya_v4_roles import (  # noqa: E402
    AMBIGUOUS_CODES,
    GRADER_VERSION,
    company_caps,
    grade_caps,
    load_enrichment,
    parse_intent,
)
from laya_v4_roles import _rx  # noqa: E402

OUT_JSON = ROOT / "data/eval/grader_fix_validation.json"
V1_FRESH = json.loads((ROOT / "data/eval/grader_fix_v1_fresh_labels.json").read_text(encoding="utf-8"))["labels"]

# triage Case A sets (residual_failure_cases.jsonl A1 / v4_2_candidate_queue V42-Q5)
TRUE_PR = {"雅克科技", "鼎龙股份", "上海新阳", "南大光电", "飞凯材料", "容大感光", "晶瑞电材", "彤程新材"}
PR_INTERFERERS = {"江丰电子", "欧晶科技", "有研硅", "金宏气体", "清溢光电", "安泰科技", "正帆科技", "沐邦高能"}
PR_QUERIES = ["光刻胶", "半导体光刻胶", "做光刻胶的公司", "国产光刻胶材料", "给晶圆厂卖光刻胶的"]


def rx(pat: str) -> re.Pattern:
    return re.compile(pat)


class V1Intent:
    """Faithful replica of role-grader-v1 Intent (pre-upgrade semantics)."""

    def __init__(self, raw: str) -> None:
        roles: set[str] = set()
        for pat, rs in V1_ROLE:
            if rx(pat).search(raw):
                roles.update(rs)
        excluded: set[str] = set()
        for pat, rs in V1_EXCL:
            if rx(pat).search(raw):
                excluded.update(rs)
        self.requested_roles = roles - excluded
        if "component_supplier" in self.requested_roles and rx(r"设备(的)?(零|部|组|石英|陶瓷|硅部|真空)").search(raw):
            self.requested_roles.discard("equipment_supplier")
        if "material_supplier" in self.requested_roles and rx(r"设备(的)?(材料|耗材|用)").search(raw):
            self.requested_roles.discard("equipment_supplier")
        self.excluded_roles = excluded
        self.processes: set[str] = set()
        self.equipment_subtypes: set[str] = set()
        for pat, procs, eqs in V1_PROC:
            if rx(pat).search(raw):
                self.processes.update(procs)
                self.equipment_subtypes.update(eqs)
        self.material_subtypes: set[str] = set()
        for pat, subs in V1_MAT:
            if rx(pat).search(raw):
                self.material_subtypes.update(subs)
        self.component_subtypes: set[str] = set()
        for pat, subs in V1_COMPONENT:
            if rx(pat).search(raw):
                self.component_subtypes.update(subs)
        if not self.requested_roles:
            if self.material_subtypes:
                self.requested_roles = {"material_supplier"}
            elif self.component_subtypes:
                self.requested_roles = {"component_supplier"}
        self.semi_domain = bool(rx("|".join(V1_DOMAIN)).search(raw))


def v1_grade(intent: V1Intent, caps: list[dict]) -> int | None:
    """role-grader-v1 grade_caps replica (pre-upgrade)."""
    if not caps:
        return None
    roles = ("equipment_supplier", "material_supplier", "component_supplier")
    adjacency = {
        "equipment_supplier": {"component_supplier": 2, "material_supplier": 1},
        "component_supplier": {"equipment_supplier": 2, "material_supplier": 1},
        "material_supplier": {"equipment_supplier": 1, "component_supplier": 1},
    }
    best = None
    for cap in caps:
        subtype = cap.get("equipmentType") or cap.get("materialType") or cap.get("componentType")
        role = cap.get("role") or (
            "equipment_supplier" if cap.get("equipmentType") else (
                "material_supplier" if cap.get("materialType") else "component_supplier"))
        process = cap.get("process")
        if role not in roles:
            continue
        if role in intent.excluded_roles:
            g = 0
        else:
            role_ok = (not intent.requested_roles) or role in intent.requested_roles
            proc_ok = (not intent.processes) or (process in intent.processes)
            hint = (intent.equipment_subtypes if role == "equipment_supplier"
                    else intent.material_subtypes if role == "material_supplier"
                    else intent.component_subtypes)
            sub_ok = (not hint) or (subtype in hint if subtype else False)
            if role_ok and proc_ok and sub_ok:
                g = 3
            elif role_ok and proc_ok:
                g = 2
            elif role_ok:
                g = 2 if process else 1
            elif proc_ok and intent.requested_roles and intent.processes:
                g = 1
            elif intent.requested_roles and not intent.processes:
                g = adjacency.get(next(iter(intent.requested_roles)), {}).get(role, 1)
            else:
                g = 0
        if best is None or g > best:
            best = g
    return best


def main() -> None:
    enrichment = load_enrichment()
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    name_of = {c["name"]: c["code"] for c in companies.values()}

    out: dict = {"graderVersion": GRADER_VERSION, "v1Baseline": "grader_fix_v1_fresh_labels.json + frozen-table replica"}

    # ---------------- 1. LabelAccuracy on the frozen V4 role benchmark ----------------
    truth_rows = []
    for line in (ROOT / "data/eval/v4_role_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            labels = {c: 3 for c in r["relevant3"]} | {c: 2 for c in r["relevant2"]}
            for c in r["hard1"]:
                labels.setdefault(c, 1)
            for c in r.get("negativeWatch", []):
                labels.setdefault(c, 0)
            truth_rows.append({"query": r["query"], "family": r["family"], "labels": labels})

    # queries whose parse semantics differ between v1 and v2 (the fix surface:
    # material-head process leaks, span-composition hint changes, exclusion surfaces)
    def v1_defect(query: str) -> bool:
        i1, i2 = V1Intent(query), parse_intent(query)
        return bool(
            i1.requested_roles != i2.requested_roles
            or i1.excluded_roles != i2.excluded_roles
            or i1.processes != i2.processes
            or i1.equipment_subtypes != i2.equipment_subtypes
            or i1.material_subtypes != i2.material_subtypes
            or i1.component_subtypes != i2.component_subtypes
        )

    per_query = []
    for row in truth_rows:
        q = row["query"]
        i2 = parse_intent(q)
        affected = v1_defect(q)
        stats = {"query": q, "family": row["family"], "affectedByDefect": affected, "n": 0,
                 "v1_agree": 0, "v2_agree": 0, "v2_changes": [], "skipped_notGradeable": 0}
        for code, truth in row["labels"].items():
            if code in AMBIGUOUS_CODES:
                continue
            caps = company_caps(enrichment.get(code))
            g1 = V1_FRESH.get(q, {}).get(code)
            if g1 is None:
                g1 = v1_grade(V1Intent(q), caps)
            g2, _ = grade_caps(i2, caps)
            if (g2 is None) != (g1 is None):
                stats["skipped_notGradeable"] += 1
                continue
            if g2 is None:
                continue
            if code in PUBLIC_KNOWLEDGE_OVERRIDES and q in (
                    "哪家公司生产ALD机器", "给晶圆厂卖原子层沉积机器的", "生产ALD镀膜机的企业"):
                g2 = PUBLIC_KNOWLEDGE_OVERRIDES[code].get("ALD_equipment", g2)
                g1 = PUBLIC_KNOWLEDGE_OVERRIDES[code].get("ALD_equipment", g1)
            stats["n"] += 1
            if g1 == truth:
                stats["v1_agree"] += 1
            if g2 == truth:
                stats["v2_agree"] += 1
            if g1 != g2:
                stats["v2_changes"].append({"code": code, "name": companies.get(code, {}).get("name", "?"),
                                            "v1": g1, "v2": g2, "truth": truth})
        per_query.append(stats)

    def acc(rows, key):
        n = sum(r["n"] for r in rows)
        hit = sum(r[key] for r in rows)
        return round(hit / n, 4) if n else None, n

    v2_acc_all, n_all = acc(per_query, "v2_agree")
    v1_acc_all, _ = acc(per_query, "v1_agree")
    unaffected = [r for r in per_query if not r["affectedByDefect"]]
    affected = [r for r in per_query if r["affectedByDefect"]]
    v2_acc_un, n_un = acc(unaffected, "v2_agree")
    v1_acc_un, _ = acc(unaffected, "v1_agree")
    v2_acc_af, n_af = acc(affected, "v2_agree")
    v1_acc_af, _ = acc(affected, "v1_agree")

    out["labelAccuracy"] = {
        "definition": "grader label == frozen V4 role benchmark truth (rel3=3/rel2=2/hard1=1/watch=0), AMBIGUOUS excluded, overrides applied",
        "overall": {"v1": v1_acc_all, "v2": v2_acc_all, "n": n_all},
        "unaffectedQueries": {"v1": v1_acc_un, "v2": v2_acc_un, "n": n_un,
                              "queries": [r["query"] for r in unaffected]},
        "affectedQueries": {"v1": v1_acc_af, "v2": v2_acc_af, "n": n_af,
                            "queries": [r["query"] for r in affected]},
        "perQuery": per_query,
    }

    # ---------------- 2. MaterialSubtypeAccuracy (photoresist pools) ----------------
    pools = json.loads((ROOT / "data/eval/residual_triage_pools.json").read_text(encoding="utf-8"))
    pr_pool = []
    for key, doc in pools.items():
        q = doc.get("query")
        if not q or q not in PR_QUERIES:
            continue
        true_codes = [name_of[n] for n in TRUE_PR if n in name_of]
        intf_codes = [name_of[n] for n in PR_INTERFERERS if n in name_of]
        entry = {"query": q, "poolKey": key, "trueMean": {}, "interfererMean": {}, "directionPass": {}}
        for ruler, grade_fn in (("v1", lambda c: V1_FRESH.get(q, {}).get(c)),
                                ("v2", lambda c: grade_caps(parse_intent(q), company_caps(enrichment.get(c)))[0])):
            tvals = [g for c in true_codes if (g := grade_fn(c)) is not None]
            ivals = [g for c in intf_codes if (g := grade_fn(c)) is not None]
            entry["trueMean"][ruler] = round(statistics.mean(tvals), 3) if tvals else None
            entry["interfererMean"][ruler] = round(statistics.mean(ivals), 3) if ivals else None
            entry["directionPass"][ruler] = (entry["trueMean"][ruler] or 0) > (entry["interfererMean"][ruler] or 0) if tvals and ivals else None
        pr_pool.append(entry)
    out["materialSubtypeAccuracy"] = {
        "definition": "photoresist triage pools: mean grade of 8 TRUE photoresist companies vs 8 interferers; direction pass = trueMean > interfererMean",
        "trueSet": sorted(TRUE_PR), "interfererSet": sorted(PR_INTERFERERS),
        "perQuery": pr_pool,
    }

    # ---------------- 3/4. Confusion metrics over the eval query corpus ----------------
    corpus: dict[str, str] = {}
    for line in (ROOT / "data/eval/v4_role_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            corpus[json.loads(line)["query"]] = "v4_role_benchmark"
    for key, doc in pools.items():
        if doc.get("query"):
            corpus.setdefault(doc["query"], "residual_triage_pools")
    for f in ("stage3_semiconductor_benchmark.jsonl", "v3_search_benchmark.jsonl"):
        for line in (ROOT / "data/eval" / f).read_text(encoding="utf-8").splitlines():
            if line.strip():
                corpus.setdefault(json.loads(line)["query"], f)
    focus = json.loads((ROOT / "data/eval/stage3_1_focus_pools.json").read_text(encoding="utf-8"))
    fq = focus.get("queries", focus if isinstance(focus, list) else [])
    for q in fq:
        if isinstance(q, dict) and "query" in q:
            corpus.setdefault(q["query"], "stage3_1_focus_pools")

    pm_conf, em_conf = [], []
    for q, src in sorted(corpus.items()):
        i1, i2 = V1Intent(q), parse_intent(q)
        if not i2.material_subtypes:
            continue
        if (i1.processes or i1.equipment_subtypes) and not (i2.processes or i2.equipment_subtypes):
            if i1.processes and not i2.processes:
                pm_conf.append({"query": q, "source": src, "v1Processes": sorted(i1.processes)})
            elif i1.equipment_subtypes and not i2.equipment_subtypes:
                em_conf.append({"query": q, "source": src, "v1Equipment": sorted(i1.equipment_subtypes)})
    out["processVsMaterialConfusion"] = {"definition": "material-noun queries where v1 attached process semantics and v2 does not", "count": len(pm_conf), "cases": pm_conf}
    out["equipmentVsMaterialConfusion"] = {"definition": "material-noun queries where v1 attached equipment-subtype semantics and v2 does not", "count": len(em_conf), "cases": em_conf}

    # ---------------- pool-level grade shift (stability census) ----------------
    shift = {}
    for key, doc in pools.items():
        q = doc.get("query")
        if not q:
            continue
        c1 = Counter()
        c2 = Counter()
        for g in doc.get("candidates", []):
            code = g.get("code")
            if not code or code in AMBIGUOUS_CODES:
                continue
            g1 = V1_FRESH.get(q, {}).get(code)
            if g1 is not None:
                c1[g1] += 1
            g2, _ = grade_caps(parse_intent(q), company_caps(enrichment.get(code)))
            if g2 is not None:
                c2[g2] += 1
        shift[key] = {"query": q, "v1Dist": {str(k): v for k, v in sorted(c1.items())},
                      "v2Dist": {str(k): v for k, v in sorted(c2.items())}}
    out["triagePoolGradeShift"] = shift

    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({
        "labelAccuracy": out["labelAccuracy"]["overall"],
        "unaffected": {"v1": v1_acc_un, "v2": v2_acc_un, "n": n_un},
        "affected": {"v1": v1_acc_af, "v2": v2_acc_af, "n": n_af},
        "processVsMaterial": len(pm_conf), "equipmentVsMaterial": len(em_conf),
        "photoresistDirection": {e["query"]: e["directionPass"] for e in pr_pool},
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
