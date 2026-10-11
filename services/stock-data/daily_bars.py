"""Validated point-in-time daily cache. Missing cache is coverage, not absence."""
import json
import math
import os
import re
from pathlib import Path
from datetime import datetime, timezone, timedelta

ROOT = Path(os.environ.get("ATLAS_ARTIFACT_ROOT", Path(__file__).resolve().parents[2])).resolve()

def daily_bars(symbol, root=None):
    base = {"symbol": symbol, "source": "akshare · 东财日线", "fetchedAt": None, "asOf": None, "adjust": "qfq", "timeframe": "1d", "currency": "CNY", "volumeUnit": None, "bars": []}
    if not isinstance(symbol, str) or not re.fullmatch(r"[0-9]{6}", symbol):
        return dict(base, available="error", error="证券代码格式错误")
    directory = Path(root) if root is not None else ROOT / "data/raw/daily"
    path = directory / f"{symbol}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return dict(base, available="unavailable", error="该标的尚无已采集日线")
    except (OSError, ValueError) as exc:
        return dict(base, available="error", error=f"日线缓存不可读取：{type(exc).__name__}")
    try:
        if payload.get("code") != symbol or payload.get("adjust") != "qfq" or payload.get("timeframe") != "1d":
            raise ValueError("identity/adjust/timeframe mismatch")
        if not isinstance(payload.get("source"), str) or not payload["source"].strip() or payload.get("volumeUnit") not in ("手", "股") or payload.get("currency", "CNY") != "CNY":
            raise ValueError("source/currency/volume-unit missing or unsupported")
        acquired = datetime.fromisoformat(payload["fetchedAt"])
        if acquired.tzinfo is None:
            raise ValueError("acquisition time requires timezone")
        bars = payload["bars"]
        if not isinstance(bars, list): raise ValueError("bars must be an array")
        previous = -1
        for row in bars:
            numbers = [row[key] for key in ("t", "o", "h", "l", "c", "v")]
            if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in numbers): raise ValueError("invalid numeric field")
            t,o,h,l,c,v = numbers
            if t != int(t) or t <= previous or t <= 0 or min(o,h,l,c) <= 0 or v < 0 or l > min(o,c) or h < max(o,c) or l > h: raise ValueError("invalid OHLC/order")
            previous = t
        as_of = datetime.fromtimestamp(bars[-1]["t"] / 1000, timezone(timedelta(hours=8))).date().isoformat() if bars else None
        if bars and payload.get("end") != as_of or payload.get("count", len(bars)) != len(bars):
            raise ValueError("last trading date/count mismatch")
        base.update(source=payload["source"], asOf=as_of, fetchedAt=payload["fetchedAt"], bars=bars, volumeUnit=payload["volumeUnit"])
        return dict(base, available="ok" if bars else "empty")
    except (KeyError, TypeError, ValueError) as exc:
        return dict(base, available="error", error=f"日线结构校验失败：{exc}")
