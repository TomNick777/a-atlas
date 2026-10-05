"""Full-pool source capture and validation. No model, no semantic knowledge."""
from __future__ import annotations

import hashlib
import json
import math
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent / "generated"))
import stock_data as sd

CN = timezone(timedelta(hours=8))
POLICY = json.loads((Path(__file__).parent / "market_policy.json").read_text(encoding="utf8"))


def session(now=None):
    now = now or datetime.now(CN)
    date = now.date().isoformat()
    file = REPO / "data" / "market-calendar" / f"{now.year}.json"
    if not file.exists():
        raise ValueError(f"exchange calendar does not cover {date}")
    calendar = json.loads(file.read_text(encoding="utf8"))
    def trading(day):
        iso = day.isoformat()
        if not calendar["validFrom"] <= iso <= calendar["validThrough"]:
            raise ValueError("previous year calendar is not verified")
        return day.weekday() < 5 and not any(a <= iso <= b for a, b in calendar["closedRanges"])
    minute = now.hour * 60 + now.minute
    phase = "closed" if not trading(now.date()) else "preopen" if minute < 555 else "auction" if minute < 570 else "morning" if minute < 690 else "lunch" if minute < 780 else "afternoon" if minute < 900 else "afterclose"
    target = now.date()
    if phase in ("closed", "preopen"):
        target -= timedelta(days=1)
        while not trading(target):
            target -= timedelta(days=1)
    previous = target - timedelta(days=1)
    while not trading(previous):
        previous -= timedelta(days=1)
    return {"calendarDate": date, "phase": phase, "tradeDate": target.isoformat(), "previousDate": previous.isoformat()}


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def validate_row(symbol, row, context, now):
    if not row:
        return "MISSING"
    if row.get("source_symbol") != symbol or row.get("source_code") != symbol[2:]:
        return "INVALID_IDENTITY"
    stamp = row.get("source_time")
    if not stamp or len(stamp) != 14 or not stamp.isdigit():
        return "TIME_MISSING"
    try:
        source = datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=CN)
    except ValueError:
        return "TIME_INVALID"
    if source.date().isoformat() != context["tradeDate"]:
        return "STALE_DATE"
    if (source - now).total_seconds() > POLICY["maxFutureSeconds"]:
        return "TIME_FUTURE"
    if not finite(row.get("price")) or row["price"] <= 0 or not finite(row.get("last_close")) or row["last_close"] <= 0:
        return "INVALID_PRICE"
    if not finite(row.get("volume_source")) or row["volume_source"] < 0 or not finite(row.get("amount_precise_wan")) or row["amount_precise_wan"] < 0:
        return "INVALID_TURNOVER"
    # Zero turnover is evidence of no trades, not proof of suspension.
    if row["volume_source"] == 0 and row["amount_precise_wan"] == 0:
        return "NO_TRADES"
    if row["volume_source"] == 0 or row["amount_precise_wan"] == 0:
        return "INVALID_TURNOVER"
    if finite(row.get("volumeShares")):
        average = row["amount_precise_wan"] * 10000 / row["volumeShares"]
        if not finite(row.get("high")) or not finite(row.get("low")) or not row["low"] * 0.99 <= average <= row["high"] * 1.01:
            return "INVALID_UNITS"
    phase = context["phase"]
    if phase in ("closed", "preopen", "afterclose"):
        if source.hour * 60 + source.minute < 900:
            return "INCOMPLETE_CLOSE"
    else:
        anchor = now
        if phase == "lunch":
            anchor = now.replace(hour=11, minute=30, second=0, microsecond=0)
        if phase == "auction" and now.hour * 60 + now.minute >= 565:
            anchor = now.replace(hour=9, minute=25, second=0, microsecond=0)
        if (anchor - source).total_seconds() > POLICY["maxSourceAgeSeconds"]:
            return "STALE_TIME"
    computed = (row["price"] / row["last_close"] - 1) * 100
    if not finite(row.get("change_pct")) or abs(computed - row["change_pct"]) > 0.025:
        return "INVALID_CHANGE"
    return "VALID"


