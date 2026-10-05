"""Evidence Coverage Expansion — deterministic evidence extraction (Phase 3.6).

从全池年报 PDF（data/raw/source_facts/<code>/annual-report-<FY>.pdf，acquisition
脚本已抓）提取三类 source-backed 证据，以排序合并方式写入 committed 的
data/source_facts/facts.jsonl（既有行逐字节不变、相对序不变——Pass 1 pilot 与
Pass 2 全池行冻结；新行插入 (companyCode, factId) 排序位）：

  1. 集中度事实（factType=relation, #concentration:customer|supplier）
     前五名客户/供应商的合计金额与占比句——逐字 span，terms=[]（只存证，
     不进检索投影：对判别力/字符预算的比值太低，见 extraction report）。
     名称表本身普遍匿名化（客户A/第一名），只有聚合数字是可靠事实。
  2. 关系证据窗口（factType=relation, #relation:customer|supplier|cooperation|channel|other）
     围绕关系触发词的 verbatim 窗口（±60/100，Pass 1 同法）。触发词只是
     抽取门槛（Pass 1 ANNUAL_TERMS 同性质），不含任何 benchmark 专名，
     不做同义扩展（§10/§31C）；窗口原文保真——「为苹果华为提供…」与
     「如特斯拉这样伟大的创新者」都只是原文，关系判断归 Jev（§7/§20）。
  3. 细粒度产品窗口（factType=product, #fine_product）
     围绕该公司自己 committed 产品词（companies.json mainProducts）的窗口，
     terms=[产品名]（rawText 逐字子串）。补粗类目问题（§9），词面来自
     公司自己的事实数据，不是手建词表。

纪律（全部确定性，零 LLM、零网络）：
- provenance：locator=巨潮 URL#page=N、date=filingDate、artifactSha256=PDF sha
  （与 Pass 1 pilot 年报 facts 同一形状，复用既有 provenance 结构，§18）。
- 时间语义（§19/§20）：date=披露日，绝不升级成 current 关系。
- 去重（§17）：公司内 cleaned rawText 精确/包含去重；不做 semantic dedup。
- 行 schemaVersion 保持 "1.0.0"（行格式未变）；layer 版本升 1.1.0 只记在
  data/source_facts/manifest.json。
- 没有年报的公司 = 本通道无事实（NO_FACT），绝不解释成「没有关系」（§21）。
- 确定性：factId 序号、窗口选取、行序都由输入唯一决定；多进程只并行页级
  扫描，公司序与行序不变。

Usage (services venv python):
  python -u scripts/evidence_coverage_extract_evidence.py [--workers 6]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from multiprocessing import Pool
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
RAW_BASE = ROOT / "data" / "raw" / "source_facts"
FACTS_FILE = ROOT / "data" / "source_facts" / "facts.jsonl"
FACTS_MANIFEST = ROOT / "data" / "source_facts" / "manifest.json"
OUT_DIR = ROOT / "reports" / "EVIDENCE_COVERAGE_EXPANSION"

WINDOW_BEFORE = 60
WINDOW_AFTER = 100
MAX_RELATION_WINDOWS = 5
MAX_PRODUCT_WINDOWS = 4
MAX_PRODUCT_OCCURRENCES = 2
MIN_WINDOW_CHARS = 30

# 关系触发词：只是抽取门槛（决定哪些原文窗口进入证据层），不是检索词表、
# 不是同义映射。每个触发词属于一个轻量 category 标签（§8）。
CATEGORY_TRIGGERS: list[tuple[str, list[str]]] = [
    ("customer", ["客户", "供货", "定点", "终端客户", "客户资源"]),
    ("supplier", ["供应商"]),
    ("cooperation", ["合作伙伴", "战略合作", "战略协议", "配套", "供应体系", "供应链"]),
    ("channel", ["经销", "代理商"]),
]

# 窗口级噪声守卫（Pass 1 实测假关联同源）：释义节 / 高管简历 / 集中度表格区 /
# 勾选框样板。命中即整窗不收——少收永远好于收错。
GLOSSARY_RE = re.compile(r"指.{0,24}指")
BIO_RE = re.compile(r"董事|监事|学历|学位|入职")
TABLE_RE = re.compile(r"占年度销售总额比例|占年度采购总额比例|(序号.*(第一名|客户[一A1]|供应商[一A1]))")
BOILER_RE = re.compile(r"[□☑√✓]")

# 残留桶/报表标记产品名（Pass 2 同一规则）：这些「产品名」是报表结构词或跨期
# 调整项，不许经任何通道成为事实词面（tests/sourcefacts_pass2.test.ts 同锁）。
RESIDUAL_NAME_RE = re.compile(r"抵销|抵消|小计|下角料|调整项目|分部间|租赁收入|平衡项目|^[（(][一二三四五六七八九十\d]{1,3}[)）]")

PRIORITY = {"cooperation": 0, "customer": 1, "supplier": 2, "channel": 3, "other": 4}

# 关系句式共现门槛：触发词只负责定位，窗口还必须命中一个确定性关系句式才收录。
# 这挡住年报里最大宗的「以客户为中心」式战略套话（不含任何关系句式），
# 保留「为苹果华为提供…」「与比亚迪、蔚来、华为等深度合作」这类真陈述。
# 句式表是抽取规则（什么原文算关系证据），不是语义层：不做改写、不做归一。
RELATION_PATTERN_RE = re.compile(
    r"为.{2,40}?提供"
    r"|向.{2,20}?(销售|供应|供货)"
    r"|与.{2,24}?(合作|配套|建立|签署|签订)"
    r"|(进入|入选|纳入).{0,12}?(供应链|供应体系|合格供应商|供应商目录)"
    r"|(合格供应商|供应商目录|供应商名单)"
    r"|(战略(合作|伙伴|协议)|合作伙伴|深度合作)"
    r"|(中标|定点)"
    r"|(经销商|经销|代理商)"
)

# worker 进程共享的只读状态（initializer 装载一次）
_STATE: dict = {}


def sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def clean(text: str) -> str:
    return re.sub(r"\s+", "", text)


def is_definition(window: str, at: int, trigger: str) -> bool:
    return window[at + len(trigger): at + len(trigger) + 1] == "指"


def window_rejected(window: str) -> str | None:
    if GLOSSARY_RE.search(window):
        return "glossary"
    if BIO_RE.search(window):
        return "bio"
    if TABLE_RE.search(window):
        return "table"
    if BOILER_RE.search(window):
        return "boiler"
    return None


def category_of(window: str) -> str:
    for category, triggers in CATEGORY_TRIGGERS:
        for trigger in triggers:
            if trigger in window:
                return category
    return "other"


# 窗口边界句读吸附：±60/100 的机械窗口常把对手名单/从句拦腰截断（「与赛力斯、小」）。
# 前后各最多再探 40 字，吸附到最近的句读（。！？；）——窗口仍是 rawText 的逐字
# 子串，只是选一段更完整的原文；不是改写。
SENTENCE_END_RE = re.compile(r"[。！？；]")
SNAP_CHARS = 40


def snap_window(flat: str, start: int, end: int) -> tuple[int, int]:
    tail = flat[end: end + SNAP_CHARS]
    match = SENTENCE_END_RE.search(tail)
    if match:
        end = end + match.end()
    head = flat[max(0, start - SNAP_CHARS): start]
    last = None
    for last in SENTENCE_END_RE.finditer(head):
        pass
    if last:
        start = max(0, start - SNAP_CHARS) + last.end()
    return start, end


def _init_worker(lexicon: list[str], products: dict) -> None:
    # worker 只读状态一次装齐。注意：守卫写「lexicon 不在才装」曾让 products
    # 永远装不进 worker（initializer 先播种了 lexicon）——fineProduct 全零的根因。
    _STATE["lexicon"] = lexicon
    _STATE["products"] = products


def _lexicon_hits(text: str) -> list[str]:
    hits = []
    for name in _STATE["lexicon"]:
        if name in text:
            hits.append(name)
            if len(hits) >= 3:
                break
    return hits


def extract_concentration(flat: str) -> list[tuple[str, str]]:
    """前五名客户/供应商聚合句：从「前五名X」到其后第一个百分比，verbatim span。"""
    out: list[tuple[str, str]] = []
    for side, head in (("customer", "前五名客户"), ("supplier", "前五名供应商")):
        at = flat.find(head)
        if at < 0:
            continue
        span = flat[at: at + 180]
        pct = span.find("%")
        if pct < 0:
            continue
        text = span[: pct + 1]
        if ("比例" in text or "总额" in text) and len(text) >= 20:
            out.append((side, text))
    return out


def prose_candidates(pages_flat: list[str]) -> list[dict]:
    all_triggers = [(category, trigger) for category, triggers in CATEGORY_TRIGGERS for trigger in triggers]
    candidates: list[dict] = []
    for page_idx, flat in enumerate(pages_flat):
        for category, trigger in all_triggers:
            start = 0
            while True:
                at = flat.find(trigger, start)
                if at < 0:
                    break
                start = at + len(trigger)
                if is_definition(flat, at, trigger):
                    continue
                start_pos = max(0, at - WINDOW_BEFORE)
                end_pos = at + WINDOW_AFTER
                start_pos, end_pos = snap_window(flat, start_pos, end_pos)
                window = flat[start_pos:end_pos]
                if len(window) < MIN_WINDOW_CHARS:
                    continue
                reason = window_rejected(window)
                if reason:
                    continue
                if not RELATION_PATTERN_RE.search(window):
                    continue
                candidates.append({"page": page_idx + 1, "at": at, "category": category, "text": window})
    return candidates


def product_candidates(pages_flat: list[str], product_names: list[str]) -> list[dict]:
    candidates: list[dict] = []
    for name in product_names:
        name = name.strip()
        if len(name) < 4 or RESIDUAL_NAME_RE.search(name):
            continue
        found = 0
        seen_windows: list[str] = []
        for page_idx, flat in enumerate(pages_flat):
            start = 0
            while found < MAX_PRODUCT_OCCURRENCES:
                at = flat.find(name, start)
                if at < 0:
                    break
                start = at + len(name)
                if is_definition(flat, at, name):
                    continue
                start_pos, end_pos = snap_window(flat, max(0, at - WINDOW_BEFORE), at + WINDOW_AFTER)
                window = flat[start_pos:end_pos]
                if window_rejected(window):
                    continue
                if any(window in kept or kept in window for kept in seen_windows):
                    continue
                seen_windows.append(window)
                candidates.append({"page": page_idx + 1, "at": at, "text": window, "term": name})
                found += 1
            if found >= MAX_PRODUCT_OCCURRENCES:
                break
    return candidates


def extract_company(payload: tuple[str, str]) -> dict:
    """单公司提取：返回 {rows, stats}。零网络、零共享写——确定性纯函数。"""
    code, name = payload
    out_dir = RAW_BASE / code
    stats = {"hasPdf": False, "concentration": 0, "relation": 0, "fineProduct": 0,
             "rejected": {}, "lexiconWindow": False, "byCategory": {}}
    pdfs = sorted(out_dir.glob("annual-report-*.pdf")) if out_dir.exists() else []
    if not pdfs:
        return {"code": code, "rows": [], "stats": stats, "missing": "NO_PDF"}
    pdf_path = pdfs[-1]
    artifact = None
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for entry in manifest.get("artifacts", []):
            if entry.get("file") == pdf_path.name:
                artifact = entry
                break
    if not artifact:
        return {"code": code, "rows": [], "stats": stats, "missing": "NO_MANIFEST_ARTIFACT"}
    stats["hasPdf"] = True

    url = artifact.get("url", "")
    # 时间语义（§19/§20）：优先披露日；巨潮个别公告缺 announcementTime 时退到
    # 报告期期末（FY-12-31）——报告期语义比抓取时间更诚实，绝不允许无时点。
    filing_date = artifact.get("filingDate") or (
        f"{artifact['fiscalYear']}-12-31" if artifact.get("fiscalYear") else None
    )
    artifact_sha = artifact.get("sha256")
    retrieved_at = artifact.get("retrievedAt", "")
    fy = artifact.get("fiscalYear")
    source_name = f"巨潮年报({fy}年度,{pdf_path.name})"

    doc = pymupdf.open(pdf_path)
    pages_flat = [clean(page.get_text()) for page in doc]
    doc.close()
    flat = "".join(pages_flat)

    def page_of(center: int) -> int:
        acc = 0
        for idx, page_flat in enumerate(pages_flat):
            acc += len(page_flat)
            if center < acc:
                return idx + 1
        return len(pages_flat)

    def make_row(fact_type: str, terms: list[str], raw_text: str, category: str, page: int) -> dict:
        return {
            "schemaVersion": "1.0.0",
            "factId": None,  # seq 在主进程统一续号（保持行序确定性）
            "companyCode": code,
            "companyName": name,
            "factType": fact_type,
            "terms": terms,
            "rawText": raw_text,
            "source": {
                "sourceId": f"cninfo:annual_report#{category}",
                "sourceName": source_name,
                "sourceType": "filing_annual_report",
                "locator": f"{url}#page={page}",
                **({"date": filing_date} if filing_date else {}),
            },
            "retrievedAt": retrieved_at,
            "artifactSha256": artifact_sha,
        }

    rows: list[dict] = []

    # 1) 集中度事实（只存证，terms=[]，不进检索投影）
    for side, span in extract_concentration(flat):
        rows.append(make_row("relation", [], span, f"concentration:{side}", page_of(flat.find(span[:20]))))
        stats["concentration"] += 1

    # 2) 关系证据窗口：确定性优先级（lexicon 对手公司 > customer > cooperation >
    #    supplier > channel/other；同类按页序），公司内精确/包含去重后取前 5。
    candidates = prose_candidates(pages_flat)
    selected: list[dict] = []
    selected_texts: list[str] = []
    for cand in sorted(
        candidates,
        key=lambda w: (
            0 if _lexicon_hits(w["text"]) else 1,
            PRIORITY.get(w["category"], 9),
            w["page"],
            w["at"],
        ),
    ):
        if any(cand["text"] in kept or kept in cand["text"] for kept in selected_texts):
            stats["rejected"]["contained"] = stats["rejected"].get("contained", 0) + 1
            continue
        selected.append(cand)
        selected_texts.append(cand["text"])
        if len(selected) >= MAX_RELATION_WINDOWS:
            break
    if any(_lexicon_hits(c["text"]) for c in selected):
        stats["lexiconWindow"] = True
    for cand in selected:
        rows.append(make_row("relation", [], cand["text"], f"relation:{cand['category']}", cand["page"]))
        stats["relation"] += 1
        stats["byCategory"][cand["category"]] = stats["byCategory"].get(cand["category"], 0) + 1

    # 3) 细粒度产品窗口（terms=[产品名]；head 行已覆盖的词由 builder 侧机制去重）
    product_names = list(_STATE.get("products", {}).get(code, []))[:4]
    fine = 0
    for cand in product_candidates(pages_flat, product_names):
        if fine >= MAX_PRODUCT_WINDOWS:
            break
        rows.append(make_row("product", [cand["term"]], cand["text"], "fine_product", cand["page"]))
        fine += 1
        stats["fineProduct"] += 1

    return {"code": code, "rows": rows, "stats": stats, "missing": None}


def main() -> None:
    started = time.time()
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    companies = json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))
    company_list = companies if isinstance(companies, list) else companies.get("companies", [])
    lexicon = sorted({c["name"] for c in company_list if len(c.get("name", "")) >= 3}, key=len, reverse=True)
    products = {c["code"]: [p["name"] for p in (c.get("mainProducts") or [])] for c in company_list}

    existing_lines = FACTS_FILE.read_text(encoding="utf-8").splitlines()
    existing_rows = [json.loads(line) for line in existing_lines if line.strip()]
    seq_by_company: dict[str, int] = {}
    known_texts: dict[str, set[str]] = {}
    for row in existing_rows:
        code = row["companyCode"]
        seq = int(row["factId"].rsplit("_", 1)[1])
        seq_by_company[code] = max(seq_by_company.get(code, 0), seq)
        known_texts.setdefault(code, set()).add(clean(row["rawText"]))

    totals = {"companiesScanned": 0, "companiesWithPdf": 0, "concentration": 0, "relation": 0,
              "fineProduct": 0, "dedupDropped": 0, "lexiconCompanies": 0, "byCategory": {}, "missing": {}}
    ordered_rows: list[dict] = []
    payloads = [(c["code"], c["name"]) for c in company_list]

    with Pool(args.workers, initializer=_init_worker, initargs=(lexicon, products)) as pool:
        done = 0
        for result in pool.imap(extract_company, payloads, chunksize=20):
            done += 1
            totals["companiesScanned"] += 1
            if result["missing"]:
                totals["missing"][result["missing"]] = totals["missing"].get(result["missing"], 0) + 1
                continue
            stats = result["stats"]
            totals["companiesWithPdf"] += 1
            totals["concentration"] += stats["concentration"]
            totals["relation"] += stats["relation"]
            totals["fineProduct"] += stats["fineProduct"]
            totals["dedupDropped"] += stats["rejected"].get("contained", 0)
            totals["lexiconCompanies"] += 1 if stats["lexiconWindow"] else 0
            for cat, n in stats["byCategory"].items():
                totals["byCategory"][cat] = totals["byCategory"].get(cat, 0) + n
            ordered_rows.extend(result["rows"])
            if done % 500 == 0:
                print(f"  {done}/{len(payloads)} companies scanned", flush=True)

    # 主进程统一续 factId 序号 + 公司内去重（对既有行与新行都生效，顺序确定）
    new_rows: list[dict] = []
    for row in ordered_rows:
        code = row["companyCode"]
        company_known = known_texts.setdefault(code, set())
        text = clean(row["rawText"])
        if text in company_known:
            totals["dedupDropped"] += 1
            continue
        company_known.add(text)
        seq_by_company[code] = seq_by_company.get(code, 0) + 1
        row["factId"] = f"sf_{code}_{seq_by_company[code]:06d}"
        new_rows.append(row)

    # 排序合并写：新行插入 (companyCode, factId) 的排序位置；既有行保持原字节
    # 与相对序（tests/sourcefacts.test.ts 全局排序锁）——本阶段只增不改。
    merged: list[tuple[tuple[str, str], str]] = []
    for line in existing_lines:
        if not line.strip():
            continue
        row = json.loads(line)
        merged.append(((row["companyCode"], row["factId"]), line))
    for row in new_rows:
        merged.append(((row["companyCode"], row["factId"]), json.dumps(row, ensure_ascii=False, separators=(",", ":"))))
    merged.sort(key=lambda pair: pair[0])
    with FACTS_FILE.open("w", encoding="utf-8", newline="\n") as handle:
        for _key, line in merged:
            handle.write(line + "\n")

    # manifest 更新（layer 版本 1.1.0；行格式保持 1.0.0）
    all_rows = existing_rows + new_rows
    by_fact_type: dict[str, int] = {}
    by_source_type: dict[str, int] = {}
    by_channel: dict[str, int] = {}
    for row in all_rows:
        by_fact_type[row["factType"]] = by_fact_type.get(row["factType"], 0) + 1
        st = row["source"]["sourceType"]
        by_source_type[st] = by_source_type.get(st, 0) + 1
        if st == "filing_annual_report":
            channel = row["source"]["sourceId"].split("#", 1)[-1].split(":")[0]
            by_channel[channel] = by_channel.get(channel, 0) + 1
    file_bytes = FACTS_FILE.read_bytes()
    manifest = {
        "schemaVersion": "1.1.0",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "factCount": len(all_rows),
        "companyCount": len({row["companyCode"] for row in all_rows}),
        "pilotFrozen": 169,
        "byFactType": by_fact_type,
        "bySourceType": by_source_type,
        "annualReportChannel": by_channel,
        "contentDigest": {"algorithm": "sha256", "scope": "facts.jsonl", "value": sha256_of_bytes(file_bytes)},
    }
    FACTS_MANIFEST.write_bytes((json.dumps(manifest, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    samples = [
        {"code": r["companyCode"], "category": r["source"]["sourceId"].split("#")[-1], "text": r["rawText"][:130]}
        for r in new_rows if "#relation:" in r["source"]["sourceId"]
    ][:10]
    report = {
        "totals": totals,
        "existingRows": len(existing_rows),
        "newRows": len(new_rows),
        "sampleRelationFacts": samples,
        "elapsedSeconds": round(time.time() - started, 1),
    }
    (OUT_DIR / "extraction_report.json").write_bytes(json.dumps(report, ensure_ascii=False, indent=1).encode("utf-8"))
    print(json.dumps(report, ensure_ascii=False)[:1200])
    print(f"appended {len(new_rows)} facts -> {FACTS_FILE}")


if __name__ == "__main__":
    main()
