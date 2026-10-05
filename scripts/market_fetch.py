"""Build-time Market Intelligence ingestion (Phase 1) — Market Data capture.

Fetches the vendor full-market daily package (one per completed A-share trading
day, via services/stock-data/generated/stock_data.py — extracted from the
pinned a-stock-data snapshot, never hand-copied) plus the Tencent batch quote
snapshot for the latest captured day, and writes the Market Data artifacts:

  data/market/ingest.json          capture manifest (provenance + audits)
  data/market/daily/<date>.jsonl   objective daily rows for the company pool
  data/market/quote/<date>.json    Tencent snapshot for the latest captured day

Layer discipline: this script only captures objective vendor rows (Market Data
layer). All derivation (pct_change, limit classification, streaks, returns,
volume ratios) happens deterministically in TypeScript —
scripts/build_market_state.ts reads these artifacts and nothing else.

Determinism: day files depend only on the vendor package bytes and the company
universe (fetchedAt / generatedAt live in ingest.json and quote files, which
are capture records, not derived artifacts). All JSONL is LF, byte-pinned via
.gitattributes, matching the corpus convention.

Universe: data/companies.json (the Atlas company pool) is the authority. Rows
are matched on (market, code) — the package mixes markets under one code space
(sh 000001 is the SSE index, sz 000001 is 平安银行), so a code-only match is
wrong by construction. Rows outside the pool are counted in ingest.json, never
stored.

Quote snapshot date attribution: the Tencent snapshot has no trade-date field
and qt.gtimg.cn serves "latest session" data that can lag around the close, so
a snapshot is only committed for the latest captured trading day D after a
coherence audit against day file D (last_close vs prev_close, price vs close,
change_pct vs derived pct on ≥99.5% / ≥99% of comparable pool rows). A snapshot
belonging to any other session fails the audit and is discarded — turnover is
then simply absent for D (recorded honestly), never misattributed.

Usage: python scripts/market_fetch.py [--window 60] [--lookback 130]
                                      [--force] [--skip-quote] [--force-quote]

Stdlib + requests + pandas (via the generated module) only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services" / "stock-data" / "generated"))
import stock_data as sd  # noqa: E402  (path inserted above)

DATA_DIR = REPO / "data" / "market"
DAILY_DIR = DATA_DIR / "daily"
QUOTE_DIR = DATA_DIR / "quote"
INGEST_JSON = DATA_DIR / "ingest.json"
UNIVERSE_JSON = REPO / "data" / "companies.json"

INGESTER_VERSION = "market-fetch-1.0.0"
SCHEMA_VERSION = "1.0.0"

CN_TZ = timezone(timedelta(hours=8))  # A股的"今天"按北京时间算（同 vendor cn_today）
QUOTE_BATCH = 50
QUOTE_WORKERS = 4
FETCH_WORKERS = 3
FETCH_PAUSE_S = 0.25

# Coherence audit thresholds: a snapshot that belongs to a different session
# than the day file it is audited against disagrees massively on these rates.
COHERENCE_MIN_RATE = 0.995
COHERENCE_MIN_PCT_RATE = 0.99
PRICE_TOL = 0.011  # both sides are 2-decimal prices
PCT_TOL = 0.02  # change_pct is rounded to 2 decimals upstream

_lock = threading.Lock()
_audit_failures: list[str] = []


def now_iso() -> str:
    return datetime.now(CN_TZ).isoformat(timespec="seconds")


def sha16(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def log(msg: str) -> None:
    with _lock:
        print(msg, flush=True)


def load_universe() -> tuple[dict[str, str], dict]:
    """code -> market ('sh'|'sz'|'bj'), straight from companies.json exchange."""
    raw = UNIVERSE_JSON.read_bytes()
    doc = json.loads(raw.decode("utf-8"))
    companies = doc["companies"]
    market_of = {}
    for c in companies:
        market_of[c["code"]] = c["exchange"].lower()
    return market_of, {
        "dataset": "data/companies.json",
        "sha16": sha16(raw),
        "generatedAt": doc.get("generatedAt"),
        "count": len(companies),
    }


def head_exists(date_iso: str) -> bool:
    """Existence probe for one day package. The URL pattern is the vendor's own
    constant (sd.TDX_PACKAGE_URL); this is a transport check only — parsing is
    always done by the vendor function."""
    ymd = date_iso.replace("-", "")
    url = sd.TDX_PACKAGE_URL.format(ymd=ymd)
    req = urlrequest.Request(url, method="HEAD")
    try:
        with urlrequest.urlopen(req, timeout=20):
            return True
    except urlerror.HTTPError as exc:
        if exc.code == 404:
            return False
        raise
    except (urlerror.URLError, TimeoutError, OSError):
        raise


def fetch_day_package(date_iso: str) -> list[dict]:
    """Vendor parse of one day package → raw rows (all markets, all securities)."""
    frame = sd.tdx_daily_package(date_iso)
    return frame.to_dict("records")


def day_file_path(date_iso: str) -> Path:
    return DAILY_DIR / f"{date_iso}.jsonl"


def build_day_rows(date_iso: str, raw_rows: list[dict], market_of: dict[str, str]) -> tuple[bytes, dict]:
    """Filter the package to the company pool on (market, code) and serialize.

    Row shape is the objective vendor row: no derived fields, no pct_change —
    derivation belongs to the Market State layer.
    """
    kept: list[dict] = []
    dropped_non_pool = 0
    dropped_market_mismatch = 0
    dropped_nonpositive_close = 0
    for r in raw_rows:
        code = r["code"]
        if code not in market_of:
            dropped_non_pool += 1
            continue
        if r["market"] != market_of[code]:
            dropped_market_mismatch += 1
            continue
        close = r["close"]
        if close <= 0:
            dropped_nonpositive_close += 1
            continue
        kept.append({
            "date": r["date"],
            "code": code,
            "market": r["market"],
            "name": r["name"],
            "prevClose": r["prev_close"],
            "open": r["open"],
            "high": r["high"],
            "low": r["low"],
            "close": close,
            "volume": r["volume"],
            "amount": r["amount"],
        })
    kept.sort(key=lambda row: row["code"])
    body = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in kept).encode("utf-8")
    stats = {
        "rows": len(kept),
        "droppedNonPool": dropped_non_pool,
        "droppedMarketMismatch": dropped_market_mismatch,
        "droppedNonPositiveClose": dropped_nonpositive_close,
    }
    return body, stats


def capture_trading_calendar(window: int, lookback: int) -> tuple[list[str], dict]:
    """Most recent `window` trading days (HEAD probes walk back from today)."""
    today = datetime.now(CN_TZ).date()
    trading: list[str] = []
    probe_failures = 0
    for offset in range(lookback):
        day = today - timedelta(days=offset)
        iso = day.isoformat()
        try:
            if head_exists(iso):
                trading.append(iso)
        except Exception as exc:  # transport hiccup: retry once, then give up loudly
            probe_failures += 1
            if probe_failures > 5:
                raise RuntimeError(f"day-package existence probe failed repeatedly at {iso}: {exc}") from exc
            time.sleep(1.0)
            if head_exists(iso):
                trading.append(iso)
        if len(trading) >= window:
            break
    if len(trading) < window:
        raise RuntimeError(
            f"only found {len(trading)} trading days within {lookback} calendar days "
            f"(window {window}) — vendor retention or network problem"
        )
    trading.sort(reverse=True)  # most recent first
    return trading, {"probedCalendarDays": offset + 1, "probeFailures": probe_failures}


def fetch_missing_days(dates: list[str], market_of: dict[str, str], force: bool) -> dict[str, dict]:
    """Download + write day files for dates without one. Returns per-date stats."""
    todo = [d for d in dates if force or not day_file_path(d).exists()]
    stats: dict[str, dict] = {}

    def work(date_iso: str) -> None:
        t0 = time.time()
        try:
            raw_rows = fetch_day_package(date_iso)
        except ValueError as exc:
            # 404: package vanished between HEAD probe and fetch (or retained gap)
            raise RuntimeError(f"{date_iso}: package disappeared after existence probe: {exc}") from exc
        body, day_stats = build_day_rows(date_iso, raw_rows, market_of)
        path = day_file_path(date_iso)
        path.write_bytes(body)
        day_stats["sha16"] = sha16(body)
        day_stats["fetchedAt"] = now_iso()
        day_stats["elapsedS"] = round(time.time() - t0, 1)
        with _lock:
            stats[date_iso] = day_stats
        log(f"  fetched {date_iso}: {day_stats['rows']} rows ({day_stats['elapsedS']}s)")

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futures = []
        for i, date_iso in enumerate(todo):
            if i:
                time.sleep(FETCH_PAUSE_S)
            futures.append(pool.submit(work, date_iso))
            if len(futures) >= 8:  # bound the dispatch queue so pauses apply
                done = futures.pop(0)
                done.result()
        for f in futures:
            f.result()
    return stats


def derived_pct(row: dict) -> float | None:
    prev = row.get("prevClose")
    close = row.get("close")
    if not prev or not close or prev <= 0:
        return None
    return (close / prev - 1) * 100


def capture_quote_snapshot(target: str, market_of: dict[str, str], force: bool) -> dict:
    """Tencent batch snapshot for the latest captured trading day + coherence audit.

    The vendor tencent_quote() output carries last_close / price / change_pct,
    so one fetch serves both the committed snapshot rows and the coherence
    audit. On audit failure nothing is committed and available=false records
    the reason — turnover for the day stays absent, never misattributed.
    """
    path = QUOTE_DIR / f"{target}.json"
    if path.exists() and not force:
        doc = json.loads(path.read_text(encoding="utf-8"))
        log(f"quote snapshot for {target} already present (lastCloseMatchRate {doc.get('coherence', {}).get('lastCloseMatchRate')})")
        return {"available": True, "reusedExisting": True, "date": target}

    codes = sorted(market_of)
    batches = [codes[i:i + QUOTE_BATCH] for i in range(0, len(codes), QUOTE_BATCH)]
    raw_rows: dict[str, dict] = {}
    failed_batches: list[str] = []

    def work(batch: list[str]) -> None:
        # Explicit market prefixes from the pool authority. sd.get_prefix() has
        # an index-vs-stock ambiguity: six SZ stock codes (000010/000016/000300/
        # 000688/000852/000905) collide with SH index codes and the vendor
        # router prefers the index — tencent_quote() accepts an explicit
        # sh/sz/bj passthrough, which is always correct here.
        prefixed = [f"{market_of[c]}{c}" for c in batch]
        result = None
        for attempt in (1, 2, 3):
            try:
                result = sd.tencent_quote(prefixed)
                break
            except Exception as exc:
                if attempt == 3:
                    with _lock:
                        failed_batches.append(batch[0])
                        _audit_failures.append(f"batch {batch[0]}: {type(exc).__name__}: {exc}")
                    return
                time.sleep(1.5 * attempt)
        time.sleep(FETCH_PAUSE_S)
        with _lock:
            for c in batch:
                r = result.get(f"{market_of[c]}{c}") or result.get(c)
                if r:
                    raw_rows[c] = r

    with ThreadPoolExecutor(max_workers=QUOTE_WORKERS) as pool:
        futures = [pool.submit(work, b) for b in batches]
        for f in as_completed(futures):
            f.result()

    day_rows: dict[str, dict] = {}
    with day_file_path(target).open("r", encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            day_rows[row["code"]] = row

    # --- coherence audit: does this snapshot belong to the target session? ---
    checked = last_close_ok = price_ok = pct_ok = 0
    worst = {"lastClose": 0.0, "price": 0.0, "pct": 0.0}
    for code, r in raw_rows.items():
        d = day_rows.get(code)
        if not d or r.get("is_stale"):
            continue
        checked += 1
        dl = abs(r["last_close"] - d["prevClose"])
        dp = abs(r["price"] - d["close"])
        pct = derived_pct(d)
        dc = abs(r["change_pct"] - pct) if pct is not None else None
        worst["lastClose"] = max(worst["lastClose"], dl)
        worst["price"] = max(worst["price"], dp)
        worst["pct"] = max(worst["pct"], dc or 0.0)
        if dl <= PRICE_TOL:
            last_close_ok += 1
        if dp <= PRICE_TOL:
            price_ok += 1
        if dc is not None and dc <= PCT_TOL:
            pct_ok += 1

    failed_batches.sort()
    if checked < 1000:
        return {
            "available": False,
            "date": target,
            "reason": f"coherence audit sample too small ({checked} comparable rows; failedBatches={failed_batches[:5]})",
            "failedBatches": failed_batches,
        }
    rates = {
        "checked": checked,
        "lastCloseMatchRate": round(last_close_ok / checked, 5),
        "priceMatchRate": round(price_ok / checked, 5),
        "changePctMatchRate": round(pct_ok / checked, 5),
        "worstAbsDiff": {k: round(v, 4) for k, v in worst.items()},
    }
    if (
        rates["lastCloseMatchRate"] < COHERENCE_MIN_RATE
        or rates["priceMatchRate"] < COHERENCE_MIN_RATE
        or rates["changePctMatchRate"] < COHERENCE_MIN_PCT_RATE
    ):
        return {
            "available": False,
            "date": target,
            "reason": "coherence audit failed — snapshot likely belongs to another session; nothing committed",
            "coherence": rates,
            "failedBatches": failed_batches,
        }

    rows = {}
    for c, r in raw_rows.items():
        limit_up = r.get("limit_up")
        limit_down = r.get("limit_down")
        rows[c] = {
            "turnoverPct": r.get("turnover_pct"),
            "marketCapYi": r.get("mcap_yi"),
            "floatMarketCapYi": r.get("float_mcap_yi"),
            "limitUp": limit_up if limit_up and limit_up > 0 else None,
            "limitDown": limit_down if limit_down and limit_down > 0 else None,
            "stale": bool(r.get("is_stale")),
        }

    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "date": target,
        "source": "腾讯",
        "sourceUrl": "https://qt.gtimg.cn/q=",
        "vendorFunction": "tencent_quote",
        "fetchedAt": now_iso(),
        "coherence": rates,
        "failedBatches": failed_batches,
        "fetchErrors": sorted(_audit_failures)[:20],
        "rowCount": len(rows),
        "rows": dict(sorted(rows.items())),
    }
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n"
    path.write_bytes(body.encode("utf-8"))
    log(f"quote snapshot {target}: {len(rows)} rows, coherence lastClose={rates['lastCloseMatchRate']} price={rates['priceMatchRate']} pct={rates['changePctMatchRate']}")
    return {"available": True, "date": target, "rowCount": len(rows), "coherence": rates, "failedBatches": failed_batches}


def main() -> int:
    global DATA_DIR, DAILY_DIR, QUOTE_DIR, INGEST_JSON
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--window", type=int, default=60, help="trading-day window size")
    parser.add_argument("--lookback", type=int, default=130, help="calendar days to probe back")
    parser.add_argument("--force", action="store_true", help="refetch day files that already exist")
    parser.add_argument("--skip-quote", action="store_true", help="skip the Tencent snapshot capture")
    parser.add_argument("--force-quote", action="store_true", help="recapture the quote snapshot even if present")
    parser.add_argument("--data-dir", type=Path, help="separate runtime capture directory; default is the committed baseline")
    parser.add_argument("--dates-file", type=Path, help="verified exchange calendar trading dates (JSON array); missing vendor packages fail capture")
    args = parser.parse_args()

    if args.data_dir:
        DATA_DIR = args.data_dir.resolve()
        DAILY_DIR = DATA_DIR / "daily"
        QUOTE_DIR = DATA_DIR / "quote"
        INGEST_JSON = DATA_DIR / "ingest.json"

    DAILY_DIR.mkdir(parents=True, exist_ok=True)
    QUOTE_DIR.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    market_of, universe_meta = load_universe()
    print(f"universe: {universe_meta['count']} companies from {universe_meta['dataset']} (sha16 {universe_meta['sha16']})")

    if args.dates_file:
        trading = json.loads(args.dates_file.read_text(encoding="utf-8"))
        if not isinstance(trading, list) or not trading or any(not isinstance(d, str) or len(d) != 10 for d in trading):
            raise ValueError("dates-file must contain ISO trading dates")
        trading = sorted(set(trading), reverse=True)
        probe_meta = {"calendar": "verified exchange calendar", "datesFile": str(args.dates_file)}
    else:
        trading, probe_meta = capture_trading_calendar(args.window, args.lookback)
    window = trading[: args.window]
    print(f"trading calendar: {len(trading)} trading days found, window {window[-1]}..{window[0]} ({len(window)} days)")

    existing = [d for d in window if day_file_path(d).exists()]
    print(f"day files present: {len(existing)}/{len(window)}; fetching {len(window) - len(existing)}")

    daily_stats = fetch_missing_days(window, market_of, args.force)

    daily_manifest = {}
    for d in window:
        path = day_file_path(d)
        if d in daily_stats:
            daily_manifest[d] = daily_stats[d]
            continue
        if path.exists():
            body = path.read_bytes()
            first = json.loads(body.splitlines()[0])
            daily_manifest[d] = {
                "rows": len(body.splitlines()),
                "sha16": sha16(body),
                "previouslyCaptured": True,
                "droppedNonPool": None,
                "note": "captured by an earlier ingest; universe-filtered counts live in that run's manifest",
                "sampleCode": first["code"],
            }
        else:
            raise RuntimeError(f"{d}: day file missing after fetch phase")

    quote_entry: dict = {"available": False, "reason": "skipped by --skip-quote"}
    if not args.skip_quote:
        quote_entry = capture_quote_snapshot(window[0], market_of, args.force_quote)

    ingest = {
        "schemaVersion": SCHEMA_VERSION,
        "ingesterVersion": INGESTER_VERSION,
        "generatedAt": now_iso(),
        "universe": universe_meta,
        "window": {"tradingDays": len(window), "start": window[-1], "end": window[0]},
        "tradingDays": window,
        "probe": probe_meta,
        "daily": dict(sorted(daily_manifest.items(), reverse=True)),
        "quote": quote_entry,
        "sources": {
            "daily": "通达信官网每日盘后包（vendor tdx_daily_package，全市场解析后按公司池过滤）",
            "quote": "腾讯财经批量行情快照（vendor tencent_quote，仅最新捕获交易日）",
        },
        "limitations": [
            "日线只有盘后包存在的交易日（非交易日/包未发布 → 该日不存在，绝不补）",
            "换手率/市值只覆盖有腾讯快照的交易日（Phase 1 只采最新捕获日），历史日如实为空",
            "涨跌停价不在本层判定——由 Market State 层按板块规则确定性计算，腾讯 limit 字段仅作交叉审计",
            "盘中运行本脚本不会污染数据：当日包未发布则 latest 停在前一交易日；快照一致性闸门拒绝错日归属",
        ],
    }
    INGEST_JSON.write_bytes((json.dumps(ingest, ensure_ascii=False, indent=1, sort_keys=False) + "\n").encode("utf-8"))
    print(f"ingest.json written ({round(time.time() - t0, 1)}s total)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
