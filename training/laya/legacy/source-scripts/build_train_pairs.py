"""Build TRAIN pairs (query × company × label) from TRAIN_TOPICS + absorbed calib.

TEST/VAL stay frozen (built from the 1464-company test snapshot); training pairs
draw from the full A-share snapshot for diversity. Deterministic: SEED + per-family
subseeds. Every row embeds the judgeText the model will see and a provenance block.

Usage: .venv/Scripts/python scripts/build_train_pairs.py
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_benchmark import label_company, select_rows, CAPS, N_NEG, subseed
from laya_lab import data as ld
from laya_lab.topics_train import CALIB_ABSORB, TRAIN_TOPICS

SEED = 20260923
OUT_DIR = Path("data/train")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    companies = ld.load_companies("train")
    print(f"train pool: {len(companies)} sha={ld.companies_sha('train')}")

    queries_out: list[dict] = []
    rows_out: list[dict] = []

    for topic in TRAIN_TOPICS:
        selected = select_rows(topic, companies)
        for qi, query in enumerate(topic["queries"]):
            qid = f"{topic['family']}::q{qi}"
            queries_out.append(
                {
                    "query_id": qid,
                    "family": topic["family"],
                    "category": topic["category"],
                    "query": query,
                    "teacher": ld.TEACHER,
                    "generation_version": ld.GENERATION_VERSION,
                }
            )
            for entry in selected:
                c = companies[entry["code"]]
                rows_out.append(
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
                        "teacher": ld.TEACHER,
                        "generation_version": ld.GENERATION_VERSION,
                    }
                )

    # 吸收 2026-09 验收校准集(二值标签 1→3, 0→0;旧 judgeText 保留)。
    calib_rows = json.loads((Path("data/raw/laya_calib.json")).read_text(encoding="utf-8"))
    by_query: dict[str, list[dict]] = {}
    for r in calib_rows:
        by_query.setdefault(r["query"], []).append(r)
    absorbed = 0
    for query, fam in CALIB_ABSORB.items():
        group = by_query.get(query)
        if not group:
            continue
        qid = f"{fam}::calib"
        queries_out.append(
            {
                "query_id": qid,
                "family": fam,
                "category": "验收吸收",
                "query": query,
                "teacher": "acceptance-calib-2026-09 (previous acceptance round)",
                "generation_version": "2026-09-calib",
            }
        )
        for r in group:
            c = companies.get(r["code"])
            rows_out.append(
                {
                    "query_id": qid,
                    "family": fam,
                    "category": "验收吸收",
                    "query": query,
                    "code": r["code"],
                    "name": r["name"],
                    "label": 3 if r["label"] == 1 else 0,
                    "evidence": "验收标注(二值):" + (r.get("judgeText") or "")[:60],
                    "judgeText": r.get("judgeText"),
                    "teacher": "acceptance-calib-2026-09 (previous acceptance round)",
                    "generation_version": "2026-09-calib",
                }
            )
            absorbed += 1

    (OUT_DIR / "laya_train_queries.jsonl").write_text(
        "\n".join(json.dumps(q, ensure_ascii=False) for q in queries_out), encoding="utf-8"
    )
    (OUT_DIR / "laya_train_pairs.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows_out), encoding="utf-8"
    )

    manifest = {
        "seed": SEED,
        "teacher": ld.TEACHER,
        "generation_version": ld.GENERATION_VERSION,
        "train_pool_sha256_16": ld.companies_sha("train"),
        "test_pool_sha256_16": ld.companies_sha("test"),
        "families": len({r["family"] for r in rows_out}),
        "queries": len(queries_out),
        "pairs": len(rows_out),
        "absorbed_calib_rows": absorbed,
        "label_dist": dict(sorted(Counter(r["label"] for r in rows_out).items())),
        "isolation_note": "TRAIN families 与 data/eval(TEST/VAL) 的 family 集合零交集;公司可重叠,查询文本零交集",
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
