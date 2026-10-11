"""Build V3 reranker training pairs: ranking-oriented data with hard negatives.

Composition (per audit reports/LAYA_V3_ROOT_CAUSE_AUDIT.md):
  1. TRAIN families (topics_train.py) — rule positives with RAISED graded caps,
     plus mined hard negatives: label-0 companies lexically closest to the query
     (the "same neighbourhood, wrong business" rows V2 never saw).
  2. Acceptance queries (Q01-Q20 texts, EV families) — rule positives (curated
     positives withheld: leak guard for the Phase H rerun) + rule hard-1 rows +
     the V2 blind-test mis-hits as labelled negatives (old rank/score preserved)
     + mined hard negatives. Disclosed as post-hoc for the acceptance rerun.
  3. CALIB absorb, as in V2.

Held-out EV paraphrase queries get NO training rows — they are the internal
ranking benchmark. Profiles: rows carry the production searchText (judgeText +
DERIVED tag line) the V3 reranker will actually read.

Usage: .venv/Scripts/python scripts/build_train_pairs_v3.py
"""

from __future__ import annotations

import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_benchmark import label_company, select_rows, subseed
from laya_lab import data as ld
from laya_lab.topics_train import CALIB_ABSORB, TRAIN_TOPICS
from laya_lab.topics_v3 import ACCEPTANCE_QUERIES, EV_FAMILIES

SEED = 20260923
OUT_DIR = Path("data/train")

CAPS_V3 = {3: 12, 2: 6, 1: 8}  # raised from {6,3,4}: graded depth matters for ranking
N_HARD_NEG = 8
N_RANDOM_NEG = 2
ACCEPT_REL3_CAP = 20


def bigrams(text: str) -> set[str]:
    han = [ch for ch in text if "\u3400" <= ch <= "\u9fff"]
    return {han[i] + han[i + 1] for i in range(len(han) - 1)} | set(han)


def query_sim(query: str, hay_text: str) -> float:
    q = bigrams(query)
    if not q:
        return 0.0
    d = bigrams(hay_text)
    return len(q & d) / len(q)


def hay_text(c: dict) -> str:
    return "|".join([c.get("businessDescription") or "", "、".join(p["name"] for p in (c.get("mainProducts") or []))])


_ONTOLOGY = json.loads((Path("data") / "search_ontology.json").read_text(encoding="utf-8"))


def domain_terms(query: str) -> list[str]:
    """Ontology vocab for the query's concept groups — mirrors lib/search/querySpec.ts."""
    out: set[str] = set()
    for rule in _ONTOLOGY["query_expansions"]:
        if re.search(rule["match"], query):
            for g in rule["concepts"]:
                out.update(_ONTOLOGY["concept_groups"].get(g, []))
    for group, terms in _ONTOLOGY["concept_groups"].items():
        if any(t in query for t in terms):
            out.update(terms)
    return sorted(out)


def mine_hard_negatives(query: str, by_level0: list[dict], companies: dict[str, dict], profiles: dict, cap_domain: int = 10, cap_lex: int = 4) -> list[dict]:
    """Two mining channels:
    (a) domain: label-0 companies whose profile text hits >=2 ontology terms of the
        query's concept groups — true neighbouring businesses (car-thermal for
        liquid-cooling, copper-processing for copper-resource).
    (b) lexical: label-0 companies with the highest query bigram overlap (name/word
        look-alikes). Kept as a smaller secondary channel."""
    terms = domain_terms(query)
    scored: list[tuple[int, float, dict]] = []
    for e in by_level0:
        text = profiles.get(e["code"], {}).get("searchText") or hay_text(companies[e["code"]])
        domain_hits = sum(1 for t in terms if re.search(t, text))
        lex = query_sim(query, hay_text(companies[e["code"]]))
        scored.append((domain_hits, lex, e))
    out: dict[str, dict] = {}
    for hits, _, e in sorted(scored, key=lambda r: (-r[0], -r[1])):
        if hits >= 2:
            out[e["code"]] = {**e, "level": 0, "source": "mined-domain", "evidence": f"hard negative:同域但主营不符({e['evidence'][:30]})"}
        if len(out) >= cap_domain:
            break
    for _, lex, e in sorted(scored, key=lambda r: -r[1]):
        if e["code"] in out:
            continue
        if lex <= 0:
            break
        out[e["code"]] = {**e, "level": 0, "source": "mined-lex", "evidence": f"hard negative:词面相近但主营不符({e['evidence'][:30]})"}
        if len(out) >= cap_domain + cap_lex:
            break
    return list(out.values())


