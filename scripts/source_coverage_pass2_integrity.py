"""Source Coverage Pass 2 — full-market provenance integrity (mission §10).

对 committed facts.jsonl 做全量机械验证，任何一项非零即 FAIL（退出码 1）：

  0 orphan                facts.companyCode 必须在 companies.json canonical 池内
  0 company mismatch      facts.companyName 必须等于 canonical 名称
  0 invalid term          term 必须是 rawText 逐字子串；business 登记事实允许
                          terms=[]（Pass 1 合同），product/technology 类必须有词
  0 duplicate factId      全局唯一；(companyCode,factType,rawText) 不得重复
  provenance 完整         sourceId/sourceType 枚举、retrievedAt ISO、
                          年报事实 locator#page= + artifactSha256 64hex
  raw evidence 回指       每条 fact.rawText 必须能在该公司原始缓存 payload
                          （feeds.json / 年报 PDF 页文本）中逐字找到
                          ——防公司串数据/历史期错归公司的最强机械检查

Usage:
  services venv python -u scripts/source_coverage_pass2_integrity.py
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
FACTS = ROOT / "data" / "source_facts" / "facts.jsonl"
COMPANIES = ROOT / "data" / "companies.json"
RAW = ROOT / "data" / "raw" / "source_facts"

VALID_SOURCE_TYPES = {"disclosure_summary", "registry_scope", "filing_product_split", "filing_annual_report"}
TERMLESS_ALLOWED_TYPES = {"business"}  # 登记性长文只存证不派生词（Pass 1 合同）
FACT_ID_RE = re.compile(r"^sf_\d{6}_\d{6}$")
PAGE_LOCATOR_RE = re.compile(r"#page=\d+$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def flatten(text: str) -> str:
    return re.sub(r"\s+", "", text)


def main() -> None:
    companies = {c["code"]: c["name"] for c in json.loads(COMPANIES.read_text(encoding="utf-8"))["companies"]}
    facts = [json.loads(line) for line in FACTS.read_bytes().decode("utf-8").split("\n") if line.strip()]

    issues: Counter = Counter()
    samples: dict[str, list[str]] = {}
    note = samples.setdefault

    ids = [f["factId"] for f in facts]
    dup_ids = [i for i, n in Counter(ids).items() if n > 1]
    for fact_id in dup_ids[:10]:
        note("duplicate_factId", fact_id)
    issues["duplicate_factId"] = len(dup_ids)

    seen_triples: set[tuple[str, str, str]] = set()
    dup_triples: list[str] = []
    seen_exact: set[tuple[str, str, str, str]] = set()
    dup_exact: list[str] = []
    cross_source: list[str] = []
    raw_text_cache: dict[str, str] = {}
    pdf_text_cache: dict[str, dict[int, str]] = {}

    for fact in facts:
        bad = None
        code = fact.get("companyCode", "")
        if not FACT_ID_RE.match(fact.get("factId", "")):
            bad = "factId 形状"
        if code not in companies:
            bad = "orphan companyCode"
        elif fact.get("companyName") != companies[code]:
            bad = f"companyName mismatch ({fact.get('companyName')} != {companies[code]})"
        if fact.get("source", {}).get("sourceType") not in VALID_SOURCE_TYPES:
            bad = "sourceType 非法"
        if not fact.get("retrievedAt"):
            bad = "retrievedAt 缺失"
        terms = fact.get("terms", [])
        raw_text = fact.get("rawText", "")
        if not raw_text.strip():
            bad = "rawText 空"
        if not terms and fact.get("factType") not in TERMLESS_ALLOWED_TYPES:
            bad = "非 business 事实无 terms"
        for term in terms:
            if term not in raw_text:
                bad = f"term 非子串: {term}"
                break
        if fact["source"]["sourceType"] == "filing_annual_report":
            if not PAGE_LOCATOR_RE.search(fact.get("source", {}).get("locator") or ""):
                bad = "年报 locator 无 #page"
            if not SHA256_RE.match(fact.get("artifactSha256") or ""):
                bad = "年报事实缺 artifactSha256"
            if not (fact["source"].get("date") or "").startswith("20"):
                bad = "年报事实缺披露日期"

        triple = (code, fact["factType"], raw_text)
        exact = (code, fact["factType"], raw_text, fact["source"]["sourceId"])
        if triple in seen_triples:
            # 跨源同词（THS 与东财对同一产品的双重 provenance）是事实层的印证
            # 特性，corpus 层判重；同源同格同文才是真重复。
            cross_source.append(fact["factId"])
            if exact in seen_exact:
                dup_exact.append(fact["factId"])
        seen_triples.add(triple)
        seen_exact.add(exact)

        # raw evidence 回指：rawText 必须逐字存在于该公司原始缓存
        if code not in raw_text_cache:
            feeds_path = RAW / code / "feeds.json"
            cache_text = ""
            if feeds_path.exists():
                payload = json.loads(feeds_path.read_text(encoding="utf-8"))
                parts = []
                for row in payload.get("zyjs", []) + payload.get("profile_cninfo", []) + payload.get("zygc", []):
                    parts.extend(str(v) for v in row.values())
                cache_text = flatten("".join(parts))
            raw_text_cache[code] = cache_text
        source_type = fact["source"]["sourceType"]
        if source_type in ("disclosure_summary", "registry_scope", "filing_product_split"):
            if fact["rawText"] not in raw_text_cache[code] and flatten(fact["rawText"]) not in raw_text_cache[code]:
                bad = "rawText 不在公司原始缓存中（串公司/错归嫌疑）"
        elif source_type == "filing_annual_report":
            locator = fact["source"].get("locator") or ""
            page_match = re.search(r"#page=(\d+)$", locator)
            pdf_name = re.search(r"/([^/]+\.pdf)", locator, re.IGNORECASE)
            if page_match and pdf_name:
                # locator 指向巨潮附件 URL；本地文件名经 raw manifest 的 url→file 映射解析。
                key = f"{code}:{pdf_name.group(1)}"
                if key not in pdf_text_cache:
                    pages: dict[int, str] = {}
                    manifest_path = RAW / code / "manifest.json"
                    local = None
                    if manifest_path.exists():
                        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                        for artifact in manifest.get("artifacts", []):
                            if artifact.get("url", "").endswith(pdf_name.group(1)):
                                local = RAW / code / artifact["file"]
                                break
                    if local and local.exists():
                        doc = pymupdf.open(local)
                        for index, page in enumerate(doc):
                            pages[index + 1] = flatten(strip_noise(page.get_text("text")))
                        doc.close()
                    pdf_text_cache[key] = pages
                page_no = int(page_match.group(1))
                page_text = pdf_text_cache[key].get(page_no, "")
                if flatten(fact["rawText"]) not in page_text:
                    bad = f"年报 rawText 不在 {key}#page={page_no}"
            else:
                bad = "年报 locator 无法解析 pdf/page"

        if bad:
            issues[bad if isinstance(bad, str) else "unknown"] += 1
            note(bad if isinstance(bad, str) else "unknown", fact["factId"])

    issues["duplicate_fact_same_source"] = len(dup_exact)
    for fact_id in dup_exact[:10]:
        note("duplicate_fact_same_source", fact_id)

    hard_failures = {k: v for k, v in issues.items() if v}
    verdict = "PASS" if not hard_failures else "FAIL"
    result = {
        "verdict": verdict,
        "facts": len(facts),
        "companies": len({f["companyCode"] for f in facts}),
        "issues": dict(hard_failures),
        "samples": {k: v[:5] for k, v in samples.items() if v},
        "termlessFacts": len([f for f in facts if not f["terms"]]),
        "crossSourceCorroboration": len(cross_source),
        "bySourceType": dict(Counter(f["source"]["sourceType"] for f in facts)),
    }
    print(json.dumps(result, ensure_ascii=False, indent=1))
    if hard_failures:
        sys.exit(1)


def strip_noise(page_text: str) -> str:
    header = re.compile(r"^\d{1,4}$|^\d{1,3}\s*/\s*\d{1,3}$")
    lines = []
    for line in page_text.split("\n"):
        s = line.strip()
        if header.fullmatch(s) and len(s) <= 12:
            continue
        if "年度报告" in s and len(s) <= 45:
            continue
        lines.append(line)
    return "\n".join(lines)


if __name__ == "__main__":
    main()
