"""Evidence Surface Expansion — announcement acquisition (Phase 3.7, Surface A Tier 1).

把（pilot 或全池）公司的巨潮公告列表抓下来，按确定性标题门槛选出 point-in-time
relation 候选公告，PDF 下载到 data/raw/source_facts/<code>/announcements/。

管线与 Phase 3.6 年报通道同源（orgId 映射 / hisAnnouncement query / static.cninfo
下载 / 大小守卫 / 断点续跑 / 分片并行），三处不同：

  1. 不带 category——中标/重大合同/框架协议类公告没有专用类别码
     （category_rcjy_szsh 在该端点无效，见 SURFACE_AUDIT.md §1 Q2），
     选择机制 = 标题触发词门槛（公告文体通用词，零专名，§30/§31）；
  2. 时间窗口 12 个月（2025-10-01~2026-09-30）——point-in-time surface 的
     语义就是「最近发生了什么」，也把列表请求量压在可控运维成本内（§47）；
  3. 失败语义独立记录：SOURCE_UNAVAILABLE / NOT_IN_CNINFO_MAP /
     NO_ANNOUNCEMENTS（窗口内无公告=该通道真空，不解释成没有关系）/ DOWNLOAD_FAILED /
     SIZE_ANOMALY。列表成功但没有标题命中 = 正常 0 命中，不是失败。

断点续跑：manifest 已有同名 announce-* artifact 且文件在盘 → 跳过该份下载；
列表本身每家都要重查（窗口滚动，列表便宜）。

Usage (services venv python):
  python -u scripts/evidence_surface_fetch_announcements.py --shard 0 --shards 1 \
      --sample reports/EVIDENCE_SURFACE_EXPANSION/pilot_sample.json \
      --status-file data/raw/source_facts/_p37_ann_status_0.jsonl
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

os_env_fix = None
import os

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
WINDOW = "2025-10-01~2026-09-30"
PAGE_SIZE = 30
MAX_PAGES = 30          # 单家公告列表页数保险丝（900 份）
MAX_PDFS = 6            # 单家公告 PDF 下载上限（pilot 预算，§27）
PAUSE_BASE = 0.8
ATTEMPTS = 3

# 标题门槛：point-in-time relation 公告文体的通用结构词——中标/重大合同/协议类/
# 定点/供货/订单/入围/供应商。只有这些词面会进获取通道；不含任何公司名、行业名
# 或 benchmark 词（tests/evidence_surface.test.ts 机械钉死）。
TITLE_GATE_RE = re.compile(
    r"中标|中选|重大合同|框架协议|合作协议|战略合作|合作框架|购销合同|销售合同"
    r"|采购合同|供货|定点|订单|入围|供应商|联合开发"
)


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
    """static.cninfo 直连；curl 兜底处理 TLS 指纹挑战（3.6 同款）。"""
    result = subprocess.run(
        ["curl", "-s", "-m", str(timeout), "-L", url,
         "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
         "-o", str(out_path)],
        capture_output=True,
    )
    if result.returncode != 0 or not out_path.exists() or out_path.stat().st_size < 1024:
        size = out_path.stat().st_size if out_path.exists() else 0
        raise RuntimeError(f"download failed rc={result.returncode} size={size}")


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


def list_page(code: str, org_id: str, page: int) -> list[dict]:
    payload = {
        "pageNum": page, "pageSize": PAGE_SIZE, "column": column_for(code), "tabName": "fulltext",
        "plate": "", "stock": f"{code},{org_id}", "searchkey": "", "secid": "",
        "category": "", "trade": "", "seDate": WINDOW,
        "sortName": "", "sortType": "", "isHLtitle": "true",
    }
    rows = http_post_json(QUERY_URL, payload).get("announcements") or []
    out = []
    for row in rows:
        title = (row.get("announcementTitle") or "").strip()
        adjunct = row.get("adjunctUrl") or ""
        if not title or not adjunct or not adjunct.lower().endswith(".pdf"):
            continue
        announced = row.get("announcementTime")
        announced_at = None
        if isinstance(announced, (int, float)):
            announced_at = time.strftime("%Y-%m-%d", time.localtime(announced / 1000))
        else:
            m = re.search(r"finalpage/(\d{4}-\d{2}-\d{2})/", adjunct)
            announced_at = m.group(1) if m else None
        out.append({
            "title": title,
            "url": STATIC_BASE + adjunct,
            "announcedAt": announced_at,
            "fileBasename": Path(adjunct).name,
        })
    return out


def gate_hits(title: str) -> bool:
    return bool(TITLE_GATE_RE.search(title))


def fetch_one(code: str, stock_map: dict, status_counts: dict) -> dict:
    """返回 {status, artifacts?, pages}；失败也是结果，绝不抛异常。"""
    org = stock_map.get(code)
    if not org:
        return {"status": "NOT_IN_CNINFO_MAP"}
    listing: list[dict] = []
    total_pages = 1
    try:
        for page in range(1, MAX_PAGES + 1):
            rows = list_page(code, org["orgId"], page)
            if page == 1 and not rows:
                break
            listing.extend(rows)
            if len(rows) < PAGE_SIZE:
                break
            time.sleep(PAUSE_BASE + random.random() * 0.4)
        total_pages = min(max(1, math.ceil(len(listing) / PAGE_SIZE)) if listing else 1, MAX_PAGES)
    except Exception as error:  # noqa: BLE001
        return {"status": "SOURCE_UNAVAILABLE", "detail": f"{type(error).__name__}: {str(error)[:150]}"}
    if not listing:
        return {"status": "NO_ANNOUNCEMENTS"}
    hits = [row for row in listing if gate_hits(row["title"])]
    if not hits:
        return {"status": "OK_ZERO_HITS", "listed": len(listing)}

    out_dir = OUT_BASE / code / "announcements"
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT_BASE / code / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"code": code, "artifacts": []}
    artifacts: list[dict] = []
    downloaded = 0
    for row in hits:
        if downloaded >= MAX_PDFS:
            break
        name = f"announce-{row['fileBasename']}"
        path = out_dir / name
        cached = next((a for a in manifest.get("artifacts", []) if a.get("file") == name), None)
        if cached and path.exists():
            artifacts.append(cached)
            downloaded += 1
            continue
        try:
            time.sleep(0.3)
            http_get_curl(row["url"], path)
            size = path.stat().st_size
            if size < 20_000:
                path.unlink(missing_ok=True)
                status_counts["SIZE_ANOMALY"] = status_counts.get("SIZE_ANOMALY", 0) + 1
                continue
        except Exception as error:  # noqa: BLE001
            status_counts["DOWNLOAD_FAILED"] = status_counts.get("DOWNLOAD_FAILED", 0) + 1
            continue
        artifact = {
            "file": name,
            "sha256": sha256_of(path),
            "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "url": row["url"],
            "title": row["title"],
            "announcedAt": row["announcedAt"],
            "bytes": size,
        }
        artifacts.append(artifact)
        downloaded += 1
    if artifacts:
        kept = [a for a in manifest.get("artifacts", []) if not str(a.get("file", "")).startswith("announce-")]
        # 既有 announce-* 缓存保留（不同年份不同文件名），本次新增合入
        kept.extend(a for a in artifacts if a not in kept)
        manifest["artifacts"] = kept
        manifest["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"status": "OK", "listed": len(listing), "hits": len(hits), "artifacts": artifacts}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--sample", default=str(ROOT / "reports" / "EVIDENCE_SURFACE_EXPANSION" / "pilot_sample.json"))
    parser.add_argument("--status-file", required=True)
    args = parser.parse_args()

    sample = json.loads(Path(args.sample).read_text(encoding="utf-8"))
    codes = sorted(r["code"] for r in sample["companies"])
    mine = [c for i, c in enumerate(codes) if i % args.shards == args.shard]
    print(f"shard {args.shard}/{args.shards}: {len(mine)} companies, window {WINDOW}", flush=True)

    stock_map = load_stock_map()
    status_path = Path(args.status_file)
    status_path.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    listed_total = 0
    hits_total = 0
    started = time.time()
    for idx, code in enumerate(mine):
        result = fetch_one(code, stock_map, counts)
        counts[result["status"]] = counts.get(result["status"], 0) + 1
        listed_total += result.get("listed", 0)
        hits_total += result.get("hits", 0)
        status_path.open("a", encoding="utf-8").write(json.dumps(
            {"code": code, "status": result["status"], "listed": result.get("listed"),
             "hits": result.get("hits"), "pdfs": len(result.get("artifacts") or []),
             "detail": result.get("detail"), "at": time.strftime("%H:%M:%S")},
            ensure_ascii=False) + "\n")
        if (idx + 1) % 10 == 0:
            rate = (idx + 1) / (time.time() - started) * 60
            print(f"[shard {args.shard}] {idx + 1}/{len(mine)} {json.dumps(counts, ensure_ascii=False)} "
                  f"listed={listed_total} hits={hits_total} {rate:.1f}/min", flush=True)
        time.sleep(PAUSE_BASE + random.random() * 0.4)
    summary = {"shard": args.shard, "counts": counts, "listed": listed_total, "hits": hits_total}
    print("DONE " + json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
