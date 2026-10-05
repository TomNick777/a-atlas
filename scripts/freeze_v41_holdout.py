"""Freeze the real-user search log into the V4.1 shadow-replay holdout (spec §3).

Reads data/search_log/search_log.jsonl and emits data/eval/v4_1_real_search_holdout.json.
No training, no retrieval: the frozen candidate pool for each entry IS the
fusedTop200 the production run logged, so replay only swaps the reranker.

Exclusion rules are structural and were fixed before any V3/V4.1 comparison
existed — no query is judged, edited, or dropped for looking "hard" or "bad":
  SYSTEM_TEST      query self-identifies as a probe (contains 探针 / smoke marker)
  CACHED_REPLAY    row.cached == true (frequency counter, not a fresh search)
  CORRUPT_CAPTURE  stored raw contains U+FFFD — the original bytes were lost by a
                   GBK-decoding terminal client at capture time; unrecoverable
  DUPLICATE_SMOKE  same (normalized query, system era) as an earlier kept run
                   (36s-apart double submits; distinct eras stay, the system
                   genuinely changed between them)

Usage: .venv/Scripts/python.exe scripts/freeze_v41_holdout.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "data/search_log/search_log.jsonl"
OUT = ROOT / "data/eval/v4_1_real_search_holdout.json"

PROBE_MARKERS = ("探针", "smoke", "SMOKE", "test probe")
# Manual topic tags for the sample-size report only; never used in judgment.
DOMAIN_HINTS = [
    ("液冷", "datacenter-liquid-cooling"),
    ("散热", "thermal-cooling"),
    ("铜", "copper"),
    ("减速器", "robotics-reducer"),
    ("机器人", "robotics"),
    ("光刻胶", "semiconductor-material"),
    ("刻蚀", "semiconductor-equipment"),
    ("清洗", "semiconductor-equipment"),
    ("薄膜沉积", "semiconductor-equipment"),
    ("柴油", "diesel-engine"),
]


def domain_tag(query: str) -> str:
    for needle, tag in DOMAIN_HINTS:
        if needle in query:
            return tag
    return "other"


def sha16(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def main() -> None:
    rows = [json.loads(line) for line in LOG.read_text(encoding="utf-8").splitlines() if line.strip()]
    seen: dict[tuple[str, str], str] = {}
    kept, excluded = [], []
    for index, row in enumerate(rows):
        raw = row["query"]["raw"]
        normalized = row["query"]["normalized"]
        era = f"{row['versions'].get('semiconductorEnrichmentVersion') or 'pre-stage3'}+{row['versions'].get('sourceSnapshotId') or '-'}"
        reasons = []
        if any(marker in raw for marker in PROBE_MARKERS):
            reasons.append("SYSTEM_TEST")
        if row.get("cached") is True:
            reasons.append("CACHED_REPLAY")
        if "\ufffd" in raw:
            reasons.append("CORRUPT_CAPTURE")
        dup_of = seen.get((normalized, era))
        if not reasons and dup_of is not None:
            reasons.append("DUPLICATE_SMOKE")
        if reasons:
            excluded.append(
                {
                    "logIndex": index,
                    "searchId": row["searchId"],
                    "timestamp": row["timestamp"],
                    "query": raw,
                    "reasons": reasons,
                    "duplicateOf": dup_of,
                    "note": (
                        "stored text carries U+FFFD; original bytes lost to GBK terminal decoding at capture time"
                        if "CORRUPT_CAPTURE" in reasons
                        else None
                    ),
                }
            )
            continue
        seen[(normalized, era)] = row["searchId"]
        kept.append(
            {
                "entryId": row["searchId"],
                "logIndex": index,
                "query": raw,
                "normalized": normalized,
                "timestamp": row["timestamp"],
                "era": era,
                "systemVersions": row["versions"],
                "querySpec": row["query"]["querySpec"],
                "frozenPool": row["retrieval"]["fusedTop200"],
                "poolSize": row["retrieval"]["poolSize"],
                "v3Top20": row["result"]["top20"],
                "v3Matches": row["result"]["matches"],
                "domainTag": domain_tag(normalized),
                "duplicates": [
                    {"searchId": r["searchId"], "timestamp": r["timestamp"], "logIndex": i}
                    for i, r in enumerate(rows)
                    if i != index
                    and r["query"]["normalized"] == normalized
                    and f"{r['versions'].get('semiconductorEnrichmentVersion') or 'pre-stage3'}+{r['versions'].get('sourceSnapshotId') or '-'}" == era
                ],
            }
        )

    queries = [entry["normalized"] for entry in kept]
    tags = Counter(entry["domainTag"] for entry in kept)
    holdout = {
        "name": "v4_1_real_search_holdout",
        "frozenAt": rows[-1]["timestamp"] if rows else None,
        "generatedBy": "scripts/freeze_v41_holdout.py",
        "sourceLog": {"path": "data/search_log/search_log.jsonl", "sha16": sha16(LOG), "rows": len(rows)},
        "exclusionRules": [
            "SYSTEM_TEST: query self-identifies as a probe (探针/smoke marker)",
            "CACHED_REPLAY: row.cached == true",
            "CORRUPT_CAPTURE: stored raw contains U+FFFD (bytes lost at capture time)",
            "DUPLICATE_SMOKE: same normalized query in the same system era as an earlier kept run",
        ],
        "rulesFrozenBeforeReplay": True,
        "counts": {
            "logRows": len(rows),
            "realSearchRuns": len(kept),
            "distinctQueries": len(set(queries)),
            "distinctDomains": len(tags),
            "domainTags": dict(tags),
        },
        "dateRange": {
            "first": kept[0]["timestamp"] if kept else None,
            "last": kept[-1]["timestamp"] if kept else None,
        },
        "realWorldEvidenceInsufficient": len(set(queries)) < 30,
        "realWorldEvidenceNote": (
            "Fewer than 30 distinct real queries: this holdout can corroborate or contradict the "
            "frozen benchmark sets, but cannot carry the promotion decision on its own. "
            "Sample is also semiconductor-heavy (the dev-user's searches during the stage3/V4 era) — "
            "non-semiconductor coverage is thin."
            if len(set(queries)) < 30
            else None
        ),
        "exclusions": excluded,
        "queries": kept,
    }
    OUT.write_text(json.dumps(holdout, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"holdout: kept {len(kept)} runs / {len(set(queries))} distinct queries, "
        f"excluded {len(excluded)} (rules: {Counter(r for e in excluded for r in e['reasons'])})"
    )


if __name__ == "__main__":
    sys.exit(main())
