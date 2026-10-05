"""Evidence Coverage Expansion — §13 Relation Source Discovery Pass probes (v2).

P2 改为复用 Pass 1 已验证的巨潮年报管线（source_coverage_fetch），P1 加退避重试。
只选代表公司验证 source 存在性与结构稳定性（§13）；机制必须 company-agnostic（§14）。

产物：reports/EVIDENCE_COVERAGE_EXPANSION/probe_results.json
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import time
from pathlib import Path

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"
socket.setdefaulttimeout(30)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

OUT_DIR = ROOT / "reports" / "EVIDENCE_COVERAGE_EXPANSION"
RAW_TMP = OUT_DIR / "_probe_pdfs"

RESULT: dict = {}

COMPANIES = {
    "000333": "美的集团",
    "603626": "科森科技",
    "601689": "拓普集团",
    "002050": "三花智控",
    "300033": "同花顺",
}

RELATION_WORDS = ["供应链", "供应商", "客户", "合作伙伴", "战略合作", "配套", "定点", "供货"]
COUNTERPARTS = ["特斯拉", "英伟达", "华为", "苹果", "美的"]
FINE_WORDS = ["K线", "行情", "技术分析", "金融信息服务", "看盘", "交易终端", "Level-2", "level2"]


def records(df) -> list[dict]:
    if df is None or df.empty:
        return []
    return json.loads(df.to_json(orient="records", force_ascii=False))


def _em_get_json(url: str, params: dict) -> dict:
    # python urllib 会被东财风控 RemoteDisconnected；curl 直连稳定（Pass 1 同款兜底）。
    import subprocess
    import urllib.parse
    query = urllib.parse.urlencode(params)
    result = subprocess.run(
        ["curl", "-s", "-m", "20", f"{url}?{query}",
         "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
         "-H", "Referer: https://quote.eastmoney.com/"],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"curl rc={result.returncode}")
    return json.loads(result.stdout.decode("utf-8"))


def em_market_code(code: str) -> str:
    # vendor #46：不能用 startswith("6")——北交所 43/83/87/92 是 0，沪 6 开头是 1，深 0/3 开头是 0
    if code.startswith(("60", "68", "9")):
        return "1"
    return "0"


def probe1_concept_boards() -> None:
    """vendor §3.3：个股 slist(spt=3) 一次拿全板块；板块类型分类用一次性 clist 枚举（t:2=概念）。"""
    out: dict = {"name": "P1 EM concept boards (direct slist)"}
    try:
        concept_bk = {}
        for page in (1, 2):
            data = _em_get_json("https://push2.eastmoney.com/api/qt/clist/get", {
                "pn": page, "pz": 500, "po": 1, "np": 1, "fltt": 2, "invt": 2,
                "fid": "f12", "fs": "m:90 t:2", "fields": "f12,f14",
            })
            rows = ((data.get("data") or {}).get("diff") or {})
            items = rows.values() if isinstance(rows, dict) else rows
            for it in items:
                concept_bk[str(it.get("f12", ""))] = str(it.get("f14", ""))
            if not items:
                break
            time.sleep(1.2)
        out["status"] = "ok"
        out["conceptBoardCount"] = len(concept_bk)
        interesting = sorted({n for n in concept_bk.values() if any(w in n for w in ["英伟达", "特斯拉", "华为", "机器人", "苹果", "供应链"])})
        out["interestingConceptBoards"] = interesting

        membership = {}
        for code, name in COMPANIES.items():
            time.sleep(1.2)
            data = _em_get_json("https://push2.eastmoney.com/api/qt/slist/get", {
                "fltt": 2, "invt": 2, "secid": f"{em_market_code(code)}.{code}",
                "spt": 3, "pi": 0, "pz": 300, "po": 1, "fields": "f12,f14",
            })
            rows = ((data.get("data") or {}).get("diff") or {})
            items = rows.values() if isinstance(rows, dict) else rows
            all_blocks = [(str(it.get("f12", "")), str(it.get("f14", ""))) for it in items]
            concepts = [n for bk, n in all_blocks if bk in concept_bk]
            membership[f"{code} {name}"] = {
                "totalBlocks": len(all_blocks),
                "concepts": concepts,
                "relationish": [c for c in concepts if any(w in c for w in ["英伟达", "特斯拉", "华为", "苹果", "机器人", "新能源", "供应链"])],
            }
        out["membership"] = membership
    except Exception as error:  # noqa: BLE001
        out["status"] = "error"
        out["errorType"] = type(error).__name__
        out["error"] = str(error)[:300]
    RESULT["P1_concept_boards"] = out
    print(json.dumps({k: out.get(k) for k in ["status", "conceptBoardCount", "interestingConceptBoards"]}, ensure_ascii=False))


def probe2_annual_report(code: str, name: str) -> None:
    import source_coverage_fetch as scf
    import pymupdf

    out: dict = {"code": code, "name": name}
    try:
        stock_map = scf.load_stock_map()
        (RAW_TMP / code).mkdir(parents=True, exist_ok=True)
        entry = scf.fetch_annual_report(code, stock_map, RAW_TMP / code)
        if not entry:
            out["status"] = "NO_ANNUAL_REPORT_ROW"
            RESULT[f"P2_{code}"] = out
            return
        out["report"] = entry["title"]
        out["fiscalYear"] = entry["fiscalYear"]
        out["pdfBytes"] = entry["bytes"]
        doc = pymupdf.open(RAW_TMP / code / entry["file"])
        out["pages"] = doc.page_count
        full_pages = [page.get_text() for page in doc]
        flat = re.sub(r"\s+", "", "\n".join(full_pages))

        out["hasSalesConcentration"] = "占年度销售总额比例" in flat or "前五名客户" in flat
        out["hasPurchaseConcentration"] = "占年度采购总额" in flat or "前五名供应商" in flat

        def window_of(term: str, span: int = 260, hits: int = 1) -> list[str]:
            got, start = [], 0
            for _ in range(hits):
                at = flat.find(term, start)
                if at < 0:
                    break
                got.append(flat[max(0, at - 20): at + span])
                start = at + 1
            return got

        out["fiveCustomersWindow"] = window_of("前五名客户")
        out["fiveSuppliersWindow"] = window_of("前五名供应商")
        out["anonymousCustomerStyle"] = bool(re.search(r"客户[一二三四五ABC1-5][）)]?", flat))

        flat_pages = [re.sub(r"\s+", "", t) for t in full_pages]
        out["counterpartWindows"] = {}
        for w in COUNTERPARTS:
            windows = []
            for i, fp in enumerate(flat_pages):
                at = fp.find(w)
                if at >= 0:
                    windows.append(f"p{i + 1}: " + fp[max(0, at - 30): at + 70])
                if len(windows) >= 3:
                    break
            if windows:
                out["counterpartWindows"][w] = windows
        if code == "300033":
            out["fineProductWindows"] = {w: window_of(w, 120, 2) for w in FINE_WORDS}
        out["status"] = "ok"
    except Exception as error:  # noqa: BLE001
        out["status"] = "error"
        out["errorType"] = type(error).__name__
        out["error"] = str(error)[:300]
    RESULT[f"P2_{code}"] = out
    print(f"P2 {code} {name}: {out.get('status')} fy={out.get('fiscalYear')} pages={out.get('pages')} "
          f"sales={out.get('hasSalesConcentration')} purchase={out.get('hasPurchaseConcentration')}")


def probe3_irm(code: str, name: str) -> None:
    import akshare as ak
    out: dict = {"code": code, "name": name}
    try:
        time.sleep(2.0)
        df = ak.stock_irm_cninfo(symbol=code)
        rows = records(df)
        out["status"] = "ok" if rows else "empty"
        out["rows"] = len(rows)
        out["columns"] = list(rows[0].keys()) if rows else []
        rel = [
            r for r in rows
            if any(w in json.dumps(r, ensure_ascii=False) for w in RELATION_WORDS + COUNTERPARTS)
        ]
        out["relationRows"] = len(rel)
        out["samples"] = [
            {k: str(v)[:150] for k, v in r.items()}
            for r in rel[:3]
        ]
    except Exception as error:  # noqa: BLE001
        out["status"] = "error"
        out["errorType"] = type(error).__name__
        out["error"] = str(error)[:300]
    RESULT[f"P3_irm_{code}"] = out
    print(f"P3 irm {code} {name}: {out.get('status')} rows={out.get('rows')} relation={out.get('relationRows')}")


def main() -> None:
    probe1_concept_boards()
    for code in ["000333", "603626", "601689", "300033"]:
        probe2_annual_report(code, COMPANIES[code])
    for code in ["603626", "300033"]:
        probe3_irm(code, COMPANIES[code])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "probe_results.json").write_bytes(json.dumps(RESULT, ensure_ascii=False, indent=1).encode("utf-8"))
    print("\nwrote", OUT_DIR / "probe_results.json")


if __name__ == "__main__":
    main()
