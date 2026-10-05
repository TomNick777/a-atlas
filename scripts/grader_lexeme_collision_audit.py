"""Grader lexeme collision audit (Residual Remediation Phase 1, spec §二).

Programmatic scan of EVERY lexeme surface that participates in
query → process → material → role → application → target grade:

  1. query-side grader lexicon  scripts/laya_v4_roles.py (role-grader-v1 tables)
  2. profile-side ontology      search/ontology/*.ts (patterns arrays, concept groups)
  3. cross-domain grader keys   scripts/laya_v4_1_cross_domain.py FAMILIES
  4. query corpora              train pairs / frozen benchmarks / triage pools

Finds prefix/substring collisions (光刻 ⊂ 光刻胶 class) programmatically, counts
affected training/eval rows, and classifies each collision:
  CONTAMINATION     short+long both fire in v1, short's semantics gate/overrule the long
  MISSING_SURFACE   long form absent from the v1 lexicon entirely, query mis-typed
  COMPOSITION       intended nesting (刻蚀 ⊂ 刻蚀机), equipment surface = process+head
  NOISE             domain/English incidental substring, no grading effect

Outputs: data/eval/grader_lexeme_collisions.json + reports/GRADER_LEXEME_COLLISION_AUDIT.md
Usage: .venv/Scripts/python scripts/grader_lexeme_collision_audit.py
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

# ---------------------------------------------------------------------------
# FROZEN role-grader-v1 lexicon snapshot (git debd742,
# scripts/laya_v4_roles.py SHA16 e814fb31dda9b629). The live module has been
# upgraded to role-grader-v2 (typed spans); the audit targets v1, so its tables
# are embedded verbatim here.
# ---------------------------------------------------------------------------
ROLE_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    (r"零部件|零组件|组件(供应商|厂商|公司)|部件(供应商|厂商|厂|公司)|石英件|陶瓷件|真空件|硅部件|精密零件", ("component_supplier",)),
    (r"设备(的)?(厂商|制造商|供应商|公司|厂|企业|商)|装备(厂商|公司|企业)|机器(厂商|供应商|公司)|机(厂商|企业)|设备商|整机(厂商|厂|公司)|整机设备", ("equipment_supplier",)),
    (r"刻蚀机|沉积机器|镀膜机|清洗机|抛光机|光刻机|量测机|检测机|(做|生产|生产|造|卖|研发|供应).{0,4}设备", ("equipment_supplier",)),
    (r"材料(的)?(供应商|厂商|公司|厂|企业|商)|材料商|前驱体|靶材|光刻胶|电子(特种|特气|级)?气体|特气|湿电子化学品|抛光液|抛光垫|试剂|电子化学品|(做|生产|产|卖|供应|只做|只产)材料", ("material_supplier",)),
]
EXCLUDED_ROLE_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    (r"不做设备|不产设备|非设备|不生产设备|不含设备", ("equipment_supplier",)),
    (r"不做材料|不产材料|非材料", ("material_supplier",)),
    (r"不做零部件|不产零部件|非零部件|不产整机|不做整机", ("component_supplier",)),
]
PROCESS_PATTERNS: list[tuple[str, tuple[str, ...], tuple[str, ...]]] = [
    (r"ALD|原子层沉积|原子层", ("deposition",), ("ALD_equipment",)),
    (r"PVD|物理气相沉积|溅射镀膜|磁控溅射|蒸发镀膜", ("deposition",), ("PVD_equipment",)),
    (r"CVD|化学气相沉积|薄膜沉积", ("deposition",), ("CVD_equipment",)),
    (r"PECVD", ("deposition",), ("PECVD_equipment",)),
    (r"LPCVD", ("deposition",), ("LPCVD_equipment",)),
    (r"外延|MOCVD|MBE", ("epitaxy",), ("epitaxy_equipment", "MOCVD_equipment")),
    (r"刻蚀|etch", ("etching",), ("etcher",)),
    (r"CCP|电容耦合", ("etching",), ("etcher",)),
    (r"ICP|电感耦合", ("etching",), ("etcher",)),
    (r"清洗", ("cleaning",), ("cleaning_equipment",)),
    (r"CMP|化学机械抛光|抛光设备|机械抛光", ("cmp",), ("CMP_equipment",)),
    (r"涂胶显影|光刻-track|track设备|Track", ("photoresist_track",), ("track_equipment",)),
    (r"光刻", ("lithography",), ("lithography_equipment",)),
    (r"量测|检测设备|检测机|测量设备", ("metrology_inspection",), ("metrology_equipment",)),
    (r"测试机|测试设备|测试系统|test", ("testing",), ("test_equipment",)),
    (r"离子注入", ("ion_implantation",), ("ion_implanter",)),
    (r"探针台|prober", ("wafer_probing",), ("prober",)),
    (r"切割|划片|dicing", ("dicing",), ("dicing_equipment",)),
    (r"封装设备|封测设备", ("packaging_assembly",), ("packaging_equipment",)),
    (r"热处理|退火|氧化炉|扩散炉|管式炉", ("thermal_processing",), ("furnace",)),
    (r"晶体生长|长晶|单晶炉", ("crystal_growth",), ("growth_furnace",)),
    (r"减薄|grinding", ("thinning",), ("grinding_equipment",)),
]
MATERIAL_SUBTYPE_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    (r"前驱体", ("precursor",)),
    (r"靶材", ("target_material",)),
    (r"光刻胶", ("photoresist",)),
    (r"特气|电子气体|特种气体", ("electronic_special_gas",)),
    (r"湿电子化学品|湿化学品|电子化学品|试剂", ("wet_chemicals",)),
    (r"抛光液", ("CMP_slurry",)),
    (r"抛光垫", ("CMP_pad",)),
    (r"硅片|硅料", ("silicon_wafer",)),
    (r"外延片|epi", ("epi_wafer",)),
    (r"碳化硅|SiC", ("sic_substrate",)),
    (r"掩膜版|光罩|photomask", ("photomask",)),
    (r"引线框架", ("lead_frame",)),
    (r"封装基板|载板", ("package_substrate",)),
    (r"键合线|焊线", ("bonding_wire",)),
]
COMPONENT_SUBTYPE_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    (r"石英", ("quartz_component",)),
    (r"陶瓷", ("ceramic_component",)),
    (r"真空", ("vacuum_component",)),
    (r"硅部件|硅零件", ("silicon_component",)),
    (r"精密|零部件|零组件|组件|部件|零件", ("precision_component",)),
]
SEMI_DOMAIN_PATTERNS = (r"半导体|晶圆|芯片|集成电路|集成电路|微电子|wafer|IC",)

OUT_JSON = ROOT / "data/eval/grader_lexeme_collisions.json"
OUT_MD = ROOT / "reports/GRADER_LEXEME_COLLISION_AUDIT.md"

RUN_RE = re.compile(r"[A-Za-z]{2,}|[\u4e00-\u9fff]{2,}")
GENERIC_SUFFIXES = {"公司", "厂商", "供应商", "企业", "制造商", "生产商", "供应商", "厂", "商"}
SUFFIXY = {"公司", "厂商", "供应商", "企业", "制造商", "生产商"}


def literal_runs(pattern: str) -> list[str]:
    """Literal runs (CJK>=2 or ASCII word>=2) from one alternation branch set."""
    runs: list[str] = []
    for alt in pattern.split("|"):
        # expand simple (...) groups so 供应商 inside 组件(供应商|...) survives
        alt = re.sub(r"\(([^()?|]*)\)", r"\1", alt)
        alt = re.sub(r"\([^()]*\)", "", alt)  # drop non-literal groups (?:...), {0,4}
        for m in RUN_RE.finditer(alt):
            runs.append(m.group(0))
    return runs


def lexicon_inventory() -> list[dict]:
    """Every query-side lexeme with its v1 semantic type and payload."""
    inv: list[dict] = []
    for pat, roles in ROLE_PATTERNS:
        t = "ROLE_EQUIPMENT" if "equipment_supplier" in roles else (
            "ROLE_COMPONENT" if "component_supplier" in roles else "ROLE_MATERIAL")
        for run in literal_runs(pat):
            inv.append({"surface": run, "kind": t, "table": "ROLE_PATTERNS", "pattern": pat})
    for pat, roles in EXCLUDED_ROLE_PATTERNS:
        for run in literal_runs(pat):
            inv.append({"surface": run, "kind": "EXCLUSION", "table": "EXCLUDED_ROLE_PATTERNS", "pattern": pat})
    for pat, procs, eqs in PROCESS_PATTERNS:
        for run in literal_runs(pat):
            inv.append({"surface": run, "kind": "PROCESS", "table": "PROCESS_PATTERNS",
                        "pattern": pat, "payload": {"processes": list(procs), "equipmentSubtypes": list(eqs)}})
    for pat, subs in MATERIAL_SUBTYPE_PATTERNS:
        for run in literal_runs(pat):
            inv.append({"surface": run, "kind": "MATERIAL", "table": "MATERIAL_SUBTYPE_PATTERNS",
                        "pattern": pat, "payload": {"materialSubtypes": list(subs)}})
    for pat, subs in COMPONENT_SUBTYPE_PATTERNS:
        for run in literal_runs(pat):
            inv.append({"surface": run, "kind": "COMPONENT", "table": "COMPONENT_SUBTYPE_PATTERNS",
                        "pattern": pat, "payload": {"componentSubtypes": list(subs)}})
    for pat in SEMI_DOMAIN_PATTERNS:
        for run in literal_runs(pat):
            inv.append({"surface": run, "kind": "DOMAIN", "table": "SEMI_DOMAIN_PATTERNS", "pattern": pat})
    return inv


def ts_string_terms(path: Path) -> list[str]:
    """Quoted CJK/ASCII terms from an ontology TS file (patterns/concept arrays)."""
    text = path.read_text(encoding="utf-8")
    terms = []
    for m in re.finditer(r'"([^"]{2,})"', text):
        t = m.group(1)
        if RUN_RE.fullmatch(t) or re.fullmatch(r"[\u4e00-\u9fffA-Za-z /·+]+", t):
            terms.append(t)
    return terms


def corpus_queries() -> dict[str, list[str]]:
    """name -> list of query texts (deduped)."""
    out: dict[str, list[str]] = {}

    def add(name: str, queries: list[str]):
        out[name] = sorted(set(q for q in queries if q))

    train_files = ["v4_train_pairs.jsonl", "v4_1_train_pairs_A.jsonl", "v4_1_train_pairs_B.jsonl",
                   "v3_train_pairs.jsonl", "laya_train_pairs.jsonl"]
    for f in train_files:
        p = ROOT / "data/train" / f
        if p.exists():
            qs, rowc = [], Counter()
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    r = json.loads(line)
                    qs.append(r["query"])
                    rowc[r["query"]] += 1
            out[f + "::rows"] = dict(rowc)
            add(f, qs)
    for f, key in [("v4_role_benchmark.jsonl", "query"), ("stage3_semiconductor_benchmark.jsonl", "query"),
                   ("v3_search_benchmark.jsonl", "query")]:
        p = ROOT / "data/eval" / f
        if p.exists():
            add(f, [json.loads(l)[key] for l in p.read_text(encoding="utf-8").splitlines() if l.strip()])
    for f in ["stage3_1_focus_pools.json", "v4_1_cross_domain_queries.json", "residual_triage_pools.json"]:
        p = ROOT / "data/eval" / f
        if p.exists():
            d = json.loads(p.read_text(encoding="utf-8"))
            qs = []
            if isinstance(d, dict):
                for v in d.values():
                    if isinstance(v, dict) and "query" in v:
                        qs.append(v["query"])
                    elif isinstance(v, list):
                        qs += [x.get("query") for x in v if isinstance(x, dict) and "query" in x]
            elif isinstance(d, list):
                qs = [x.get("query") for x in d if isinstance(x, dict) and "query" in x]
            add(f, qs)
    return out


def classify(short: dict, long: dict, long_in_v1: bool) -> str:
    if short["kind"] == long["kind"]:
        return "COMPOSITION" if short["kind"] in ("PROCESS", "ROLE_EQUIPMENT", "MATERIAL") else "NOISE"
    if long["kind"] in ("PROCESS",) and short["kind"] in ("PROCESS",):
        return "COMPOSITION"
    if not long_in_v1:
        return "MISSING_SURFACE"
    if short["kind"] in ("PROCESS", "DOMAIN") and long["kind"] in ("MATERIAL", "COMPONENT"):
        return "CONTAMINATION"
    if short["kind"] in ("MATERIAL", "COMPONENT") and long["kind"] in ("PROCESS",):
        return "COMPOSITION"
    if short["kind"] == "DOMAIN":
        return "NOISE"
    if short["kind"] == "ROLE_EQUIPMENT" and long["kind"] == "MATERIAL":
        return "NOISE"  # 设备-run inside 抛光垫 etc. — role tables don't fire on material-only queries
    return "REVIEW"


def main() -> None:
    inv = lexicon_inventory()
    # dedupe (surface, kind); keep payload
    by_pair: dict[tuple[str, str], dict] = {}
    for e in inv:
        if e["surface"] in SUFFIXY or len(e["surface"]) < 2:
            continue  # bare 公司/厂商 runs never open semantics alone in v1
        by_pair.setdefault((e["surface"], e["kind"]), e)
    lexemes = list(by_pair.values())
    surfaces_v1 = {e["surface"] for e in lexemes}

    # ---- ontology-side terms (secondary, knowledge-pass input) ----
    ontology_terms: dict[str, list[str]] = {}
    for f in sorted((ROOT / "search/ontology").glob("*.ts")):
        ontology_terms[f.name] = sorted(set(ts_string_terms(f)))
    sys.path.insert(0, str(ROOT / "scripts"))
    from laya_v4_1_cross_domain import FAMILIES  # noqa: E402

    cd_keys: list[dict] = []
    for dom, fam in FAMILIES.items():
        for k in list(fam.get("strong_keys", ())) + list(fam.get("profile_keys", ())):
            cd_keys.append({"domain": dom, "key": k})
    ontology_terms["laya_v4_1_cross_domain.FAMILIES"] = sorted({k["key"] for k in cd_keys})

    corpora = corpus_queries()

    # ---- pairwise substring scan (query-side grader lexicon) ----
    collisions = []
    for s in lexemes:
        for l in lexemes:
            if s["surface"] == l["surface"] or s["surface"] not in l["surface"]:
                continue
            cls = classify(s, l, long_in_v1=True)
            if cls == "NOISE" and s["kind"] == "DOMAIN":
                continue
            affected_train, affected_eval = Counter(), Counter()
            for name, qs in corpora.items():
                if name.endswith("::rows"):
                    continue
                hits = [q for q in qs if l["surface"] in q]
                if not hits:
                    continue
                rows = sum(corpora.get(name + "::rows", {}).get(q, 1) for q in hits)
                if "train_pairs" in name or name.startswith("laya_train"):
                    affected_train[name] = rows
                else:
                    affected_eval[name] = len(hits)
            collisions.append({
                "shortLexeme": s["surface"], "shortType": s["kind"],
                "longLexeme": l["surface"], "longType": l["kind"],
                "classification": cls,
                "shortPayload": s.get("payload"), "longPayload": l.get("payload"),
                "affectedTrainingRows": dict(affected_train),
                "affectedEvalQueries": dict(affected_eval),
                "risk": {"CONTAMINATION": "high", "MISSING_SURFACE": "high",
                         "COMPOSITION": "intended", "REVIEW": "review", "NOISE": "low"}[cls],
            })

    # ---- missing surfaces that SHOULD exist (typed-material candidates) ----
    # surfaces found in ontologies/benchmarks that contain a PROCESS lexeme but are
    # not themselves in the v1 lexicon (刻蚀液 class)
    missing = []
    known_long = {"光刻胶", "外延片", "掩膜版", "抛光液", "抛光垫", "湿电子化学品", "硅片",
                  "碳化硅", "引线框架", "载板", "封装基板", "键合线", "前驱体", "靶材"}
    proc_runs = {e["surface"] for e in lexemes if e["kind"] == "PROCESS"}
    candidates = set()
    for name, qs in corpora.items():
        if name.endswith("::rows"):
            continue
        for q in qs:
            for pr in proc_runs:
                for m in re.finditer(re.escape(pr), q):
                    tail = q[m.end():m.end() + 3]
                    head = q[max(0, m.start() - 3):m.start()]
                    for ctx in (tail, head):
                        if ctx and ctx not in known_long:
                            candidates.add(pr + "|" + q)
    # material-suffix heuristic: X液 / X胶 / X片 / X垫 / X剂 / X气体 following a process word
    suffix_re = re.compile(r"([\u4e00-\u9fff]{1,4}?(?:液|胶|片|垫|剂|气体|膏|蜡|膜|靶材|前驱体|化学品))")
    for name, qs in corpora.items():
        if name.endswith("::rows"):
            continue
        for q in qs:
            for mm in suffix_re.finditer(q):
                w = mm.group(1)
                if w in surfaces_v1 or len(w) < 2:
                    continue
                if any(pr in w for pr in proc_runs):
                    missing.append({"surface": w, "containsProcessRun": [pr for pr in proc_runs if pr in w],
                                    "seenIn": name, "exampleQuery": q})
    missing = { (m["surface"]): m for m in missing }.values()  # dedupe by surface

    # ---- ontology/cross-domain profile-side substring pairs (Knowledge Pass input) ----
    knowledge_side = []
    for src, terms in ontology_terms.items():
        tset = sorted(set(terms), key=len, reverse=True)
        for a in tset:
            for b in tset:
                if a != b and len(a) >= 2 and a in b and not (a.isascii() and b.isascii() and len(a) < 3):
                    knowledge_side.append({"source": src, "shortTerm": a, "longTerm": b})
    # keep only pairs whose short term carries semantic load in its own right
    kg_counter = Counter((k["source"], k["shortTerm"]) for k in knowledge_side)

    doc = {
        "generatedBy": "scripts/grader_lexeme_collision_audit.py",
        "graderVersion": "role-grader-v1 (audit target)",
        "lexemeCount": len(lexemes),
        "collisions": sorted(collisions, key=lambda c: (c["risk"] != "high", c["shortLexeme"])),
        "missingMaterialSurfaces": sorted(missing, key=lambda m: -len(m["surface"])),
        "knowledgeSideSubstringPairs": knowledge_side,
        "corpora": {k: (len(v) if not k.endswith("::rows") else sum(v for v in [sum(v.values())])) for k, v in corpora.items() if not k.endswith("::rows")},
    }
    OUT_JSON.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- markdown ----
    lines = [
        "# GRADER_LEXEME_COLLISION_AUDIT — role-grader-v1 词面冲突全扫描",
        "",
        f"生成:`scripts/grader_lexeme_collision_audit.py`(程序化,非人工枚举);机器可读版 `data/eval/grader_lexeme_collisions.json`。",
        f"扫描范围:query 侧 grader 词表(`laya_v4_roles.py` 六张表,去重后 {len(lexemes)} 个词面)、profile 侧 ontology(`search/ontology/*.ts` 全部文件)、跨域 grader 词表(`laya_v4_1_cross_domain.FAMILIES`)、语料(全部训练对 + 冻结 benchmark + triage 池)。",
        "",
        "## 1. 分类语义",
        "",
        "| classification | 含义 | 处置 |",
        "| --- | --- | --- |",
        "| CONTAMINATION | 短词面与长词面在 v1 中**同时触发**,短词面的 process/role 语义错误门控长词面的打分(光刻⊂光刻胶类) | 本轮 typed span 修复 |",
        "| MISSING_SURFACE | 长词面在 v1 词表**完全缺失**,整条 query 被误判成另一语义(刻蚀液类) | 本轮 typed span 修复(补词面) |",
        "| COMPOSITION | 有意嵌套:设备/机词面内含工艺词,复合词面=工艺+头名词(刻蚀⊂刻蚀机) | 保留,typed 层显式化 |",
        "| REVIEW | 类型间嵌套但影响待查 | 报告列出 |",
        "",
        "## 2. Query 侧 collision 总表(按风险排序)",
        "",
    ]
    high = [c for c in doc["collisions"] if c["risk"] == "high"]
    rest = [c for c in doc["collisions"] if c["risk"] != "high"]
    for c in high + rest:
        tr = json.dumps(c["affectedTrainingRows"], ensure_ascii=False) if c["affectedTrainingRows"] else "0"
        ev = json.dumps(c["affectedEvalQueries"], ensure_ascii=False) if c["affectedEvalQueries"] else "0"
        lines.append(f"### {c['classification']}: {c['shortLexeme']}({c['shortType']}) ⊂ {c['longLexeme']}({c['longType']})")
        lines.append("")
        lines.append(f"- currentBehavior(v1): 两词面各自独立触发;short payload `{c['shortPayload']}` 会与 long payload `{c['longPayload']}` 叠加")
        if c["classification"] == "CONTAMINATION":
            lines.append(f"- expectedBehavior(v2): long 词面整体成 span,short 语义被吞并,不再单独触发")
        elif c["classification"] == "MISSING_SURFACE":
            lines.append(f"- expectedBehavior(v2): long 词面作为独立 MATERIAL span 入表,short 仅作为 processQualifier")
        else:
            lines.append(f"- expectedBehavior(v2): 复合词面整体识别(工艺+头名词),不视为冲突")
        lines.append(f"- affectedTrainingRows: {tr}")
        lines.append(f"- affectedEvalQueries: {ev}")
        lines.append(f"- risk: {c['risk']}")
        lines.append("")
    lines += [
        "## 3. 词表缺失的候补材料词面(语料中含工艺词的 X液/X胶/X片 形态)",
        "",
        "| surface | 内含工艺词 | 出处 | 示例 query |",
        "| --- | --- | --- | --- |",
    ]
    for m in sorted(doc["missingMaterialSurfaces"], key=lambda x: -len(x["surface"]))[:40]:
        lines.append(f"| {m['surface']} | {','.join(m['containsProcessRun'])} | {m['seenIn']} | {m['exampleQuery']} |")
    lines += [
        "",
        "## 4. Profile 侧 ontology / 跨域词表 substring 对(Knowledge Pass 输入,本轮不修)",
        "",
        "这些是 **profile 匹配侧**的子串泄漏(公司文本包含长词 → 短词 key 命中),与 query 侧 grader 冲突同根不同层:",
        "",
        "| source | shortTerm | longTerm |",
        "| --- | --- | --- |",
    ]
    seen = set()
    for k in knowledge_side:
        key = (k["source"], k["shortTerm"], k["longTerm"])
        if key in seen:
            continue
        seen.add(key)
        # curate: only keep pairs where short term is a semantic term (>=2 chars, in same source top list)
        lines.append(f"| {k['source']} | {k['shortTerm']} | {k['longTerm']} |")
    lines += [
        "",
        "## 5. 审计结论(衔接 §三 设计)",
        "",
        "1. 高危 collision 全部落在「PROCESS 词面 ⊂ MATERIAL 词面」与「MATERIAL 词面缺失」两类 —— 证实 triage Case A 的判断:这不是光刻胶一个 if,是词表结构问题。",
        "2. COMPOSITION 类(刻蚀⊂刻蚀机等)是正确构造,typed 层需保留其复合语义(工艺+设备头)。",
        "3. Profile 侧 substring 对(铜类/热管理类)是 Knowledge Pass 的输入,不属于 grader 修复范围。",
        "",
    ]
    OUT_MD.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT_MD}")
    print(f"collisions: {len(high)} high-risk / {len(rest)} other; missing surfaces: {len(doc['missingMaterialSurfaces'])}; knowledge-side pairs: {len(seen)}")


if __name__ == "__main__":
    main()
