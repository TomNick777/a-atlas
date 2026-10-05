# Stage 3 source fetcher — Tier 1 annual report PDFs from cninfo (巨潮资讯).
#
# universe.json 的 LEVEL A 公司,每家抓最新一期年度报告(优先 FY2025,回退 FY2024):
#   data/sources/semiconductor/<code>/annual-report-<FY>.pdf + manifest.json
#
# 增量规则(规格第十六节):manifest 已有同 sourceUrl 且文件存在 → 跳过下载;
# 否则下载、记 SHA256。禁止整库重抓。
#
# Usage: .venv/Scripts/python.exe -u scripts/stage3_fetch_sources.py [--limit N] [--codes 688012,002371]
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
OUT_BASE = ROOT / "data" / "sources" / "semiconductor"
UNIVERSE = ROOT / "data" / "enrichment" / "semiconductor" / "universe.json"
STOCK_MAP_CACHE = ROOT / "data" / "sources" / "cninfo_stock_map.json"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "*/*"}
QUERY_URL = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
STATIC_BASE = "http://static.cninfo.com.cn/"

TITLE_EXCLUDE = re.compile(r"摘要|英文|已取消|修订版|UPDATE|ENGLISH", re.IGNORECASE)
TITLE_FY = re.compile(r"(\d{4})\s*年{0,2}度报告")


