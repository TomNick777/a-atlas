# Stage 3 evidence extractor — 年报 PDF → 可检索工艺证据窗口(规格第五/八/九节)。
#
# 对 data/sources/semiconductor/<code>/ 的每份 Tier 1 年报:
#   - 逐页扫描工艺/材料/设备关键词
#   - 每个命中截取最小证明片段(±窗口,≤190 字符),记录页码+节区
#   - 另抓「主营业务概述」段(业务总览证据)
#   - 去重、限量(每关键词≤6,每公司≤48 + 总览)
# 输出 data/sources/semiconductor/<code>/evidence_raw.json(不进 git;派生可重跑)
#
# Usage: .venv/Scripts/python.exe -u scripts/stage3_extract_evidence.py [--codes a,b]
import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import pymupdf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC_BASE = ROOT / "data" / "sources" / "semiconductor"

KEYWORDS = [
    # equipment / process
    "刻蚀", "蚀刻", "CVD", "PECVD", "LPCVD", "SACVD", "MOCVD", "ALD", "原子层沉积",
    "薄膜沉积", "薄膜设备", "PVD", "物理气相沉积", "溅射", "外延",
    "清洗设备", "单片清洗", "槽式清洗", "湿法", "湿法清洗",
    "CMP", "化学机械抛光", "抛光液", "抛光垫",
    "涂胶显影", "离子注入", "光刻机", "光刻设备", "光刻工艺",
    "立式炉", "炉管", "氧化炉", "扩散炉", "快速热处理", "RTP",
    "减薄", "划片", "晶圆切割",
    "测试机", "测试系统", "分选机", "探针台", "探针卡", "ATE", "老化测试",
    "量测", "缺陷检测", "缺陷检查", "膜厚",
    "固晶机", "键合机", "引线键合", "封装设备", "塑封",
    "晶体生长", "长晶炉", "单晶炉", "晶体炉",
    "半导体设备", "半导体装备", "集成电路设备", "电子工艺装备",
    "真空腔体", "气体管路", "真空阀",
    # materials / parts
    "硅片", "抛光片", "外延片", "衬底", "硅零部件", "硅电极", "硅环",
    "掩膜版", "掩模版", "光罩", "靶材", "溅射靶材",
    "电子特气", "特种气体", "高纯气体", "电子级",
    "湿电子化学品", "超纯试剂", "蚀刻液", "刻蚀液",
    "前驱体", "MO源", "光刻胶",
    "石英", "陶瓷", "引线框架", "封装基板", "载板", "键合线", "键合丝",
    "碳化硅", "氮化镓", "砷化镓", "金刚石",
]

OVERVIEW_RE = re.compile(r"(报告期内公司从事(?:的)?主要业务|主营业务及经营模式|公司从事的主要业务|主要业务及产品)")
SECTION_RE = re.compile(r"^(第[一二三四五六七八九十百]+节)\s*([^\n]{0,30})")

WINDOWS_PER_KEYWORD = 8
MAX_EVIDENCES = 60


def clean_window(text: str, center: int, before: int = 70, after: int = 110) -> str:
    raw = text[max(0, center - before): center + after]
    return re.sub(r"\s+", "", raw)


HEADER_LINE_RE = re.compile(r"(\d+\s*/\s*\d+\s*$|^\s*\d+\s*$)")
TITLE_LINE_RE = re.compile(r"股份有限公司.{0,12}年度报告|年度报告.{0,12}全文")


def strip_boilerplate(page_text: str) -> str:
    """去页眉/页脚/页码行:它们包含公司名(可能自带工艺词)和页码,不承载内容。"""
    lines = []
    for line in page_text.split("\n"):
        s = line.strip()
        if HEADER_LINE_RE.search(s) and len(s) <= 12:
            continue
        if TITLE_LINE_RE.search(s) and len(s) <= 45:
            continue
        lines.append(line)
    return "\n".join(lines)


def is_definition(keyword: str, page_text: str, center: int) -> bool:
    """「X指…」术语定义窗口(释义节样板文)不能作为能力证据;「外延片指」这类
    变体同样命中(关键词后 0-3 字内跟指,且不是「指引/指导/指数」)。"""
    tail = re.sub(r"\s+", "", page_text[center: center + len(keyword) + 6])
    m = re.match(re.escape(keyword) + r".{0,3}指", tail)
    if not m:
        return False
    return not re.search(r"指[引导出数]", m.group(0)[-2:])


GLOSSARY_RE = re.compile(r"[一-龥A-Za-z]{1,12}\s*指(?![引导出数])")  # 释义表「词\n指\n定义」排版,指 常独占一行
COVER_RE = re.compile(r"公司代码|公司简称")


def page_kind(page_text: str) -> str:
    if COVER_RE.search(page_text[:400]) and len(page_text) < 1500:
        return "cover"
    if len(GLOSSARY_RE.findall(page_text)) >= 5:
        return "glossary"
    return "content"


