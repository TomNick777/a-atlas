"""Sidecar identity + telemetry for the Product Evidence Layer (规格 §6, §9, §32).

Importable WITHOUT the laya/torch stack so tests can run everywhere:
laya_server.py pulls build_health_payload and emit_event from here.

Everything is best-effort: telemetry write failures print to stderr and never
take the sidecar down. Event envelope mirrors lib/telemetry/types.ts v1.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TELEMETRY_SCHEMA_VERSION = 1
REPO_ROOT = Path(__file__).resolve().parents[1]
TELEMETRY_DIR = REPO_ROOT / "data" / "telemetry"

# Frozen production contract (matches lib/telemetry/contract.ts).
EXPECTED_SHA16 = "2742affc3f677d71"
V42_CANDIDATE_SHA16 = "727a685c37c101bb"


def sha16_of_file(path: Path, chunk: int = 1 << 20) -> str | None:
    """First 16 hex chars of sha256, streamed — model.safetensors is big."""
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            while True:
                block = handle.read(chunk)
                if not block:
                    break
                digest.update(block)
    except OSError:
        return None
    return digest.hexdigest()[:16]


def checkpoint_safetensors(checkpoint: str) -> Path | None:
    """model.safetensors of a local checkpoint dir; None for hub checkpoints."""
    candidate = Path(checkpoint)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / checkpoint
    if not candidate.is_dir():
        return None
    for leaf in ("checkpoint_best", "checkpoint_last"):
        nested = candidate / leaf / "model.safetensors"
        if nested.exists():
            return nested
    direct = candidate / "model.safetensors"
    return direct if direct.exists() else None


def port_owner_pid(port: int, host: str = "127.0.0.1") -> bool:
    """True when something already LISTENs on host:port (bind-fail predictor)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.settimeout(0.5)
        return probe.connect_ex((host, port)) == 0
    finally:
        probe.close()


def git_head() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=5, check=False
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def new_event_id() -> str:
    return f"ev_{int(time.time() * 1000)}_{os.getpid():x}"


def build_envelope(event_type: str, category: str, payload: dict, component: str, app_run_id: str) -> dict:
    return {
        "telemetrySchemaVersion": TELEMETRY_SCHEMA_VERSION,
        "eventId": new_event_id(),
        "eventType": event_type,
        "category": category,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "appRunId": app_run_id,
        "sessionId": None,
        "searchId": None,
        "gitHead": git_head(),
        "component": component,
        "runtime": {"pid": os.getpid(), "platform": sys.platform, "pythonVersion": sys.version.split()[0]},
        "versions": {},
        "payload": payload,
    }


def append_event(event: dict, directory: Path | None = None) -> bool:
    """One event = one complete JSONL line (§44). Never raises."""
    target_dir = directory or (TELEMETRY_DIR / "events")
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        line = json.dumps(event, ensure_ascii=False) + "\n"
        with open(target_dir / f"{event['timestamp'][:10]}.jsonl", "a", encoding="utf-8") as handle:
            handle.write(line)
        return True
    except OSError as error:
        print(f"laya: telemetry write failed (service unaffected): {error}", file=sys.stderr, flush=True)
        return False


def emit_sidecar_event(
    event_type: str,
    payload: dict,
    app_run_id: str,
    category: str = "runtime",
    versions: dict | None = None,
    directory: Path | None = None,
) -> bool:
    event = build_envelope(event_type, category, payload, "sidecar", app_run_id)
    if versions:
        event["versions"] = versions
    ok = append_event(event, directory)
    if event_type.startswith("MODEL_") or event_type in ("SIDECAR_CRASH", "SIDECAR_START_FAILED"):
        # Mirror incidents into incidents/incidents.jsonl (§32).
        try:
            incidents_dir = directory.parent / "incidents" if directory else (TELEMETRY_DIR / "incidents")
            incidents_dir.mkdir(parents=True, exist_ok=True)
            with open(incidents_dir / "incidents.jsonl", "a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        except OSError:
            pass
    return ok


def build_health_payload(
    *,
    ok: bool,
    model: str,
    device: str | None,
    checkpoint_path: str | None,
    sha16: str | None,
    startup_ms: float | None,
    cuda: bool | None,
    vram: dict | None,
) -> dict:
    """Health payload: legacy fields first (Harbor ADR-008 anchors on `service`),
    identity fields added — additive, so an older Next side keeps working."""
    return {
        "ok": ok,
        "service": "a-share-laya-sidecar",
        "model": model,
        "device": device,
        "checkpointPath": checkpoint_path,
        "sha16": sha16,
        "pid": os.getpid(),
        "startupMs": round(startup_ms) if startup_ms is not None else None,
        "cuda": cuda,
        "vram": vram,
    }


def fetch_health(url: str, timeout: float = 2.0) -> dict | None:
    """GET a health endpoint, best effort (used by probes and tests)."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
