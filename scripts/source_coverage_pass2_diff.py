"""Source Coverage Pass 2 — corpus semantic diff (mission §9).

对比扩量前后 corpus companies.jsonl，输出：
  changed / unchanged / sourceFacts-added / searchableText-changed / truncated 计数
  每家变更的 field 级分解（searchableText / sourceFacts / sources / 其他）
  抽查名单：普通 20 / 事实特别多 10 / 撞 cap 10 / 撞预算 10 / pilot 6

Usage:
  git show <baseline>:data/company-corpus/companies.jsonl > /tmp/before.jsonl
  services venv python -u scripts/source_coverage_pass2_diff.py --before /tmp/before.jsonl --out reports/SOURCE_COVERAGE_PASS2/semantic_diff.json
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
AFTER = ROOT / "data" / "company-corpus" / "companies.jsonl"
PILOT = ["000651", "000333", "300124", "688320", "603416", "688187"]


def doc_fields(doc: dict) -> dict:
    """参与 diff 的字段集合（schemaVersion 恒升不参与）。"""
    return {k: v for k, v in doc.items() if k != "schemaVersion"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", required=True)
    parser.add_argument("--out", default="reports/SOURCE_COVERAGE_PASS2/semantic_diff.json")
    parser.add_argument("--seed", type=int, default=0x50DC)
    args = parser.parse_args()

    before = {}
    for line in Path(args.before).read_bytes().decode("utf-8").split("\n"):
        if line.strip():
            doc = json.loads(line)
            before[doc["symbol"]] = doc
    after = {}
    for line in AFTER.read_bytes().decode("utf-8").split("\n"):
        if line.strip():
            doc = json.loads(line)
            after[doc["symbol"]] = doc

    changed: list[str] = []
    field_changes: Counter = Counter()
    sf_added: list[str] = []
    text_changed: list[str] = []
    truncated_now: list[str] = []
    details: dict[str, dict] = {}
    for symbol, doc in after.items():
        old = before.get(symbol)
        if old is None:
            changed.append(symbol)
            field_changes["NEW"] += 1
            continue
        if doc_fields(doc) == doc_fields(old):
            continue
        changed.append(symbol)
        row: dict = {}
        for key in ("searchableText", "sourceFacts", "sources", "themes", "aliases", "profile", "business", "products", "revenueMix", "concepts", "exclusions", "identity"):
            if doc.get(key) != old.get(key):
                field_changes[key] += 1
                row[key] = True
        if row.get("sourceFacts") and not (old.get("sourceFacts")):
            sf_added.append(symbol)
        if row.get("searchableText"):
            text_changed.append(symbol)
        details[symbol] = row
        if len(doc["searchableText"]) >= 640 and len(old["searchableText"]) < 640:
            truncated_now.append(symbol)
            details[symbol]["newlyTruncated640"] = True
    for symbol in before:
        if symbol not in after:
            changed.append(symbol)
            field_changes["MISSING"] += 1

    fact_counts = {symbol: len(doc.get("sourceFacts") or []) for symbol, doc in after.items()}
    text_lengths = {symbol: len(doc["searchableText"]) for symbol, doc in after.items()}
    rng = random.Random(args.seed)
    sf_added_pool = [s for s in sf_added if s not in PILOT]
    cap_pool = [s for s, c in fact_counts.items() if c >= 12 and s not in PILOT]
    budget_pool = [s for s in text_changed if text_lengths[s] >= 630 and s not in PILOT]
    normal_pool = [s for s in sf_added if s not in PILOT and 1 <= fact_counts[s] <= 4]
    sample = {
        "normal20": sorted(rng.sample(sorted(normal_pool), min(20, len(normal_pool)))),
        "factHeavy10": sorted(rng.sample([s for s in fact_counts if fact_counts[s] >= 8 and s not in PILOT], min(10, len([s for s in fact_counts if fact_counts[s] >= 8 and s not in PILOT])))),
        "capHitting10": sorted(rng.sample(cap_pool, min(10, len(cap_pool)))),
        "budgetHitting10": sorted(rng.sample(budget_pool, min(10, len(budget_pool)))),
        "pilot6": PILOT,
    }

    common = set(before) & set(after)
    new_symbols = set(after) - set(before)
    missing_symbols = set(before) - set(after)
    common_changed_count = len([s for s in common if s in details])
    result = {
        "before": len(before),
        "after": len(after),
        "changed": len([s for s in common if s in details]) + len(new_symbols) + len(missing_symbols),
        "unchanged": len(common) - common_changed_count,
        "newOrMissing": {"new": len(new_symbols), "missing": len(missing_symbols)},
        "fieldChanges": dict(field_changes),
        "sourceFactsAdded": len(sf_added),
        "searchableTextChanged": len(text_changed),
        "newlyTruncated640": len(truncated_now),
        "pilotChanged": [s for s in PILOT if s in details],
        "sample": sample,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (out.parent / "semantic_diff_details.json").write_text(json.dumps(details, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
