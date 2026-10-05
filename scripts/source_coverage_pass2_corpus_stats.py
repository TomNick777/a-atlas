"""Source Coverage Pass 2 — corpus scale impact audit (mission §8).

读 rebuilt corpus companies.jsonl + facts.jsonl + 旧 corpus（git HEAD~ 或
--before 指定路径），输出：

  DF gate        source fact 词条的 document frequency 分布、被 0.05 闸门丢弃的
                 词条与代表例、near-threshold 词条（mission §8.1，只观察不调阈）
  cap12          每公司 sourceFacts 词条数 p50/p75/p90/p95/p99/max 与撞 cap 比例
  160-char       「来源事实」行长度分布、截断率、截断公司数
  640-budget     searchableText 长度、profileTruncated 前后对比、被挤压简介的公司
  retention      旗舰/required 词条在对应公司 searchableText 的保留率

Usage:
  npx tsx 不适用——本脚本纯 python：
  services venv python -u scripts/source_coverage_pass2_corpus_stats.py --before <old companies.jsonl>
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "data" / "company-corpus" / "companies.jsonl"
FACTS = ROOT / "data" / "source_facts" / "facts.jsonl"

SOURCE_LINE_RE = re.compile(r"来源事实：(.*)")
CAP12 = 12
LINE160 = 160


def percentile(sorted_values: list[int], p: float) -> int:
    if not sorted_values:
        return 0
    index = min(len(sorted_values) - 1, round(p / 100 * (len(sorted_values) - 1)))
    return sorted_values[index]


def dist(values: list[int]) -> dict:
    ordered = sorted(values)
    return {
        "p50": percentile(ordered, 50), "p75": percentile(ordered, 75), "p90": percentile(ordered, 90),
        "p95": percentile(ordered, 95), "p99": percentile(ordered, 99), "max": ordered[-1] if ordered else 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", help="扩量前 corpus companies.jsonl（git show 出来的文件）")
    args = parser.parse_args()

    docs = [json.loads(line) for line in CORPUS.read_bytes().decode("utf-8").split("\n") if line.strip()]
    facts = [json.loads(line) for line in FACTS.read_bytes().decode("utf-8").split("\n") if line.strip()]
    n = len(docs)
    total = n or 1

    # ---- DF gate（facts 层全量词频 → corpus 闸门效果）----
    fact_term_df: Counter = Counter()
    for fact in facts:
        for term in set(fact["terms"]):
            fact_term_df[term] += 1
    corpus_term_df: Counter = Counter()
    retained_terms = 0
    for doc in docs:
        for entry in doc.get("sourceFacts") or []:
            corpus_term_df[entry["term"]] += 1
            retained_terms += 1
    gate_dropped = {t: c for t, c in fact_term_df.items() if c / total > 0.05}
    near_threshold = {t: c for t, c in fact_term_df.items() if 0.03 < c / total <= 0.05}
    df_report = {
        "companies": n,
        "factsTotal": len(facts),
        "uniqueTermsInFacts": len(fact_term_df),
        "retainedTermInstances": retained_terms,
        "retainedUniqueTerms": len(corpus_term_df),
        "gateDroppedTerms": len(gate_dropped),
        "gateDroppedTop": [{"term": t, "df": c, "share": round(c / total, 4)} for t, c in Counter(gate_dropped).most_common(30)],
        "nearThreshold": [{"term": t, "df": c, "share": round(c / total, 4)} for t, c in Counter(near_threshold).most_common(30)],
        "topRetained": [{"term": t, "companies": c} for t, c in corpus_term_df.most_common(20)],
        "singleCompanyTerms": len([t for t, c in fact_term_df.items() if c == 1]),
    }

    # ---- cap12 ----
    sf_counts = [len(doc.get("sourceFacts") or []) for doc in docs]
    hitting_cap = len([c for c in sf_counts if c >= CAP12])
    cap_report = {
        "distribution": dist(sf_counts),
        "companiesWithSourceFacts": len([c for c in sf_counts if c > 0]),
        "hittingCap12": hitting_cap,
        "hittingCap12Share": round(hitting_cap / total, 4),
    }

    # ---- 160-char line ----
    line_lengths = []
    truncated_160 = 0
    for doc in docs:
        match = SOURCE_LINE_RE.search(doc["searchableText"])
        if not match:
            continue
        joined = "、".join(entry["term"] for entry in doc.get("sourceFacts") or [])
        line_lengths.append(len(match.group(1)))
        if len(joined) > LINE160:
            truncated_160 += 1
    line_report = {
        "distribution": dist(line_lengths),
        "avg": round(sum(line_lengths) / len(line_lengths), 1) if line_lengths else 0,
        "companiesHitting160": truncated_160,
        "truncationRate": round(truncated_160 / max(len(line_lengths), 1), 4),
    }

    # ---- 640 budget / profileTruncated ----
    text_lengths = [len(doc["searchableText"]) for doc in docs]
    at_cap_640 = len([x for x in text_lengths if x >= 640])
    docs_by_symbol = {doc["symbol"]: doc for doc in docs}
    budget_report = {
        "distribution": dist(text_lengths),
        "avg": round(sum(text_lengths) / n, 1),
        "at640Cap": at_cap_640,
    }

    before_docs = {}
    if args.before and Path(args.before).exists():
        for line in Path(args.before).read_bytes().decode("utf-8").split("\n"):
            if line.strip():
                doc = json.loads(line)
                before_docs[doc["symbol"]] = doc
        # profileTruncated（builder 口径：profile 字段顶满 400）前后对比。
        before_truncated = len([d for d in before_docs.values() if len(d.get("profile") or "") >= 400])
        after_truncated = len([d for d in docs if len(d.get("profile") or "") >= 400])
        budget_report["before"] = {
            "profileTruncatedProfileFieldAt400": before_truncated,
            "avgSearchableText": round(sum(len(d["searchableText"]) for d in before_docs.values()) / max(len(before_docs), 1), 1),
        }
        budget_report["after"] = {"profileTruncatedProfileFieldAt400": after_truncated}
        budget_report["profileFieldTruncatedDelta"] = after_truncated - before_truncated

        def intro_line(doc: dict) -> str:
            match = re.search(r"^简介：(.*)$", doc.get("searchableText") or "", re.MULTILINE)
            return match.group(1) if match else ""

        # §8.4 真正的挤压信号：searchableText 简介行内容变短的公司（来源事实行
        # 挤占 640 预算的直接后果）。doc.profile 来自未变输入，不反映挤压。
        squeezed = []
        for doc in docs:
            old = before_docs.get(doc["symbol"])
            if not old:
                continue
            old_intro, new_intro = intro_line(old), intro_line(doc)
            if len(new_intro) < len(old_intro):
                squeezed.append({"symbol": doc["symbol"], "name": doc["name"], "introLost": len(old_intro) - len(new_intro)})
        squeezed.sort(key=lambda row: -row["introLost"])
        budget_report["introSqueezedCompanies"] = len(squeezed)
        budget_report["introSqueezedTop10"] = squeezed[:10]
        budget_report["introCharsLostTotal"] = sum(row["introLost"] for row in squeezed)
        # required evidence retention：被挤压公司里有多少仍保住主要产品行
        kept_product_line = 0
        for row in squeezed:
            doc, old = docs_by_symbol.get(row["symbol"]), before_docs.get(row["symbol"])
            if not doc or not old:
                continue
            def product_of(d: dict) -> str:
                match = re.search(r"^主要产品：(.*)$", d.get("searchableText") or "", re.MULTILINE)
                return match.group(1) if match else ""
            if product_of(old) and product_of(doc) == product_of(old):
                kept_product_line += 1
        budget_report["squeezedKeptProductLineUnchanged"] = kept_product_line

    # ---- required / flagship evidence retention ----
    flagship = {
        "000651": ["家用空调", "中央空调", "空气调节器"],
        "000333": ["暖通空调", "中央空调", "家用空调"],
        "300124": ["伺服系统", "伺服电机"],
        "688320": ["伺服系统"],
        "603416": ["伺服系统", "伺服驱动", "伺服电机"],
        "688187": ["IGBT", "功率半导体"],
    }
    ups_probe = ["UPS", "不间断电源"]
    retention = {}
    for symbol, terms in flagship.items():
        doc = docs_by_symbol.get(symbol)
        text = doc["searchableText"] if doc else ""
        retention[symbol] = {term: (term in text) for term in terms}
    ups = {}
    for symbol in ("002518", "300376"):
        doc = docs_by_symbol.get(symbol)
        text = doc["searchableText"] if doc else ""
        ups[symbol] = {term: (term in text) for term in ups_probe}
    ups_market = len([doc for doc in docs if "UPS" in doc["searchableText"] or "不间断电源" in doc["searchableText"]])
    # corpusVerified: sourceFacts evidence 指针可反查
    fact_ids = {f["factId"] for f in facts}
    dangling = [entry["evidence"] for doc in docs for entry in doc.get("sourceFacts") or [] if entry["evidence"] not in fact_ids]

    print(json.dumps({
        "dfGate": df_report,
        "cap12": cap_report,
        "line160": line_report,
        "budget640": budget_report,
        "flagshipRetention": retention,
        "upsProbe": {"corpus": ups, "marketwideCompanies": ups_market},
        "danglingEvidencePointers": len(dangling),
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
