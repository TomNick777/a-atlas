"""Owned FIFO worker; waits for inference and other training without taking over."""
from __future__ import annotations
import argparse
import time
from pathlib import Path
from atlas_runtime import STATE, ROOT, owned, health, runtime_lock, execute, read_json
from artifacts import atomic_json, sha

def main():
    while True:
        pending = sorted(((p, read_json(p)) for p in (STATE / "queue").glob("*.json")), key=lambda pair: pair[1]["createdAt"])
        pending = [(p, row) for p, row in pending if row["state"] == "queued"]
        if not pending:
            return
        try:
            with runtime_lock(timeout=0):
                if owned("laya") or health(8787) or any(owned(p.stem) for p in STATE.glob("train-*.json")):
                    pass
                else:
                    path, row = pending[0]
                    row = read_json(path)
                    if row["state"] != "queued":
                        continue
                    try:
                        args = argparse.Namespace(**row["arguments"])
                        if args.config and sha(Path(args.config)) != row["configSha256"]:
                            raise ValueError("Queued configuration changed")
                        execute(args)
                        row.update(state="launched", launchedAt=time.time())
                    except Exception as error:
                        row.update(state="failed", error=f"{type(error).__name__}: {error}")
                    atomic_json(path, row)
        except RuntimeError as error:
            if "Another runtime operation" not in str(error):
                raise
        time.sleep(1)

if __name__ == "__main__":
    main()
