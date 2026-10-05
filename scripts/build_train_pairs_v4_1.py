"""Build V4.1 prior-correction training pairs (LAYA_V4_1 spec §七/§九–§十五/§十八).

Base inheritance (§二/§十八): ALL 7923 V4 role-aware rows are inherited verbatim
— the acquired role-aware ranking must not be washed out. On top, correction
layers ordered by evidence strength:

  C0 model-mined prior failures (§七 P0)
       data/train/v4_1_prior_negatives.jsonl — (query, company) pairs the V4
       checkpoint actually scored >=1.5 where frozen evidence says mismatch.
       targetGrade + reason come from the cross-domain grader.
  C1 anchor x cross-domain contrast (§七 P1, §十四 query-conditioned)
       every TRAIN_XDOM surface x each of the 12 anchors, graded by the
       deterministic cross-domain grader (grade-0 expected; grade-1
       WEAK_ASSOCIATION_ONLY kept; >=2 skipped as genuine answers). Together
       with the inherited V4 rows this realizes the contrast "same profile is
       1-3 under its domain queries, 0 under these".
  C2 supply-chain breadth (§七 P2, de-celebritization)
       non-anchor enriched (capped) companies under the same surfaces — the
       boundary must attach to the capability-profile population, not to
       famous names (root cause audit B2: the trigger is the profile, not
       identity).
  C3 cross-domain domain boundary (§七 P2/P3)
       per train domain: grade-3 core companies (positives, capped), grade-1
       weak rows, and BETWEEN-non-semi-domains negatives (白酒 x 铜加工 → 0) so
       the model cannot collapse into "unknown query domain → 0".

Caps (§十一): per-company grade>=2 correction cap 4, per-company total
correction cap 16, per-query cap 12, per-domain symmetric caps. AMBIGUOUS
companies excluded everywhere. Variants: A = C0+C1 (light), B = C0+C1+C2+C3
(strong); C = B + dropout applied at itemization time (name p=0.3, 标签段
p=0.25, 应用段 p=0.15 — 工艺/主营/产品 never dropped, §十二/§十三).

Isolation: new texts must be disjoint from V4 role VAL/TEST and from the frozen
V4.1 held-out texts (VAL-B/TEST-B/SET C) — isolation_check_v41; zero-touch
domains (agriculture/grid/gold/airline/coal/securities) get NO train rows.

Usage: .venv/Scripts/python scripts/build_train_pairs_v4_1.py
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_1_cross_domain import (  # noqa: E402
    ANCHOR_CODES,
    FAMILIES,
    TRAIN_XDOM_QUERIES,
    ZERO_TOUCH_DOMAINS,
    company_evidence,
    grade_cross_domain,
    isolation_check_v41,
)
from laya_v4_roles import AMBIGUOUS_CODES, company_caps, load_enrichment  # noqa: E402

SEED = 20260925
TEACHER = "GLM-5.3-Flash (ZCode agent, in-context)"
GENERATION_VERSION = "2026-09-25-v1-v4.1"

V4_PAIRS = ROOT / "data/train/v4_train_pairs.jsonl"
PRIOR_QUEUE = ROOT / "data/train/v4_1_prior_negatives.jsonl"

# caps (§十一) — grade-0 correction mass is the FIX, so the total cap is set
# generously while the POSITIVE cap stays tight (prior came from positive
# concentration, not from negatives)
C0_PER_COMPANY_CAP = 4
C0_PER_QUERY_CAP = 8
C1_PER_DOMAIN_SAMPLE = 12          # anchors <= 12 -> every anchor covers >= 8 domains
C2_PER_QUERY_SAMPLE = 6
C2_PER_COMPANY_CAP = 3
C3_POS_PER_DOMAIN = 8
C3_WEAK_PER_DOMAIN = 3
C3_NEG_PER_DOMAIN = 4
C3_POS_PER_COMPANY_CAP = 2
CORRECTION_COMPANY_TOTAL_CAP = 28  # ~ C1(24) + C0(4); positive cap below is the binding guard
CORRECTION_COMPANY_POS_CAP = 4
CORRECTION_PER_QUERY_CAP = 28      # ceiling guard (C1 12 + C2 6 + C3 <= 15 fit)


def load_profiles() -> dict:
    return json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))


def companies_doc() -> dict:
    return {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}


def make_row(qid: str, family: str, category: str, query: str, code: str, name: str,
             label: int, reason: str, evidence: str, source: str, profiles: dict, c: dict) -> dict:
    return {
        "query_id": qid, "family": family, "category": category, "query": query,
        "code": code, "name": name, "label": int(label),
        "reason": reason,  # DOMAIN_MISMATCH / WEAK_ASSOCIATION_ONLY / DOMAIN_CORE (§十)
        "evidence": evidence[:220],
        "source": source, "profileText": profiles.get(code, {}).get("searchText") or c.get("judgeText") or "",
        "judgeText": c.get("judgeText"), "teacher": TEACHER, "generation_version": GENERATION_VERSION,
    }


def main() -> None:
    rng = random.Random(SEED)
    enrichment = load_enrichment()
    profiles = load_profiles()
    companies = companies_doc()
    train_domains = {t["domain"] for t in TRAIN_XDOM_QUERIES}
    assert not (train_domains & set(ZERO_TOUCH_DOMAINS)), "zero-touch domain leaked into train families"
    assert set(FAMILIES) >= train_domains

    correction: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(row: dict) -> bool:
        key = (row["query"], row["code"])
        if key in seen or row["code"] in AMBIGUOUS_CODES:
            return False
        seen.add(key)
        correction.append(row)
        return True

    dom_of_surface = {q: t["domain"] for t in TRAIN_XDOM_QUERIES for q in t["queries"]}
    fam_of_surface = {q: t["family"] for t in TRAIN_XDOM_QUERIES for q in t["queries"]}
    surfaces = sorted(dom_of_surface)

    def qid_of(query: str, tag: str = "") -> str:
        return f"{fam_of_surface[query]}::{tag}{surfaces.index(query)}"

    # ---------------- C0: model-mined prior failures ----------------
    c0 = 0
    per_c0: Counter = Counter()
    for line in PRIOR_QUEUE.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if per_c0[r["companyCode"]] >= C0_PER_COMPANY_CAP or c0 >= C0_PER_QUERY_CAP * 40:
            continue
        if r["companyCode"] not in companies:
            continue
        if add(make_row(f"V41-MINED::{r['query'][:20]}", "V41-MINED", "v41-mined-prior",
                        r["query"], r["companyCode"], companies[r["companyCode"]]["name"],
                        r["targetGrade"], r["reason"].upper(),
                        f"mined-prior:v4score={r['v4Score']}|v4rank={r['v4Rank']}|{r['origin']}|{'+'.join(r['tags'])}",
                        "v41-mined-prior", profiles, companies[r["companyCode"]])):
            per_c0[r["companyCode"]] += 1
            c0 += 1

    # ---------------- C1: anchor x cross-domain contrast ----------------
    c1 = 0
    anchor_domain_cover: defaultdict[str, set] = defaultdict(set)
    for query in surfaces:
        domain = dom_of_surface[query]
        for code in ANCHOR_CODES:
            if code not in companies:
                continue
            ind_fields, prof = company_evidence(code, companies, profiles)
            grade, reason = grade_cross_domain(domain, ind_fields, prof)
            if grade >= 2:
                continue  # anchor genuinely answers this domain (立昂微x光伏 shape)
            label_reason = "DOMAIN_MISMATCH" if grade == 0 else "WEAK_ASSOCIATION_ONLY"
            if add(make_row(qid_of(query, "c1"), fam_of_surface[query], "v41-anchor-contrast",
                            query, code, companies[code]["name"], grade, label_reason,
                            f"anchor-contrast:domain={domain}|roles={enrichment.get(code, {}).get('roles')}",
                            "v41-anchor-contrast", profiles, companies[code])):
                c1 += 1
                anchor_domain_cover[code].add(domain)

    # ---------------- C2: supply-chain breadth (non-anchor enriched) ----------------
    c2 = 0
    per_c2: Counter = Counter()
    for query in surfaces:
        domain = dom_of_surface[query]
        cand = []
        for code, rec in enrichment.items():
            if code in AMBIGUOUS_CODES or code in ANCHOR_CODES or not company_caps(rec):
                continue
            if per_c2[code] >= C2_PER_COMPANY_CAP:
                continue
            ind_fields, prof = company_evidence(code, companies, profiles)
            grade, reason = grade_cross_domain(domain, ind_fields, prof)
            if grade >= 2:
                continue
            cand.append((grade, code, reason))
        rng.shuffle(cand)
        got = 0
        for grade, code, reason in cand:
            if got >= C2_PER_QUERY_SAMPLE:
                break
            label_reason = "DOMAIN_MISMATCH" if grade == 0 else "WEAK_ASSOCIATION_ONLY"
            if add(make_row(qid_of(query, "c2"), fam_of_surface[query], "v41-breadth",
                            query, code, companies[code]["name"], grade, label_reason,
                            f"breadth:domain={domain}|caps={len(company_caps(enrichment.get(code)))}",
                            "v41-breadth", profiles, companies[code])):
                per_c2[code] += 1
                got += 1
                c2 += 1

    # ---------------- C3: domain boundary (positives + weak + between-domain negs) ----------------
    c3 = 0
    per_c3_pos: Counter = Counter()
    for t in TRAIN_XDOM_QUERIES:
        domain = t["domain"]
        pos_query, side_query = t["queries"][0], t["queries"][-1]
        g3, g1, g0 = [], [], []
        for code, c in companies.items():
            if code in AMBIGUOUS_CODES:
                continue
            ind_fields, prof = company_evidence(code, companies, profiles)
            grade, reason = grade_cross_domain(domain, ind_fields, prof)
            if grade == 3 and code not in enrichment:
                g3.append(code)
            elif grade == 1 and code not in enrichment:
                g1.append(code)
            elif grade == 0 and code not in enrichment and code not in ANCHOR_CODES:
                g0.append(code)
        rng.shuffle(g3), rng.shuffle(g1), rng.shuffle(g0)
        for code in g3[:C3_POS_PER_DOMAIN]:
            if per_c3_pos[code] >= C3_POS_PER_COMPANY_CAP:
                continue
            if add(make_row(qid_of(pos_query, "c3"), t["family"], "v41-domain-core", pos_query, code,
                            companies[code]["name"], 3, "DOMAIN_CORE",
                            f"domain-core:domain={domain}|industry+profile evidence", "v41-domain-core",
                            profiles, companies[code])):
                per_c3_pos[code] += 1
                c3 += 1
        for code in g1[:C3_WEAK_PER_DOMAIN]:
            if add(make_row(qid_of(side_query, "c3"), t["family"], "v41-weak-assoc", side_query, code,
                            companies[code]["name"], 1, "WEAK_ASSOCIATION_ONLY",
                            f"weak-assoc:domain={domain}|profile mention without industry gate", "v41-weak-assoc",
                            profiles, companies[code])):
                c3 += 1
        for code in g0[:C3_NEG_PER_DOMAIN]:
            if add(make_row(qid_of(side_query, "c3"), t["family"], "v41-domain-neg", side_query, code,
                            companies[code]["name"], 0, "DOMAIN_MISMATCH",
                            f"domain-neg:domain={domain}|other-domain company", "v41-domain-neg",
                            profiles, companies[code])):
                c3 += 1

    # ---------------- caps over correction rows (§十一) ----------------
    demoted = []
    keep = []
    per_total: Counter = Counter()
    per_pos: Counter = Counter()
    # order: C0 (V4-verified) wins, then C1 (anchor contrast), then C2/C3
    priority = {"v41-mined-prior": 0, "v41-anchor-contrast": 1, "v41-breadth": 2,
                "v41-domain-core": 3, "v41-weak-assoc": 3, "v41-domain-neg": 3}
    correction.sort(key=lambda r: priority[r["source"]])
    for r in correction:
        code = r["code"]
        if per_total[code] >= CORRECTION_COMPANY_TOTAL_CAP or per_q_count(correction, keep, r["query"]) >= CORRECTION_PER_QUERY_CAP:
            demoted.append(r)
            continue
        if r["label"] >= 2 and per_pos[code] >= CORRECTION_COMPANY_POS_CAP:
            demoted.append(r)
            continue
        per_total[code] += 1
        if r["label"] >= 2:
            per_pos[code] += 1
        keep.append(r)
    correction = keep

    # ---------------- variants ----------------
    c0_rows = [r for r in correction if r["source"] == "v41-mined-prior"]
    c1_rows = [r for r in correction if r["source"] == "v41-anchor-contrast"]
    rest_rows = [r for r in correction if r["source"] in ("v41-breadth", "v41-domain-core", "v41-weak-assoc", "v41-domain-neg")]
    variant_rows = {
        "A": c0_rows + c1_rows,
        "B": c0_rows + c1_rows + rest_rows,
    }

    base_rows = [json.loads(l) for l in V4_PAIRS.read_text(encoding="utf-8").splitlines() if l.strip()]
    base_texts = {r["query"] for r in base_rows}
    base_pair_keys = {(r["query"], r["code"]) for r in base_rows}
    for variant, corr in list(variant_rows.items()):
        clash = [r for r in corr if (r["query"], r["code"]) in base_pair_keys]
        if clash:
            print(f"variant {variant}: dropping {len(clash)} correction rows already covered by inherited base pairs")
            variant_rows[variant] = [r for r in corr if (r["query"], r["code"]) not in base_pair_keys]
    variant_rows = {v: c for v, c in variant_rows.items()}

    # ---------------- isolation ----------------
    all_new_texts = {r["query"] for r in correction} | {t["queries"][0] for t in TRAIN_XDOM_QUERIES} | {q for t in TRAIN_XDOM_QUERIES for q in t["queries"]}
    violations = isolation_check_v41(all_new_texts | base_texts)
    if violations:
        for v in violations:
            print("ISOLATION VIOLATION:", v)
        raise SystemExit("V4.1 isolation failed — refusing to write training data")

    manifests = {}
    for variant, corr in variant_rows.items():
        rows = base_rows + corr
        rows.sort(key=lambda r: (r["query_id"], r["code"]))
        out_pairs = ROOT / f"data/train/v4_1_train_pairs_{variant}.jsonl"
        out_pairs.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

        semi_q = sum(1 for r in corr if any(m in r["query"] for m in ("半导体", "晶圆", "芯片", "ALD", "PVD", "CVD", "刻蚀", "CMP", "前驱体", "靶材", "光刻胶")))
        manifest = {
            "seed": SEED,
            "teacher": TEACHER,
            "generation_version": GENERATION_VERSION,
            "base_inherited": {"file": "data/train/v4_train_pairs.jsonl", "rows": len(base_rows)},
            "correction_rows": len(corr),
            "correction_share": round(len(corr) / len(rows), 4),
            "correction_layers": {
                "C0_mined_prior": sum(1 for r in corr if r["source"] == "v41-mined-prior"),
                "C1_anchor_contrast": sum(1 for r in corr if r["source"] == "v41-anchor-contrast"),
                "C2_breadth": sum(1 for r in corr if r["source"] == "v41-breadth"),
                "C3_boundary": sum(1 for r in corr if r["source"] in ("v41-domain-core", "v41-weak-assoc", "v41-domain-neg")),
            },
            "correction_label_dist": dict(sorted(Counter(r["label"] for r in corr).items())),
            "correction_reason_dist": dict(sorted(Counter(r["reason"] for r in corr).items())),
            "correction_domain_dist": dict(sorted(Counter(dom_of_surface.get(r["query"], "mined-ev-log") for r in corr).items())),
            "anchor_domain_coverage": {companies[a]["name"]: len(anchor_domain_cover.get(a, set())) for a in ANCHOR_CODES},
            "caps": {"company_total": CORRECTION_COMPANY_TOTAL_CAP, "company_positive": CORRECTION_COMPANY_POS_CAP,
                     "per_query": CORRECTION_PER_QUERY_CAP, "rows_dropped_by_caps": len(demoted)},
            "top_correction_companies": [[companies[c]["name"], n] for c, n in Counter(r["code"] for r in corr).most_common(12)],
            "correction_rows_on_semi_queries": semi_q,
            "train_total": len(rows),
            "train_label_dist": dict(sorted(Counter(r["label"] for r in rows).items())),
            "isolation": "TRAIN(new+inherited) vs V4 role VAL/TEST + V41 VAL-B/TEST-B/SET-C disjoint (isolation_check_v41); AMBIGUOUS excluded; zero-touch domains carry no train rows",
        }
        (ROOT / f"data/train/v4_1_manifest_{variant}.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        manifests[variant] = manifest
        print(f"variant {variant}: total={len(rows)} correction={len(corr)} ({manifest['correction_share']:.1%})")
    (ROOT / "data/train/v4_1_manifest.json").write_text(json.dumps(manifests, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk in ("train_total", "correction_rows", "correction_share", "correction_layers", "correction_label_dist")} for k, v in manifests.items()}, ensure_ascii=False, indent=1))


def per_q_count(all_rows: list[dict], kept: list[dict], query: str) -> int:
    return sum(1 for r in kept if r["query"] == query)


if __name__ == "__main__":
    main()
