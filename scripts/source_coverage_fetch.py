"""Source Coverage Pass 1 — pilot acquisition (fetch side).

把每家 pilot 公司的原始 source 抓到 data/raw/source_facts/<code>/（gitignored 缓存）：

  feeds.json   akshare 三 feed 的完整 payload（zyjs / profile_cninfo / zygc 全历史行）——
               即 fetch_companies.py 已在用、但 normalize 层丢弃字段的同一批接口
  annual-report-<FY>.pdf
               巨潮最新年报 PDF（stage3_fetch_sources.py 同一管线），修 feeds 修不了的
               具体产品词（汇川/信捷的「伺服」、时代电气「IGBT」字面）
  manifest.json 逐文件 provenance：url + sha256 + retrievedAt（断点续跑依据）

纪律：只抓、只存原始 payload，不做任何提取（提取归 extract_facts 脚本）。
增量规则：manifest 已有同 url 且文件存在 → 跳过，禁止整库重抓。

Usage:
  # 用带 akshare 的 python 环境运行（本仓现成环境见 PROJECT_STATE 数据抓取节）
  python -u scripts/source_coverage_fetch.py --codes 000651,000333
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"
socket.setdefaulttimeout(30)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import akshare as ak

ROOT = Path(__file__).resolve().parent.parent
OUT_BASE = ROOT / "data" / "raw" / "source_facts"
STOCK_MAP_CACHE = ROOT / "data" / "sources" / "cninfo_stock_map.json"
PAUSE = 1.0

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "*/*"}
QUERY_URL = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
STATIC_BASE = "http://static.cninfo.com.cn/"
TITLE_EXCLUDE = re.compile(r"摘要|英文|已取消|修订版|UPDATE|ENGLISH", re.IGNORECASE)
TITLE_FY = re.compile(r"(\d{4})\s*年{0,2}度报告")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def records(df) -> list[dict]:
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
            print(f"  retry {name} ({attempt + 1}): {type(error).__name__}: {error}", flush=True)
            time.sleep(1.5 * (attempt + 1))
    print(f"  give up {name}: {last}", flush=True)
    return None


def market_of(code: str) -> str:
    return "SH" if code.startswith("6") else "SZ"


# ---------------- feeds (akshare) ----------------


def fetch_feeds(code: str, out_dir: Path) -> dict:
    payload = {
        "code": code,
        "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "zyjs": records(call(f"zyjs {code}", lambda: ak.stock_zyjs_ths(symbol=code))),
        "profile_cninfo": records(call(f"profile {code}", lambda: ak.stock_profile_cninfo(symbol=code))),
        "zygc": records(call(f"zygc {code}", lambda: ak.stock_zygc_em(symbol=f"{market_of(code)}{code}"))),
    }
    path = out_dir / "feeds.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return {
        "file": "feeds.json",
        "sha256": sha256_of(path),
        "retrievedAt": payload["retrievedAt"],
        "rows": {"zyjs": len(payload["zyjs"]), "profile_cninfo": len(payload["profile_cninfo"]), "zygc": len(payload["zygc"])},
    }


# ---------------- annual report (cninfo, stage3 同管线) ----------------


def http_post(url: str, data: dict, timeout: int = 30) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={**UA, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get_curl(url: str, out_path: Path, timeout: int = 180) -> None:
    """static.cninfo 直连即可；curl 兜底处理 TLS 指纹挑战。"""
    result = subprocess.run(
        ["curl", "-s", "-m", str(timeout), "-L", url,
         "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
         "-o", str(out_path)],
        capture_output=True,
    )
    if result.returncode != 0 or not out_path.exists() or out_path.stat().st_size < 1024:
        raise RuntimeError(f"download failed rc={result.returncode} size={out_path.stat().st_size if out_path.exists() else 0}")


def load_stock_map() -> dict:
    if STOCK_MAP_CACHE.exists():
        return json.loads(STOCK_MAP_CACHE.read_text(encoding="utf-8"))
    req = urllib.request.Request("http://www.cninfo.com.cn/new/data/szse_stock.json", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    mapping = {s["code"]: {"orgId": s["orgId"], "name": s["zwjc"]} for s in data["stockList"]}
    STOCK_MAP_CACHE.parent.mkdir(parents=True, exist_ok=True)
    STOCK_MAP_CACHE.write_text(json.dumps(mapping, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"stock map cached: {len(mapping)} orgs")
    return mapping


def column_for(code: str) -> str:
    if code.startswith(("60", "68", "90")):
        return "sse"
    if code.startswith(("43", "83", "87", "88", "92")):
        return "bj"
    return "szse"


def pick_annual_report(code: str, org_id: str) -> dict | None:
    payload = {
        "pageNum": 1, "pageSize": 30, "column": column_for(code), "tabName": "fulltext",
        "plate": "", "stock": f"{code},{org_id}", "searchkey": "", "secid": "",
        "category": "category_ndbg_szsh", "trade": "", "seDate": "2024-01-01~2026-09-28",
        "sortName": "", "sortType": "", "isHLtitle": "true",
    }
    rows = http_post(QUERY_URL, payload).get("announcements") or []
    candidates = []
    for row in rows:
        title = row.get("announcementTitle") or ""
        if TITLE_EXCLUDE.search(title):
            continue
        match = TITLE_FY.search(title)
        if not match:
            continue
        announced = row.get("announcementTime")
        report_url = STATIC_BASE + row["adjunctUrl"]
        filing_date = None
        try:
            filing_date = time.strftime("%Y-%m-%d", time.localtime(int(announced) / 1000))
        except (TypeError, ValueError):
            url_match = re.search(r"finalpage/(\d{4}-\d{2}-\d{2})/", report_url)
            filing_date = url_match.group(1) if url_match else None
        candidates.append({"fy": int(match.group(1)), "title": title, "url": report_url, "filingDate": filing_date})
    if not candidates:
        return None
    candidates.sort(key=lambda item: -item["fy"])
    return candidates[0]


def fetch_annual_report(code: str, stock_map: dict, out_dir: Path) -> dict | None:
    org = stock_map.get(code)
    if not org:
        print(f"  {code}: not in cninfo stock map")
        return None
    report = call(f"query {code}", lambda: pick_annual_report(code, org["orgId"]))
    if not report:
        print(f"  {code}: no annual report found")
        return None
    fy = report["fy"]
    path = out_dir / f"annual-report-{fy}.pdf"
    if not path.exists():
        time.sleep(PAUSE)
        http_get_curl(report["url"], path)
    size = path.stat().st_size
    if size < 50_000:
        raise RuntimeError(f"{code}: annual report suspiciously small ({size} bytes)")
    return {
        "file": path.name,
        "sha256": sha256_of(path),
        "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "url": report["url"],
        "title": report["title"],
        "fiscalYear": fy,
        "bytes": size,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codes", required=True, help="comma-separated 6-digit codes")
    parser.add_argument("--skip-annual", action="store_true", help="feeds only")
    args = parser.parse_args()
    codes = [c.strip() for c in args.codes.split(",") if c.strip()]

    stock_map = {} if args.skip_annual else load_stock_map()
    for code in codes:
        out_dir = OUT_BASE / code
        out_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = out_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"code": code, "artifacts": []}
        have = {a["file"] for a in manifest.get("artifacts", [])}

        if "feeds.json" not in have:
            print(f"[{code}] fetching feeds...", flush=True)
            entry = fetch_feeds(code, out_dir)
            manifest["artifacts"] = [a for a in manifest.get("artifacts", []) if a["file"] != "feeds.json"] + [entry]
            time.sleep(PAUSE)
        else:
            print(f"[{code}] feeds cached")

        if not args.skip_annual and not any(a["file"].startswith("annual-report-") for a in manifest.get("artifacts", [])):
            print(f"[{code}] fetching annual report...", flush=True)
            try:
                entry = fetch_annual_report(code, stock_map, out_dir)
            except Exception as error:  # noqa: BLE001 - record, don't kill the batch
                print(f"  {code}: annual report FAILED: {error}", flush=True)
                entry = None
            if entry:
                manifest["artifacts"].append(entry)
        elif args.skip_annual:
            pass
        else:
            print(f"[{code}] annual report cached")

        manifest["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    print("done")


if __name__ == "__main__":
    main()
