"""Evidence Coverage Expansion — full-pool annual report acquisition (Phase 3.6).

把全池 5567 家（authority = data/companies.json，不另抓名单，§14 company-agnostic）
的最新一期巨潮年报 PDF 抓到 data/raw/source_facts/<code>/annual-report-<FY>.pdf。
管线与 Pass 1 `source_coverage_fetch.py` 的年报通道逐字同源（orgId 映射 / hisAnnouncement
query / static.cninfo curl 下载 / 大小守卫），仅两处不同：

  1. 全池分片并行：--shard i --shards n 按代码排序取模分配，多进程各自独立断点；
  2. 逐公司失败语义落盘（§21）：SOURCE_UNAVAILABLE / NOT_IN_CNINFO_MAP /
     NO_ANNUAL_REPORT_ROW / DOWNLOAD_FAILED / SIZE_ANOMALY——网络失败与 source
     真空不混为一类，absence of evidence ≠ evidence of absence。

断点续跑：manifest 已有 annual-report-* artifact 且文件在盘 → 跳过（Pass 1 六家
pilot 的年报 acquisition 冻结不动，自然命中此规则）。

Usage (services venv python):
  python -u scripts/evidence_coverage_fetch_annual.py --shard 0 --shards 6 \
      --status-file data/raw/source_facts/_p36_annual_status_0.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import random
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

ROOT = Path(__file__).resolve().parent.parent
OUT_BASE = ROOT / "data" / "raw" / "source_facts"
STOCK_MAP_CACHE = ROOT / "data" / "sources" / "cninfo_stock_map.json"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "*/*"}
QUERY_URL = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
STATIC_BASE = "http://static.cninfo.com.cn/"
TITLE_EXCLUDE = re.compile(r"摘要|英文|已取消|修订版|UPDATE|ENGLISH", re.IGNORECASE)
TITLE_FY = re.compile(r"(\d{4})\s*年{0,2}度报告")
QUERY_WINDOW = "2024-01-01~2026-09-30"
PAUSE_BASE = 0.8
ATTEMPTS = 3


def sha256_of(path: Path) -> str:
    import hashlib
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def http_post_json(url: str, data: dict, timeout: int = 30) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={**UA, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get_curl(url: str, out_path: Path, timeout: int = 240) -> None:
    """static.cninfo 直连即可；curl 兜底处理 TLS 指纹挑战（Pass 1 同款）。"""
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
        "category": "category_ndbg_szsh", "trade": "", "seDate": QUERY_WINDOW,
        "sortName": "", "sortType": "", "isHLtitle": "true",
    }
    rows = http_post_json(QUERY_URL, payload).get("announcements") or []
    candidates = []
    for row in rows:
        title = row.get("announcementTitle") or ""
        if TITLE_EXCLUDE.search(title):
            continue
        match = TITLE_FY.search(title)
        if not match:
            continue
        report_url = STATIC_BASE + row["adjunctUrl"]
        announced = row.get("announcementTime")
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


def query_with_retry(code: str, org_id: str) -> dict | None:
    last: Exception | None = None
    for attempt in range(ATTEMPTS):
        try:
            return pick_annual_report(code, org_id)
        except Exception as error:  # noqa: BLE001
            last = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"SOURCE_UNAVAILABLE: {type(last).__name__}: {str(last)[:150]}")


def fetch_one(code: str, stock_map: dict) -> dict:
    """返回 {status, ...}；ok 时附带 manifest artifact。绝不抛异常——失败也是结果。"""
    org = stock_map.get(code)
    if not org:
        return {"status": "NOT_IN_CNINFO_MAP"}
    try:
        report = query_with_retry(code, org["orgId"])
    except RuntimeError as error:
        return {"status": "SOURCE_UNAVAILABLE", "detail": str(error)[:200]}
    if not report:
        return {"status": "NO_ANNUAL_REPORT_ROW"}
    out_dir = OUT_BASE / code
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"annual-report-{report['fy']}.pdf"
    try:
        if not path.exists():
            time.sleep(0.3)
            http_get_curl(report["url"], path)
        size = path.stat().st_size
        if size < 50_000:
            path.unlink(missing_ok=True)
            return {"status": "SIZE_ANOMALY", "bytes": size, "url": report["url"]}
    except Exception as error:  # noqa: BLE001
        return {"status": "DOWNLOAD_FAILED", "detail": str(error)[:200], "url": report["url"]}
    return {
        "status": "OK",
        "artifact": {
            "file": path.name,
            "sha256": sha256_of(path),
            "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "url": report["url"],
            "title": report["title"],
            "fiscalYear": report["fy"],
            "filingDate": report["filingDate"],
            "bytes": size,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--status-file", required=True)
    args = parser.parse_args()

    companies = json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))
    company_list = companies if isinstance(companies, list) else companies.get("companies", [])
    codes = sorted(c["code"] for c in company_list)
    mine = [c for i, c in enumerate(codes) if i % args.shards == args.shard]
    print(f"shard {args.shard}/{args.shards}: {len(mine)} companies", flush=True)

    stock_map = load_stock_map()
    status_path = Path(args.status_file)
    status_path.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    started = time.time()
    for idx, code in enumerate(mine):
        out_dir = OUT_BASE / code
        manifest_path = out_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"code": code, "artifacts": []}
        cached = next((a for a in manifest.get("artifacts", []) if str(a.get("file", "")).startswith("annual-report-")), None)
        if cached and (out_dir / str(cached["file"])).exists():
            result = {"status": "CACHED", "file": cached["file"]}
        else:
            result = fetch_one(code, stock_map)
            if result.get("artifact"):
                manifest["artifacts"] = [a for a in manifest.get("artifacts", []) if not str(a.get("file", "")).startswith("annual-report-")]
                manifest["artifacts"].append(result["artifact"])
                manifest["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        counts[result["status"]] = counts.get(result["status"], 0) + 1
        status_path.open("a", encoding="utf-8").write(json.dumps(
            {"code": code, "status": result["status"], "file": result.get("artifact", {}).get("file") or result.get("file"),
             "detail": result.get("detail"), "at": time.strftime("%H:%M:%S")}, ensure_ascii=False) + "\n")
        if (idx + 1) % 25 == 0:
            rate = (idx + 1) / (time.time() - started) * 60
            eta = (len(mine) - idx - 1) / max(rate / 60, 1e-9) / 60
            print(f"[shard {args.shard}] {idx + 1}/{len(mine)} {json.dumps(counts, ensure_ascii=False)} "
                  f"{rate:.1f}/min ETA {eta:.1f}h", flush=True)
        time.sleep(PAUSE_BASE + random.random() * 0.4)
    print(f"[shard {args.shard}] done: {json.dumps(counts, ensure_ascii=False)}", flush=True)


if __name__ == "__main__":
    main()
