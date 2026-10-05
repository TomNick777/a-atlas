"""Evidence Surface Expansion — deterministic evidence extraction (Phase 3.7).

从两类新 surface 的 raw snapshot 提取 source-backed 证据，以排序合并方式写入
committed 的 data/source_facts/facts.jsonl（既有行逐字节不变、相对序不变；
新行插到 (companyCode, factId) 排序位——与 3.6 同法，append-only）：

  Surface A — 公告关系证据（factType=relation, sourceType=filing_announcement）
    输入 data/raw/source_facts/<code>/announcements/announce-*.pdf（标题门槛已由
    acquisition 完成）。窗口 = 关系短语 ±60/100 + 句读吸附（3.6 同法），加两级
    确定性分类（§5/§6，全部来自窗口原文，零推测）：
      relationType  customer / supplier / cooperation / certification / bid / other
      strength      planned / sampling / trial / confirmed / stated / unclear
    编码进 sourceId 片段 `cninfo:announcement#<relationType>:<strength>`——
    不同强度的关系绝不压成一个布尔（送样≠供货、协议≠收入，§6/§7）。
    direction 由短语表确定性解析（公司为公告主体）：中标/供货/销售→公司卖给
    对象；采购/供应商→公司向对象买；合作→mutual；判不出→unresolved（§8）。
    时间 = announcedAt（披露日，一等字段，§9），绝不升级成 current。

  Surface B — 官网产品证据（factType=product, sourceType=official_product_page）
    输入 data/raw/source_facts/<code>/website/*.html snapshot。句子级 verbatim
    证据：通用产品能力词表定位 + 噪声行守卫（版权/登录/备案…），只收原文句，
    不自造 tag、不扩写（§18）；provenance = 页面 canonical URL + retrievedAt +
    sha256（§19）；页面无可靠披露时点 → 不写 date，freshness 只记 retrievedAt（§26）。

纪律：全部确定性（规则抽取，零 LLM）；公司内 cleaned rawText 精确/包含去重；
manifest 走「读改写」保住 3.6 字段并新增 surfaces registry 块（§38/§39）；
factId 主进程统一续号，行序确定性；没有 snapshot 的公司 = 本通道无事实（NO_FACT），
绝不解释成「没有关系/没有产品」（§21）。

Usage (services venv python):
  python -u scripts/evidence_surface_extract.py [--workers 4]
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
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
RAW_BASE = ROOT / "data" / "raw" / "source_facts"
FACTS_FILE = ROOT / "data" / "source_facts" / "facts.jsonl"
FACTS_MANIFEST = ROOT / "data" / "source_facts" / "manifest.json"
OUT_DIR = ROOT / "reports" / "EVIDENCE_SURFACE_EXPANSION"

WINDOW_BEFORE = 60
WINDOW_AFTER = 100
MIN_WINDOW_CHARS = 20
MAX_RELATION_WINDOWS = 6          # 单家公告通道窗口上限
MAX_PRODUCT_SENTENCES_PER_PAGE = 4
MAX_PRODUCT_ROWS = 6              # 单家官网通道行上限
SNAP_CHARS = 40
SENTENCE_END_RE = re.compile(r"[。！？；]")

EXTRACTOR_VERSION = "evidence-surface-extract-1"

# ---- Surface A：关系短语定位 + 强度/类型/方向分类（全部确定性词面规则） ----

# 定位短语：公告文体里的关系陈述结构（与年报 RELATION_PATTERN 同性质——
# 抽取门槛，不是语义层；不含任何公司/行业专名）。「为…提供」后必须跟通用
# 产品名词——挡掉「为…发展提供强力支撑」式的抽象支撑语。
RELATION_PATTERN_RE = re.compile(
    r"为.{2,40}?提供(了)?(产品|服务|设备|系统|解决方案|技术|部件|组件|结构件|材料|装备|软件|工程)"
    r"|向.{2,20}?(销售|供应|供货|采购|购买)"
    r"|与.{2,24}?(签署|签订|合作|达成)"
    r"|(签订|签署).{0,24}(合同|协议|订单)"
    r"|(中标|中选|定点)"
    r"|(批量供货|批量供应|已供货|已交付|正式供应)"
    r"|(送样|样品|样机|试样)"
    r"|(通过|获得).{0,12}认证"
    r"|(合格供应商|供应商目录|供应商名单|入围)"
    r"|(战略合作|合作框架|框架协议|合作协议)"
    r"|(联合开发|共同开发|联合研制)"
)
# 抽取守卫：法律条款/争议解决段是协议文本但不是关系证据。
LEGAL_BOILER_RE = re.compile(r"诉讼|仲裁|法院|管辖|违约|争议解决|反诉")

# 强度分类（§6）：按表中顺序第一个命中者生效——送样/测试类优先于「已」类，
# 候选/拟类优先于中标本体。原文没有强度词面 → unclear，绝不猜。
# planned 的「拟」与动词之间允许插入公司简称括注（「拟与XX（以下简称…）签署」）。
STRENGTH_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("planned", re.compile(r"拟[^。；]{0,40}?(签订|签署|中标|投资|合作)|意向(书|性|协议)|预中标|中标候选人|计划(签订|投产|合作)")),
    ("sampling", re.compile(r"送样|样品|样机|试样")),
    ("trial", re.compile(r"试用|测试验证|验证(中|阶段)|测试(中|阶段)|小批量试")),
    ("confirmed", re.compile(r"中标|中选|定点|(签订|签署)了?|获得.{0,8}订单|批量供货|批量供应|已供货|已交付|正式供应|(通过|获得).{0,12}认证|入围")),
    ("stated", re.compile(r"(战略)?(合作|协议|供应|供货|销售|采购)")),
]

# relationType + direction（§8）：direction ∈ sells_to / buys_from / mutual / unresolved。
# 「入选/入围…供应商名单」是公司被选为供应商 = 公司卖给对象（customer 方向）；
# 「（以下简称“供应商”）」把对手方定义为供应商 = 公司向对手买（buys_from）——
# 方向由短语词面决定，判不出就 unresolved，绝不猜（§8）。supplier 的对手方
# 角色括注检查先于 customer 的裸「供货」词，否则买卖方向必然误判。
TYPE_RULES: list[tuple[str, str, re.Pattern[str]]] = [
    ("bid", "sells_to", re.compile(r"中标|中选|定点")),
    ("certification", "sells_to", re.compile(r"(通过|获得).{0,12}认证|(入选|入围|列入).{0,24}(合格供应商|供应商名单|供应商目录)|选定供应商")),
    ("supplier", "buys_from", re.compile(r"简称.?.{0,3}(供应商|卖方)[”」）)]|向.{2,20}?(采购|购买)|向(公司|本公司|发行人)(供应|销售|供货)|采购(合同|协议)|(原材料|设备)采购")),
    ("customer", "sells_to", re.compile(r"向.{2,20}?(销售|供应|供货)|提供(了)?(产品|服务|设备|系统|解决方案|技术|部件|组件|结构件|材料|装备|软件|工程)|供货|销售(合同|订单)|购销|获得.{0,8}订单|客户")),
    ("joint_development", "mutual", re.compile(r"联合开发|共同开发|联合研制")),
    ("cooperation", "mutual", re.compile(r"(战略)?合作|框架协议|合作协议|战略合作")),
    ("project", "unresolved", re.compile(r"项目|工程")),
]

# 窗口级噪声守卫（3.6 同表：释义/简历/表格/勾选框样板）+ 合同文书样板段
# （权利义务/检验接收条款——是合同结构文本，不是关系陈述）。
GLOSSARY_RE = re.compile(r"指.{0,24}指")
BIO_RE = re.compile(r"董事|监事|学历|学位|入职")
TABLE_RE = re.compile(r"占年度销售总额比例|占年度采购总额比例|序号.*(第一名|客户[一A1]|供应商[一A1])")
BOILER_RE = re.compile(r"[□☑√✓]")
CONTRACT_BOILER_RE = re.compile(r"权利义务|检验与接收|违约责任|保密条款|不可抗力|争议解决")
# 经营范围/营业执照文本与披露政策元话语：是登记/元信息，不是关系陈述。
LICENSE_TEXT_RE = re.compile(r"分支机构经营|市场主体依法自主选择|披露标准")


def clean(text: str) -> str:
    return re.sub(r"\s+", "", text)


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
    return max(0, start), end


def window_rejected(window: str) -> str | None:
    if GLOSSARY_RE.search(window):
        return "glossary"
    if BIO_RE.search(window):
        return "bio"
    if TABLE_RE.search(window):
        return "table"
    if BOILER_RE.search(window):
        return "boiler"
    if LEGAL_BOILER_RE.search(window):
        return "legal"
    if CONTRACT_BOILER_RE.search(window):
        return "contract_boiler"
    if LICENSE_TEXT_RE.search(window):
        return "license_text"
    return None


def classify_strength(window: str) -> str:
    for name, pattern in STRENGTH_RULES:
        if pattern.search(window):
            return name
    return "unclear"


def classify_type(window: str) -> tuple[str, str]:
    for name, direction, pattern in TYPE_RULES:
        if pattern.search(window):
            return name, direction
    return "other", "unresolved"


def announcement_rows(code: str, name: str, workers_state: dict) -> list[dict]:
    out_dir = RAW_BASE / code / "announcements"
    rows: list[dict] = []
    if not out_dir.exists():
        return rows
    pdfs = sorted(out_dir.glob("announce-*.pdf"))
    candidates: list[dict] = []
    for pdf_path in pdfs:
        manifest_path = RAW_BASE / code / "manifest.json"
        artifact = None
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for entry in manifest.get("artifacts", []):
                if entry.get("file") == pdf_path.name:
                    artifact = entry
                    break
        if not artifact:
            continue
        announced_at = artifact.get("announcedAt")
        if not announced_at:
            continue  # 无披露时点的公告绝不进事实层（§9）
        doc = pymupdf.open(pdf_path)
        pages_flat = [clean(page.get_text()) for page in doc]
        doc.close()
        flat = "".join(pages_flat)
        page_starts = []
        acc = 0
        for idx, page_flat in enumerate(pages_flat):
            page_starts.append((acc, acc + len(page_flat), idx + 1))
            acc += len(page_flat)

        def page_of(center: int) -> int:
            for start, end, page in page_starts:
                if start <= center < end:
                    return page
            return len(pages_flat)

        for match in RELATION_PATTERN_RE.finditer(flat):
            start_pos, end_pos = snap_window(flat, max(0, match.start() - WINDOW_BEFORE), match.end() + WINDOW_AFTER)
            window = flat[start_pos:end_pos]
            if len(window) < MIN_WINDOW_CHARS:
                continue
            if window_rejected(window):
                continue
            candidates.append({
                "text": window, "page": page_of(match.start()),
                "announcedAt": announced_at, "title": artifact.get("title", ""),
                "url": artifact.get("url", ""), "sha": artifact.get("sha256"),
                "retrievedAt": artifact.get("retrievedAt", ""),
                # 排序键：披露日新者优先，同日按文档内位置
                "sort": (announced_at, pdf_path.name, match.start()),
            })
        # 同文档窗口包含去重
        kept: list[dict] = []
        for cand in sorted(candidates, key=lambda c: c["sort"]):
            if any(cand["text"] in k["text"] or k["text"] in cand["text"] for k in kept):
                continue
            kept.append(cand)
        candidates = kept
    # 跨文档：披露日新者优先，公司内最后包含去重 + 上限
    selected: list[dict] = []
    for cand in sorted(candidates, key=lambda c: c["sort"]):
        if any(cand["text"] in k["text"] or k["text"] in cand["text"] for k in selected):
            continue
        selected.append(cand)
        if len(selected) >= MAX_RELATION_WINDOWS:
            break
    for cand in selected:
        rtype, direction = classify_type(cand["text"])
        strength = classify_strength(cand["text"])
        rows.append({
            "schemaVersion": "1.0.0",
            "factId": None,
            "companyCode": code,
            "companyName": name,
            "factType": "relation",
            "terms": [],
            "rawText": cand["text"],
            "source": {
                # §8：direction 一等保留（sells_to/buys_from/mutual/unresolved）——
                # 编码进 sourceId 第三段，绝不丢弃也不猜测升级。
                "sourceId": f"cninfo:announcement#{rtype}:{strength}:{direction}",
                "sourceName": f"巨潮公告({cand['announcedAt']},{cand['title'][:36]})",
                "sourceType": "filing_announcement",
                "locator": f"{cand['url']}#page={cand['page']}",
                "date": cand["announcedAt"],
            },
            "retrievedAt": cand["retrievedAt"],
            "artifactSha256": cand["sha"],
        })
    return rows


# ---- Surface B：官网产品句证据 ----

# 产品能力词表：官网产品页文体的通用结构词（产品能做什么），不是行业词表。
PRODUCT_CONTEXT_RE = re.compile(
    r"产品|系统|平台|解决方案|模块|设备|软件|服务(器|能力)?|型号|系列"
)
PRODUCT_CAPABILITY_RE = re.compile(
    r"支持|提供|适用于|应用于|包括|涵盖|具备|实现|覆盖|采用|面向|用于"
)
# 页面噪声守卫：导航/法务/营销样板行整句不收；FAQ 问答体行（Q:/问：开头）
# 保留会破坏「陈述句证据」的形状，同样不收（§12：不截断问答上下文，
# 干脆整句不进产品证据层）。
PAGE_NOISE_RE = re.compile(
    r"版权|备案|Cookie|cookie|隐私|登录|注册|关注我们|二维码|招聘|联系电话|联系地址|ICP|©|[Cc]opyright|All [Rr]ights [Rr]eserved"
    r"|首页|扫一扫|微信|微博|客服热线|免责声明|法律声明|网站地图|技术支持"
)
FAQ_LINE_RE = re.compile(r"^[QA][:：]|^问[:：]|^答[:：]")
# 问句不是能力陈述；表单/客服引导语是页面机制文本。
QUESTION_SENT_RE = re.compile(r"[？?]\s*$")
FORM_BOILER_RE = re.compile(r"请(先)?填写|为您解答|立即咨询|在线客服|表单")


def page_sentences(html: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript", "header", "footer", "nav"]):
        tag.decompose()
    text = soup.get_text("\n", strip=True)
    sentences: list[str] = []
    for block in text.split("\n"):
        block = clean(block)
        if not block:
            continue
        for piece in SENTENCE_END_RE.split(block):
            piece = piece.strip("、，,；;：: ")
            if PRODUCT_CONTEXT_RE.search(piece) and PRODUCT_CAPABILITY_RE.search(piece):
                sentences.append(piece)
    return sentences


def product_rows(code: str, name: str) -> list[dict]:
    out_dir = RAW_BASE / code / "website"
    rows: list[dict] = []
    if not out_dir.exists():
        return rows
    manifest_path = RAW_BASE / code / "manifest.json"
    artifacts: dict[str, dict] = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for entry in manifest.get("artifacts", []):
            if str(entry.get("file", "")).startswith("website/"):
                artifacts[entry["file"]] = entry
    selected: list[dict] = []
    for path in sorted(out_dir.glob("*.html")):
        artifact = artifacts.get(f"website/{path.name}")
        if not artifact:
            continue
        html = decode_html_bytes(path.read_bytes())
        kept = 0
        for sentence in page_sentences(html):
            if kept >= MAX_PRODUCT_SENTENCES_PER_PAGE:
                break
            if len(sentence) < 10 or len(sentence) > 160:
                continue
            if PAGE_NOISE_RE.search(sentence) or FAQ_LINE_RE.search(sentence):
                continue
            if QUESTION_SENT_RE.search(sentence) or FORM_BOILER_RE.search(sentence):
                continue
            if any(sentence in k["text"] or k["text"] in sentence for k in selected):
                continue
            selected.append({
                "text": sentence, "artifact": artifact,
                "sort": (artifact.get("url", ""), path.name, sentence),
            })
            kept += 1
    for cand in sorted(selected, key=lambda c: c["sort"])[:MAX_PRODUCT_ROWS]:
        artifact = cand["artifact"]
        rows.append({
            "schemaVersion": "1.0.0",
            "factId": None,
            "companyCode": code,
            "companyName": name,
            "factType": "product",
            "terms": [],
            "rawText": cand["text"],
            "source": {
                "sourceId": "website:product_page",
                "sourceName": f"官网产品页({urllib.parse.urlsplit(artifact.get('url','')).netloc},{artifact.get('anchorText','')[:20]})",
                "sourceType": "official_product_page",
                "locator": artifact.get("url", ""),
            },
            "retrievedAt": artifact.get("retrievedAt", ""),
            "artifactSha256": artifact.get("sha256"),
        })
    return rows


import urllib.parse  # noqa: E402  (product_rows sourceName 用)


def decode_html_bytes(raw: bytes) -> str:
    for charset in ("utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(charset)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


_STATE: dict = {}


def _init_worker(companies: dict) -> None:
    _STATE["companies"] = companies


def extract_company(payload: tuple[str, str]) -> dict:
    code, name = payload
    rows = announcement_rows(code, name, _STATE) + product_rows(code, name)
    return {"code": code, "rows": rows, "announcements": sum(1 for r in rows if r["source"]["sourceType"] == "filing_announcement"),
            "products": sum(1 for r in rows if r["source"]["sourceType"] == "official_product_page")}


def main() -> None:
    started = time.time()
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    companies = json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))["companies"]
    by_code = {c["code"]: c for c in companies}

    existing_lines = FACTS_FILE.read_text(encoding="utf-8").splitlines()
    existing_rows = [json.loads(line) for line in existing_lines if line.strip()]
    seq_by_company: dict[str, int] = {}
    known_texts: dict[str, set[str]] = {}
    for row in existing_rows:
        code = row["companyCode"]
        seq = int(row["factId"].rsplit("_", 1)[1])
        seq_by_company[code] = max(seq_by_company.get(code, 0), seq)
        known_texts.setdefault(code, set()).add(clean(row["rawText"]))

    payloads = [(c["code"], c["name"]) for c in companies]
    totals = {"companiesScanned": 0, "announcementFacts": 0, "productFacts": 0,
              "companiesWithAnnouncementFacts": 0, "companiesWithProductFacts": 0, "dedupDropped": 0}
    by_type_strength: dict[str, int] = {}
    ordered_rows: list[dict] = []
    with Pool(args.workers, initializer=_init_worker, initargs=(by_code,)) as pool:
        done = 0
        for result in pool.imap(extract_company, payloads, chunksize=40):
            done += 1
            totals["companiesScanned"] += 1
            saw_ann = False
            saw_prod = False
            for row in result["rows"]:
                code = row["companyCode"]
                company_known = known_texts.setdefault(code, set())
                text = clean(row["rawText"])
                if text in company_known or any(text in k or k in text for k in company_known):
                    totals["dedupDropped"] += 1
                    continue
                company_known.add(text)
                seq_by_company[code] = seq_by_company.get(code, 0) + 1
                row["factId"] = f"sf_{code}_{seq_by_company[code]:06d}"
                ordered_rows.append(row)
                if row["source"]["sourceType"] == "filing_announcement":
                    totals["announcementFacts"] += 1
                    saw_ann = True
                    key = row["source"]["sourceId"].split("#", 1)[-1]
                    by_type_strength[key] = by_type_strength.get(key, 0) + 1
                else:
                    totals["productFacts"] += 1
                    saw_prod = True
            totals["companiesWithAnnouncementFacts"] += 1 if saw_ann else 0
            totals["companiesWithProductFacts"] += 1 if saw_prod else 0
            if done % 1000 == 0:
                print(f"  {done}/{len(payloads)} companies scanned", flush=True)

    # 排序合并写：既有行字节与相对序冻结；新行插 (companyCode, factId) 排序位。
    merged: list[tuple[tuple[str, str], str]] = []
    for line in existing_lines:
        if not line.strip():
            continue
        row = json.loads(line)
        merged.append(((row["companyCode"], row["factId"]), line))
    for row in ordered_rows:
        merged.append(((row["companyCode"], row["factId"]), json.dumps(row, ensure_ascii=False, separators=(",", ":"))))
    merged.sort(key=lambda pair: pair[0])
    with FACTS_FILE.open("w", encoding="utf-8", newline="\n") as handle:
        for _key, line in merged:
            handle.write(line + "\n")

    # manifest 读改写：保住 3.6 字段，新增 surfaces registry（§38/§39）。
    all_rows = existing_rows + ordered_rows
    by_fact_type: dict[str, int] = {}
    by_source_type: dict[str, int] = {}
    annual_channel: dict[str, int] = {}
    ann_strength: dict[str, int] = {}
    for row in all_rows:
        by_fact_type[row["factType"]] = by_fact_type.get(row["factType"], 0) + 1
        st = row["source"]["sourceType"]
        by_source_type[st] = by_source_type.get(st, 0) + 1
        if st == "filing_annual_report":
            channel = row["source"]["sourceId"].split("#", 1)[-1].split(":")[0]
            annual_channel[channel] = annual_channel.get(channel, 0) + 1
        if st == "filing_announcement":
            key = row["source"]["sourceId"].split("#", 1)[-1]
            ann_strength[key] = ann_strength.get(key, 0) + 1

    prev = json.loads(FACTS_MANIFEST.read_text(encoding="utf-8")) if FACTS_MANIFEST.exists() else {}
    surfaces = prev.get("surfaces") or {}
    surfaces["annual_report"] = {
        "authorityClass": "regulatory_filing",
        "temporal": "periodic",
        "extractorVersion": "evidence-coverage-extract-1",
        "factCount": by_source_type.get("filing_annual_report", 0),
    }
    surfaces["announcement"] = {
        "authorityClass": "regulatory_filing",
        "temporal": "point_in_time",
        "extractorVersion": EXTRACTOR_VERSION,
        "factCount": by_source_type.get("filing_announcement", 0),
        "window": "2025-10-01~2026-09-30",
    }
    surfaces["official_product"] = {
        "authorityClass": "official_corporate_website",
        "temporal": "current_snapshot",
        "extractorVersion": EXTRACTOR_VERSION,
        "factCount": by_source_type.get("official_product_page", 0),
    }
    manifest = {
        **prev,
        "schemaVersion": "1.2.0",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "factCount": len(all_rows),
        "companyCount": len({row["companyCode"] for row in all_rows}),
        "pilotFrozen": prev.get("pilotFrozen", 169),
        "byFactType": by_fact_type,
        "bySourceType": by_source_type,
        "annualReportChannel": annual_channel,
        "announcementChannel": {"byTypeStrength": ann_strength},
        "surfaces": surfaces,
        "contentDigest": {"algorithm": "sha256", "scope": "facts.jsonl",
                          "value": hashlib.sha256(FACTS_FILE.read_bytes()).hexdigest()},
    }
    FACTS_MANIFEST.write_bytes((json.dumps(manifest, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    samples = {
        "announcement": [
            {"code": r["companyCode"], "category": r["source"]["sourceId"].split("#")[-1],
             "date": r["source"].get("date"), "text": r["rawText"][:120]}
            for r in ordered_rows if r["source"]["sourceType"] == "filing_announcement"
        ][:12],
        "product": [
            {"code": r["companyCode"], "url": r["source"]["locator"][:80], "text": r["rawText"][:120]}
            for r in ordered_rows if r["source"]["sourceType"] == "official_product_page"
        ][:12],
    }
    report = {
        "totals": totals,
        "byTypeStrength": by_type_strength,
        "existingRows": len(existing_rows),
        "newRows": len(ordered_rows),
        "samples": samples,
        "elapsedSeconds": round(time.time() - started, 1),
    }
    (OUT_DIR / "surface_extraction_report.json").write_bytes(json.dumps(report, ensure_ascii=False, indent=1).encode("utf-8"))
    print(json.dumps({k: v for k, v in report.items() if k != "samples"}, ensure_ascii=False)[:900])
    print(f"appended {len(ordered_rows)} facts -> {FACTS_FILE}")


if __name__ == "__main__":
    main()
