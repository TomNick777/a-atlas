"""Version grammar for production model directories under models/ (shared rule).

`latest` must resolve the newest FORMAL version dir. The grammar is numeric and
open-ended — `a-share-laya-v3`, `a-share-laya-v4.1`, `a-share-laya-v5.1.2` all
resolve, so a new minor line never needs a code change (the V4.1 lesson: the old
`a-share-laya-v\\d+` regex silently pinned latest to V3 and mis-attributed the
log's rerankerSha).

  Formal (resolvable):  a-share-laya-v3 · a-share-laya-v4.1 · a-share-laya-v4.2
  Not resolvable:       a-share-laya-v4.1-candidate(-A/-B/-C) · a-share-laya-v4-rc1
                        a-share-laya-v4.1.0-beta · a-share-laya (unversioned first
                        fine-tune, only a fallback when no formal version exists)

Ordering is per numeric component (v4.10 > v4.9, v10 > v9), zero-padded so
v4 == v4.0; a longer tuple wins that tie (a pinned v4.0 beats bare v4), then
the lexicographically greater name — deterministic in every case.

Stdlib only, no heavy imports: tests and tools load this without torch.
"""

from __future__ import annotations

import re
from pathlib import Path

VERSIONED_NAME = re.compile(r"^a-share-laya-v(\d+(?:\.\d+)*)$")

# Leaf directories probed in order inside a model dir (production reads best).
CHECKPOINT_LEAVES = ("checkpoint_best", "checkpoint_last")


def parse_model_version(name: str) -> tuple[int, ...] | None:
    """(4, 1) for a-share-laya-v4.1; None for anything not a formal version dir."""
    match = VERSIONED_NAME.fullmatch(name)
    return tuple(int(part) for part in match.group(1).split(".")) if match else None


def version_sort_key(name: str) -> tuple[int, tuple[int, ...], str]:
    """Total-order key over formal version names (see module docstring).

    Plain tuple compare already gives numeric per-component order — (4, 9) <
    (4, 10) — and the padded tie-break falls out naturally: (4,) < (4, 0), so
    a pinned v4.0 beats bare v4; the trailing name keeps it total.
    """
    version = parse_model_version(name)
    if version is None:
        return (0, (), name)
    return (1, version, name)


def latest_versioned_name(names: list[str] | tuple[str, ...]) -> str | None:
    """Greatest formal version among `names`, else None (caller applies fallback)."""
    versioned = [name for name in names if parse_model_version(name) is not None]
    if not versioned:
        return None
    return max(versioned, key=version_sort_key)


def resolve_latest_model_dir(models_dir: Path) -> Path | None:
    """Newest formal version dir under models_dir, else the unversioned
    a-share-laya fine-tune, else None (caller falls back to a stock model).
    Absolute path out: laya.load only treats existing paths as local."""
    if not models_dir.is_dir():
        return None
    latest = latest_versioned_name([p.name for p in models_dir.iterdir() if p.is_dir()])
    model_dir = models_dir / latest if latest else models_dir / "a-share-laya"
    for leaf in CHECKPOINT_LEAVES:
        if (model_dir / leaf).is_dir():
            return model_dir / leaf
    return model_dir if model_dir.is_dir() else None
