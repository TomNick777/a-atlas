"""Source Coverage Pass 2 — full-market Source A acquisition (fetch side).

把全池 5567 家（authority = data/companies.json，不另抓名单）的 Source A 三 feed
原始 payload 抓到 data/raw/source_facts/<code>/feeds.json（gitignored 缓存）。
与 Pass 1 `source_coverage_fetch.py` 的差别（其余规则逐字继承）：

  1. market_of 修复：北交所 92 前缀 → "BJ" 符号（Pass 1 的 scan 曾把 92 当 SZ，
     14 家 BJ 的 zygc 全部空手；实测 ak.stock_zygc_em("BJ920002") 返回 90 行）。
  2. 逐 feed 状态记录：feedStatus{zyjs,profile_cninfo,zygc} = ok|empty|error +
     rows + errorType。§11 要求网络失败与 source 真空不混为一类，这在 fetch 侧
     记录，extract 侧不感知（feeds.json 多一个键，extract 不读它）。
  3. 断点续跑按公司粒度：feeds.json 已存在且带 feedStatus → 跳过；
     存在但无 feedStatus（Pass 1 scan 遗留）→ 重抓（BJ 修复 + 状态补齐）；
     6 家 pilot 整体跳过（Pass 1 acquisition 冻结，facts 原样保留）。
  4. 阶段性持久化：每家公司抓完立即写 feeds.json + manifest.json（禁止全量跑完
     才落盘）；run 状态文件每 25 家刷新（进度/失败分类/续跑检查）。
  5. 年报通道冻结（§2.3）：本脚本永不下载年报 PDF。

Usage:
  services venv python -u scripts/source_coverage_fetch_full.py --codes-file data/raw/source_facts/_pass2_codes_A.txt --status-file data/raw/source_facts/_pass2_fetch_status_A.json
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"
socket.setdefaulttimeout(30)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import akshare as ak

ROOT = Path(__file__).resolve().parent.parent
OUT_BASE = ROOT / "data" / "raw" / "source_facts"
COMPANIES = ROOT / "data" / "companies.json"
PAUSE = 0.5
ATTEMPTS = 3

# Pass 1 pilot：acquisition 冻结，raw 缓存与 committed facts 原样保留。
PILOT = {"000651", "000333", "300124", "688320", "603416", "688187"}


def market_of(code: str) -> str:
    if code.startswith("6"):
        return "SH"
    if code.startswith(("43", "83", "87", "88", "92")):
        return "BJ"
    return "SZ"


def records(df) -> list[dict]:
    if df is None or df.empty:
        return []
    return json.loads(df.to_json(orient="records", force_ascii=False))


def call_feed(name: str, fn) -> tuple[list[dict], dict]:
    """3 次退避重试；返回 (rows, status)。ok/empty 是 source 侧事实，error 是网络侧。"""
    last = None
    for attempt in range(ATTEMPTS):
        try:
            rows = records(fn())
            return rows, {"status": "ok" if rows else "empty", "rows": len(rows)}
        except Exception as error:  # noqa: BLE001 - upstream feeds fail in different ways
            last = error
            if attempt < ATTEMPTS - 1:
                time.sleep(1.5 * (attempt + 1))
    return [], {
        "status": "error",
        "rows": 0,
        "errorType": type(last).__name__,
        "error": str(last)[:200],
    }


def fetch_feeds(code: str, out_dir: Path) -> dict:
    """三 feed 并行抓取（每 provider 的全局并发仍受分片数控制）。
    结果按 feed 名归位，payload 内容与串行一致（确定性不受线程序影响）。"""
    retrieved_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    jobs = {
        "zyjs": (f"zyjs {code}", lambda: ak.stock_zyjs_ths(symbol=code)),
        "profile_cninfo": (f"profile {code}", lambda: ak.stock_profile_cninfo(symbol=code)),
        "zygc": (f"zygc {code}", lambda: ak.stock_zygc_em(symbol=f"{market_of(code)}{code}")),
    }
    results: dict[str, tuple[list[dict], dict]] = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {name: pool.submit(call_feed, label, fn) for name, (label, fn) in jobs.items()}
        for name, future in futures.items():
            results[name] = future.result()
    zyjs, st_zyjs = results["zyjs"]
    profile, st_profile = results["profile_cninfo"]
    zygc, st_zygc = results["zygc"]
    payload = {
        "code": code,
        "retrievedAt": retrieved_at,
        "zyjs": zyjs,
        "profile_cninfo": profile,
        "zygc": zygc,
        "feedStatus": {"zyjs": st_zyjs, "profile_cninfo": st_profile, "zygc": st_zygc},
    }
    path = out_dir / "feeds.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return {
        "file": "feeds.json",
        "retrievedAt": retrieved_at,
        "rows": {"zyjs": len(zyjs), "profile_cninfo": len(profile), "zygc": len(zygc)},
        "feedStatus": payload["feedStatus"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codes", help="comma-separated 6-digit codes（缺省=companies.json 全池）")
    parser.add_argument("--codes-file", help="一行一码的文件（分片并行用）")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 家（试跑用）")
    parser.add_argument("--status-file", default=str(OUT_BASE / "_pass2_fetch_status.json"))
    args = parser.parse_args()

    companies = json.loads(COMPANIES.read_text(encoding="utf-8"))["companies"]
    known = {c["code"] for c in companies}
    if args.codes:
        codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    elif args.codes_file:
        codes = [line.strip() for line in Path(args.codes_file).read_text(encoding="utf-8").split("\n") if line.strip()]
    else:
        codes = [c["code"] for c in companies]
    unknown = [c for c in codes if c not in known]
    if unknown:
        raise SystemExit(f"codes not in companies.json authority: {unknown[:10]}")
    if args.limit:
        codes = codes[: args.limit]

    status_path = Path(args.status_file)
    status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "processed": 0, "fetched": 0, "skippedCached": 0, "skippedPilot": 0,
        "feedErrors": {}, "emptyFeeds": {},
    }

    def flush_status() -> None:
        status["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        status_path.write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding="utf-8")

    for index, code in enumerate(codes):
        if code in PILOT:
            status["skippedPilot"] += 1
            continue
        out_dir = OUT_BASE / code
        out_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = out_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"code": code, "artifacts": []}
        have = {a["file"]: a for a in manifest.get("artifacts", [])}
        feeds_entry = have.get("feeds.json")
        if feeds_entry and "feedStatus" in feeds_entry:
            status["skippedCached"] += 1
            continue

        entry = fetch_feeds(code, out_dir)
        manifest["artifacts"] = [a for a in manifest.get("artifacts", []) if a["file"] != "feeds.json"] + [entry]
        manifest["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

        status["fetched"] += 1
        for feed, st in entry["feedStatus"].items():
            if st["status"] == "error":
                status["feedErrors"].setdefault(code, {})[feed] = st["errorType"]
            elif st["status"] == "empty":
                status["emptyFeeds"].setdefault(code, {})[feed] = st["rows"]
        status["processed"] += 1
        if status["processed"] % 25 == 0:
            flush_status()
            rate_note = f" at ~{status['processed']} this shard"
            print(f"[{index + 1}/{len(codes)}] {code} done{rate_note}", flush=True)
        time.sleep(PAUSE)

    flush_status()
    print(f"done: fetched={status['fetched']} skippedCached={status['skippedCached']} skippedPilot={status['skippedPilot']}")


if __name__ == "__main__":
    main()
