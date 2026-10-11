"""Explicit local judge loaded only from the immutable private model registry."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Same parser as scripts/load-env.ts: file values lose to real environment variables.
for name in (".env.local", ".env"):
    file = Path(os.environ.get("ATLAS_ARTIFACT_ROOT", Path(__file__).resolve().parents[2])) / name
    if not file.exists():
        continue
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))

# argv wins over env, so `npm run laya:ft` can point at the fine-tuned model
# without touching .env.local. Usage: laya_server.py [--checkpoint NAME_OR_PATH] [--device cuda]
_args = sys.argv[1:]
for _flag, _env in (("--checkpoint", "LAYA_CHECKPOINT"), ("--device", "LAYA_DEVICE"), ("--port", "LAYA_PORT")):
    if _flag in _args:
        os.environ[_env] = _args[_args.index(_flag) + 1]

os.environ.setdefault("USE_TF", "0")

import laya  # noqa: E402  (after env, so USE_TF=0 sticks before transformers loads)
from immutable_load import checkpoint_copy

from laya_identity import (  # noqa: E402
    build_health_payload,
    checkpoint_safetensors,
    emit_sidecar_event,
    port_owner_pid,
    sha16_of_file,
)

CHECKPOINT = _args[_args.index("--checkpoint") + 1] if "--checkpoint" in _args else ""
_artifact_root = Path(os.environ.get("ATLAS_ARTIFACT_ROOT", Path(__file__).resolve().parents[2])).resolve()
sys.path.insert(0, str(_artifact_root / "training/laya"))
from artifacts import registry, model_path, atomic_json
_registry = registry()
if not CHECKPOINT:
    CHECKPOINT = str(model_path(_registry["active"])[0])
_registered = next((model_id for model_id, row in _registry["models"].items() if (_artifact_root / row["path"]).resolve() == Path(CHECKPOINT).resolve()), None)
if _registered is None:
    raise SystemExit("Checkpoint is not registered")
model_path(_registered)
DEVICE = os.environ.get("LAYA_DEVICE", "cuda").strip() or "cuda"
HOST = os.environ.get("LAYA_HOST", "127.0.0.1").strip()
if HOST not in ("127.0.0.1", "localhost", "::1"):
    raise SystemExit("Laya must bind loopback")
PORT = int(os.environ.get("LAYA_PORT", "8787"))
MAX_LEN = int(os.environ.get("LAYA_MAX_LEN", "2048"))
HEAD_MAX_LEN = int(os.environ.get("LAYA_HEAD_MAX_LEN", "512"))
# Options per forward pass. Enough room that industry names keep most of their 48-token option budget.
CHOICE_CHUNK = int(os.environ.get("LAYA_CHOICE_CHUNK", "32"))
# Softmax temperature for noul. The multilingual checkpoint ships uncalibrated and
# saturates at 1.0; sweep a value against labelled queries before trusting it.
TEMPERATURE_NOUL = float(os.environ.get("LAYA_TEMPERATURE_NOUL", "0"))
LOCK = threading.Lock()
DRAINING = threading.Event()
AGENT = None
MODEL_NAME = "laya:loading"
STARTUP_MS: float | None = None

# ---- Product Evidence Layer: sidecar self-identity (规格 §6/§9) ----
APP_RUN_ID = f"run_sidecar_{os.getpid()}_{int(time.time() * 1000)}"
START_REQUESTED_AT = time.time()
SAFETENSORS = checkpoint_safetensors(CHECKPOINT)
SHA16 = sha16_of_file(SAFETENSORS) if SAFETENSORS else None
if not SHA16:
    raise SystemExit("Checkpoint identity is unavailable")
MODEL_NAME = f"laya:{Path(CHECKPOINT).name}@{SHA16}"


def _vram_snapshot() -> dict | None:
    try:
        import torch  # already loaded by laya

        if not torch.cuda.is_available():
            return None
        free, total = torch.cuda.mem_get_info()
        peak = torch.cuda.max_memory_allocated()
        return {
            "usedMb": round((total - free) / 1024 / 1024),
            "totalMb": round(total / 1024 / 1024),
            "peakAllocMb": round(peak / 1024 / 1024),
        }
    except Exception:  # noqa: BLE001 — vram evidence is optional
        return None


def emit_event(event_type: str, payload: dict, category: str = "runtime", versions: dict | None = None) -> None:
    versions = versions if versions is not None else {"rerankerShaActual": SHA16, "model": MODEL_NAME}
    emit_sidecar_event(event_type, payload, APP_RUN_ID, category=category, versions=versions)


def load() -> None:
    global AGENT
    started = time.time()
    emit_event("SIDECAR_START_REQUESTED", {"checkpoint": CHECKPOINT, "sha16": SHA16, "port": PORT, "device": DEVICE})
    try:
        import torch
        if DEVICE.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable; refusing implicit CPU fallback")
        with checkpoint_copy(Path(CHECKPOINT), _artifact_root / ".local/runtime") as temporary:
            AGENT = laya.load(str(temporary), device=DEVICE)
            import hashlib
            tokenizer_runtime_sha = hashlib.sha256((temporary / "tokenizer/tokenizer_config.json").read_bytes()).hexdigest()
        model_path(_registered)  # Loading must leave the registered full manifest intact.
    except Exception as error:  # noqa: BLE001 — record the failure as evidence, then die honestly
        emit_event("SIDECAR_START_FAILED", {"checkpoint": CHECKPOINT, "error": str(error)[:500]}, category="incident")
        raise
    AGENT.cfg["max_len"] = MAX_LEN
    AGENT.cfg["head_max_len"] = HEAD_MAX_LEN
    if TEMPERATURE_NOUL > 0:
        AGENT.cfg["temperature"][laya.QTYPES["noul"]] = TEMPERATURE_NOUL
        print(f"laya: noul temperature {TEMPERATURE_NOUL}", flush=True)
    import hashlib
    global MODEL_NAME
    from importlib.metadata import version
    effective_digest = hashlib.sha256(json.dumps({"config": AGENT.cfg, "adapter": "laya-adapter-1", "tokenizerRuntimeSha256": tokenizer_runtime_sha, "software": {name: version(name) for name in ("laya", "torch", "transformers")}, "serverSha256": hashlib.sha256(Path(__file__).read_bytes().replace(b"\r\n", b"\n")).hexdigest(), "loaderSha256": hashlib.sha256(Path(__file__).with_name("immutable_load.py").read_bytes().replace(b"\r\n", b"\n")).hexdigest()}, sort_keys=True, default=str).encode()).hexdigest()[:16]
    MODEL_NAME = f"laya:{_registered}@{SHA16}/{effective_digest}"
    startup_ms = (time.time() - started) * 1000
    global STARTUP_MS
    STARTUP_MS = startup_ms
    print(f"laya: {MODEL_NAME} on {AGENT.device} in {time.time() - started:.1f}s", flush=True)
    emit_event(
        "SIDECAR_STARTED",
        {
            "checkpoint": CHECKPOINT,
            "checkpointPath": str(SAFETENSORS) if SAFETENSORS else None,
            "sha16": SHA16,
            "startupMs": round(startup_ms),
            "device": str(AGENT.device),
            "vram": _vram_snapshot(),
        },
    )


def chunked(item: tuple[str, dict], state) -> dict:
    qid, question = item
    merged: dict[str, float] = {}
    best_label, best_p, usage = None, -1.0, 0
    criteria = question.get("criteria") or {}
    for at in range(0, len(criteria), CHOICE_CHUNK):
        part = dict(list(criteria.items())[at : at + CHOICE_CHUNK])
        out = AGENT.predict(state, {qid: {**question, "criteria": part}})
        usage += out.get("usage", {}).get("input_tokens", 0)
        probabilities = out["answers"][qid]["probabilities"]
        merged.update(probabilities)
        label, p = max(probabilities.items(), key=lambda row: row[1])
        if p > best_p:
            best_label, best_p = label, p
    return {
        "type": "choice",
        "choice": best_label,
        "probabilities": merged,
        "chunked": len(criteria) > CHOICE_CHUNK,
        "usage": {"input_tokens": usage},
    }


def sidecar_ins(question: dict) -> dict:
    """Pre-serialize instructions the way this sidecar feeds the local model.

    laya.Agent._to_internal json.dumps 结构化 instructions 时用默认 ensure_ascii=True,
    中文会变成 Unicode 转义序列,token 数膨胀 2-3 倍并把 profile 挤出 head 预算。
    这里改为 ensure_ascii=False 的紧凑序列化;字符串输入会被 _to_internal 原样保留。
    线格式不变:POST body 里的 instructions 仍是结构化对象。
    """
    ins = question.get("instructions")
    if isinstance(ins, dict):
        return {**question, "instructions": json.dumps(ins, ensure_ascii=False)}
    return question


def answer(body: dict) -> dict:
    state, questions = body["state"], body["questions"]
    if not isinstance(questions, dict) or not questions:
        raise ValueError("questions must be a non-empty object")
    questions = {qid: sidecar_ins(q) for qid, q in questions.items()}
    answers: dict[str, dict] = {}
    tokens = 0
    plain = {qid: q for qid, q in questions.items() if q.get("type") != "choice"}
    if plain:
        out = AGENT.predict(state, plain)
        answers.update(out["answers"])
        tokens += out.get("usage", {}).get("input_tokens", 0)
    for item in questions.items():
        if item[1].get("type") != "choice":
            continue
        chunk = chunked(item, state)
        answers[item[0]] = chunk
        tokens += chunk.pop("usage")["input_tokens"]
    return {"model": MODEL_NAME, "answers": answers, "usage": {"input_tokens": tokens, "output_tokens": 0}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # one line per request, like the TS side
        print(f"laya: {self.address_string()} {fmt % args}", flush=True)

    def do_GET(self) -> None:
        if self.path.rstrip("/") in ("", "/health"):
            # service 字段是 Harbor ADR-008 强身份健康检查的锚点，改名前先改 Harbor 注册表。
            vram = _vram_snapshot() if AGENT else None
            body = json.dumps(
                {**build_health_payload(
                    ok=bool(AGENT) and not DRAINING.is_set(),
                    model=MODEL_NAME,
                    device=str(AGENT.device) if AGENT else None,
                    checkpoint_path=str(SAFETENSORS) if SAFETENSORS else None,
                    sha16=SHA16,
                    startup_ms=STARTUP_MS,
                    cuda=vram is not None or (AGENT is not None and "cuda" in str(getattr(AGENT, "device", "")).lower()),
                    vram=vram,
                ), "lane": "production" if registry()["active"] == _registered else "evaluation"},
                ensure_ascii=False,
            ).encode()
            self.send_response(200)
        else:
            body = b'{"error": "not found"}'
            self.send_response(404)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path == "/control/drain":
            if self.headers.get("x-runtime-token") != os.environ.get("ATLAS_RUNTIME_TOKEN") or not os.environ.get("ATLAS_RUNTIME_TOKEN"):
                self.send_error(403)
                return
            DRAINING.set()
            with LOCK:
                pass
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"drained":true}')
            return
        if self.path != "/v1/systemone":
            self.send_error(404)
            return
        if DRAINING.is_set():
            self.send_error(503, "model draining")
            return
        if registry()["active"] != _registered and self.headers.get("x-atlas-laya-purpose") != "evaluation":
            self.send_error(503, "candidate available only to explicit evaluation")
            return
        try:
            length = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            if body.get("model") != MODEL_NAME:
                self.send_error(409, "model identity changed")
                return
            started = time.time()
            with LOCK:
                if time.time() * 1000 >= float(self.headers.get("x-deadline-at", "inf")):
                    raise TimeoutError("request expired while queued")
                if DRAINING.is_set():
                    raise RuntimeError("model draining")
                if registry()["active"] != _registered and self.headers.get("x-atlas-laya-purpose") != "evaluation":
                    raise RuntimeError("active model changed")
                if AGENT is None:
                    raise RuntimeError("model still loading")
                result = answer(body)
            payload = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(200)
            print(f"laya: judged {len(body.get('questions', {}))} questions in {time.time() - started:.2f}s", flush=True)
        except Exception as error:  # the client degrades to mock on any non-200
            payload = json.dumps({"error": str(error)}, ensure_ascii=False).encode()
            self.send_response(500)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    import atexit
    import sys as _sys

    # Port ownership (规格 §8): a bind failure must be evidence, not a mystery.
    if port_owner_pid(PORT, HOST if HOST != "0.0.0.0" else "127.0.0.1"):
        emit_event(
            "SIDECAR_START_FAILED",
            {"reason": "port_already_bound", "port": PORT, "host": HOST, "note": "another process owns the port; PID is on the Next side via PORT_ALREADY_BOUND"},
            category="incident",
        )
        print(f"laya: port {PORT} already in use, refusing to double-bind", file=sys.stderr, flush=True)
        _sys.exit(1)

    atexit.register(lambda: emit_event("SIDECAR_STOPPED", {"uptimeMs": round((time.time() - START_REQUESTED_AT) * 1000), "sha16": SHA16}))

    def _crash_hook(kind: str, value: object) -> None:
        emit_event("SIDECAR_CRASHED", {"kind": kind, "error": str(value)[:500], "uptimeMs": round((time.time() - START_REQUESTED_AT) * 1000)}, category="incident")

    _sys.excepthook = lambda type_, value, tb: (_crash_hook("uncaughtException", value), _sys.__excepthook__(type_, value, tb))

    import secrets
    os.environ.setdefault("ATLAS_RUNTIME_TOKEN", secrets.token_hex(24))
    load()
    atomic_json(_artifact_root / ".local/runtime/laya.json", {"pid": os.getpid(), "entry": str(Path(__file__).resolve()), "identityArgs": [str(Path(CHECKPOINT).resolve())] if "--checkpoint" in sys.argv else [], "startedAt": START_REQUESTED_AT, "controlToken": os.environ["ATLAS_RUNTIME_TOKEN"]})
    # §9: identity verification is the sidecar attesting to its own weights.
    emit_event(
        "SIDECAR_IDENTITY_VERIFIED",
        {
            "verified": "self_attested",
            "sha16": SHA16,
            "expectedSha16": registry()["models"][registry()["active"]]["sha256"][:16],
            "matchesProductionContract": _registered == registry()["active"],
            "registeredModelId": _registered,
            "lane": "production" if _registered == registry()["active"] else "evaluation",
            "isV42Candidate": SHA16 == "727a685c37c101bb",
            "checkpointPath": str(SAFETENSORS) if SAFETENSORS else None,
        },
    )
    print(f"laya: listening on http://{HOST}:{PORT}/v1/systemone", flush=True)
    emit_event("SIDECAR_HEALTHY", {"host": HOST, "port": PORT, "startupMs": STARTUP_MS, "vram": _vram_snapshot()})
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
