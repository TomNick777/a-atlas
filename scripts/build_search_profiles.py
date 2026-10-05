"""Derive per-company search profiles (DERIVED tags with provenance) from profile text.

Canonical company facts in data/companies.json are untouched. This writes
data/search_profiles.json: for every company, which ontology concept groups its own
business text evidences, with the matched span as provenance. A tag exists only if the
company's 主营/产品 text names the underlying words — no teacher guessing, no external
knowledge. Companies with no matches get an empty tag list (not fabricated ones).

Usage: .venv/Scripts/python scripts/build_search_profiles.py
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 派生只读业务文本(主营+产品),与 judgeText 的口径一致;机构简介是注册沿革样板,不读。
SOURCES = ("businessDescription", "mainProducts")


def source_text(c: dict) -> str:
    products = "、".join(p["name"] for p in (c.get("mainProducts") or []))
    return f"{c.get('businessDescription') or ''}。产品:{products}"


def main() -> None:
    onto = json.loads((ROOT / "data" / "search_ontology.json").read_text(encoding="utf-8"))
    companies = json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))["companies"]
    compiled = {g: [re.compile(t) for t in terms] for g, terms in onto["concept_groups"].items()}

    started = time.time()
    out: dict[str, dict] = {}
    tagged = 0
    for c in companies:
        text = source_text(c)
        tags: list[dict] = []
        for group, patterns in compiled.items():
            evidence = next((p.search(text).group(0) for p in patterns if p.search(text)), None)
            if evidence:
                tags.append({"tag": group, "evidence": evidence[:40], "provenance": "DERIVED:业务文本词面命中"})
        tag_names = "、".join(t["tag"] for t in tags)
        out[c["code"]] = {
            "name": c["name"],
            "tags": tags,
            # 检索底文:judgeText 原文 + 派生标签行(检索与 rerank 共读这一份)
            "searchText": (c.get("judgeText") or "") + (f" | 标签:{tag_names}" if tags else ""),
            "derivedAt": time.strftime("%Y-%m-%d"),
            "sourceFields": list(SOURCES),
            "unknownNote": None if tags else "UNKNOWN:业务文本未命中任何概念组(不补假标签)",
        }
        if tags:
            tagged += 1

    (ROOT / "data" / "search_profiles.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"companies: {len(companies)}, tagged: {tagged} ({tagged / len(companies) * 100:.1f}%) in {time.time() - started:.1f}s")
    dist: dict[str, int] = {}
    for row in out.values():
        for t in row["tags"]:
            dist[t["tag"]] = dist.get(t["tag"], 0) + 1
    top = sorted(dist.items(), key=lambda kv: -kv[1])[:25]
    print("top tags:", ", ".join(f"{k}:{v}" for k, v in top))


if __name__ == "__main__":
    main()
