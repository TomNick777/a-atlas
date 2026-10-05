# Stage 3.1 missing-source recovery checker (规格第八/九/十二节).
#
# Stage 3 遗留的 6 家次新公司「缺失 FY2025 年报」。本脚本对每家按序检查官方渠道,
# 有年报则走抓取(复用 stage3_fetch_sources.py 的通道),确认不存在则落
# SOURCE_GAP(带 reason/checkedSources/checkedAt),FETCH 失败才落 FETCH_GAP:
#
#   1. cninfo 正式披露(category_ndbg_szsh, 2024-01-01~now)
#   2. 东财公告镜像全节点(标题/栏目含「年度报告」,排除摘要/英文/取消)
#
# Usage: .venv/Scripts/python.exe -u scripts/stage3_check_source_gaps.py
#   → data/sources/semiconductor/<code>/source_gap.json (per company)
#   → data/enrichment/semiconductor/source_recovery_report.json
import json
import re
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys_out = None
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
OUT_BASE = ROOT / "data" / "sources" / "semiconductor"
UNIVERSE = ROOT / "data" / "enrichment" / "semiconductor" / "universe.json"
STOCK_MAP = ROOT / "data" / "sources" / "cninfo_stock_map.json"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
TITLE_EXCLUDE = re.compile(r"摘要|英文|已取消|修订版|UPDATE|ENGLISH", re.IGNORECASE)
TITLE_FY = re.compile(r"(\d{4})\s*年{0,2}度报告")
COMPANIES = ["301689", "301717", "688797", "688808", "688813", "688820"]