def capture(companies, context=None, fetch=None, observed_at=None):
    context = context or session()
    fetch = fetch or sd.tencent_quote_snapshot
    started = datetime.now(CN)
    clock = time.monotonic()
    symbols = [c["exchange"].lower() + c["code"] for c in companies]
    identity = {c["exchange"].lower() + c["code"]: c for c in companies}
    rows, batches = {}, []
    def work(batch):
        begin = datetime.now(CN)
        try:
            values = fetch(batch)
            end = datetime.now(CN)
            return values, {"symbols": batch, "startedAt": begin.isoformat(), "endedAt": end.isoformat(), "hashes": sorted({v.get("raw_sha256", "") for v in values.values()}), "error": None}
        except Exception as exc:
            return {}, {"symbols": batch, "startedAt": begin.isoformat(), "endedAt": datetime.now(CN).isoformat(), "hashes": [], "error": f"{type(exc).__name__}: {exc}"}
    with ThreadPoolExecutor(max_workers=POLICY["workers"]) as pool:
        futures = [pool.submit(work, symbols[i:i + POLICY["batchSize"]]) for i in range(0, len(symbols), POLICY["batchSize"])]
        for future in as_completed(futures):
            values, batch = future.result()
            batches.append(batch)
            for symbol in batch["symbols"]:
                row = values.get(symbol)
                if row:
                    row["volumeUnit"] = "shares" if identity[symbol]["board"] == "科创板" else "lots100"
                    row["volumeShares"] = row["volume_source"] * (1 if row["volumeUnit"] == "shares" else 100) if finite(row.get("volume_source")) else None
                status = "ERROR" if batch["error"] else validate_row(symbol, row, context, observed_at or datetime.now(CN))
                rows[symbol[2:]] = {"symbol": symbol, "status": status, "source": row}
    ended = datetime.now(CN)
    counts = dict(Counter(r["status"] for r in rows.values()))
    # A current, valid zero-turnover row is covered but is not ranked as a trade.
    coverage = (counts.get("VALID", 0) + counts.get("NO_TRADES", 0)) / len(symbols) if symbols else 0
    elapsed = time.monotonic() - clock
    failures = []
    if started.date() != ended.date(): failures.append("collection crossed calendar date")
    if elapsed > POLICY["maxCollectionSeconds"]: failures.append("collection span exceeds policy")
    if coverage < POLICY["minValidCoverage"]: failures.append("valid coverage below policy")
    valid_times = sorted(r["source"]["source_time"] for r in rows.values() if r["status"] == "VALID")
    return {"version": "market-source-capture-1", "policy": POLICY, "context": context,
            "startedAt": started.isoformat(), "endedAt": ended.isoformat(), "collectionSeconds": round(elapsed, 3),
            "universeCount": len(symbols), "counts": counts, "validCoverage": coverage,
            "rankingCoverage": counts.get("VALID", 0) / len(symbols) if symbols else 0, "publishable": not failures,
            "failures": failures, "sourceTimeMin": valid_times[0] if valid_times else None,
            "sourceTimeMax": valid_times[-1] if valid_times else None, "batches": sorted(batches, key=lambda b: b["symbols"][0]), "rows": dict(sorted(rows.items()))}


def pilot(full=False):
    raw = (REPO / "data" / "companies.json").read_bytes()
    companies = json.loads(raw)["companies"]
    if not full:
        selected = {}
        for exchange in ("SH", "SZ", "BJ"):
            for c in sorted((c for c in companies if c["exchange"] == exchange), key=lambda c: c["code"])[:8]: selected[c["code"]] = c
        for group in [sorted(companies, key=lambda c: c.get("listedAt") or "", reverse=True)[:8], [c for c in companies if "ST" in c["name"]][:8]]:
            for c in group: selected[c["code"]] = c
        companies = list(selected.values())
    result = capture(companies)
    result["universeSha16"] = hashlib.sha256(raw).hexdigest()[:16]
    pointer = REPO / "data" / "market-runtime" / "current.json"
    directory = REPO / "data" / "market"
    if pointer.exists(): directory = pointer.parent / "snapshots" / json.loads(pointer.read_text())["snapshotId"]
    daily_file = directory / "daily" / f"{result['context']['tradeDate']}.jsonl"
    if daily_file.exists():
        daily = {r["code"]: r for r in map(json.loads, daily_file.read_text(encoding="utf8").splitlines())}
        checks = Counter()
        for code, captured in result["rows"].items():
            if captured["status"] != "VALID" or code not in daily: continue
            quote, day = captured["source"], daily[code]
            checks["compared"] += 1
            if abs(quote["price"] - day["close"]) <= 0.011: checks["priceMatches"] += 1
            if abs(quote["volumeShares"] - day["volume"]) <= 100: checks["volumeUnitMatches"] += 1
            if abs(quote["amount_precise_wan"] * 10000 - day["amount"]) <= max(1, day["amount"] * 0.0001): checks["amountUnitMatches"] += 1
        result["dailyAudit"] = dict(checks)
        if checks["compared"] and any(checks[k] / checks["compared"] < 0.995 for k in ("priceMatches", "volumeUnitMatches", "amountUnitMatches")):
            result["publishable"] = False
            result["failures"].append("daily unit/coherence audit below 99.5%")
    destination = REPO / "reports" / "MARKET_M2_RUNTIME"
    destination.mkdir(parents=True, exist_ok=True)
    file = destination / ("full-pool.json" if full else "pilot.json")
    file.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf8")
    print(json.dumps({k: v for k, v in result.items() if k not in ("rows", "batches", "policy")}, ensure_ascii=False))
    return result


if __name__ == "__main__":
    pilot("--full" in sys.argv)
