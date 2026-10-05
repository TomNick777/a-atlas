"""Build the frozen A-share Laya benchmark (TEST + VAL) from topic rules.

Every row carries the judgeText snapshot and a provenance block. Deterministic:
fixed seed, stable per-query subseeds, companies.json sha recorded in the manifest.

Usage: .venv/Scripts/python scripts/build_benchmark.py [--out-dir data/eval]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from laya_lab import data as ld
from laya_lab.topics import TEST_TOPICS, VAL_TOPICS

SEED = 20260923
TEACHER = ld.TEACHER
VERSION = ld.GENERATION_VERSION

# Topics whose None means "this company has no data for the queried dimension"
# and must be excluded, versus keyword topics where no-match is a derivable 0.
DIMENSIONAL = {
    "T-ATTR-OVERSEAS",
    "T-ATTR-EXPORTMFR",
    "T-ATTR-SOE",
    "T-COMBO-ROBOT-OVERSEAS",
    "T-COMBO-AUTOPART-EXPORT",
    "T-COMBO-CE-EXPORT",
    "V-ATTR-REGION-GD",
}

CAPS = {3: 6, 2: 3, 1: 4}  # per query, including curated entries
N_NEG = 5  # sampled level-0 rows per query


def subseed(text: str) -> int:
    return int.from_bytes(hashlib.sha256(text.encode()).digest()[:4], "big")


def label_company(topic: dict, c: dict) -> tuple[int, str] | None:
    """Final (level, evidence) for one company under one topic; None = excluded."""
    code = c["code"]
    curated = topic.get("curated") or {}
    if code in curated:
        entry = curated[code]
        return entry if entry else None
    result = topic["label"](c)
    if result is None:
        if topic["family"] in DIMENSIONAL:
            return None
        return 0, "资料未提及该业务"
    level, evidence = result
    if level is None:
        return None
    return int(level), evidence or "规则命中"


def select_rows(topic: dict, companies: dict[str, dict]) -> list[dict]:
    by_level: dict[int, list[dict]] = {3: [], 2: [], 1: [], 0: []}
    for code, c in companies.items():
        labeled = label_company(topic, c)
        if labeled is None:
            continue
        level, evidence = labeled
        by_level[level].append({"code": code, "name": c["name"], "evidence": evidence})

    curated_codes = set((topic.get("curated") or {}).keys())
    rows: list[dict] = []
    for level in (3, 2, 1):
        entries = by_level[level]
        curated_first = [e for e in entries if e["code"] in curated_codes]
        rest = sorted((e for e in entries if e["code"] not in curated_codes), key=lambda e: e["code"])
        take = curated_first + rest
        take = take[: CAPS[level]]
        rows.extend({**e, "level": level} for e in take)

    rng = random.Random(subseed(topic["family"]))
    neg_pool = [e for e in by_level[0] if e["code"] not in curated_codes]
    # 任何 split 的 curated 边界公司都不做随机负例,保留它们当 hard negative 的价值
    for e in rng.sample(neg_pool, min(N_NEG, len(neg_pool))):
        rows.append({**e, "level": 0})
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", default="data/eval")
    args = parser.parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    companies = ld.load_companies()
    print(f"companies: {len(companies)} sha={ld.companies_sha()}")

    manifest = {
        "generatedAt": "2026-09-23",
        "seed": SEED,
        "teacher": TEACHER,
        "generation_version": VERSION,
        "companies_sha256_16": ld.companies_sha(),
        "splits": {},
    }

    for split, topics in (("test", TEST_TOPICS), ("val", VAL_TOPICS)):
        queries, rows = [], []
        # 复用 select_rows 的逐题选择,保证同一 family 在所有问法下候选一致
        for topic in topics:
            selected = select_rows(topic, companies)
            for qi, query in enumerate(topic["queries"]):
                qid = f"{topic['family']}::q{qi}"
                queries.append(
                    {
                        "query_id": qid,
                        "family": topic["family"],
                        "category": topic["category"],
                        "split": split,
                        "query": query,
                        "teacher": TEACHER,
                        "generation_version": VERSION,
                    }
                )
                for entry in selected:
                    c = companies[entry["code"]]
                    rows.append(
                        {
                            "query_id": qid,
                            "family": topic["family"],
                            "category": topic["category"],
                            "query": query,
                            "code": entry["code"],
                            "name": entry["name"],
                            "label": entry["level"],
                            "evidence": entry["evidence"],
                            "judgeText": c.get("judgeText"),
                            "teacher": TEACHER,
                            "generation_version": VERSION,
                        }
                    )

        (out_dir / f"a_share_laya_{split}_queries.jsonl").write_text(
            "\n".join(json.dumps(q, ensure_ascii=False) for q in queries), encoding="utf-8"
        )
        # 规格要求的交付名:TEST 落在 a_share_laya_eval.jsonl
        rows_name = "a_share_laya_eval.jsonl" if split == "test" else f"a_share_laya_{split}.jsonl"
        (out_dir / rows_name).write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8"
        )
        counts = Counter(r["label"] for r in rows)
        manifest["splits"][split] = {
            "families": len({t["family"] for t in topics}),
            "queries": len(queries),
            "rows": len(rows),
            "label_dist": dict(sorted(counts.items())),
        }
        print(f"[{split}] families={manifest['splits'][split]['families']} queries={len(queries)} rows={len(rows)} dist={dict(sorted(counts.items()))}")

    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out_dir}/manifest.json")

    # review dump: 每个题的完整标签表,供 teacher 审阅规则是否真实
    with (out_dir / "review.txt").open("w", encoding="utf-8") as fh:
        for split, topics in (("test", TEST_TOPICS), ("val", VAL_TOPICS)):
            for topic in topics:
                fh.write(f"\n===== [{split}] {topic['family']} ({topic['category']}) =====\n")
                for query in topic["queries"]:
                    fh.write(f"  Q: {query}\n")
                by_level: dict[int, list[str]] = {3: [], 2: [], 1: [], 0: []}
                for code, c in companies.items():
                    labeled = label_company(topic, c)
                    if labeled is None:
                        continue
                    level, evidence = labeled
                    by_level[level].append(f"{code} {c['name']} — {evidence}")
                for level in (3, 2, 1, 0):
                    tag = {3: "正例(3)", 2: "部分(2)", 1: "沾边(1)", 0: "无关(0)"}[level]
                    entries = by_level[level]
                    shown = entries if level != 0 else entries[:8]
                    fh.write(f"  [{tag}] {len(entries)}\n")
                    for line in shown:
                        fh.write(f"      {line}\n")
    print(f"wrote {out_dir}/review.txt")


if __name__ == "__main__":
    main()
