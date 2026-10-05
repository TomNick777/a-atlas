"""Request-driven, single-flight market refresh inside the existing Data service."""
from __future__ import annotations
import hashlib
import json
import logging
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from market_snapshot import REPO, POLICY, capture, session

RUNTIME = REPO / "data" / "market-runtime"
_lock = threading.Lock()
_job = None
_failure = None
_retry_after = 0.0


def current():
    pointer = RUNTIME / "current.json"
    directory = REPO / "data" / "market"
    if pointer.exists():
        identity = json.loads(pointer.read_text())["snapshotId"]
        if not identity or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in identity):
            raise ValueError("invalid snapshot pointer")
        directory = RUNTIME / "snapshots" / identity
    manifest = json.loads((directory / "state" / "manifest.json").read_text(encoding="utf8"))
    return directory, manifest


def history_directory(directory, manifest):
    runtime = manifest.get("runtime")
    if not runtime: return directory
    identity = runtime.get("historySnapshotId")
    if identity is None: return REPO / "data" / "market"
    if any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in identity): raise ValueError("invalid history pointer")
    return RUNTIME / "snapshots" / identity


def _run(args):
    result = subprocess.run(args, cwd=REPO, capture_output=True, text=True, encoding="utf8", errors="replace", timeout=180)
    if result.returncode: raise RuntimeError(result.stderr[-1200:] or result.stdout[-1200:])


def _refresh(context):
    global _failure, _retry_after
    staging = None
    owned_lock = False
    published = False
    try:
        directory, manifest = current()
        history = history_directory(directory, manifest)
        base = json.loads((history / "state" / "manifest.json").read_text(encoding="utf8"))
        node = shutil.which("node")
        if not node: raise RuntimeError("Node runtime unavailable for deterministic materialization")
        tsx = str(REPO / "node_modules" / "tsx" / "dist" / "cli.mjs")
        if context["previousDate"] not in base["tradingDays"]:
            _run([node, tsx, "scripts/refresh_market.ts", "--through", context["previousDate"]])
            directory, manifest = current()
            history = history_directory(directory, manifest)
        universe = (REPO / "data" / "companies.json").read_bytes()
        RUNTIME.mkdir(parents=True, exist_ok=True)
        (RUNTIME / "refresh.lock").mkdir()
        owned_lock = True
        source = capture(json.loads(universe)["companies"], context)
        source["universeSha16"] = hashlib.sha256(universe).hexdigest()[:16]
        if not source["publishable"]: raise RuntimeError("source snapshot rejected: " + ", ".join(source["failures"]))
        # Reject phase/date transitions rather than publishing a mixed session.
        after = session()
        if after["tradeDate"] != context["tradeDate"] or after["calendarDate"] != context["calendarDate"] or after["phase"] != context["phase"]:
            raise RuntimeError("trading session changed during collection; retry with a new snapshot")
        identity = f"{context['tradeDate']}_quote_{uuid.uuid4()}"
        staging = RUNTIME / "snapshots" / identity
        staging.mkdir(parents=True)
        file = staging / "capture.json"
        file.write_text(json.dumps(source, ensure_ascii=False), encoding="utf8")
        _run([node, tsx, "scripts/build_live_market.ts", str(file), str(history), str(staging)])
        built = json.loads((staging / "state" / "manifest.json").read_text(encoding="utf8"))
        actual = hashlib.sha256((staging / "state" / f"{context['tradeDate']}.jsonl").read_bytes()).hexdigest()
        if built["contentDigest"]["value"] != actual: raise RuntimeError("state integrity failed")
        pointer = RUNTIME / f"current-{uuid.uuid4()}.tmp"
        pointer.write_text(json.dumps({"snapshotId": identity, "tradeDate": context["tradeDate"], "digest": actual, "publishedAt": source["endedAt"]}), encoding="utf8")
        pointer.replace(RUNTIME / "current.json")
        staging = None
        _failure = None
        published = True
    except Exception as exc:
        _failure = f"{type(exc).__name__}: {exc}"
        _retry_after = time.monotonic() + POLICY["retrySeconds"]
    finally:
        if staging: shutil.rmtree(staging)
        if owned_lock: (RUNTIME / "refresh.lock").rmdir()
    if published:
        # Maintenance has its own publication lock. Failure cannot undo a valid snapshot.
        try:
            _run([node, tsx, "scripts/prune_market_snapshots.ts", "--apply"])
        except Exception as exc:
            logging.warning("Market snapshot published; retention deferred: %s", exc)


def market_snapshot(wait=True):
    global _job
    context = session()
    directory, manifest = current()
    runtime = manifest.get("runtime")
    universe_sha = hashlib.sha256((REPO / "data" / "companies.json").read_bytes()).hexdigest()[:16]
    final = context["phase"] in ("closed", "preopen", "afterclose")
    due = not runtime or runtime["tradeDate"] != context["tradeDate"] or manifest["inputs"]["universeSha16"] != universe_sha
    if runtime and not due:
        from datetime import datetime
        age = time.time() - datetime.fromisoformat(runtime["endedAt"]).timestamp()
        due = (not final and age >= POLICY["refreshSeconds"]) or (final and runtime["phase"] not in ("closed", "preopen", "afterclose"))
    with _lock:
        if due and (_job is None or not _job.is_alive()) and time.monotonic() >= _retry_after:
            _job = threading.Thread(target=_refresh, args=(context,), daemon=True)
            _job.start()
        job = _job
    if wait and job and job.is_alive(): job.join(POLICY["maxCollectionSeconds"] + 10)
    _, manifest = current()
    return {"context": context, "snapshotId": manifest.get("runtime", {}).get("snapshotId"),
            "refreshing": bool(job and job.is_alive()), "error": _failure, "manifest": manifest}