def cninfo_annual_reports(code: str, org: str) -> list[dict]:
    column = "sse" if code.startswith(("60", "68", "90")) else "szse"
    body = urllib.parse.urlencode({
        "pageNum": 1, "pageSize": 30, "column": column, "tabName": "fulltext",
        "plate": "", "stock": f"{code},{org}", "searchkey": "", "secid": "",
        "category": "category_ndbg_szsh", "trade": "", "seDate": "2024-01-01~2026-09-24",
        "sortName": "", "sortType": "", "isHLtitle": "true",
    }).encode()
    req = urllib.request.Request("http://www.cninfo.com.cn/new/hisAnnouncement/query", data=body,
                                 headers={**UA, "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode())
    rows = []
    for row in data.get("announcements") or []:
        title = re.sub(r"<[^>]+>", "", row.get("announcementTitle") or "")
        fy = TITLE_FY.search(title)
        if TITLE_EXCLUDE.search(title) or not fy or int(fy.group(1)) not in (2024, 2025):
            continue
        rows.append({"title": title, "fy": int(fy.group(1)), "url": "http://static.cninfo.com.cn/" + row["adjunctUrl"],
                     "date": time.strftime("%Y-%m-%d", time.gmtime(row["announcementTime"] / 1000))})
    return rows


def em_annual_reports(code: str) -> list[dict]:
    """东财公告镜像,不筛节点(page_index 1..4 覆盖次新公司的全部公告)。"""
    found: list[dict] = []
    for page in (1, 2, 3, 4):
        url = (f"https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=50&page_index={page}"
               f"&ann_type=A&client_source=web&stock_list={code}&s_node=0")
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
        rows = data.get("data", {}).get("list") or []
        if not rows:
            break
        for row in rows:
            title = (row.get("title") or "").split(":")[-1].strip()
            fy = TITLE_FY.search(title)
            if not fy or int(fy.group(1)) not in (2024, 2025):
                continue
            if TITLE_EXCLUDE.search(title):
                continue
            found.append({"title": title, "fy": int(fy.group(1)),
                          "url": f"https://pdf.dfcfw.com/pdf/H2_{row['art_code']}_1.pdf",
                          "date": (row.get("notice_date") or "")[:10]})
    return found


def main() -> None:
    universe = {c["code"]: c for c in json.loads(UNIVERSE.read_text(encoding="utf-8"))["companies"]}
    stock_map = json.loads(STOCK_MAP.read_text(encoding="utf-8"))
    companies = {c["code"]: c for c in json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))["companies"]}
    report = []
    for code in COMPANIES:
        entry = universe.get(code) or {}
        name = entry.get("name") or companies.get(code, {}).get("name", "")
        listed_at = companies.get(code, {}).get("listedAt") or "unknown"
        checked: list[dict] = []
        picked = None
        org = stock_map.get(code, {}).get("orgId")
        if org:
            rows = cninfo_annual_reports(code, org)
            checked.append({"channel": "cninfo", "query": "category_ndbg_szsh 2024-01-01~2026-09-24", "hits": len(rows)})
            if rows:
                picked = max(rows, key=lambda r: r["fy"])
        time.sleep(2)
        if not picked:
            rows = em_annual_reports(code)
            checked.append({"channel": "eastmoney_mirror", "query": "all nodes, FY2024/2025 年度报告(排除摘要/英文)", "hits": len(rows)})
            if rows:
                picked = max(rows, key=lambda r: r["fy"])
        if picked:
            out_dir = OUT_BASE / code
            out_dir.mkdir(parents=True, exist_ok=True)
            pdf = out_dir / f"annual-report-{picked['fy']}.pdf"
            result = subprocess.run(["curl", "-s", "-m", "120", "-L", picked["url"],
                                     "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                                     "-H", "Referer: https://data.eastmoney.com/"], capture_output=True)
            blob = result.stdout
            if len(blob) < 100_000 or not blob.startswith(b"%PDF"):
                status = "FETCH_GAP"
                reason = f"document listed ({picked['title']}) but download failed ({len(blob)} bytes)"
                gap = {"status": status, "reason": reason, "expectedReport": f"{picked['fy']} 年度报告",
                       "checkedSources": checked, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            else:
                pdf.write_bytes(blob)
                import hashlib
                manifest = {
                    "companyCode": code, "companyName": name, "orgId": org, "sourceType": "annual_report",
                    "sourceChannel": "cninfo" if "cninfo" in picked["url"] else "eastmoney_mirror",
                    "sourceTitle": picked["title"], "reportPeriod": f"{picked['fy']}-12-31",
                    "sourceDate": picked["date"], "sourceUrl": picked["url"], "fileName": pdf.name,
                    "fileSizeBytes": pdf.stat().st_size, "documentSha256": hashlib.sha256(blob).hexdigest(),
                    "authorityTier": 1, "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
                gap = {"status": "RECOVERED", "title": picked["title"], "sha256": manifest["documentSha256"]}
        else:
            # 官方两渠道确认:不存在独立 FY2025 年度报告 → SOURCE_GAP(规格第十二节)
            reason = (f"次新上市(listedAt={listed_at}),FY2025 年度报告披露义务由 IPO 招股说明书/上市公告书承担,"
                      "官方渠道无独立年度报告;2026 半年报/季报为上市后首期定期报告")
            gap = {"status": "SOURCE_GAP", "reason": reason, "expectedReport": "FY2025 年度报告",
                   "checkedSources": checked, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            out_dir = OUT_BASE / code
            out_dir.mkdir(parents=True, exist_ok=True)
        (OUT_BASE / code / "source_gap.json").write_text(json.dumps({"companyCode": code, "companyName": name, "listedAt": listed_at, **gap}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        report.append({"code": code, "name": name, "listedAt": listed_at, "status": gap["status"]})
        print(code, name, gap["status"], json.dumps(checked, ensure_ascii=False))
    (ROOT / "data" / "enrichment" / "semiconductor" / "source_recovery_report.json").write_text(
        json.dumps({"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "companies": report}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("recovered:", sum(1 for r in report if r["status"] == "RECOVERED"), "/ source_gap:", sum(1 for r in report if r["status"] == "SOURCE_GAP"))


if __name__ == "__main__":
    main()
