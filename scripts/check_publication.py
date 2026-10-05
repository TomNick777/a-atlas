"""Reject private data in both the index and every reachable Git history ref."""
from __future__ import annotations

import subprocess
from pathlib import PurePosixPath


def private_path(name: str) -> bool:
    path = PurePosixPath(name)
    if name.startswith(("data/", "reports/", "quality/discovery/snapshots/",
                        "quality/discovery/reviews/", "tests/fixtures/stockdata/",
                        "tests/fixtures/semantic/judge/", "tests/fixtures/semantic/retrieval/")):
        return True
    if path.parent.as_posix() in ("quality/discovery", "evaluation/discovery", "tests/fixtures/semantic") and path.suffix == ".json":
        return True
    if path.suffix.lower() in (".pt", ".f32", ".exe", ".pdf", ".xlsx"):
        return True
    return path.name.startswith(".env") and path.name != ".env.example"


def check() -> None:
    indexed = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    reachable = subprocess.check_output(["git", "rev-list", "--objects", "--all"]).decode().splitlines()
    paths = set(filter(None, indexed))
    paths.update(line.split(" ", 1)[1] for line in reachable if " " in line)
    rejected = sorted(name for name in paths if private_path(name))
    if rejected:
        raise SystemExit("Private paths are reachable; do not push:\n" + "\n".join(rejected))
    print(f"Publication check passed: {len(indexed) - 1} indexed files; no private paths in any reachable ref.")


if __name__ == "__main__":
    check()
