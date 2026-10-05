"""Source Coverage Pass 1 — fact extraction (pin/compile side).

从 data/raw/source_facts/<code>/ 的原始缓存提取 CompanySourceFact（见
lib/sourcefacts/contracts.ts），写 committed 产物：

  data/source_facts/facts.jsonl       逐行一条事实，rawText 保真
  data/source_facts/manifest.json     schema 版本 + 来源统计 + facts.jsonl sha16
  data/source_facts/fetch_report.json 逐公司逐 artifact 的抓取对账（committed）

提取规则全部确定性（无 LLM、无网络）：

  zyjs 产品类型/产品名称   → factType=product，terms=按「、」切分
  zyjs/cninfo 经营范围     → factType=business，terms=[]（登记语言只存证，不派生词）
  cninfo 主营业务（与 THS 主营业务不同时）→ factType=business，terms=[]
  zygc 按产品分类          → 每个产品名取报告期最新一行，factType=product，
                             terms=[产品名]，date=报告期，占比进 rawText 以外还
                             以 structured 的方式留在 provenance 之外（rawText
                             仍是单元格原文）
  年报 PDF                → 旗舰产品词表逐页扫，最小证据窗口（stage3 同法），
                             factType 按词表映射，terms=[命中词]

Usage:
  # 用带 pymupdf 的同一 python 环境运行
  python -u scripts/source_coverage_extract_facts.py
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
RAW_BASE = ROOT / "data" / "raw" / "source_facts"
OUT_DIR = ROOT / "data" / "source_facts"
COMPANIES_FILE = ROOT / "data" / "companies.json"

SCHEMA_VERSION = "1.0.0"

# Pass 1 pilot：committed facts 是冻结证据，Pass 2 重提取时不重建——
# committed 输出模式（--out 为默认目录）下原样保留这些行，只提取其余公司。
PILOT = {"000651", "000333", "300124", "688320", "603416", "688187"}

# 旗舰证据词表（Pass 1 pilot）：word → factType。来源=Phase 2 探针确认的 gap 词面。
# 只匹配、只引用，不做同义扩展。
ANNUAL_TERMS: dict[str, str] = {
    "伺服系统": "product",
    "伺服驱动": "product",
    "伺服电机": "product",
    "交流伺服": "product",
    "IGBT": "technology",
    "绝缘栅双极型晶体管": "technology",
    "功率半导体": "technology",
    "家用空调": "product",
    "空气调节器": "product",
    "中央空调": "product",
    "暖通空调": "product",
    "不间断电源": "product",
    "UPS": "product",
}

WINDOWS_PER_TERM = 4
MAX_REPORT_FACTS = 24
WINDOW_BEFORE = 60
WINDOW_AFTER = 100


def sha16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def clean_window(text: str, center: int) -> str:
    raw = text[max(0, center - WINDOW_BEFORE): center + WINDOW_AFTER]
    return re.sub(r"\s+", "", raw)


def is_definition(flat: str, at: int, term: str) -> bool:
    """「X指…」释义节样板窗口不是该公司做这个产品的证据（stage3 同一守卫）。"""
    return flat[at + len(term): at + len(term) + 1] == "指"


# 窗口级噪声守卫：命中这些语境的窗口不作为「该公司做这个产品」的证据。
# 每条规则都来自 pilot 实测的假关联（禾川 IGBT=行业上游描述、汇川 功率半导体=
# 供应链风险段、格力 伺服系统=董事简历、各家年报释义节）。
GLOSSARY_RE = re.compile(r"指.{0,24}指")          # 释义节：一段里多个「X指…」
UPSTREAM_RE = re.compile(r"上游|原材料|大宗商品|供应链风险")  # 采购/风险语境
BIO_RE = re.compile(r"董事|监事|学历|学位|入职")     # 高管简历语境


def window_rejected(window: str) -> str | None:
    if GLOSSARY_RE.search(window):
        return "glossary"
    if UPSTREAM_RE.search(window):
        return "upstream_or_risk"
    if BIO_RE.search(window):
        return "bio"
    return None


HEADER_LINE_RE = re.compile(r"^\d{1,4}$|^\d{1,3}\s*/\s*\d{1,3}$")
TITLE_LINE_RE = re.compile(r"年度报告")


def strip_page_noise(page_text: str) -> str:
    """去页码/页眉行：它们含公司全称与页码，不承载业务内容。"""
    lines = []
    for line in page_text.split("\n"):
        s = line.strip()
        if HEADER_LINE_RE.fullmatch(s) and len(s) <= 12:
            continue
        if TITLE_LINE_RE.search(s) and len(s) <= 45:
            continue
        lines.append(line)
    return "\n".join(lines)


def period_of(epoch_ms: float | str | None) -> str | None:
    if epoch_ms in (None, ""):
        return None
    try:
        return time.strftime("%Y-%m-%d", time.localtime(float(epoch_ms) / 1000))
    except (TypeError, ValueError):
        return str(epoch_ms)[:10]


class FactWriter:
    def __init__(self) -> None:
        self.facts: list[dict] = []
        self.seq: dict[str, int] = {}

    def add(self, code: str, name: str, fact_type: str, terms: list[str], raw_text: str,
            source_id: str, source_name: str, source_type: str,
            locator: str | None = None, date: str | None = None,
            artifact_sha256: str | None = None, retrieved_at: str | None = None) -> None:
        raw_text = re.sub(r"\s+", " ", raw_text).strip()
        if not raw_text:
            return
        seen: list[str] = []
        for term in terms:
            term = term.strip()
            if term and term in raw_text and term not in seen:
                seen.append(term)
        if not raw_text:
            return
        n = self.seq.get(code, 0) + 1
        self.seq[code] = n
        self.facts.append({
            "schemaVersion": SCHEMA_VERSION,
            "factId": f"sf_{code}_{n:06d}",
            "companyCode": code,
            "companyName": name,
            "factType": fact_type,
            "terms": seen,
            "rawText": raw_text,
            "source": {
                "sourceId": source_id,
                "sourceName": source_name,
                "sourceType": source_type,
                **({"locator": locator} if locator else {}),
                **({"date": date} if date else {}),
            },
            "retrievedAt": retrieved_at or "",
            **({"artifactSha256": artifact_sha256} if artifact_sha256 else {}),
        })


def residual_bucket(name: str) -> bool:
    """残差/会计桶不是产品事实：其他*、合计、平衡项目、租赁收入类。

    Pass 2 全样本复检（266 家分层样本）在 pilot 之外新证实的假阳性形态：
    抵销/抵消（分部间抵销 df≈9% 全是金融/多分部公司）、小计（电影及衍生小计）、
    调整项目、租赁收入（df≈5%，Pass 1 只挡了「租赁/租金收入」两个精确形）、
    废料/副产品/下脚料（ scrap 处置行，全池 df 3%+）。
    租赁取子串口径：融资租赁类公司的真实产品词仍可由 THS 产品类型/巨潮进入，
    zygc 的租赁收入行一律视为残差（决策记录见 FULL_MARKET_EXTRACTION_AUDIT.md）。"""
    if not name:
        return True
    if name in {"合计", "平衡项目", "材料销售收入", "租赁", "租金收入", "原材料及废料", "材料销售", "劳务"}:
        return True
    if re.search(r"其他|其它|抵销|抵消|小计|调整项目|租赁|租金|分部间|下角料|废料|副产品", name):
        return True
    return False


# 报表枚举标记是排版产物不是产品名的一部分：term 剥离后仍是 rawText 子串。
LEADING_MARKER_RE = re.compile(r"^[（(][一二三四五六七八九十\d]{1,3}[)）]\s*|^\d+[.、]\s*")


def strip_marker(name: str) -> str:
    return LEADING_MARKER_RE.sub("", name).strip()


def split_terms(value: str) -> list[str]:
    """顿号/逗号/分号切分，但括号内的分隔符不算切点（「注射用盐酸伊吡诺司他
    （BEBT-908，商品名：贝特琳）」是一个产品名，不能拦腰斩断）。"""
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in value:
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        if ch in "、,，;；" and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return [p.strip() for p in (strip_marker(part) for part in parts)
            if 1 < len(p.strip()) <= 24 and not residual_bucket(p.strip())]


def extract_feeds(code: str, company_name: str, payload: dict, writer: FactWriter) -> dict:
    stats = {"product_types": 0, "business_scope": 0, "cninfo_business": 0, "zygc_products": 0}
    retrieved_at = payload.get("retrievedAt", "")

    zyjs = (payload.get("zyjs") or [{}])[0] if payload.get("zyjs") else {}
    ths_business = str(zyjs.get("主营业务") or "").strip()

    for field in ("产品类型", "产品名称"):
        value = str(zyjs.get(field) or "").strip()
        if not value or value == ths_business:
            continue
        kept = split_terms(value)
        if kept:
            writer.add(code, company_name, "product", kept, value,
                       f"akshare:stock_zyjs_ths#{field}", f"同花顺主营介绍·{field}(ak.stock_zyjs_ths)",
                       "disclosure_summary", retrieved_at=retrieved_at)
        else:
            # 词条全被残差桶/长度规则过滤：整格纯残差（租赁、其他*）不是产品事实，
            # 不立；真实描述性内容（整段超长、单字商品名）以 business 登记证据
            # 保留（terms=[]，同 registry 文本口径——evidence 在、无派生词）。
            parts = [p.strip() for p in re.split(r"[、,，;；]", value) if p.strip()]
            non_residual = [p for p in parts if not residual_bucket(strip_marker(p))]
            if non_residual:
                writer.add(code, company_name, "business", [], value,
                           f"akshare:stock_zyjs_ths#{field}", f"同花顺主营介绍·{field}(ak.stock_zyjs_ths)",
                           "disclosure_summary", retrieved_at=retrieved_at)
        stats["product_types"] += 1
        break

    for scope_field, scope_id in (("经营范围", "akshare:stock_zyjs_ths#business_scope"),):
        value = str(zyjs.get(scope_field) or "").strip()
        if value:
            writer.add(code, company_name, "business", [], value, scope_id,
                       "同花顺主营介绍·经营范围(ak.stock_zyjs_ths)",
                       "registry_scope", retrieved_at=retrieved_at)
            stats["business_scope"] += 1

    profile = (payload.get("profile_cninfo") or [{}])[0] if payload.get("profile_cninfo") else {}
    cn_business = str(profile.get("主营业务") or "").strip()
    if cn_business and cn_business != ths_business:
        writer.add(code, company_name, "business", [], cn_business,
                   "akshare:stock_profile_cninfo#main_business", "巨潮公司资料·主营业务(ak.stock_profile_cninfo)",
                   "disclosure_summary", retrieved_at=retrieved_at)
        stats["cninfo_business"] += 1
    cn_scope = str(profile.get("经营范围") or "").strip()
    if cn_scope and cn_scope != str(zyjs.get("经营范围") or "").strip():
        writer.add(code, company_name, "business", [], cn_scope,
                   "akshare:stock_profile_cninfo#business_scope", "巨潮公司资料·经营范围(ak.stock_profile_cninfo)",
                   "registry_scope", retrieved_at=retrieved_at)
        stats["business_scope"] += 1

    rows = [r for r in (payload.get("zygc") or []) if r.get("分类类型") == "按产品分类"]
    latest_by_name: dict[str, dict] = {}
    for row in rows:
        name = zygc_term(str(row.get("主营构成") or ""))
        if not name or len(name) > 24:
            continue
        period = period_of(row.get("报告日期"))
        current = latest_by_name.get(name)
        if current is None or (period or "") > (current.get("_period") or ""):
            latest_by_name[name] = {**row, "_period": period}
    for name, row in sorted(latest_by_name.items()):
        writer.add(code, company_name, "product", [name], str(row.get("主营构成") or ""),
                   "akshare:stock_zygc_em#product_split_history",
                   "东方财富主营构成·按产品(全报告期,ak.stock_zygc_em)",
                   "filing_product_split",
                   date=row.get("_period"),
                   artifact_sha256=sha16(json.dumps(row, ensure_ascii=False)),
                   retrieved_at=retrieved_at)
        stats["zygc_products"] += 1
    return stats


def zygc_term(cell: str) -> str | None:
    """主营构成单元格 → 派生词。残差桶不是产品事实；「其中:A-B」取子项 B
    （父类 A 已在主要产品行）；其中标记有冒号/分号/无标记三形，一律剥离；
    报表枚举标记（(一)整车）从词条剥离；词条最短 2 字（单字商品名「电/煤/银」
    是检索噪声，rawText 仍保真）。返回的词必须是单元格原文的子串。"""
    n = cell.strip()
    n = re.sub(r"^其中\s*[:：;；]?\s*", "", n)
    if "-" in n:
        n = n.rsplit("-", 1)[1].strip()
    n = strip_marker(n)
    if residual_bucket(n):
        return None
    if len(n) < 2:
        return None
    return n


def extract_annual_report(code: str, company_name: str, pdf_path: Path, artifact: dict, writer: FactWriter) -> dict:
    stats = {"pages": 0, "windows": 0, "rejected": {}}
    doc = pymupdf.open(pdf_path)
    hits: dict[str, list[dict]] = {}
    for page_index, page in enumerate(doc):
        flat = re.sub(r"\s+", "", strip_page_noise(page.get_text("text")))
        stats["pages"] += 1
        for term in ANNUAL_TERMS:
            start = 0
            while len(hits.get(term, [])) < WINDOWS_PER_TERM:
                at = flat.find(term, start)
                if at < 0:
                    break
                start = at + len(term)
                if is_definition(flat, at, term):
                    continue
                window = clean_window(flat, at)
                # 公司语境：窗口必须出现「公司」或本公司简称，否则是行业泛述。
                if "公司" not in window and company_name not in window:
                    continue
                reason = window_rejected(window)
                if reason:
                    stats["rejected"][reason] = stats["rejected"].get(reason, 0) + 1
                    continue
                bucket = hits.setdefault(term, [])
                if any(window == seen["rawText"] for seen in bucket):
                    continue
                bucket.append({"rawText": window, "page": page_index + 1})
    doc.close()

    fiscal_year = artifact.get("fiscalYear")
    base_locator = artifact.get("url", pdf_path.name)
    url_date = re.search(r"finalpage/(\d{4}-\d{2}-\d{2})/", base_locator)
    filing_date = artifact.get("filingDate") or (url_date.group(1) if url_date else None)
    for term, rows in sorted(hits.items()):
        for row in rows[:WINDOWS_PER_TERM]:
            if len([f for f in writer.facts if f["companyCode"] == code and f["source"]["sourceType"] == "filing_annual_report"]) >= MAX_REPORT_FACTS:
                break
            writer.add(code, company_name, ANNUAL_TERMS[term], [term], row["rawText"],
                       "cninfo:annual_report", f"巨潮年报({fiscal_year}年度,{pdf_path.name})",
                       "filing_annual_report",
                       locator=f"{base_locator}#page={row['page']}",
                       date=filing_date,
                       artifact_sha256=artifact.get("sha256"))
            stats["windows"] += 1
    return stats


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(OUT_DIR), help="输出目录（coverage scan 用临时目录，不覆盖 pilot 产物）")
    args = parser.parse_args()
    out_dir = Path(args.out)
    if not RAW_BASE.exists():
        raise SystemExit("data/raw/source_facts missing; run source_coverage_fetch.py first")

    # companyName 以 companies.json canonical 名称为准（§10 companyName 必须
    # 与 canonical 一致；payload 简称只是展示口径，身份主键是 companyCode）。
    canonical = {c["code"]: c["name"] for c in json.loads(COMPANIES_FILE.read_text(encoding="utf-8"))["companies"]}

    # committed 输出模式：pilot 行原样保留（Pass 1 冻结证据，不重建）。
    committed_mode = out_dir.resolve() == OUT_DIR.resolve()
    pilot_lines: list[str] = []
    if committed_mode:
        committed_path = OUT_DIR / "facts.jsonl"
        if committed_path.exists():
            for line in committed_path.read_bytes().decode("utf-8").split("\n"):
                if line.strip() and json.loads(line)["companyCode"] in PILOT:
                    pilot_lines.append(line)

    writer = FactWriter()
    report = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "companies": {}}
    orphans: list[str] = []

    for code_dir in sorted(RAW_BASE.iterdir()):
        if not code_dir.is_dir():
            continue
        code = code_dir.name
        if committed_mode and code in PILOT:
            report["companies"][code] = {"facts": None, "pilotFrozen": True}
            continue
        if code not in canonical:
            orphans.append(code)
            continue
        manifest_path = code_dir / "manifest.json"
        feeds_path = code_dir / "feeds.json"
        if not manifest_path.exists() or not feeds_path.exists():
            continue
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        artifacts = {a["file"]: a for a in manifest.get("artifacts", [])}
        feeds = json.loads(feeds_path.read_text(encoding="utf-8"))
        company_name = canonical[code]

        per_company = {"facts": 0}
        feeds_artifact = artifacts.get("feeds.json", {})
        per_company["feeds"] = extract_feeds(code, company_name, feeds, writer)
        annual = next((a for key, a in artifacts.items() if key.startswith("annual-report-")), None)
        per_company["annual_report"] = None
        if annual:
            pdf_path = code_dir / annual["file"]
            if pdf_path.exists():
                per_company["annual_report"] = extract_annual_report(code, company_name, pdf_path, annual, writer)
        per_company["facts"] = len([f for f in writer.facts if f["companyCode"] == code])
        report["companies"][code] = per_company

    for fact in writer.facts:
        if not fact["retrievedAt"]:
            fact["retrievedAt"] = report["generatedAt"]

    if orphans:
        raise SystemExit(f"raw cache codes not in companies.json authority (orphans): {orphans[:20]}")

    out_dir.mkdir(parents=True, exist_ok=True)
    writer.facts.sort(key=lambda f: (f["companyCode"], f["factId"]))
    lines = [json.dumps(f, ensure_ascii=False) for f in writer.facts]
    # pilot 冻结行按 (companyCode, factId) 有序合并回最终文件。
    lines.extend(pilot_lines)
    lines.sort(key=lambda line: (json.loads(line)["companyCode"], json.loads(line)["factId"]))
    jsonl = "\n".join(lines) + "\n"
    # 字节级写盘：Windows 上 write_text 会把 \n 翻译成 \r\n，digest 就对不上字节了。
    (out_dir / "facts.jsonl").write_bytes(jsonl.encode("utf-8"))

    by_type: dict[str, int] = {}
    by_source: dict[str, int] = {}
    for line in lines:
        fact = json.loads(line)
        by_type[fact["factType"]] = by_type.get(fact["factType"], 0) + 1
        by_source[fact["source"]["sourceType"]] = by_source.get(fact["source"]["sourceType"], 0) + 1
    out_manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": report["generatedAt"],
        "factCount": len(lines),
        "companyCount": len({json.loads(line)["companyCode"] for line in lines}),
        "pilotFrozen": len(pilot_lines),
        "byFactType": by_type,
        "bySourceType": by_source,
        "contentDigest": {"algorithm": "sha256", "scope": "facts.jsonl", "value": hashlib.sha256(jsonl.encode("utf-8")).hexdigest()},
    }
    (out_dir / "manifest.json").write_text(json.dumps(out_manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (out_dir / "fetch_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(out_manifest, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
