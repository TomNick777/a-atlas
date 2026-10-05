"""Fetch the full A-share universe into data/raw. Safe to re-run: every response is cached.

Usage:
  python scripts/fetch_companies.py [--limit N] [--threads N]

Without --limit it walks every name in the exchange list (names.json / spot.json).
ST / *ST companies stay in the pool: they are still listed companies.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import time
from pathlib import Path

# Eastmoney and cninfo fail through the local proxy. This process only talks to those feeds.
os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"
socket.setdefaulttimeout(25)

import akshare as ak
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PAUSE = 0.3

# Acceptance-test companies first, so a short run still covers the eval set.
SEED = [
    "603650", "300346", "300655", "300576", "688981",
    "601138", "300308", "002463", "002837", "688111", "600588",
    "000338", "000903", "002765", "000625",
    "002595",
    "300054", "688019", "002409", "688347",
    "002747", "688017", "002472",
    "600406", "000400", "600312",
    "600031", "000039",
    "600519", "000858", "000333", "000651", "600036", "601318", "600030",
    "002415", "000063", "600276", "600887", "601012", "300750", "002594",
    "600104", "000001", "601166", "600900", "601668", "601390", "600585",
    "002371", "688012", "603501", "002475", "000725", "002241", "300124",
    "601766", "000157", "600660", "002352", "300760", "603259", "600196",
    "002230", "600941", "601728", "000977", "688256", "002049", "603986",
    "600089", "601179", "002028", "300274", "601012",
]

def announce(message: str) -> None:
    print(message, flush=True)


def records(df: pd.DataFrame | None) -> list[dict]:
    if df is None or df.empty:
        return []
    return json.loads(df.to_json(orient="records", force_ascii=False))


def call(name: str, fn, attempts: int = 3):
    last = None
    for attempt in range(attempts):
        try:
            return fn()
        except Exception as error:  # noqa: BLE001 - upstream feeds fail in different ways
            last = error
            announce(f"  retry {name} ({attempt + 1}): {error}")
            time.sleep(1.2 * (attempt + 1))
    announce(f"  give up {name}: {last}")
    return None


def cached(path: Path, fn):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    path.parent.mkdir(parents=True, exist_ok=True)
    value = fn()
    if not value:
        return []
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    return value


def code_of(row: dict) -> str:
    for key in ("代码", "code", "股票代码"):
        if row.get(key) is not None:
            return str(row[key]).split(".")[0].zfill(6)
    return ""


def name_of(row: dict) -> str:
    for key in ("名称", "name", "股票简称"):
        if row.get(key):
            return str(row[key]).replace(" ", "")
    return ""


def market_of(code: str) -> str:
    if code.startswith(("43", "83", "87", "88", "92")):
        return "BJ"
    if code.startswith(("6", "9")):
        return "SH"
    return "SZ"


def load_universe() -> dict[str, dict]:
    spot_path = RAW / "spot.json"
    rows = cached(spot_path, lambda: records(call("spot", ak.stock_zh_a_spot_em)))
    if not rows:
        names = cached(RAW / "names.json", lambda: records(call("names", ak.stock_info_a_code_name)))
        rows = names
    universe: dict[str, dict] = {}
    for row in rows:
        code = code_of(row)
        if not code or not code.isdigit() or len(code) != 6:
            continue
        # Exchange-listed A shares only: the prefix ranges below leave out
        # B shares (200/900), delisted books, and off-exchange NEEQ codes.
        if not code.startswith(("000", "001", "002", "003", "300", "301", "302", "600", "601", "603", "605", "688", "689", "43", "83", "87", "88", "92")):
            continue
        cap = row.get("总市值")
        try:
            cap_value = float(cap) if cap is not None else None
        except (TypeError, ValueError):
            cap_value = None
        universe[code] = {"code": code, "name": name_of(row), "marketCap": cap_value}
    return universe


def one(symbol: str, fn):
    frame = call(symbol, fn)
    rows = records(frame)
    return rows[0] if rows else None


def fetch_profile(code: str, name: str, market_cap: float | None) -> bool:
    path = RAW / "companies" / f"{code}.json"
    if path.exists():
        return True
    profile = one(code, lambda: ak.stock_profile_cninfo(symbol=code))
    zyjs_rows = records(call(f"zyjs {code}", lambda: ak.stock_zyjs_ths(symbol=code)))
    market = market_of(code)
    zygc = records(call(f"zygc {code}", lambda: ak.stock_zygc_em(symbol=f"{market}{code}")))
    if profile is None and not zyjs_rows and not zygc:
        announce(f"  {code} {name}: all sources failed, will retry next run")
        return False
    payload = {
        "code": code,
        "name": name,
        "marketCap": market_cap,
        "profile": profile,
        "zyjs": zyjs_rows[0] if zyjs_rows else None,
        "zygc": zygc,
        "concepts": [],
        "industryBoard": "",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    time.sleep(PAUSE)
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="stop after N companies total (0 = all)")
    parser.add_argument("--shard", default="0/1", help="i/n: run slice i of n (start one process per slice)")
    args = parser.parse_args()
    shard_at, shard_count = (int(part) for part in args.shard.split("/"))

    RAW.mkdir(parents=True, exist_ok=True)
    universe = load_universe()
    announce(f"listed names: {len(universe)}")
    if len(universe) < 100:
        raise SystemExit("stock list came back almost empty; check the network and rerun")

    codes: list[str] = []
    for code in SEED:
        if code in universe:
            codes.append(code)
    codes.extend(sorted(set(universe) - set(codes)))
    # One process per shard: akshare builds a fresh V8 (py_mini_racer) inside every
    # cninfo profile call, and two of those in one process race V8's pool init to a
    # hard crash. Separate processes, serial calls inside, shared per-code cache.
    codes = codes[shard_at::shard_count]
    if args.limit:
        codes = codes[: args.limit]

    done = 0
    skipped: list[str] = []
    for index, code in enumerate(codes):
        if fetch_profile(code, universe[code]["name"], universe[code]["marketCap"]):
            done += 1
            if done % 100 == 0:
                announce(f"[{done}] cached, at #{index + 1}/{len(codes)}")
        else:
            skipped.append(code)

    fetched = sorted(path.stem for path in (RAW / "companies").glob("*.json"))
    (RAW / "universe.json").write_text(json.dumps(fetched, ensure_ascii=False, indent=2), encoding="utf-8")
    announce(f"shard {args.shard}: cached {done}/{len(codes)}, {len(skipped)} need a rerun")


if __name__ == "__main__":
    main()
