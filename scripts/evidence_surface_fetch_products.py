"""Evidence Surface Expansion — official product page acquisition (Phase 3.7, Surface B).

把（pilot 或全池）公司官网的产品/解决方案页抓成 raw snapshot，供确定性抽取。

机制（§15/§16/§17，company-agnostic）：
  1. 官网 URL 来自巨潮公司资料「官方网站」登记字段（data/raw source_facts feeds.json
     全池缓存，5533/5567 家非空）——唯一 authority 是 data/companies.json 全池，
     不另抓名单、不含任何站点专属规则；
  2. 首页静态 HTML → <a> href/锚文本按通用产品导航词表发现（产品/解决方案/
     Products/Solution…，官网 IA 的通用结构词，非行业词表）；
  3. 取 ≤3 个同域产品页，raw 字节落盘 data/raw/source_facts/<code>/website/，
     sha256 + retrievedAt + URL 进 manifest artifact（§41 snapshot 纪律）；
  4. 失败语义分离：NO_WEBSITE（登记真空）/ HOMEPAGE_UNREACHABLE（网络/证书）/
     NO_PRODUCT_LINKS（静态发现落空——JS 渲染站点如实落空，不是失败）/ OK。
     JS 渲染不引浏览器路径（§20）。

获取顺序：https 严格 → http → https 宽松（curl -k，artifact 记 insecure=true
如实标注）。抽取只从 snapshot 走，页面漂移不影响可复现（§42）。

Usage (services venv python):
  python -u scripts/evidence_surface_fetch_products.py \
      --sample reports/EVIDENCE_SURFACE_EXPANSION/pilot_sample.json \
      --status-file data/raw/source_facts/_p37_prod_status_0.jsonl
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import os

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"
socket.setdefaulttimeout(25)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
OUT_BASE = ROOT / "data" / "raw" / "source_facts"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6"}
MAX_PRODUCT_PAGES = 3
PAUSE_BASE = 0.9
ATTEMPTS = 2
SKIP_EXT_RE = re.compile(r"\.(pdf|jpg|jpeg|png|gif|zip|rar|7z|mp4|doc|docx|xls|xlsx|css|js|ico|svg|woff2?)(\?|$)", re.IGNORECASE)

# 产品导航发现词表：官网信息架构的通用结构词（中英），不是行业词表、不含专名。
NAV_VOCAB = [
    "产品中心", "产品与服务", "产品和解决方案", "产品与方案", "产品介绍", "产品展示",
    "产品系列", "产品列表", "产品", "解决方案", "方案", "products", "product", "solutions", "solution",
]
NOISE_TEXT_RE = re.compile(r"登录|注册|招聘|联系我们|copyright|©|备案|首页|english|中文", re.IGNORECASE)
# §15 排除面：新闻/关于/招聘/ESG/品牌/联系等非产品栏目——路径段与锚文本都是
# 官网 IA 的通用结构词，company-agnostic。
EXCLUDE_PATH_RE = re.compile(
    r"/(news|about|career|jobs?|esg|contact|investor(?:s)?|brand|culture|sustainability|media|activity|notice|download|support/service)(/|$|_)",
    re.IGNORECASE,
)
EXCLUDE_ANCHOR_RE = re.compile(r"新闻|动态|资讯|招聘|关于|联系|加入我们|社会招聘|校园招聘|活动|公告|下载|支持|服务支持|投资者")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def http_get(url: str, timeout: int = 25) -> tuple[bytes, str]:
    """返回 (raw_bytes, final_url)；urllib 失败抛异常由调用方分级处理。"""
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if raw[:2] == b"\x1f\x8b":
            import gzip
            raw = gzip.decompress(raw)
        return raw, resp.geturl()


def http_get_curl(url: str, insecure: bool, timeout: int = 60) -> bytes:
    flags = ["curl", "-s", "-m", str(timeout), "-L"]
    if insecure:
        flags.append("-k")
    flags += ["-H", f"User-Agent: {UA['User-Agent']}", url]
    result = subprocess.run(flags, capture_output=True)
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError(f"curl rc={result.returncode} bytes={len(result.stdout)}")
    if result.stdout[:2] == b"\x1f\x8b":
        import gzip
        return gzip.decompress(result.stdout)
    return result.stdout


def fetch_page(url: str) -> tuple[bytes, str, bool]:
    """三级回退：https 严格 → http → https 宽松。返回 (bytes, final_url, insecure)。"""
    errors: list[str] = []
    for attempt in range(ATTEMPTS):
        try:
            raw, final = http_get(url)
            if len(raw) >= 512:
                return raw, final, False
            errors.append("short-body")
        except Exception as error:  # noqa: BLE001
            errors.append(f"{type(error).__name__}")
        time.sleep(1.0 + attempt)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "https":
        try:
            http_url = urllib.parse.urlunsplit(parsed._replace(scheme="http"))
            raw, final = http_get(http_url)
            if len(raw) >= 512:
                return raw, final, False
        except Exception as error:  # noqa: BLE001
            errors.append(f"http:{type(error).__name__}")
        try:
            raw = http_get_curl(url, insecure=True)
            if len(raw) >= 512:
                return raw, url, True
        except Exception as error:  # noqa: BLE001
            errors.append(f"curlk:{type(error).__name__}")
    raise RuntimeError("; ".join(errors[:4]))


def normalize_site(site: str) -> str | None:
    site = (site or "").strip()
    if not site or site in {"-", "无"}:
        return None
    if not re.match(r"^https?://", site, re.IGNORECASE):
        site = "https://" + site
    parsed = urllib.parse.urlsplit(site)
    if not parsed.netloc or "." not in parsed.netloc:
        return None
    return urllib.parse.urlunsplit(parsed._replace(path="", query="", fragment=""))


def decode_html(raw: bytes) -> str:
    for charset in ("utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(charset)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def discover_product_links(homepage_html: str, base_url: str) -> list[tuple[str, str]]:
    """静态 <a> 发现：返回 [(url, anchor_text)]，同域、非二进制、按导航词评分排序。"""
    soup = BeautifulSoup(homepage_html, "lxml")
    host = urllib.parse.urlsplit(base_url).netloc.lower()
    scored: list[tuple[int, int, str, str]] = []
    seen: set[str] = set()
    for order, anchor in enumerate(soup.find_all("a", href=True)):
        href = anchor["href"].strip()
        text = re.sub(r"\s+", "", anchor.get_text(" ", strip=True))[:40]
        if href.startswith(("javascript:", "mailto:", "tel:", "#")):
            continue
        if href.startswith("//"):
            href = "https:" + href
        absolute = urllib.parse.urljoin(base_url, href)
        parsed = urllib.parse.urlsplit(absolute)
        if parsed.netloc.lower() != host or SKIP_EXT_RE.search(parsed.path):
            continue
        if EXCLUDE_PATH_RE.search(parsed.path):
            continue
        clean = urllib.parse.urlunsplit(parsed._replace(fragment=""))
        if clean in seen:
            continue
        seen.add(clean)
        if EXCLUDE_ANCHOR_RE.search(text):
            continue
        haystack = f"{parsed.path}{'?'+parsed.query if parsed.query else ''} {text}".lower()
        score = -1
        for rank, word in enumerate(NAV_VOCAB):
            if word in haystack:
                # 越靠前的词越专指（产品中心 > 产品），锚文本命中强于路径命中
                bonus = 0 if word in text.lower() else 1
                candidate = rank * 2 + bonus
                score = candidate if score < 0 else min(score, candidate)
        if score < 0:
            continue
        scored.append((score, order, clean, text))
    scored.sort(key=lambda row: (row[0], row[1]))
    return [(url, text) for _s, _o, url, text in scored[:MAX_PRODUCT_PAGES]]


def snapshot_dir_for(code: str, url: str) -> Path:
    parsed = urllib.parse.urlsplit(url)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", parsed.netloc + parsed.path).strip("-")[:80] or "index"
    return OUT_BASE / code / "website" / (slug[:70] + ".html")


def fetch_one(code: str, website_field: str) -> dict:
    site = normalize_site(website_field)
    if not site:
        return {"status": "NO_WEBSITE"}
    try:
        raw, final_url, insecure = fetch_page(site)
    except Exception as error:  # noqa: BLE001
        return {"status": "HOMEPAGE_UNREACHABLE", "detail": str(error)[:160], "site": site}
    html = decode_html(raw)
    links = discover_product_links(html, final_url)
    if not links:
        return {"status": "NO_PRODUCT_LINKS", "site": site}

    manifest_path = OUT_BASE / code / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"code": code, "artifacts": []}
    artifacts: list[dict] = []
    for page_url, anchor in links:
        out_path = snapshot_dir_for(code, page_url)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        name = f"website/{out_path.name}"
        cached = next((a for a in manifest.get("artifacts", []) if a.get("file") == name), None)
        if cached and out_path.exists():
            artifacts.append(cached)
            continue
        try:
            praw, pfinal, pinsecure = fetch_page(page_url)
        except Exception as error:  # noqa: BLE001
            continue
        # §42：内容变化不静默覆盖——同 URL 旧 snapshot 在盘且字节不同时，
        # 旧文件改存带时点后缀的文件名留链，新 snapshot 用原名；后缀冲突
        # （三代以上）递增序号——Windows rename 目标存在即抛错。
        if out_path.exists() and sha256_of(out_path) != hashlib.sha256(praw).hexdigest():
            cached_retrieved = (cached or {}).get("retrievedAt", "unknown")
            stamp = re.sub(r"[^0-9]", "", str(cached_retrieved))[:8] or "prior"
            chain = out_path.with_name(f"{out_path.stem}.{stamp}{out_path.suffix}")
            n = 2
            while chain.exists():
                chain = out_path.with_name(f"{out_path.stem}.{stamp}-{n}{out_path.suffix}")
                n += 1
            out_path.rename(chain)
        out_path.write_bytes(praw)
        artifacts.append({
            "file": name,
            "sha256": sha256_of(out_path),
            "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "url": pfinal,
            "requestedUrl": page_url,
            "anchorText": anchor,
            "bytes": len(praw),
            **({"insecure": True} if pinsecure else {}),
        })
        time.sleep(PAUSE_BASE + random.random() * 0.4)
    if artifacts:
        kept = [a for a in manifest.get("artifacts", []) if not str(a.get("file", "")).startswith("website/")]
        kept.extend(a for a in artifacts if a not in kept)
        manifest["artifacts"] = kept
        manifest["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"status": "OK", "site": site, "discovered": len(links), "artifacts": artifacts}


def website_of(code: str) -> str:
    path = OUT_BASE / code / "feeds.json"
    if not path.exists():
        return ""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return ""
    profile = payload.get("profile_cninfo") or []
    return (profile[0].get("官方网站") or "").strip() if profile else ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", default=str(ROOT / "reports" / "EVIDENCE_SURFACE_EXPANSION" / "pilot_sample.json"))
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--only", help="comma-separated codes（调试单家用）")
    args = parser.parse_args()

    sample = json.loads(Path(args.sample).read_text(encoding="utf-8"))
    codes = sorted(r["code"] for r in sample["companies"])
    if args.only:
        only = {c.strip() for c in args.only.split(",")}
        codes = [c for c in codes if c in only]
    mine = [c for i, c in enumerate(codes) if i % args.shards == args.shard]
    print(f"product fetch shard {args.shard}/{args.shards}: {len(mine)} companies", flush=True)

    status_path = Path(args.status_file)
    status_path.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    pages_total = 0
    for idx, code in enumerate(mine):
        result = fetch_one(code, website_of(code))
        counts[result["status"]] = counts.get(result["status"], 0) + 1
        pages_total += len(result.get("artifacts") or [])
        status_path.open("a", encoding="utf-8").write(json.dumps(
            {"code": code, "status": result["status"], "site": result.get("site"),
             "discovered": result.get("discovered"), "pages": len(result.get("artifacts") or []),
             "detail": result.get("detail"), "at": time.strftime("%H:%M:%S")},
            ensure_ascii=False) + "\n")
        if (idx + 1) % 10 == 0:
            print(f"{idx + 1}/{len(mine)} {json.dumps(counts, ensure_ascii=False)} pages={pages_total}", flush=True)
        time.sleep(PAUSE_BASE + random.random() * 0.3)
    print("DONE " + json.dumps({"counts": counts, "pages": pages_total}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
