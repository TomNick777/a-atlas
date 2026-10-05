"""Build V4 role-aware reranker training pairs (spec §6/§8/§12/§13/§15).

Composition, in priority order:
  P0 model-mined errors  — data/train/v4_candidate_queue.jsonl rows the miner
        tagged HARD_POSITIVE / HARD_NEGATIVE / ROLE_INVERSION (facts validated by
        the deterministic grader or frozen truth; AMBIGUOUS/CANDIDATE_UNVERIFIED
        never enter).
  P1 role contrast       — synthetic graded rows for TRAIN_ROLE_QUERIES: every
        company the grader can grade from Stage 3.1 facts, so the same company
        lands at different grades under different role queries (query-relative,
        §13) and same-process-wrong-role lands at 1 (§12).
  P2 inherited V3 data   — v3_train_pairs.jsonl, subsampled so the old mix cannot
        drown the role-aware rows (mishits/calib/curated/mined-domain kept whole;
        mined-lex and rule rows thinned).
  P3 random negatives    — small on purpose (spec §6: no more 茅台-vs-半导体 diet).

Guards: per-company row caps + per-company grade-3 caps (§15), (query, code)
dedup, family isolation against VAL/TEST/EV texts (§17), manifest with all
distributions for the final report (§37).

Usage: .venv/Scripts/python scripts/build_train_pairs_v4.py
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_query_sets import (  # noqa: E402
    TRAIN_ROLE_QUERIES,
    all_train_queries,
    isolation_check,
)
from laya_v4_roles import (  # noqa: E402
    AMBIGUOUS_CODES,
    company_caps,
    grade_caps,
    load_enrichment,
    parse_intent,
)

SEED = 20260924
TEACHER = "GLM-5.3-Flash (ZCode agent, in-context)"
GENERATION_VERSION = "2026-09-24-v1-v4"

QUEUE = ROOT / "data/train/v4_candidate_queue.jsonl"
V3_PAIRS = ROOT / "data/train/v3_train_pairs.jsonl"
OUT_PAIRS = ROOT / "data/train/v4_train_pairs.jsonl"
OUT_QUERIES = ROOT / "data/train/v4_train_queries.jsonl"
OUT_MANIFEST = ROOT / "data/train/v4_manifest.json"

# caps (§15)
P0_PER_QUERY_CAP = 12
P0_PER_COMPANY_CAP = 6
P1_GRADE0_SAMPLE = 12
P2_KEEP_SOURCES = {"acceptance-mishit", "calib", "curated-neg", "mined-domain"}
P2_SUBSAMPLE = {"mined-lex": 800, "rule": 1200, "random": 150}
COMPANY_TOTAL_CAP = 40
COMPANY_GRADE3_CAP = 20
P3_PER_QUERY = 2
P3_QUERIES = 40


def load_profiles() -> dict:
    return json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))


def companies_doc() -> dict:
    return {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}


def make_row(qid: str, family: str, category: str, query: str, code: str, name: str,
             label: int, evidence: str, source: str, profiles: dict, c: dict) -> dict:
    return {
        "query_id": qid, "family": family, "category": category, "query": query,
        "code": code, "name": name, "label": int(label), "evidence": evidence[:220],
        "source": source, "profileText": profiles.get(code, {}).get("searchText") or c.get("judgeText") or "",
        "judgeText": c.get("judgeText"), "teacher": TEACHER, "generation_version": GENERATION_VERSION,
    }


def main() -> None:
    rng = random.Random(SEED)
    enrichment = load_enrichment()
    profiles = load_profiles()
    companies = companies_doc()

    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(row: dict) -> bool:
        key = (row["query"], row["code"])
        if key in seen or row["code"] in AMBIGUOUS_CODES:
            return False
        seen.add(key)
        rows.append(row)
        return True

    # ---------------- P1 synthetic role contrast ----------------
    p1 = 0
    for topic in TRAIN_ROLE_QUERIES:
        for qi, query in enumerate(topic["queries"]):
            qid = f"{topic['family']}::q{qi}"
            intent = parse_intent(query)
            if not intent.gradeable:
                raise SystemExit(f"TRAIN query not role-expressive: {query}")
            graded: list[tuple[int, str, str]] = []  # (grade, code, reason)
            for code, rec in enrichment.items():
                if code in AMBIGUOUS_CODES:
                    continue
                grade, reason = grade_caps(intent, company_caps(rec))
                if grade is not None:
                    graded.append((grade, code, reason))
            grade0 = [g for g in graded if g[0] == 0]
            keep0 = set(code for _, code, _ in rng.sample(grade0, min(P1_GRADE0_SAMPLE, len(grade0))))
            for grade, code, reason in graded:
                if grade == 0 and code not in keep0:
                    continue
                if code not in companies:
                    continue
                label = grade
                ev = f"role-logic:{reason}|roles={enrichment[code].get('roles')}"
                if add(make_row(qid, topic["family"], "v4-role-contrast", query, code,
                                companies[code]["name"], label, ev, "v4-synthetic",
                                profiles, companies[code])):
                    p1 += 1

    # ---------------- P0 mined errors from the queue ----------------
    p0 = 0
    p0_origin: Counter = Counter()
    per_q: Counter = Counter()
    per_c: Counter = Counter()
    priority = {"ROLE_INVERSION": 0, "HARD_NEGATIVE": 1, "HARD_POSITIVE": 2}
    queue = [json.loads(l) for l in QUEUE.read_text(encoding="utf-8").splitlines() if l.strip()]
    queue = [r for r in queue if r["reason"] in priority and not r.get("needsValidation")]
    queue.sort(key=lambda r: (priority[r["reason"]], -(r["v3"]["grade"] or 0)))
    qid_map = {}
    for r in queue:
        q = r["query"]
        if q not in qid_map:
            qid_map[q] = f"V4-MINED::{len(qid_map)}"
        qid = qid_map[q]
        if per_q[qid] >= P0_PER_QUERY_CAP or per_c[r["companyCode"]] >= P0_PER_COMPANY_CAP:
            continue
        code = r["companyCode"]
        if code not in companies:
            continue
        label = r["targetGrade"]
        if label is None:
            continue
        ev = f"mined:{r['reason']}|v3grade={r['v3']['grade']}|v3rank={r['v3']['rank']}|{r['origin']}"
        if add(make_row(qid, "V4-MINED", "v4-mined", q, code, companies[code]["name"],
                        label, ev, f"v4-mined:{r['reason']}", profiles, companies[code])):
            per_q[qid] += 1
            per_c[code] += 1
            p0 += 1
            p0_origin[r["origin"]] += 1

    # ---------------- P2 inherited V3 rows (subsampled) ----------------
    p2 = 0
    p2_by_source: Counter = Counter()
    v3_rows = [json.loads(l) for l in V3_PAIRS.read_text(encoding="utf-8").splitlines() if l.strip()]
    rng.shuffle(v3_rows)
    for r in v3_rows:
        src = r.get("source", "rule")
        if src in P2_KEEP_SOURCES:
            keep = True
        elif src in P2_SUBSAMPLE:
            keep = p2_by_source[src] < P2_SUBSAMPLE[src]
        else:
            keep = False
        if not keep:
            continue
        p2_by_source[src] += 1
        if add(make_row(f"{r['query_id']}::p2", f"p2-{r['family']}", "v3-inherit", r["query"],
                        r["code"], r["name"], r["label"], "v3-inherit:" + (r.get("evidence") or ""),
                        f"v3:{src}", profiles, companies.get(r["code"], {}))):
            p2 += 1

    # ---------------- P3 small random negatives ----------------
    p3 = 0
    train_queries = all_train_queries()
    for topic in rng.sample(TRAIN_ROLE_QUERIES, min(P3_QUERIES, len(TRAIN_ROLE_QUERIES))):
        query = topic["queries"][0]
        qid = f"{topic['family']}::rnd"
        picks = rng.sample(sorted(companies), P3_PER_QUERY + 4)
        got = 0
        for code in picks:
            if code in AMBIGUOUS_CODES or code in enrichment:
                continue  # enriched companies are already graded; P3 = truly unrelated
            if got >= P3_PER_QUERY:
                break
            if add(make_row(qid, topic["family"], "v4-random", query, code,
                            companies[code]["name"], 0, "random-negative:与查询领域无证据关联",
                            "v4-random", profiles, companies[code])):
                got += 1
                p3 += 1

    # ---------------- company prior caps (§15) ----------------
    demoted = []
    keep_rows = []
    per_code_total: Counter = Counter()
    per_code_g3: Counter = Counter()
    for r in rows:  # rows are P1→P0→P2→P3 ordered; P1/P0 win over inherited rows
        code = r["code"]
        if per_code_total[code] >= COMPANY_TOTAL_CAP:
            demoted.append(r)
            continue
        if r["label"] == 3 and per_code_g3[code] >= COMPANY_GRADE3_CAP:
            demoted.append(r)
            continue
        per_code_total[code] += 1
        if r["label"] == 3:
            per_code_g3[code] += 1
        keep_rows.append(r)
    rows = keep_rows
    by_company = Counter(r["code"] for r in rows)
    g3_by_company = Counter(r["code"] for r in rows if r["label"] == 3)
    top_companies = by_company.most_common(12)
    train_texts = {r["query"] for r in rows} | {q["query"] for q in all_train_queries()}
    violations = isolation_check(train_texts)
    if violations:
        for v in violations:
            print("ISOLATION VIOLATION:", v)
        raise SystemExit("family isolation failed — refusing to write training data")

    rows.sort(key=lambda r: (r["query_id"], r["code"]))
    (OUT_PAIRS).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    query_rows = []
    for r in rows:
        if not query_rows or query_rows[-1]["query_id"] != r["query_id"]:
            query_rows.append({"query_id": r["query_id"], "family": r["family"], "category": r["category"], "query": r["query"]})
    (OUT_QUERIES).write_text("\n".join(json.dumps(q, ensure_ascii=False) for q in query_rows) + "\n", encoding="utf-8")

    manifest = {
        "seed": SEED,
        "teacher": TEACHER,
        "generation_version": GENERATION_VERSION,
        "train_pool_sha256_16": "0ce8e558d16900a9",
        "profiles": "data/search_profiles_v3.json (frozen, d1908e94449341d6)",
        "enrichment": "stage3.1-semiconductor-v1 / s3-derive-v2 (frozen)",
        "families": len({r["family"] for r in rows}),
        "queries": len(query_rows),
        "pairs": len(rows),
        "origin_pairs": {"P0_mined": p0, "P1_synthetic_role_contrast": p1, "P2_v3_inherited": p2, "P3_random": p3,
                         "P0_source_split": dict(p0_origin)},
        "label_dist": dict(sorted(Counter(r["label"] for r in rows).items())),
        "source_dist": dict(sorted(Counter(r["source"] for r in rows).items())),
        "category_dist": dict(sorted(Counter(r["category"] for r in rows).items())),
        "p2_subsampled": dict(p2_by_source),
        "company_total_cap": COMPANY_TOTAL_CAP,
        "company_grade3_cap": COMPANY_GRADE3_CAP,
        "rows_dropped_by_caps": len(demoted),
        "top_companies_by_rows": [[companies[c]["name"], n] for c, n in top_companies],
        "isolation": "TRAIN/VAL/TEST/EV query texts disjoint (laya_v4_query_sets.isolation_check); AMBIGUOUS 23家 excluded",
    }
    (OUT_MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
