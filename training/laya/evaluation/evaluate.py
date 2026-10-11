"""Load an immutable candidate, evaluate the frozen seam, then restore active."""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from artifacts import ROOT, atomic_json, registry, model_path, sha
sys.path.insert(0, str(ROOT / "scripts"))
from atlas_runtime import owned, stop, serve

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--label", default="")
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    seal = manifest_path.with_suffix(".sha256")
    if not seal.exists() or seal.read_text().strip() != sha(manifest_path):
        raise ValueError("Evaluation manifest must be sealed before inference/training")
    _, candidate = model_path(args.candidate)
    models = registry()
    active = models["active"]
    was_running = owned("laya") is not None
    if args.label and not args.label.replace("-", "").replace("_", "").isalnum():
        raise ValueError("Invalid evaluation label")
    output = ROOT / "reports/laya-evaluation" / f"{args.candidate}-{sha(manifest_path)[:16]}{('-' + args.label) if args.label else ''}"
    if output.exists():
        raise ValueError("Evaluation artifact already exists; do not overwrite observations")
    output.mkdir(parents=True)
    stop("laya")
    try:
        actual = serve(args.candidate)
        raw = output / "capabilities.json"
        subprocess.run(["node", "--import", "tsx", ROOT / "training/laya/evaluation/capabilities.ts", "--provider", "laya", "--manifest", manifest_path, "--output", raw], cwd=ROOT, env={**os.environ, "ATLAS_LAYA_EVALUATION": "1"}, check=True)
        evidence = json.loads(raw.read_text(encoding="utf-8"))
        records = evidence["records"]
        required = {"semantic_match", "semantic_relation", "semantic_comparison", "evidence_explanation", "market_eligibility"}
        covered = {r["capability"] for r in records}
        contract_ok = all(r["contractValid"] and r["runtimeModel"] == actual["model"] for r in records)
        boundaries_ok = all(r["passed"] for r in records if r["boundary"])
        # A controlled training diagnostic is explicitly insufficient for product qualification.
        product_set = manifest.get("purpose") == "independent-product-qualification"
        benchmark_ok = False
        runs = manifest.get("benchmarkRunPaths", [])
        receipts = []
        if len(runs) == 4:
            coordinates = []
            providers = []
            for run in runs:
                path = ROOT / run
                if not path.is_file():
                    break
                item = json.loads(path.read_text(encoding="utf-8"))
                receipts.append({"path": run, "sha256": sha(path)})
                if item.get("mode") != "live" or item["totals"]["cases"] != 55 or item["totals"]["unexpectedAttempts"] or any(item["totals"]["byStatus"].get(k, 0) for k in ("error", "degraded")):
                    break
                providers.append(item.get("provider", "jev"))
                if item.get("provider") == "laya" and item.get("actualModel") != actual["model"]:
                    break
                coordinates.append((item["benchmarkSha16"], item.get("corpusDigest"), item.get("gitHead"), item.get("marketDate")))
            else:
                benchmark_ok = providers.count("jev") == providers.count("laya") == 2 and len(set(coordinates)) == 1
        qualified = required <= covered and contract_ok and boundaries_ok and product_set and benchmark_ok and manifest.get("independentLabelsReviewed") is True
        report = {"schemaVersion": 1, "candidate": args.candidate, "sha256": candidate["sha256"], "artifactDigest": candidate["artifactDigest"], "manifestSha256": sha(manifest_path), "rawSha256": sha(raw), "actualModel": actual["model"], "benchmarkReceipts": receipts, "qualified": qualified, "gates": {"capabilityCoverage": required <= covered, "contractValid": contract_ok, "boundaries": boundaries_ok, "independentProductSet": product_set, "benchmarkRepeats": benchmark_ok, "labelsReviewed": manifest.get("independentLabelsReviewed") is True}, "byCapability": {cap: {"cases": sum(r["capability"] == cap for r in records), "passed": sum(r["capability"] == cap and r["passed"] for r in records)} for cap in sorted(covered)}}
        report_path = output / "qualification.json"
        atomic_json(report_path, report)
        models = registry()
        models["models"][args.candidate]["qualification"] = str(report_path.relative_to(ROOT))
        models["models"][args.candidate]["qualificationSha256"] = sha(report_path)
        models["models"][args.candidate]["status"] = "qualified" if qualified else "candidate"
        atomic_json(ROOT / "models/registry.json", models)
        print(json.dumps(report, ensure_ascii=False))
    finally:
        stop("laya")
        if was_running:
            serve(active)

if __name__ == "__main__":
    main()