def http_post(url: str, data: dict, timeout: int = 30) -> dict:
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={**UA, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get(url: str, timeout: int = 120) -> bytes:
    headers = {**UA, "Accept": "application/pdf,*/*", "Referer": "https://data.eastmoney.com/"}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_get_curl(url: str, timeout: int = 120) -> bytes:
    """pdf.dfcfw.com 有 JS 反爬挑战(针对非浏览器 TLS 指纹),curl 直接通过。"""
    result = subprocess.run(
        ["curl", "-s", "-m", str(timeout), "-L", url,
         "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
         "-H", "Referer: https://data.eastmoney.com/"],
        capture_output=True, check=True,
    )
    return result.stdout


def load_stock_map() -> dict:
    if STOCK_MAP_CACHE.exists():
        return json.loads(STOCK_MAP_CACHE.read_text(encoding="utf-8"))
    data = json.loads(http_get("http://www.cninfo.com.cn/new/data/szse_stock.json", timeout=60).decode("utf-8"))
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


# global soft-throttle detector:cninfo 按 IP 限流,连续空结果说明整个 IP 在
# 冷却窗口里 —— 全局长退避比重试单家更省时间。
_GLOBAL = {"empty_strikes": 0, "last_success": 0.0}


def query_annual_reports(code: str, org_id: str) -> list[dict]:
    rows: list[dict] = []
    for category in ("category_ndbg_szsh",):
        payload = {
            "pageNum": 1, "pageSize": 30, "column": column_for(code), "tabName": "fulltext",
            "plate": "", "stock": f"{code},{org_id}", "searchkey": "", "secid": "",
            "category": category, "trade": "", "seDate": "2024-01-01~2026-09-24",
            "sortName": "", "sortType": "", "isHLtitle": "true",
        }
        empty_strikes = 0
        for attempt in range(6):
            if _GLOBAL["empty_strikes"] >= 4:
                wait = 600
                print(f"  global throttle: {_GLOBAL['empty_strikes']} consecutive empty, sleeping {wait}s")
                time.sleep(wait)
                _GLOBAL["empty_strikes"] = 0
            try:
                data = http_post(QUERY_URL, payload)
                rows = data.get("announcements") or []
            except Exception as exc:
                print(f"  {code}: query error ({exc}), cooling 30s")
                time.sleep(30 + 15 * attempt)
                continue
            if rows:
                _GLOBAL["empty_strikes"] = 0
                break
            empty_strikes += 1
            _GLOBAL["empty_strikes"] += 1
            print(f"  {code}: empty result (soft throttle?), strike {empty_strikes}, cooling")
            time.sleep(min(120, 30 + 25 * empty_strikes))
        if rows:
            break
    return rows


def pick_report(rows: list[dict]) -> dict | None:
    best = None  # latest FY wins; exclude 摘要/英文/取消
    for row in rows:
        title = row.get("announcementTitle") or ""
        title = re.sub(r"<[^>]+>", "", title)
        if TITLE_EXCLUDE.search(title):
            continue
        match = TITLE_FY.search(title)
        if not match:
            continue
        fy = int(match.group(1))
        if fy not in (2024, 2025):
            continue
        if best is None or fy > best["_fy"]:
            best = {**row, "_fy": fy, "_title": title}
    return best


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def query_em_annual(code: str) -> dict | None:
    """EastMoney 公告镜像(官方年报 PDF 的镜像通道;cninfo 被 WAF 限流时的主通道)。
    文档本身仍是 Tier 1(上市公司年度报告),manifest 里记录 channel=em 镜像 URL。"""
    url = (
        "https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=50&page_index=1"
        f"&ann_type=A&client_source=web&stock_list={code}&f_node=1&s_node=0"
    )
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    best = None
    for row in data.get("data", {}).get("list") or []:
        title = (row.get("title") or "").split(":")[-1].strip()
        columns = " ".join(c.get("column_name", "") for c in row.get("columns") or [])
        if not re.match(r"^\d{4}年{0,2}度报告$", title) and "年度报告" not in title:
            continue
        if TITLE_EXCLUDE.search(title) or "摘要" in title:
            continue
        match = TITLE_FY.search(title)
        if not match or int(match.group(1)) not in (2024, 2025):
            continue
        fy = int(match.group(1))
        if "年度报告" not in columns and "年度报告" not in title:
            continue
        if best is None or fy > best["_fy"]:
            best = {"_fy": fy, "_title": title, "art_code": row["art_code"], "date": (row.get("notice_date") or "")[:10]}
    return best


def fetch_one(code: str, name: str, org_id: str, channel: str) -> dict:
    out_dir = OUT_BASE / code
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            pdf_path = out_dir / manifest.get("fileName", "")
            if pdf_path.exists() and manifest.get("documentSha256"):
                return {"code": code, "status": "skipped", "title": manifest.get("sourceTitle", "")}
        except Exception:
            pass  # corrupt manifest → refetch

    if channel == "em":
        picked_em = query_em_annual(code)
        if not picked_em:
            return {"code": code, "status": "failed", "reason": "em: no annual report found (FY2024/2025)"}
        fy = picked_em["_fy"]
        title = picked_em["_title"]
        url = f"https://pdf.dfcfw.com/pdf/H2_{picked_em['art_code']}_1.pdf"
        announcement_date = picked_em["date"]
        source_channel = "eastmoney_mirror"
    else:
        rows = query_annual_reports(code, org_id)
        picked = pick_report(rows)
        if not picked:
            return {"code": code, "status": "failed", "reason": "no annual report found (FY2024/2025)"}
        fy = picked["_fy"]
        title = picked["_title"]
        url = STATIC_BASE + picked["adjunctUrl"]
        announcement_date = time.strftime("%Y-%m-%d", time.gmtime(picked["announcementTime"] / 1000))
        source_channel = "cninfo"
    out_dir.mkdir(parents=True, exist_ok=True)
    file_name = f"annual-report-{fy}.pdf"
    pdf_path = out_dir / file_name
    last_error = None
    for attempt in range(4):
        try:
            blob = http_get_curl(url)
            if len(blob) < 100_000 or not blob.startswith(b"%PDF"):
                raise RuntimeError(f"suspicious payload ({len(blob)} bytes): {blob[:80]!r}")
            pdf_path.write_bytes(blob)
            last_error = None
            break
        except Exception as exc:
            last_error = exc
            time.sleep(3 * (attempt + 1))
    if last_error is not None:
        return {"code": code, "status": "failed", "reason": f"download: {last_error}"}

    manifest = {
        "companyCode": code,
        "companyName": name,
        "orgId": org_id,
        "sourceType": "annual_report",
        "sourceChannel": source_channel,
        "sourceTitle": title,
        "reportPeriod": f"{fy}-12-31",
        "sourceDate": announcement_date,
        "sourceUrl": url,
        "fileName": file_name,
        "fileSizeBytes": pdf_path.stat().st_size,
        "documentSha256": sha256_of(pdf_path),
        "authorityTier": 1,
        "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lastCheckedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"code": code, "status": "downloaded", "title": title, "bytes": manifest["fileSizeBytes"]}


def main() -> None:
    limit = None
    codes_filter = None
    channel = "em"  # cninfo WAF 对本机 IP 限流;东财镜像通道更快,同为 Tier1 文档
    argv = sys.argv[1:]
    if "--limit" in argv:
        limit = int(argv[argv.index("--limit") + 1])
    if "--codes" in argv:
        codes_filter = set(argv[argv.index("--codes") + 1].split(","))
    if "--channel" in argv:
        channel = argv[argv.index("--channel") + 1]

    universe = json.loads(UNIVERSE.read_text(encoding="utf-8"))
    targets = [c for c in universe["companies"] if c["level"] == "A"]
    if codes_filter:
        targets = [c for c in targets if c["code"] in codes_filter]
    if limit:
        targets = targets[:limit]
    print(f"LEVEL A targets: {len(targets)}")

    stock_map = load_stock_map()
    results = []
    # 单线程:cninfo 软限流对并发极敏感;目标间随机间隔,拉长到整个后台时段
    import random
    for i, c in enumerate(targets):
        org = stock_map.get(c["code"])
        if not org:
            results.append({"code": c["code"], "status": "failed", "reason": "no cninfo orgId"})
            continue
        results.append(fetch_one(c["code"], c["name"], org["orgId"], channel))
        if (i + 1) % 10 == 0:
            print(f"  {i + 1}/{len(targets)} done")
        time.sleep(4.0 + random.random() * 5.0)

    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "attempted": len(targets),
        "downloaded": sum(1 for r in results if r["status"] == "downloaded"),
        "skipped": sum(1 for r in results if r["status"] == "skipped"),
        "failed": [r for r in results if r["status"] == "failed"],
    }
    (ROOT / "data" / "enrichment" / "semiconductor" / "source_fetch_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"downloaded={report['downloaded']} skipped={report['skipped']} failed={len(report['failed'])}")
    for failure in report["failed"][:15]:
        print(f"  FAIL {failure['code']}: {failure.get('reason')}")


if __name__ == "__main__":
    main()
