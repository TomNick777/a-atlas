"""V4.1 cross-domain shared module (LAYA_V4_1 spec §4/§14/§17/§21).

Deterministic cross-domain grader + frozen query sets. Same discipline as
laya_v4_roles: company facts come ONLY from frozen data (companies.json industry
fields + search_profiles_v3 searchText), never from teacher memory. The teacher
authors query SURFACES and domain keyword tables only.

Grades (query-relative, §17):
  3 = domain core       industry evidence AND profile keyword both match
  1 = weak association  profile keyword matches, industry does not (沾边: 客户/
      参股/概念 mention, or cross-listing into the domain) — WEAK_ASSOCIATION_ONLY
  0 = no evidence       DOMAIN_MISMATCH

A grade-3 requires the industry gate so semiconductor companies can never reach 3
on a cross-domain query even when their profile name-drops the domain; a grade-1
is deliberately reachable so near-domain weak relevance (§17) stays learnable and
is never conflated with 0.

Frozen sets (§21):
  TRAIN_XDOM_FAMILIES  12 domains feeding V4.1 correction data
  VAL_B_QUERIES        6 (3 train-covered-domain fresh surfaces + 3 zero-touch) —
                       checkpoint selection split
  TEST_B_QUERIES       14 — ANCHOR_CROSS_DOMAIN_SET, frozen TEST, evaluated once
  SET_C_QUERIES        8 across 6 domains with NO V3-inherited and NO V4.1-new
                       training rows (verified by audit + isolation check)
  ANCHOR_CODES         12 semiconductor anchors (equipment/material/component,
                       all non-AMBIGUOUS) — the distractors SET B measures

Usage: imported by the prior-audit, miner, dataset builder, pool builder, eval.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _ambiguous_codes() -> set:
    """Lazy import of the frozen AMBIGUOUS list (laya_v4_roles has no dependency
    on this module, so the import is safe; kept lazy to avoid import cycles in
    scripts that import both)."""
    import sys

    if str(ROOT / "scripts") not in sys.path:
        sys.path.insert(0, str(ROOT / "scripts"))
    from laya_v4_roles import AMBIGUOUS_CODES

    return AMBIGUOUS_CODES

# ---------------------------------------------------------------------------
# Domain keyword tables (query-domain evidence, deterministic)
# industry_keys match swLevel1Industry OR industry (substring); profile_keys
# match the frozen searchText (substring).
# ---------------------------------------------------------------------------
FAMILIES: dict[str, dict] = {
    # --- train-covered correction domains (§14 P1/P2) ---
    "copper_processing": {
        "name": "铜加工",
        "industry_keys": ("铜", "有色金属"),
        # kp1:铜冶炼/阴极铜/电解铜 是冶炼侧词,不是加工材 —— 从 copper_processing 撤下
        # (云南铜业/北方铜业类冶炼商不再被记为加工;箔商仍由 铜箔 子串强匹配,
        # 「电解铜箔⊂电解铜」泄漏随电解铜一词一并消除,KNOWLEDGE_PASS_INPUTS leak#4)
        "strong_keys": ("铜箔", "铜板", "铜管", "铜棒", "铜线", "铜杆", "铜带", "铜排", "铜材", "铜加工", "铜合金", "铜产品"),
        "profile_keys": (),
    },
    "industrial_automation": {
        "name": "工业自动化",
        "industry_keys": ("自动化设备", "仪器仪表", "通用设备", "机械设备"),
        "strong_keys": ("工业自动化", "伺服", "变频器", "运动控制", "可编程逻辑控制器"),
        "profile_keys": ("PLC", "控制系统", "步进电机"),
    },
    "robot_reducer": {
        "name": "机器人减速器",
        "industry_keys": ("机械设备", "通用设备", "自动化设备"),
        "strong_keys": ("减速器", "减速机", "谐波", "RV减速", "摆线针轮"),
        "profile_keys": ("丝杠", "关节模组", "执行器", "齿轮箱"),
    },
    "nev_material": {
        "name": "新能源汽车材料",
        "industry_keys": ("电力设备", "基础化工", "有色金属", "电气机械"),
        "strong_keys": ("正极材料", "负极材料", "电解液", "锂电材料", "电池材料", "三元材料", "磷酸铁锂", "六氟磷酸锂"),
        "profile_keys": ("隔膜",),
    },
    "auto_oem": {
        "name": "整车",
        "industry_keys": ("汽车",),
        "strong_keys": ("乘用车", "商用车", "整车制造", "汽车集团", "汽车整车"),
        "profile_keys": ("汽车制造",),
    },
    "energy_storage": {
        "name": "储能",
        "industry_keys": ("电力设备", "电气机械", "公用事业"),
        "strong_keys": ("储能电池", "储能系统", "储能变流", "抽水蓄能", "电化学储能"),
        "profile_keys": ("储能", "蓄能"),
    },
    "wind_component": {
        "name": "风电",
        "industry_keys": ("电力设备", "通用设备", "机械设备", "专用设备"),
        "strong_keys": ("风电", "风力发电"),
        "profile_keys": ("塔筒", "叶片", "齿轮箱", "主轴", "机舱罩"),
    },
    "consumer_electronics": {
        "name": "消费电子",
        "industry_keys": ("电子", "计算机、通信"),
        "strong_keys": ("消费电子",),
        "profile_keys": ("智能手机", "手机", "TWS", "可穿戴", "平板", "智能硬件"),
    },
    "apple_chain": {
        "name": "苹果产业链",
        "industry_keys": ("电子", "计算机、通信"),
        "strong_keys": ("苹果", "果链", "iPhone", "AirPods", "iPad"),
        "profile_keys": (),
        "exclude_keys": ("果汁", "苹果醋"),
    },
    "baijiu": {
        "name": "白酒",
        "industry_keys": ("酒、饮料和精制茶", "食品饮料", "白酒"),
        "strong_keys": ("白酒", "茅台酒", "酱香", "浓香", "基酒", "系列酒"),
        "profile_keys": ("酒类",),
    },
    "banking": {
        "name": "银行",
        "industry_keys": ("银行", "货币金融服务"),
        "strong_keys": ("商业银行", "银行业务", "存贷款", "信贷业务"),
        "profile_keys": ("银行",),
        "exclude_keys": ("银行间", "村镇银行"),
    },
    "dc_liquid_cooling": {
        "name": "数据中心液冷",
        "industry_keys": ("计算机设备", "通用设备", "专用设备", "机械设备"),
        "strong_keys": ("液冷",),
        "profile_keys": ("温控", "机房散热", "服务器散热", "数据中心", "机房温控"),
    },
    # --- zero-touch eval-only domains (SET C, §21) ---
    "agriculture": {
        "name": "农业",
        "industry_keys": ("农林牧渔", "畜牧业", "种植业", "渔业", "农业"),
        "strong_keys": ("种业", "种子", "生猪", "畜禽养殖", "水产养殖"),
        "profile_keys": ("养殖", "种植", "饲料", "农药", "化肥", "动物保健"),
    },
    "grid_equipment": {
        "name": "电网设备",
        "industry_keys": ("电网设备", "电力设备", "电气机械"),
        "strong_keys": ("变压器", "特高压", "输变电", "开关柜", "组合电器", "继电保护"),
        "profile_keys": ("电网", "配电"),
    },
    "gold_resource": {
        "name": "黄金资源",
        "industry_keys": ("有色金属", "黄金"),
        "strong_keys": ("黄金", "金矿", "矿产金", "金锭", "金精矿"),
        "profile_keys": ("贵金属",),
    },
    "airline": {
        "name": "航空运输",
        "industry_keys": ("航空", "交通运输"),
        "strong_keys": ("航空客运", "航空运输", "航空公司", "航空物流"),
        "profile_keys": ("客运航线", "机场"),
    },
    "coal": {
        "name": "煤炭",
        "industry_keys": ("煤炭",),
        "strong_keys": ("煤炭", "煤矿", "动力煤", "焦煤", "焦炭"),
        "profile_keys": (),
    },
    "securities": {
        "name": "证券",
        "industry_keys": ("非银金融", "资本市场服务", "证券"),
        "strong_keys": ("证券", "券商", "保荐", "经纪业务", "投行"),
        "profile_keys": (),
    },
    # --- eval-only domains for TEST-B anchor probes (§四 list) ---
    "copper_resource": {
        "name": "铜资源",
        "industry_keys": ("有色金属",),
        "strong_keys": ("铜矿", "铜资源", "铜金属"),
        "profile_keys": ("铜冶炼", "阴极铜"),
    },
    "robot_integral": {
        "name": "机器人整机",
        "industry_keys": ("机械设备", "自动化设备", "通用设备"),
        "strong_keys": ("工业机器人", "人形机器人", "机器人本体"),
        "profile_keys": ("机器人",),
    },
    "pv": {
        "name": "光伏",
        "industry_keys": ("电力设备", "电气机械"),
        "strong_keys": ("光伏", "太阳能", "电池片"),
        "profile_keys": ("硅片", "硅料", "组件"),
    },
    "shipping": {
        "name": "航运",
        "industry_keys": ("交通运输", "航运"),
        "strong_keys": ("航运", "集装箱", "海运", "船舶运输"),
        "profile_keys": ("货运航线", "港口"),
    },
    "pharma": {
        "name": "医药",
        "industry_keys": ("医药生物", "医药制造", "医药"),
        "strong_keys": ("创新药", "化学制药", "原料药", "生物制药"),
        "profile_keys": ("医药", "临床试验", "药物研发"),
    },
}

# domains whose typical surfaces carry V3-inherited training rows (audit §C):
# these may appear in VAL-B/TEST-B only as FRESH surfaces (text-isolated), and
# are never claimed zero-touch.
TRAIN_COVERED_DOMAINS = (
    "copper_processing", "industrial_automation", "robot_reducer", "nev_material",
    "auto_oem", "energy_storage", "wind_component", "consumer_electronics",
    "apple_chain", "baijiu", "banking", "dc_liquid_cooling",
)
ZERO_TOUCH_DOMAINS = ("agriculture", "grid_equipment", "gold_resource", "airline", "coal", "securities")

# ---------------------------------------------------------------------------
# TRAIN cross-domain query surfaces (correction-data source, §9/§14).
# 2 surfaces per train-covered family; grades via grade_cross_domain.
# ---------------------------------------------------------------------------
TRAIN_XDOM_QUERIES: list[dict] = [
    {"family": "V41-XD-COPPER-PROC", "domain": "copper_processing", "queries": ["做铜箔铜材加工的企业", "铜板铜管加工制造公司"]},
    {"family": "V41-XD-INDAUTO", "domain": "industrial_automation", "queries": ["工业自动化控制系统企业", "做伺服变频器的公司"]},
    {"family": "V41-XD-ROBOT-RED", "domain": "robot_reducer", "queries": ["机器人用减速器的公司", "谐波减速器制造商"]},
    {"family": "V41-XD-NEVMAT", "domain": "nev_material", "queries": ["锂电池正极负极材料企业", "做动力电池电解液材料的公司"]},
    {"family": "V41-XD-AUTOOEM", "domain": "auto_oem", "queries": ["生产乘用车的整车企业", "商用车制造集团"]},
    {"family": "V41-XD-ESS", "domain": "energy_storage", "queries": ["储能系统集成企业", "电网侧储能电池企业"]},
    {"family": "V41-XD-WIND", "domain": "wind_component", "queries": ["风电叶片塔筒零部件企业", "做风电齿轮箱部件的公司"]},
    {"family": "V41-XD-CONSEL", "domain": "consumer_electronics", "queries": ["消费电子整机制造企业", "做智能手机代工的公司"]},
    {"family": "V41-XD-APPLE", "domain": "apple_chain", "queries": ["苹果供应链上的制造企业", "给iPhone做零部件的上市公司"]},
    {"family": "V41-XD-BAIJIU", "domain": "baijiu", "queries": ["白酒酿造上市企业", "高端白酒品牌公司"]},
    {"family": "V41-XD-BANK", "domain": "banking", "queries": ["全国性商业银行", "上市城市商业银行"]},
    {"family": "V41-XD-DCLIQ", "domain": "dc_liquid_cooling", "queries": ["数据中心液冷温控企业", "机房散热冷却方案公司"]},
]

# ---------------------------------------------------------------------------
# VAL-B (checkpoint selection, §19): 6 anchor-cross-domain queries.
# domainInTrain=True → fresh surface of a train-covered domain (paraphrase-level
# generalization); False → zero-touch domain (full generalization).
# ---------------------------------------------------------------------------
VAL_B_QUERIES: list[dict] = [
    {"family": "V41-VB-BAIJIU", "domain": "baijiu", "domainInTrain": True, "query": "主营高端白酒的公司"},
    {"family": "V41-VB-BANK", "domain": "banking", "domainInTrain": True, "query": "股份制商业银行"},
    {"family": "V41-VB-COPPER-PROC", "domain": "copper_processing", "domainInTrain": True, "query": "铜加工材制造企业"},
    {"family": "V41-VB-AGRI", "domain": "agriculture", "domainInTrain": False, "query": "做种业育种的上市公司"},
    {"family": "V41-VB-GRID", "domain": "grid_equipment", "domainInTrain": False, "query": "特高压输变电设备制造商"},
    {"family": "V41-VB-COAL", "domain": "coal", "domainInTrain": False, "query": "煤炭开采企业"},
]

# ---------------------------------------------------------------------------
# TEST-B — ANCHOR_CROSS_DOMAIN_SET (frozen, §4/§21): anchors must score 0.
# ---------------------------------------------------------------------------
TEST_B_QUERIES: list[dict] = [
    # natural phrasings from the spec (§四), train-covered domains
    {"family": "V41-TB-ROBOT-RED", "domain": "robot_reducer", "domainInTrain": True, "query": "给机器人做减速器的"},
    {"family": "V41-TB-NEVMAT", "domain": "nev_material", "domainInTrain": True, "query": "做汽车电池材料但不是整车的"},
    {"family": "V41-TB-DCLIQ", "domain": "dc_liquid_cooling", "domainInTrain": True, "query": "给数据中心降温的"},
    {"family": "V41-TB-APPLE", "domain": "apple_chain", "domainInTrain": True, "query": "苹果产业链代工厂"},
    {"family": "V41-TB-CONSEL", "domain": "consumer_electronics", "domainInTrain": True, "query": "TWS耳机代工企业"},
    {"family": "V41-TB-AUTOOEM", "domain": "auto_oem", "domainInTrain": True, "query": "新能源整车厂商"},
    {"family": "V41-TB-BAIJIU", "domain": "baijiu", "domainInTrain": True, "query": "浓香型白酒上市公司"},
    {"family": "V41-TB-BANK", "domain": "banking", "domainInTrain": True, "query": "区域性银行"},
    # zero-touch domains
    {"family": "V41-TB-COPPER-RES", "domain": "copper_resource", "domainInTrain": False, "query": "铜矿资源储量丰富的企业"},
    {"family": "V41-TB-ROBOT-INT", "domain": "robot_integral", "domainInTrain": False, "query": "人形机器人本体制造商"},
    {"family": "V41-TB-PV", "domain": "pv", "domainInTrain": False, "query": "光伏组件制造商"},
    {"family": "V41-TB-SHIP", "domain": "shipping", "domainInTrain": False, "query": "集装箱航运公司"},
    {"family": "V41-TB-PHARMA", "domain": "pharma", "domainInTrain": False, "query": "创新药研发企业"},
    {"family": "V41-TB-GRID2", "domain": "grid_equipment", "domainInTrain": False, "query": "大型电力变压器制造企业"},
]

# ---------------------------------------------------------------------------
# SET C — cross-domain generalization (§21): 6 zero-touch domains, 8 queries.
# Labels include POSITIVES (domain core companies) — measures that V4.1 does
# not suppress everything on unseen domains.
# ---------------------------------------------------------------------------
SET_C_QUERIES: list[dict] = [
    {"family": "V41-SC-AGRI-SEED", "domain": "agriculture", "query": "种业公司"},
    {"family": "V41-SC-AGRI-HOG", "domain": "agriculture", "query": "生猪养殖企业"},
    {"family": "V41-SC-GRID-TD", "domain": "grid_equipment", "query": "输变电一次设备企业"},
    {"family": "V41-SC-GRID-SW", "domain": "grid_equipment", "query": "配电网开关柜制造商"},
    {"family": "V41-SC-GOLD", "domain": "gold_resource", "query": "黄金矿产资源公司"},
    {"family": "V41-SC-AIR", "domain": "airline", "query": "航空客运公司"},
    {"family": "V41-SC-COAL", "domain": "coal", "query": "动力煤生产企业"},
    {"family": "V41-SC-SEC", "domain": "securities", "query": "证券公司"},
]

# ---------------------------------------------------------------------------
# Anchors (§4): 12 semiconductor distractors for SET B/VAL-B/SET C pools.
# All non-AMBIGUOUS (laya_v4_roles list); roles span equipment / material /
# component / mixed so the audit cannot blame one role.
# ---------------------------------------------------------------------------
ANCHOR_CODES: dict[str, str] = {
    "688012": "中微公司",      # equipment(+material), etch/deposition platform
    "002371": "北方华创",      # equipment platform (mixed-role)
    "688072": "拓荆科技",      # equipment, deposition
    "688082": "盛美上海",      # equipment, cleaning/plating
    "688120": "华海清科",      # equipment(+material+component), CMP
    "688037": "芯源微",        # equipment, coating/developing
    "300666": "江丰电子",      # material(+component), sputtering targets
    "002409": "雅克科技",      # material, precursors
    "300054": "鼎龙股份",      # material, CMP pad/slurry
    "688019": "安集科技",      # material, CMP slurry
    "301611": "珂玛科技",      # component, ceramic/quartz parts
    "605358": "立昂微",        # material, silicon wafer
}

_REASON3 = "domain_core"
_REASON1 = "weak_association_only"
_REASON0 = "domain_mismatch"

_RE_CACHE: dict[str, re.Pattern] = {}


def _rx(p: str) -> re.Pattern:
    if p not in _RE_CACHE:
        _RE_CACHE[p] = re.compile(p)
    return _RE_CACHE[p]


def grade_cross_domain(domain: str, industry_fields: str, profile_text: str) -> tuple[int, str]:
    """Deterministic cross-domain grade. industry_fields = sw1 + ' ' + industry.

    strong_keys  — word surface alone proves domain-core (减速器/黄金/液冷…)
    profile_keys — prove domain-core only WITH the industry gate; without it they
                   are concept adjacency (客户/参股/概念 mention) → grade 1
    """
    fam = FAMILIES[domain]
    text = profile_text or ""
    if any(_rx(re.escape(k)).search(text) for k in fam.get("exclude_keys", ())):
        return 0, _REASON0
    strong_hit = any(_rx(re.escape(k)).search(text) for k in fam.get("strong_keys", ()))
    profile_hit = strong_hit or any(_rx(re.escape(k)).search(text) for k in fam["profile_keys"])
    industry_hit = any(_rx(re.escape(k)).search(industry_fields or "") for k in fam["industry_keys"])
    if strong_hit or (profile_hit and industry_hit):
        return 3, _REASON3
    if profile_hit:
        return 1, _REASON1
    return 0, _REASON0


def company_evidence(code: str, companies: dict, profiles: dict) -> tuple[str, str]:
    """(industry_fields, profile_text) for one company from the frozen files."""
    c = companies.get(code) or {}
    profile = (profiles.get(code) or {}).get("searchText") or c.get("judgeText") or ""
    industry_fields = f"{c.get('swLevel1Industry', '')} {c.get('industry', '')}"
    return industry_fields, profile


def all_heldout_queries() -> list[dict]:
    """VAL-B + TEST-B + SET C rows (the frozen evaluation texts)."""
    out = []
    for split, rows in (("val-b", VAL_B_QUERIES), ("test-b", TEST_B_QUERIES)):
        for q in rows:
            out.append({"split": split, **q})
    for q in SET_C_QUERIES:
        out.append({"split": "set-c", **q})
    return out


def labels_for_pool(pool_query: dict, companies: dict, profiles: dict, enrichment: dict) -> dict[str, dict]:
    """Deterministic labels for one frozen V4.1 pool query (VAL-B/TEST-B/SET C).

    Returns {code: {"label": int, "reason": str, "weakAssoc": bool}}. Every pool
    candidate is graded from frozen facts (industry + searchText); AMBIGUOUS
    companies keep their enrichment-derived grade (domain evidence is
    unambiguous for cross-domain queries) but are flagged so role-inversion
    stats can keep excluding them.
    """
    domain = pool_query["domain"]
    out = {}
    for cand in pool_query["candidates"]:
        code = cand["code"]
        c = companies.get(code)
        if c is None:
            continue
        ind_fields, prof = company_evidence(code, companies, profiles)
        grade, reason = grade_cross_domain(domain, ind_fields, prof)
        out[code] = {"label": grade, "reason": reason, "weakAssoc": grade == 1,
                     "ambiguous": code in _ambiguous_codes(),
                     "anchor": code in ANCHOR_CODES,
                     "injected": bool(cand.get("injected"))}
    return out


def isolation_check_v41(train_texts: set[str]) -> list[str]:
    """V4.1 extension: new train texts must be disjoint from every frozen V4.1
    held-out text AND from the V4 role VAL/TEST texts. Same substring rule as
    laya_v4_query_sets.isolation_check (shorter >=4 chars contained = violation).
    Returns violations (empty = pass)."""
    from laya_v4_query_sets import VAL_ROLE_QUERIES, TEST_ROLE_QUERIES
    heldout = [q["query"] for q in all_heldout_queries()]
    heldout += [q["query"] for q in VAL_ROLE_QUERIES] + [q["query"] for q in TEST_ROLE_QUERIES]
    violations = []
    for ht in heldout:
        for tt in train_texts:
            if ht == tt:
                violations.append(f"exact overlap: train '{tt}' ↔ held-out '{ht}'")
                continue
            short, long = (tt, ht) if len(tt) <= len(ht) else (ht, tt)
            if len(short) >= 4 and short in long:
                violations.append(f"containment: '{short}' inside '{ht}' ↔ train '{tt}'")
    return violations


if __name__ == "__main__":
    # dump the frozen query tables for the pool builder (scripts/build_v41_pools.ts)
    import json

    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    missing = [c for c in ANCHOR_CODES if c not in companies]
    assert not missing, f"anchor codes missing from companies.json: {missing}"
    doc = {
        "anchors": [{"code": c, "name": n} for c, n in ANCHOR_CODES.items()],
        "queries": all_heldout_queries(),
        "trainXdom": [{"family": t["family"], "domain": t["domain"], "query": q}
                      for t in TRAIN_XDOM_QUERIES for q in t["queries"]],
    }
    out = ROOT / "data/eval/v4_1_cross_domain_queries.json"
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"anchors={len(ANCHOR_CODES)} val-b={len(VAL_B_QUERIES)} test-b={len(TEST_B_QUERIES)} "
          f"set-c={len(SET_C_QUERIES)} train-xdom={len(doc['trainXdom'])} -> {out}")
