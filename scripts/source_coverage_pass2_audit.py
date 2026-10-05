"""Source Coverage Pass 2 — pre-scale extraction audit (mission §6).

对固定种子的分层样本（data/raw/source_facts_pass2_audit_sample.json）做规则复检：
在跑 full market 之前，把 Pass 1 的提取/残差桶规则放到非 pilot 样本上量出
假阳性/假阴性，给 FULL_MARKET_EXTRACTION_AUDIT.md 提供数据。

只读 raw 缓存 + 临时提取产物，不写任何 committed 数据、不碰 pilot facts。

Usage:
  services venv python -u scripts/source_coverage_pass2_audit.py --facts data/raw/source_coverage_pass2_audit/facts.jsonl
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "source_facts"
COMPANIES = ROOT / "data" / "companies.json"
SAMPLE = ROOT / "data" / "raw" / "source_facts_pass2_audit_sample.json"

# 与 extract 侧 residual_bucket 同构的口径（审计侧复算，不改提取规则）
RESIDUAL_EXACT = {"合计", "平衡项目", "材料销售收入", "租赁", "租金收入", "原材料及废料", "材料销售", "劳务"}
RESIDUAL_SUBSTR = ("其他", "其它")

# §6 必查假阳性模式：漏网残差/非本公司产品的可疑词面
FP_PATTERNS = {
    "residual_other": re.compile(r"其他|其它"),
    "residual_total": re.compile(r"合计|小计|抵销|内部抵消|平衡项目"),
    "lease": re.compile(r"租赁|租金"),
    "internal": re.compile(r"内部|分部间"),
    "upstream_purchase": re.compile(r"原材料采购|采购"),
    "industry_not_product": re.compile(r"^(制造业|建筑业|批发|零售|房地产|金融服务|服务业)$"),
}

# §6 必查假阴性模式：被 residual_bucket 丢弃但可能是真产品的词面
FN_CANDIDATE_RE = re.compile(r"其他|其它")
PAREN_RE = re.compile(r"[（(].{1,20}[)）]")
WHERE_RE = re.compile(r"其中[:：]?")

def cjk_ratio(term: str) -> float:
    if not term:
        return 0.0
    cjk = sum(1 for ch in term if "CJK" in unicodedata.name(ch, ""))
    return cjk / len(term)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--facts", required=True, help="临时提取的 facts.jsonl（audit extract 输出）")
    args = parser.parse_args()

    sample = set(json.loads(SAMPLE.read_text(encoding="utf-8")))
    pilot = {"000651", "000333", "300124", "688320", "603416", "688187"}
    audit_codes = sorted(sample - pilot)
    companies = {c["code"]: c for c in json.loads(COMPANIES.read_text(encoding="utf-8"))["companies"]}

    facts_by_code: dict[str, list[dict]] = defaultdict(list)
    for line in Path(args.facts).read_text(encoding="utf-8").split("\n"):
        if line.strip():
            fact = json.loads(line)
            facts_by_code[fact["companyCode"]].append(fact)

    report = {
        "sampleSize": len(audit_codes),
        "extractedCompanies": len([c for c in audit_codes if facts_by_code.get(c)]),
        "termsTotal": 0,
        "termLength": {},
        "fpSuspects": defaultdict(list),
        "fnDropped": defaultdict(list),
        "whereParentChild": [],
        "parenTerms": [],
        "nameDriftExamples": [],
        "zygcRowCap": [],
        "emptyFeedsBySource": Counter(),
        "termDfTop": [],
        "broadTerms": [],
    }

    df = Counter()
    term_lengths = []
    for code in audit_codes:
        company = companies[code]
        facts = facts_by_code.get(code, [])
        terms = sorted({t for f in facts for t in f["terms"]})
        for term in terms:
            df[term] += 1
        report["termsTotal"] += len(terms)
        term_lengths.extend(len(t) for t in terms)

        # FP：抽出来的词面里可疑模式
        for fact in facts:
            for term in fact["terms"]:
                for label, pattern in FP_PATTERNS.items():
                    if pattern.search(term):
                        report["fpSuspects"][label].append({"code": code, "name": company["name"], "term": term, "rawText": fact["rawText"][:80]})

        # FN：zygc 单元格里被 residual_bucket 丢弃的词面全列表（人工复检样本）
        feeds_path = RAW / code / "feeds.json"
        if not feeds_path.exists():
            continue
        feeds = json.loads(feeds_path.read_text(encoding="utf-8"))
        for feed, st in (feeds.get("feedStatus") or {}).items():
            if st["status"] != "ok":
                report["emptyFeedsBySource"][f"{feed}:{st['status']}"] += 1
        rows = [r for r in (feeds.get("zygc") or []) if r.get("分类类型") == "按产品分类"]
        if len(feeds.get("zygc") or []) >= 200:
            periods = {r["报告日期"] for r in rows}
            report["zygcRowCap"].append({"code": code, "name": company["name"], "zygcRows": len(feeds["zygc"]), "productPeriods": len(periods)})
        for row in rows:
            cell = str(row.get("主营构成") or "").strip()
            name = cell
            if name.startswith("其中:"):
                name = name[len("其中:"):]
            if "-" in name:
                name = name.rsplit("-", 1)[1].strip()
            dropped = (not name) or name in RESIDUAL_EXACT or any(m in name for m in RESIDUAL_SUBSTR)
            if dropped and name:
                if FN_CANDIDATE_RE.search(name):
                    report["fnDropped"]["contains_other"].append({"code": code, "name": company["name"], "cell": cell})
            if cell.startswith("其中"):
                report["whereParentChild"].append({"code": code, "cell": cell})

        # 词面带括号/型号
        for term in terms:
            if PAREN_RE.search(term):
                report["parenTerms"].append({"code": code, "term": term})

        # 名称漂移：同公司跨期名称集合
        names_by_period = defaultdict(set)
        for row in rows:
            names_by_period[str(row.get("报告日期"))].add(str(row.get("主营构成") or ""))
        if len(names_by_period) >= 2:
            all_names = set().union(*names_by_period.values())
            drift = []
            for a in sorted(all_names):
                for b in sorted(all_names):
                    if a < b and (a in b or b in a) and a not in ("", b):
                        drift.append({"a": a, "b": b})
            if drift and len(report["nameDriftExamples"]) < 15:
                report["nameDriftExamples"].append({"code": code, "name": company["name"], "pairs": drift[:5]})

    lengths = Counter(term_lengths)
    report["termLength"] = {
        "p50": sorted(term_lengths)[len(term_lengths) // 2] if term_lengths else 0,
        "max": max(term_lengths) if term_lengths else 0,
        "dist": dict(sorted(lengths.items())),
    }
    report["termDfTop"] = [{"term": t, "df": n, "share": round(n / max(len(audit_codes), 1), 4)} for t, n in df.most_common(40)]
    report["fpSuspects"] = {k: v[:25] for k, v in report["fpSuspects"].items()}
    report["fnDropped"] = {k: v[:40] for k, v in report["fnDropped"].items()}
    report["broadTerms"] = [
        {"term": t, "df": n}
        for t, n in df.most_common(200)
        if n >= 3 and cjk_ratio(t) > 0.5 and len(t) <= 4 and any(m in t for m in ("研发", "生产", "销售", "高科技", "综合", "服务", "业务"))
    ][:25]
    report["emptyFeedsBySource"] = dict(report["emptyFeedsBySource"])
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