def extract_company(code_dir: Path) -> dict | None:
    manifest_path = code_dir / "manifest.json"
    if not manifest_path.exists():
        return None
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    pdf_path = code_dir / manifest.get("fileName", "")
    if not pdf_path.exists():
        return None

    doc = pymupdf.open(str(pdf_path))
    evidences: list[dict] = []
    seen_windows: set[str] = set()
    per_keyword: dict[str, int] = {}
    section = ""
    overview_done = False

    # 公司全名/简称里常带工艺词(「中微半导体设备」),先占位替换再扫描,
    # 否则页眉/释义表/子公司名都会给「半导体设备」制造假命中。
    company_names = {manifest.get("companyName", "")}
    raw_file = ROOT / "data" / "raw" / "companies" / f"{manifest['companyCode']}.json"
    if raw_file.exists():
        try:
            profile = json.loads(raw_file.read_text(encoding="utf-8")).get("profile") or {}
            company_names.add(profile.get("公司名称", ""))
        except Exception:
            pass
    expanded = set()
    for name in company_names:
        if name:
            expanded.add(name)
            expanded.add(name.replace("股份有限公司", "").replace("有限公司", ""))
    company_names = [n for n in expanded if len(n) >= 4]

    for page_no in range(len(doc)):
        raw_text = doc[page_no].get_text()
        if not raw_text:
            continue
        kind = page_kind(raw_text)
        if kind == "cover":
            continue
        page_text = strip_boilerplate(raw_text)
        for name in company_names:
            page_text = page_text.replace(name, "◎")
        for line in raw_text.split("\n"):
            m = SECTION_RE.match(line.strip())
            if m:
                section = f"{m.group(1)} {m.group(2)}".strip()
        # business overview paragraph(优先级证据,不受窗口去重限制)
        if not overview_done:
            m = OVERVIEW_RE.search(page_text)
            if m:
                snippet = re.sub(r"\s+", "", page_text[m.start(): m.start() + 420])
                if len(snippet) >= 80:
                    evidences.append({
                        "page": page_no + 1,
                        "section": section,
                        "keyword": "主营业务概述",
                        "text": snippet[:420],
                    })
                    overview_done = True
        if len(evidences) >= MAX_EVIDENCES + 8:
            break
        # 释义/术语定义页是样板文,不能作为能力证据(内容级检测,节标题跟踪只作辅助)
        if kind == "glossary" or "释义" in section:
            continue
        for match in re.finditer("|".join(re.escape(k) for k in KEYWORDS), page_text):
            keyword = match.group(0)
            if per_keyword.get(keyword, 0) >= WINDOWS_PER_KEYWORD:
                continue
            if is_definition(keyword, page_text, match.start()):
                continue
            window = clean_window(page_text, match.start())
            if len(window) < 30:
                continue
            prefix = window[:40]
            if prefix in seen_windows or window in seen_windows:
                continue
            seen_windows.add(window)
            seen_windows.add(prefix)
            per_keyword[keyword] = per_keyword.get(keyword, 0) + 1
            evidences.append({"page": page_no + 1, "section": section, "keyword": keyword, "text": window[:190]})
            if len(evidences) >= MAX_EVIDENCES + 8:
                break

    doc.close()
    # overview 固定排最前,其余按页序;超过上限时丢非 overview 尾部
    evidences.sort(key=lambda e: (0 if e["keyword"] == "主营业务概述" else 1, e["page"]))
    evidences = evidences[: MAX_EVIDENCES + 1]
    return {
        "companyCode": manifest["companyCode"],
        "sourceTitle": manifest["sourceTitle"],
        "reportPeriod": manifest.get("reportPeriod"),
        "sourceDate": manifest.get("sourceDate"),
        "sourceUrl": manifest.get("sourceUrl"),
        "documentSha256": manifest.get("documentSha256"),
        "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pageCount": None,
        "evidences": evidences,
    }


def main() -> None:
    codes_filter = None
    if "--codes" in sys.argv:
        codes_filter = set(sys.argv[sys.argv.index("--codes") + 1].split(","))
    stats = {"companies": 0, "evidences": 0, "skipped": 0}
    for code_dir in sorted(SRC_BASE.iterdir()):
        if not code_dir.is_dir() or (codes_filter and code_dir.name not in codes_filter):
            continue
        out = code_dir / "evidence_raw.json"
        if out.exists():
            stats["skipped"] += 1
            continue
        result = extract_company(code_dir)
        if result is None:
            continue
        result["pageCount"] = None
        out.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
        stats["companies"] += 1
        stats["evidences"] += len(result["evidences"])
        print(f"  {code_dir.name}: {len(result['evidences'])} evidences")
    print(f"extracted {stats['companies']} companies, {stats['evidences']} evidences, skipped {stats['skipped']} (already done)")


if __name__ == "__main__":
    main()
