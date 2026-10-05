"""Source Coverage Pass 2 — full-market source coverage statistics (mission §11).

真实全池数据（不是外推）。读 raw 缓存 manifest（feedStatus）+ committed
facts.jsonl，输出逐 source 覆盖率与公司级覆盖分布；0 可用事实公司生成名单
并分类原因（网络失败 ≠ source 真空 ≠ 字段在场但无可用词）。

Usage:
  services venv python -u scripts/source_coverage_pass2_coverage_stats.py --out reports/SOURCE_COVERAGE_PASS2/coverage_stats.json
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "source_facts"
COMPANIES = ROOT / "data" / "companies.json"
FACTS = ROOT / "data" / "source_facts" / "facts.jsonl"
PILOT = {"000651", "000333", "300124", "688320", "603416", "688187"}


def percentile(values: list[int], p: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(p / 100 * (len(ordered) - 1)))]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    companies = json.loads(COMPANIES.read_text(encoding="utf-8"))["companies"]
    all_codes = [c["code"] for c in companies]

    facts_by_code: dict[str, list[dict]] = {}
    for line in FACTS.read_bytes().decode("utf-8").split("\n"):
        if line.strip():
            fact = json.loads(line)
            facts_by_code.setdefault(fact["companyCode"], []).append(fact)

    stats = {
        "pool": len(all_codes),
        "ths": {"fetchOk": 0, "productTypesPresent": 0, "scopePresent": 0, "usableProductTerm": 0},
        "cninfo": {"fetchOk": 0, "scopePresent": 0, "usableBusinessFacts": 0},
        "zygc": {"fetchOk": 0, "companiesWithProductRows": 0, "totalPeriods": 0, "totalProductRows": 0, "usableProductFacts": 0},
        "companyLevel": {
            "withAnyFact": 0, "withProductFact": 0, "withBusinessFact": 0,
            "factsPerCompany": {}, "zeroUsableFacts": [],
        },
        "fetchFailureByFeed": Counter(),
        "emptyByFeed": Counter(),
    }

    for code in all_codes:
        feeds_path = RAW / code / "feeds.json"
        facts = facts_by_code.get(code, [])
        if code in PILOT:
            # pilot 抓取冻结在 Pass 1（无 feedStatus），事实照常计入覆盖统计。
            stats["ths"]["fetchOk"] += 1
            stats["cninfo"]["fetchOk"] += 1
            stats["zygc"]["fetchOk"] += 1
        elif feeds_path.exists():
            payload = json.loads(feeds_path.read_text(encoding="utf-8"))
            status = payload.get("feedStatus") or {}
            for feed, key in (("zyjs", "ths"), ("profile_cninfo", "cninfo"), ("zygc", "zygc")):
                st = status.get(feed) or {}
                if st.get("status") == "ok":
                    stats[key]["fetchOk"] += 1
                elif st.get("status") == "empty":
                    stats["emptyByFeed"][feed] += 1
                else:
                    stats["fetchFailureByFeed"][feed] += 1
            zyjs = (payload.get("zyjs") or [{}])[0] if payload.get("zyjs") else {}
            if str(zyjs.get("产品类型") or "").strip():
                stats["ths"]["productTypesPresent"] += 1
            if str(zyjs.get("经营范围") or "").strip():
                stats["ths"]["scopePresent"] += 1
            profile = (payload.get("profile_cninfo") or [{}])[0] if payload.get("profile_cninfo") else {}
            if str(profile.get("经营范围") or "").strip():
                stats["cninfo"]["scopePresent"] += 1
            zygc_rows = [r for r in (payload.get("zygc") or []) if r.get("分类类型") == "按产品分类"]
            if zygc_rows:
                stats["zygc"]["companiesWithProductRows"] += 1
                stats["zygc"]["totalPeriods"] += len({str(r.get("报告日期")) for r in zygc_rows})
                stats["zygc"]["totalProductRows"] += len(zygc_rows)

        product_facts = [f for f in facts if f["factType"] == "product"]
        business_facts = [f for f in facts if f["factType"] == "business"]
        ths_facts = [f for f in facts if f["source"]["sourceId"].startswith("akshare:stock_zyjs_ths")]
        cninfo_facts = [f for f in facts if f["source"]["sourceId"].startswith("akshare:stock_profile_cninfo")]
        zygc_facts = [f for f in facts if f["source"]["sourceId"].startswith("akshare:stock_zygc_em")]
        if any(f["terms"] for f in ths_facts):
            stats["ths"]["usableProductTerm"] += 1
        if cninfo_facts:
            stats["cninfo"]["usableBusinessFacts"] += 1
        stats["zygc"]["usableProductFacts"] += len(zygc_facts)
        if facts:
            stats["companyLevel"]["withAnyFact"] += 1
        if product_facts:
            stats["companyLevel"]["withProductFact"] += 1
        if business_facts:
            stats["companyLevel"]["withBusinessFact"] += 1
        if not facts:
            feeds_path = RAW / code / "feeds.json"
            reason = "pilot-without-facts" if code in PILOT else "no-raw-cache"
            if feeds_path.exists() and code not in PILOT:
                payload = json.loads(feeds_path.read_text(encoding="utf-8"))
                status = payload.get("feedStatus") or {}
                errors = [feed for feed, st in status.items() if st.get("status") == "error"]
                empties = [feed for feed, st in status.items() if st.get("status") == "empty"]
                if errors:
                    reason = f"feed-error:{','.join(errors)}"
                elif len(empties) == 3:
                    reason = "source-vacuum:all-feeds-empty"
                else:
                    reason = f"fields-empty-but-fetched:{','.join(empties) or 'extraction-empty'}"
            stats["companyLevel"]["zeroUsableFacts"].append({"code": code, "reason": reason})

    counts = [len(facts_by_code.get(code, [])) for code in all_codes]
    nonzero = [c for c in counts if c > 0]
    stats["companyLevel"]["factsPerCompany"] = {
        "p50": percentile(counts, 50), "p90": percentile(counts, 90), "p95": percentile(counts, 95),
        "p99": percentile(counts, 99), "max": max(counts) if counts else 0,
        "meanNonzero": round(sum(nonzero) / len(nonzero), 1) if nonzero else 0,
    }
    stats["fetchFailureByFeed"] = dict(stats["fetchFailureByFeed"])
    stats["emptyByFeed"] = dict(stats["emptyByFeed"])
    reasons = Counter(row["reason"].split(":")[0] for row in stats["companyLevel"]["zeroUsableFacts"])
    stats["zeroFactsReasonSummary"] = dict(reasons)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(stats, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in stats.items() if k != "companyLevel"}, ensure_ascii=False, indent=1))
    print("companyLevel:", json.dumps({k: v for k, v in stats["companyLevel"].items() if k != "zeroUsableFacts"}, ensure_ascii=False))
    print("zeroUsableFacts:", len(stats["companyLevel"]["zeroUsableFacts"]))


if __name__ == "__main__":
    main()
