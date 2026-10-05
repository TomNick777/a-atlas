#!/usr/bin/env python3
"""批量抓取公司池全部企业 logo(同花顺 F10 company.html 内嵌 company-logo PNG)。

- 输入: data/companies.json (companies[].code/name/exchange)
- 输出: data/raw/logos/{code}.png + manifest.json + failed.json
- 增量: manifest 命中且本地文件完整(>300B 且 PNG 签名)则跳过; --force 全部重抓
- 断点: manifest/failed 每 300 条原子落盘, 中断后重跑自动续
"""
import argparse
import json
import random
import re
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POOL_PATH = ROOT / "data" / "companies.json"
OUT_DIR = ROOT / "data" / "raw" / "logos"
MANIFEST_PATH = OUT_DIR / "manifest.json"
FAILED_PATH = OUT_DIR / "failed.json"

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
}
# 页面是 GBK, 解码后正则取 logo 直链(实测: 直链无防盗链, 60x60; 扩展名 .png/.PNG 混用, 忽略大小写)
LOGO_RE = re.compile(r"https?:?/?/?[^\"']*company-logo/[^\"']+\.(?:png|jpe?g)", re.IGNORECASE)
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def http_get(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def png_dims(data: bytes):
    if data[:8] != PNG_SIG or len(data) < 24:
        return None
    return struct.unpack(">II", data[16:24])


def grab(item: dict) -> dict:
    """抓一家: 页面(GBK)提取 logo URL -> 下载 -> 校验 PNG 签名 -> 落盘。"""
    code, name = str(item["code"]), item.get("name", "")
    time.sleep(random.uniform(0.05, 0.30))  # worker 内节流, 全局约 4-6 req/s
    last_err = ""
    for attempt in range(3):
        try:
            html = http_get(f"https://basic.10jqka.com.cn/{code}/company.html", 15).decode("gbk", "ignore")
            m = LOGO_RE.search(html)
            if not m:
                return {"code": code, "name": name, "ok": False, "reason": "no-logo-in-page"}
            url = re.sub(r"^https?:?/?/?", "https://", m.group(0))
            data = http_get(url, 20)
            dims = png_dims(data)
            if dims is None or len(data) < 300:
                return {"code": code, "name": name, "ok": False, "reason": f"bad-image({len(data)}B)"}
            (OUT_DIR / f"{code}.png").write_bytes(data)
            return {
                "code": code, "name": name, "ok": True,
                "url": url, "bytes": len(data),
                "w": dims[0], "h": dims[1],
                "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
        except Exception as e:  # noqa: BLE001 网络类异常统一重试
            last_err = f"{type(e).__name__}: {e}"
            time.sleep(1.0 + attempt * 1.5 + random.random())
    return {"code": code, "name": name, "ok": False, "reason": last_err}


def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            print(f"[warn] {path.name} 解析失败, 重建", flush=True)
    return default


def dump_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="忽略 manifest 全部重抓")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="均匀抽样 N 家(冒烟用)")
    ap.add_argument("--codes", type=str, default="", help="逗号分隔指定代码")
    args = ap.parse_args()

    pool = json.loads(POOL_PATH.read_text(encoding="utf-8"))["companies"]
    for x in pool:
        x["code"] = str(x["code"])
    if args.codes:
        want = {c.strip().zfill(6) for c in args.codes.split(",") if c.strip()}
        pool = [x for x in pool if x["code"] in want]
    if args.limit:
        step = max(1, len(pool) // args.limit)
        pool = pool[::step][: args.limit]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {} if args.force else load_json(MANIFEST_PATH, {})
    manifest = {k: v for k, v in manifest.items() if isinstance(v, dict)}

    todo = []
    for x in pool:
        f = OUT_DIR / f"{x['code']}.png"
        if not args.force and x["code"] in manifest and f.exists() and f.stat().st_size >= 300:
            continue
        todo.append(x)

    print(f"池 {len(pool)} | 已完成(跳过) {len(pool) - len(todo)} | 待抓 {len(todo)}", flush=True)
    if not todo:
        print("nothing to do", flush=True)
        return 0

    t0 = time.time()
    ok_cnt, fail_list = 0, []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(grab, x) for x in todo]
        for i, fut in enumerate(as_completed(futures), 1):
            r = fut.result()
            if r["ok"]:
                manifest[r["code"]] = {"ok": True, **{k: r[k] for k in ("name", "url", "bytes", "w", "h", "fetchedAt")}}
                ok_cnt += 1
            else:
                fail_list.append({"code": r["code"], "name": r["name"], "reason": r["reason"]})
            if i % 300 == 0 or i == len(todo):
                rate = i / max(time.time() - t0, 1e-6)
                print(f"[{i}/{len(todo)}] ok={ok_cnt} fail={len(fail_list)} {rate:.1f}/s "
                      f"eta={int((len(todo) - i) / max(rate, 0.1))}s", flush=True)
                dump_json(MANIFEST_PATH, manifest)
                dump_json(FAILED_PATH, fail_list)

    dump_json(MANIFEST_PATH, manifest)
    dump_json(FAILED_PATH, fail_list)
    print(f"完成: ok={ok_cnt} fail={len(fail_list)} 用时 {int(time.time() - t0)}s", flush=True)
    for x in fail_list[:20]:
        print(f"  FAIL {x['code']} {x['name']}: {x['reason']}", flush=True)
    return 0 if not fail_list else 2


if __name__ == "__main__":
    sys.exit(main())
