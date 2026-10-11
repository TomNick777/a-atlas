"""Give the loader writable metadata while keeping registered artifacts immutable."""
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import tempfile

@contextmanager
def checkpoint_copy(checkpoint: Path, runtime_root: Path):
    runtime_root = runtime_root.resolve()
    runtime_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="laya-load-", dir=runtime_root) as directory:
        target = Path(directory).resolve()
        if not target.is_relative_to(runtime_root):
            raise ValueError("Loader staging path escaped runtime root")
        for source in checkpoint.rglob("*"):
            if not source.is_file():
                continue
            destination = target / source.relative_to(checkpoint)
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Laya 0.3.5 only rewrites tokenizer metadata. Weights are read-only inputs.
            if source.suffix == ".safetensors":
                try:
                    os.link(source, destination)
                except OSError:
                    shutil.copy2(source, destination)
            else:
                shutil.copy2(source, destination)
        yield target
