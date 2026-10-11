"""Review a hash manifest before copying private artifacts; never overwrite conflicts."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

def sha(path):
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source")
    parser.add_argument("--destination")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--purpose", default="private artifact migration")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    manifest_file = Path(args.manifest).resolve()
    if not args.execute and not args.verify:
        source, target = Path(args.source).resolve(), Path(args.destination).resolve()
        if not source.is_dir() or source == target or target.is_relative_to(source):
            raise ValueError("Invalid source/destination scope")
        rows = []
        for file in sorted(source.rglob("*")):
            if not file.is_file():
                continue
            destination = target / file.relative_to(source)
            digest = sha(file)
            rows.append({"relative": str(file.relative_to(source)), "source": str(file), "target": str(destination), "sha256": digest, "size": file.stat().st_size, "action": "identical" if destination.exists() and sha(destination) == digest else "conflict" if destination.exists() else "copy"})
        manifest_file.parent.mkdir(parents=True, exist_ok=True)
        with manifest_file.open("x", encoding="utf-8") as handle:
            json.dump({"schemaVersion": 1, "source": str(source), "target": str(target), "purpose": args.purpose, "files": rows}, handle, ensure_ascii=False, indent=2)
        print(json.dumps({"manifest": str(manifest_file), "files": len(rows), "conflicts": sum(r["action"] == "conflict" for r in rows)}))
        return
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    source, target = Path(manifest["source"]).resolve(), Path(manifest["target"]).resolve()
    for row in manifest["files"]:
        src, dst = Path(row["source"]).resolve(), Path(row["target"]).resolve()
        if not src.is_relative_to(source) or not dst.is_relative_to(target) or src.relative_to(source) != dst.relative_to(target):
            raise ValueError("Manifest path escapes declared scope")
        if row["action"] == "conflict" or sha(src) != row["sha256"]:
            raise ValueError("Conflict or source changed after review")
        if args.execute and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation also protects against a race after dry-run.
            with src.open("rb") as incoming, dst.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
                outgoing.flush(); os.fsync(outgoing.fileno())
        if not dst.exists() or sha(dst) != row["sha256"]:
            raise ValueError(f"Destination integrity failure: {dst}")
    print(json.dumps({"verified": len(manifest["files"]), "sourcePreserved": True, "purpose": manifest["purpose"]}))

if __name__ == "__main__":
    main()