def pick_rows(topic: dict, companies: dict[str, dict], profiles: dict) -> list[dict]:
    """Raised-cap graded rows + mined hard negatives for one TRAIN topic."""
    by_level: dict[int, list[dict]] = {3: [], 2: [], 1: [], 0: []}
    for code, c in companies.items():
        labeled = label_company(topic, c)
        if labeled is None:
            continue
        level, evidence = labeled
        by_level[int(level)].append({"code": code, "name": c["name"], "evidence": evidence})

    curated_codes = set((topic.get("curated") or {}).keys())
    rows: list[dict] = []
    for level in (3, 2, 1):
        entries = by_level[level]
        curated_first = [e for e in entries if e["code"] in curated_codes]
        rest = sorted((e for e in entries if e["code"] not in curated_codes), key=lambda e: e["code"])
        rows.extend({**e, "level": level} for e in (curated_first + rest)[: CAPS_V3[level]])

    rng = random.Random(subseed(topic["family"]))
    neg_pool = [e for e in by_level[0] if e["code"] not in curated_codes]
    for query in topic["queries"]:
        for e in mine_hard_negatives(query, neg_pool, companies, profiles):
            rows.append(dict(e))
        rest_pool = [e for e in neg_pool if e["code"] not in {r["code"] for r in rows if r.get("source", "").startswith("mined")}]
        for e in rng.sample(rest_pool, min(N_RANDOM_NEG, len(rest_pool))):
            rows.append({**e, "level": 0, "source": "random"})
    return rows


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    companies = ld.load_companies("train")
    profiles = json.loads((Path("data") / "search_profiles.json").read_text(encoding="utf-8"))
    print(f"train pool: {len(companies)} sha={ld.companies_sha('train')}")

    def search_text(code: str, c: dict) -> str:
        return profiles.get(code, {}).get("searchText") or c.get("judgeText") or ""

    queries_out: list[dict] = []
    rows_out: list[dict] = []

    def emit(qid: str, family: str, category: str, query: str, entries: list[dict], teacher: str, version: str) -> None:
        queries_out.append({"query_id": qid, "family": family, "category": category, "query": query, "teacher": teacher, "generation_version": version})
        for e in entries:
            c = companies[e["code"]]
            rows_out.append(
                {
                    "query_id": qid,
                    "family": family,
                    "category": category,
                    "query": query,
                    "code": e["code"],
                    "name": e["name"],
                    "label": int(e["level"]),
                    "evidence": e["evidence"],
                    "source": e.get("source", "rule"),
                    "old_rank": e.get("old_rank"),
                    "old_score": e.get("old_score"),
                    "profileText": search_text(e["code"], c),
                    "judgeText": c.get("judgeText"),
                    "teacher": teacher,
                    "generation_version": version,
                }
            )

    # ---- 1. TRAIN families (V2 pipeline, raised caps, mined hard negatives) ----
    for topic in TRAIN_TOPICS:
        selected = pick_rows(topic, companies, profiles)
        for qi, query in enumerate(topic["queries"]):
            emit(f"{topic['family']}::q{qi}", topic["family"], topic["category"], query, selected, ld.TEACHER, ld.GENERATION_VERSION + "-v3")

    # ---- 2. acceptance queries via EV families (mis-hits + rule rows) ----
    acceptance_raw = json.loads((Path("reports") / "acceptance" / "laya_real_search_acceptance_raw.json").read_text(encoding="utf-8"))
    mishits: dict[str, list[dict]] = {}
    for q in acceptance_raw["queries"]:
        mishits[q["query_text"]] = q["top20"]

    ev_by_query = {}
    for fam in EV_FAMILIES:
        for query in fam["queries"]:
            if query in ACCEPTANCE_QUERIES:
                ev_by_query[query] = fam

    n_mishit = 0
    for query, fam in sorted(ev_by_query.items(), key=lambda kv: kv[1]["family"]):
        if fam.get("external_only"):
            continue  # Q12 苹果链:档案无客户字段,只有 EXTERNAL curated —— 全留给外部裁判
        by_level: dict[int, list[dict]] = {0: [], 1: [], 2: [], 3: []}
        for code, c in companies.items():
            labeled = label_company(fam, c)
            if labeled is None:
                continue
            level, evidence = labeled
            by_level[int(level)].append({"code": code, "name": c["name"], "evidence": evidence})

        curated = fam.get("curated") or {}
        entries: list[dict] = []
        # curated 0(HARDNEG/查询排除)直接成为训练行 —— 它们正是对比数据的核心
        for code, entry in sorted(curated.items()):
            if entry and entry[0] == 0 and code in companies:
                entries.append({"code": code, "name": companies[code]["name"], "level": 0, "evidence": entry[1], "source": "curated-neg"})
        # curated positives withheld (leak guard); rule positives only
        for level in (3, 2):
            entries.extend({**e, "level": level, "source": "rule"} for e in sorted(by_level[level], key=lambda r: r["code"])[: ACCEPT_REL3_CAP] if e["code"] not in curated)
        entries.extend({**e, "level": 1, "source": "rule"} for e in sorted(by_level[1], key=lambda r: r["code"])[:6])
        # V2 blind-test mis-hits: top20 rows that the rule scores 0/1
        for row in mishits.get(query, []):
            code = row["company_code"]
            if code not in companies:
                continue
            labeled = label_company(fam, companies[code])
            if labeled is None:
                continue
            level, evidence = labeled
            if level >= 2:
                continue
            entries.append(
                {
                    "code": code,
                    "name": row["company_name"],
                    "level": 0 if level == 0 else 1,
                    "evidence": f"V2盲测误命中(top{row['rank']});规则判{level}:{evidence[:40]}",
                    "source": "acceptance-mishit",
                    "old_rank": row["rank"],
                    "old_score": row["laya_score"],
                }
            )
            n_mishit += 1
        # mined hard negatives for the acceptance query too
        neg_pool = [e for e in by_level[0] if e["code"] not in curated]
        entries.extend(mine_hard_negatives(query, neg_pool, companies, profiles))

        qid = f"{fam['family']}::acc::{ACCEPTANCE_QUERIES[query]}"
        emit(qid, fam["family"], fam["category"], query, entries, "GLM-5.3-Flash + V2-acceptance-mishits", ld.GENERATION_VERSION + "-v3-acc")

    # ---- 3. calib absorb (unchanged from V2) ----
    calib_rows = json.loads((Path("data/raw") / "laya_calib.json").read_text(encoding="utf-8"))
    by_query: dict[str, list[dict]] = {}
    for r in calib_rows:
        by_query.setdefault(r["query"], []).append(r)
    absorbed = 0
    for query, fam in CALIB_ABSORB.items():
        group = by_query.get(query)
        if not group:
            continue
        entries = []
        for r in group:
            c = companies.get(r["code"])
            if not c:
                continue
            entries.append(
                {
                    "code": r["code"],
                    "name": r["name"],
                    "level": 3 if r["label"] == 1 else 0,
                    "evidence": "验收标注(二值):" + (r.get("judgeText") or "")[:60],
                    "source": "calib",
                }
            )
            absorbed += 1
        emit(f"{fam}::calib", fam, "验收吸收", query, entries, "acceptance-calib-2026-09", "2026-09-calib")

    (OUT_DIR / "v3_train_queries.jsonl").write_text("\n".join(json.dumps(q, ensure_ascii=False) for q in queries_out), encoding="utf-8")
    (OUT_DIR / "v3_train_pairs.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows_out), encoding="utf-8")

    manifest = {
        "seed": SEED,
        "teacher": ld.TEACHER,
        "generation_version": ld.GENERATION_VERSION + "-v3",
        "train_pool_sha256_16": ld.companies_sha("train"),
        "families": len({r["family"] for r in rows_out}),
        "queries": len(queries_out),
        "pairs": len(rows_out),
        "acceptance_mishit_rows": n_mishit,
        "absorbed_calib_rows": absorbed,
        "label_dist": dict(sorted(Counter(r["label"] for r in rows_out).items())),
        "source_dist": dict(sorted(Counter(r["source"] for r in rows_out).items())),
        "isolation_note": "EV held-out paraphrase 查询零训练行;acceptance 文本行按规格吸收(Phase H 复跑按 post-hoc 披露);curated 正例不进训练",
    }
    (OUT_DIR / "v3_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
