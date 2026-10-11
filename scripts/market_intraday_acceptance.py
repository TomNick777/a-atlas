"""Observe the running M2 market pipeline; retain real responses locally.

Run during each actual session, e.g. python scripts/market_intraday_acceptance.py
--rounds 9 --interval 15. No simulated clock, vendor override or Jev calls.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CN = timezone(timedelta(hours=8))
FIELDS = ("amount", "pctChange", "turnoverRate", "volumeRatio20d")


def request(url, body=None):
    started = time.monotonic()
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=50) as response:
            return {"body": json.load(response), "seconds": round(time.monotonic() - started, 3)}
    except Exception as exc:
        return {"error": str(exc), "seconds": round(time.monotonic() - started, 3)}


def observe(data_url, web_url):
    started = datetime.now(CN).isoformat()
    # Concurrent callers exercise the existing Data single-flight boundary.
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: request(data_url + "/market-snapshot"), range(4)))
    checks, failures = [], []
    bodies = [r["body"] for r in responses if "body" in r]
    if len(bodies) != 4 or any(b.get("error") or b.get("refreshing") for b in bodies):
        failures.append("data refresh failed or remained in flight")
    ids = {b.get("snapshotId") for b in bodies}
    if len(ids) != 1 or None in ids:
        failures.append("concurrent callers did not receive one published snapshot")
    snapshot = bodies[0] if bodies else {}
    runtime = snapshot.get("manifest", {}).get("runtime", {})
    state = []
    if runtime.get("snapshotId"):
        directory = ROOT / "data/market-runtime/snapshots" / runtime["snapshotId"]
        raw = (directory / "state" / (runtime["tradeDate"] + ".jsonl")).read_bytes()
        state = [json.loads(line) for line in raw.splitlines()]
        if hashlib.sha256(raw).hexdigest() != snapshot["manifest"]["contentDigest"]["value"]:
            failures.append("state digest mismatch")
        capture = json.loads((directory / "capture.json").read_text(encoding="utf8"))
        by_code = {r["code"]: r for r in state}
        projection_errors = []
        for code, entry in capture["rows"].items():
            row = by_code.get(code)
            if entry["status"] != "VALID":
                if row: projection_errors.append(code)
                continue
            q = entry["source"]
            if not row or row["close"] != q["price"] or row["volume"] != q["volumeShares"] or not math.isclose(row["amount"], q["amount_precise_wan"] * 10000, rel_tol=1e-12):
                projection_errors.append(code)
        checks.append({"projectionRows": len(state), "projectionErrors": projection_errors})
        if projection_errors: failures.append("source/state projection mismatch")
    apis = {}
    for field in FIELDS:
        response = request(web_url + "/api/market", {"sort": {"field": field, "direction": "desc"}, "limit": 20})
        apis[field] = response
        body = response.get("body", {})
        if not body.get("available"):
            failures.append(field + ": " + str(body.get("reason", response.get("error"))))
            continue
        audit_state = state
        digest = body.get("provenance", {}).get("stateDigest16")
        audit_id = runtime.get("snapshotId")
        if digest != snapshot.get("manifest", {}).get("contentDigest", {}).get("value", "")[:16]:
            # Each API request pins its own snapshot. A later refresh is valid;
            # reconcile against that response's immutable digest, not a prior
            # Data request's snapshot.
            matches = []
            for manifest_file in (ROOT / "data/market-runtime/snapshots").glob("*/state/manifest.json"):
                candidate = json.loads(manifest_file.read_text(encoding="utf8"))
                if candidate["contentDigest"]["value"][:16] == digest:
                    matches.append((manifest_file.parent, candidate))
            if not matches:
                failures.append(field + ": response snapshot unavailable for reconciliation")
                continue
            state_dir, candidate = matches[0]
            raw = (state_dir / (candidate["latestTradingDay"] + ".jsonl")).read_bytes()
            if hashlib.sha256(raw).hexdigest() != candidate["contentDigest"]["value"]:
                failures.append(field + ": response snapshot digest mismatch")
                continue
            audit_state = [json.loads(line) for line in raw.splitlines()]
            audit_id = candidate["runtime"]["snapshotId"]
        expected = sorted(audit_state, key=lambda r: (r[field] is None, -(r[field] or 0), r["code"]))[:20]
        actual = body["rows"]
        matched = [r["code"] for r in expected] == [r["code"] for r in actual] and all(a[field] == e[field] and a["sortValue"] == e[field] for a, e in zip(actual, expected))
        checks.append({"field": field, "rankingAndValuesMatch": matched, "rows": len(actual), "snapshotId": audit_id})
        if not matched: failures.append(field + ": ranking/value mismatch")
    return {"startedAt": started, "endedAt": datetime.now(CN).isoformat(), "dataResponses": responses,
            "apis": apis, "checks": checks, "failures": failures, "snapshotId": runtime.get("snapshotId"),
            "runtime": runtime}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=9)
    parser.add_argument("--interval", type=float, default=15)
    parser.add_argument("--data-url", default="http://127.0.0.1:8920")
    parser.add_argument("--web-url", default="http://127.0.0.1:3400")
    args = parser.parse_args()
    if args.rounds < 1 or args.interval < 0: parser.error("invalid rounds/interval")
    output = ROOT / "reports/MARKET_M2_RUNTIME" / datetime.now(CN).strftime("%Y-%m-%d/%H%M%S-%f")
    output.mkdir(parents=True)
    rounds = []
    for index in range(args.rounds):
        begin = time.monotonic()
        result = observe(args.data_url.rstrip("/"), args.web_url.rstrip("/"))
        rounds.append(result)
        (output / f"round-{index + 1:02}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
        print(json.dumps({"round": index + 1, "snapshotId": result["snapshotId"], "failures": result["failures"], "sourceTimeMin": result["runtime"].get("sourceTimeMin")}, ensure_ascii=False), flush=True)
        if index + 1 < args.rounds: time.sleep(max(0, args.interval - (time.monotonic() - begin)))
    summary = {"version": "market-intraday-observation-1", "directory": str(output),
               "rounds": len(rounds), "distinctSnapshots": len({r["snapshotId"] for r in rounds}),
               "failedRounds": sum(bool(r["failures"]) for r in rounds),
               "note": "Real session observations only; not organic usage or full M2 acceptance."}
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return int(summary["failedRounds"] > 0)


if __name__ == "__main__":
    raise SystemExit(main())
