"""Shared data access for the Laya A-share lab: benchmark, training data, evaluation.

Companies come from data/companies.json exactly as the search pipeline reads them,
so every label is grounded in the same profile text the model sees in production.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPANIES_JSON = ROOT / "data" / "companies.json"
SNAPSHOT_DIR = ROOT / "data" / "lab_snapshot"

TEACHER = "GLM-5.3-Flash (ZCode agent, in-context)"
GENERATION_VERSION = "2026-09-23-v1"


def pinned_snapshot(role: str = "test") -> Path:
    """Frozen pool for a role: `test` (benchmark, 1464-company pool the eval was
    reviewed on) or `train` (full A-share pool). Falls back to live companies.json."""
    if SNAPSHOT_DIR.exists():
        snaps = sorted(SNAPSHOT_DIR.glob(f"companies_{role}_*.json"))
        if snaps:
            return snaps[-1]
    return COMPANIES_JSON


def load_companies(role: str = "test") -> dict[str, dict]:
    path = pinned_snapshot(role)
    data = json.loads(path.read_text(encoding="utf-8"))
    return {c["code"]: c for c in data["companies"]}


def companies_sha(role: str = "test") -> str:
    return hashlib.sha256(pinned_snapshot(role).read_bytes()).hexdigest()[:16]


def hay(c: dict) -> str:
    """All searchable profile text for one company, joined."""
    products = "、".join(p["name"] for p in c.get("mainProducts") or [])
    return "|".join(
        [
            c["name"],
            c.get("industry") or "",
            c.get("swLevel1Industry") or "",
            c.get("businessDescription") or "",
            products,
        ]
    )


def desc(c: dict) -> str:
    return c.get("companyDescription") or ""


def ov(c: dict) -> float | None:
    share = c.get("overseasRevenueShare")
    return None if share is None else float(share)


def has(c: dict, pattern: str) -> bool:
    return bool(re.search(pattern, hay(c)))


def match_text(c: dict, pattern: str, limit: int = 40) -> str | None:
    """The matched span from the profile text, for evidence."""
    m = re.search(pattern, hay(c))
    if not m:
        return None
    text = m.group(0)[:limit]
    return text
