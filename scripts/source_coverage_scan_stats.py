"""Source Coverage Pass 1 — Phase 7 scan statistics.

读 data/raw/source_coverage_scan/{sample.json,facts.jsonl,manifest.json} +
data/raw/source_facts/<code>/manifest.json（含年报 spot check），输出覆盖率/
解析成功率/事实类型/特异度分桶。pilot 6 家不计入样本统计（它们是定向抓取）。

Usage:
  services venv python -u scripts/source_coverage_scan_stats.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "data" / "raw" / "source_coverage_scan"
RAW = ROOT / "data" / "raw" / "source_facts"
PILOT = {"000651", "000333", "300124", "688320", "603416", "688187"}

# 特异度分桶（mission §15 的最低质量检查）
BROAD_MARKERS = ("研发", "生产", "销售", "高新材料", "高科技", "综合")


def main() -> None:
    sample = json.loads((SCAN / "sample.json").read_text(encoding="utf-8"))
    codes = [c for c in sample if c not in PILOT]
    stats = {
        "sampleSize": len(codes),
        "feedsFetched": 0,
        "zyjsOk": 0,
        "profileOk": 0,
        "zygcOk": 0,
        "productTypePresent": 0,
        "scopePresent": 0,
        "zygcProductsPresent": 0,
        "usableProductTerms": 0,
        "broadOnly": 0,
        "termHistogram": {},
        "factTypes": {},
    }
    facts_by_code: dict[str, list[dict]] = {}
    if (SCAN / "facts.jsonl").exists():
        for line in (SCAN / "facts.jsonl").read_text(encoding="utf-8").split("\n"):
            if line.strip():
                fact = json.loads(line)
                facts_by_code.setdefault(fact["companyCode"], []).append(fact)

    for code in codes:
        manifest_path = RAW / code / "manifest.json"
        feeds_path = RAW / code / "feeds.json"
        if not (manifest_path.exists() and feeds_path.exists()):
            continue
        stats["feedsFetched"] += 1
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        feeds = json.loads(feeds_path.read_text(encoding="utf-8"))
        zyjs = (feeds.get("zyjs") or [{}])[0] if feeds.get("zyjs") else {}
        profile = (feeds.get("profile_cninfo") or [{}])[0] if feeds.get("profile_cninfo") else {}
        if feeds.get("zyjs"):
            stats["zyjsOk"] += 1
        if feeds.get("profile_cninfo"):
            stats["profileOk"] += 1
        if feeds.get("zygc"):
            stats["zygcOk"] += 1
        if str(zyjs.get("产品类型") or "").strip():
            stats["productTypePresent"] += 1
        if str(zyjs.get("经营范围") or "").strip() or str(profile.get("经营范围") or "").strip():
            stats["scopePresent"] += 1
        facts = facts_by_code.get(code, [])
        zygc_facts = [f for f in facts if f["source"]["sourceType"] == "filing_product_split"]
        if zygc_facts:
            stats["zygcProductsPresent"] += 1
        product_terms = sorted({t for f in facts if f["factType"] == "product" for t in f["terms"]})
        if product_terms:
            stats["usableProductTerms"] += 1
            stats["termHistogram"][len(product_terms)] = stats["termHistogram"].get(len(product_terms), 0) + 1
            specific = [t for t in product_terms if not any(m in t for m in BROAD_MARKERS)]
            if not specific:
                stats["broadOnly"] += 1
        for fact in facts:
            stats["factTypes"][fact["factType"]] = stats["factTypes"].get(fact["factType"], 0) + 1

    # 年报 spot check
    annual = {"sampled": 0, "pdfOk": 0, "parseOk": 0, "annualFacts": 0}
    annual_codes = json.loads((SCAN / "annual_sample.json").read_text(encoding="utf-8")) if (SCAN / "annual_sample.json").exists() else []
    annual = {"sampled": len(annual_codes), "pdfOk": 0, "parseOk": 0, "annualFacts": 0}
    for code in annual_codes:
        manifest_path = RAW / code / "manifest.json"
        if not manifest_path.exists():
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        art = next((a for a in manifest.get("artifacts", []) if a["file"].startswith("annual-report-")), None)
        if art:
            annual["pdfOk"] += 1
        af = [f for f in facts_by_code.get(code, []) if f["source"]["sourceType"] == "filing_annual_report"]
        if af:
            annual["parseOk"] += 1
            annual["annualFacts"] += len(af)

    n = max(stats["feedsFetched"], 1)
    print(json.dumps({
        "sample": stats["sampleSize"],
        "feedsFetched": stats["feedsFetched"],
        "feedSuccess": {"zyjs": f"{stats['zyjsOk']}/{n}", "profile": f"{stats['profileOk']}/{n}", "zygc": f"{stats['zygcOk']}/{n}"},
        "fieldPresence": {
            "thsProductTypes": f"{stats['productTypePresent']}/{n} ({stats['productTypePresent']/n:.1%})",
            "businessScope": f"{stats['scopePresent']}/{n} ({stats['scopePresent']/n:.1%})",
            "zygcProductRows": f"{stats['zygcProductsPresent']}/{n} ({stats['zygcProductsPresent']/n:.1%})",
        },
        "usableEvidence": {
            "companiesWithProductTerms": f"{stats['usableProductTerms']}/{n} ({stats['usableProductTerms']/n:.1%})",
            "broadOnlyCompanies": stats["broadOnly"],
            "termCountHistogram": dict(sorted(stats["termHistogram"].items())),
        },
        "factTypeDistribution": stats["factTypes"],
        "annualSpotCheck": annual,
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
