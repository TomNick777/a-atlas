"""Evidence Coverage Expansion — Source Audit offline scan (Phase 3.6 §4).

回答审计问题的量化部分：现有 committed 数据里到底已经存在多少 relation 信号
（只是没被抽成事实 / 没进语料 / 还是根本不存在）。

离线、零网络、只读三个 committed 输入：
  data/company-corpus/companies.jsonl   Jev 现在实际看到的语料
  data/source_facts/facts.jsonl         全池 committed 事实层（rawText 保真）
  data/companies.json                   规范化公司事实（profiles 等）

产物：
  reports/EVIDENCE_COVERAGE_EXPANSION/audit_scan.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "reports" / "EVIDENCE_COVERAGE_EXPANSION"

# relation 信号词：只用于计数观察（audit），不是抽取词表、不是检索词表。
RELATION_WORDS = [
    "供应链", "供应商", "客户", "合作伙伴", "战略合作", "战略协议",
    "配套", "定点", "经销", "代理商", "合格供应商", "终端客户", "供货",
]
# relation 计数里的 counterpart 级词：知名公司专名（观察口径，不含全部公司）。
COUNTERPART_WORDS = [
    "特斯拉", "英伟达", "华为", "苹果", "比亚迪", "宁德时代",
    "小米", "谷歌", "英特尔", "美的",
]
# fine-product 信号词（K线软件案例 + 粗类目问题）。
FINE_PRODUCT_WORDS = ["行情", "K线", "K 线", "看盘", "技术分析", "证券软件", "金融信息服务"]


def count_docs(lines: list[str], words: list[str]) -> dict:
    """按词 → 命中文档集合。文本拼接口径：最宽（任何字段出现都算）。"""
    hits: dict[str, set[str]] = {w: set() for w in words}
    for line in lines:
        doc = json.loads(line)
        key = doc.get("symbol") or doc.get("companyCode") or doc.get("code") or ""
        text = json.dumps(doc, ensure_ascii=False)
        for w in words:
            if w in text:
                hits[w].add(key)
    return {w: sorted(v) for w, v in hits.items()}


def main() -> None:
    corpus_lines = (ROOT / "data" / "company-corpus" / "companies.jsonl").read_text(encoding="utf-8").splitlines()
    facts_lines = (ROOT / "data" / "source_facts" / "facts.jsonl").read_text(encoding="utf-8").splitlines()
    companies = json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))

    companies_list = companies if isinstance(companies, list) else companies.get("companies", [])
    sample = companies_list[0]
    print("companies.json entry keys:", sorted(sample.keys()))

    corpus_hit_symbols = count_docs(corpus_lines, RELATION_WORDS + COUNTERPART_WORDS + FINE_PRODUCT_WORDS)
    facts_hit_codes = count_docs(facts_lines, RELATION_WORDS + COUNTERPART_WORDS)

    def pct(n: int) -> str:
        return f"{n} ({n / 55.67:.1f}%)"

    print(f"\n=== corpus（Jev 所见，{len(corpus_lines)} docs）===")
    for w in RELATION_WORDS + COUNTERPART_WORDS + FINE_PRODUCT_WORDS:
        print(f"  {w}: {pct(len(corpus_hit_symbols[w]))}")

    print(f"\n=== facts.jsonl（{len(facts_lines)} facts）===")
    for w in RELATION_WORDS + COUNTERPART_WORDS:
        print(f"  {w}: {pct(len(facts_hit_codes[w]))} companies")

    # sample evidence：counterpart 命中的语料句子（证明信号存在但粒度/位置问题）
    samples = {}
    for w in ["特斯拉", "英伟达", "华为", "苹果", "美的", "K线", "行情", "技术分析"]:
        got = []
        for line in corpus_lines:
            doc = json.loads(line)
            if w in json.dumps(doc, ensure_ascii=False):
                st = doc.get("searchableText", "")
                at = st.find(w)
                if at >= 0:
                    got.append({"symbol": doc["symbol"], "name": doc.get("name", ""), "window": st[max(0, at - 30): at + 40]})
            if len(got) >= 4:
                break
        samples[w] = got

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    result = {
        "pool": len(corpus_lines),
        "corpusHits": {w: len(v) for w, v in corpus_hit_symbols.items()},
        "corpusHitSymbols": corpus_hit_symbols,
        "factsHits": {w: len(v) for w, v in facts_hit_codes.items()},
        "samples": samples,
    }
    (OUT_DIR / "audit_scan.json").write_bytes(json.dumps(result, ensure_ascii=False, indent=1).encode("utf-8"))
    print("\nwrote", OUT_DIR / "audit_scan.json")


if __name__ == "__main__":
    main()
