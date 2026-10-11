"""Private artifacts and atomic registry; no model selection by directory age."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(os.environ.get("ATLAS_ARTIFACT_ROOT", Path(__file__).resolve().parents[2])).resolve()

def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)

def private_path(value: str, directory: str) -> Path:
    path = (ROOT / value).resolve()
    if not path.is_relative_to((ROOT / directory).resolve()):
        raise ValueError(f"Artifact must be inside {directory}")
    return path

def model_manifest(path: Path) -> dict:
    return {str(file.relative_to(path)).replace("\\", "/"): sha(file) for file in sorted(path.rglob("*")) if file.is_file() and file.name not in ("training.log",) and ".tmp" not in file.name}

def artifact_digest(manifest: dict) -> str:
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def registry() -> dict:
    path = ROOT / "models/registry.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    models = {}
    for model_id, dirname, expected, status in (
        ("v4.1", "a-share-laya-v4.1", "2742affc3f677d71", "active"),
        ("v4.2-B", "a-share-laya-v4.2-candidate-B", "727a685c37c101bb", "candidate"),
    ):
        base = ROOT / "models" / dirname
        checkpoint = next((p for p in (base / "checkpoint_best", base / "checkpoint_last", base) if (p / "model.safetensors").is_file()), None)
        if checkpoint is None:
            raise ValueError(f"Missing historical checkpoint: {model_id}")
        actual = sha(checkpoint / "model.safetensors")
        if not actual.startswith(expected):
            raise ValueError(f"Historical identity mismatch: {model_id}")
        manifest = model_manifest(checkpoint)
        models[model_id] = {"path": str(checkpoint.relative_to(ROOT)), "sha256": actual, "artifactManifest": manifest, "artifactDigest": artifact_digest(manifest), "status": status, "parent": None, "source": "historical migration; not evaluated on merged corpus"}
    value = {"schemaVersion": 1, "active": "v4.1", "history": [], "models": models}
    atomic_json(path, value)
    return value

def model_path(model_id: str) -> tuple[Path, dict]:
    row = registry()["models"][model_id]
    path = private_path(row["path"], "models")
    required = {"model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer_config.json", "tokenizer/tokenizer.json"}
    if not isinstance(row.get("artifactManifest"), dict) or not required <= set(row["artifactManifest"]):
        raise ValueError("Registered model requires complete local encoder/tokenizer artifacts")
    if sha(path / "model.safetensors") != row["sha256"]:
        raise ValueError(f"Model hash mismatch: {model_id}")
    if "artifactManifest" in row and model_manifest(path) != row["artifactManifest"]:
        raise ValueError(f"Model configuration/tokenizer integrity mismatch: {model_id}")
    return path, row
