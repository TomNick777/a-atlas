"""Keep private local runtime files out of Next's deployment dependency traces.

Next 16's Windows trace glob matching does not reliably apply exclusions to
backslash paths. Normalize and remove references, never the original artifacts.
The app runs from its installed repository; private inputs are provisioned there.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path

PRIVATE = {"data", "reports", "models", ".local", ".venv", ".venv-laya", ".cache"}

def private_runtime_path(root: Path, path: Path) -> bool:
    try:
        relative = path.relative_to(root)
    except ValueError:
        return False
    return bool(relative.parts and (relative.parts[0] in PRIVATE or relative.parts[0].startswith(".env") and relative.parts[0] != ".env.example"))

def check(root: Path, prune=False):
    removed = traces = 0
    for trace in (root / ".next").rglob("*.nft.json"):
        document = json.loads(trace.read_text(encoding="utf-8"))
        kept = [name for name in document.get("files", []) if not private_runtime_path(root, Path(os.path.abspath(trace.parent / name)))]
        rejected = len(document.get("files", [])) - len(kept)
        traces += 1; removed += rejected
        if rejected:
            if not prune:
                raise ValueError(f"Private runtime dependency references in {trace.relative_to(root)}")
            document["files"] = kept
            temporary = trace.with_name(trace.name + ".tmp")
            temporary.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, trace)
    weights = [str(path.relative_to(root)) for path in (root / ".next").rglob("*") if path.is_file() and path.suffix.lower() in (".safetensors", ".pth", ".pt", ".ckpt", ".onnx")]
    if weights:
        raise ValueError(f"Model artifacts bundled into Web: {weights[:10]}")
    return {"traces": traces, "excludedReferences": removed, "bundledModelArtifacts": 0}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--exclude-private-traces", action="store_true")
    args = parser.parse_args()
    print(json.dumps(check(Path(__file__).resolve().parents[1], args.exclude_private_traces)))
