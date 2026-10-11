"""role-grader-v2: typed span-aware query parsing + deterministic target grading.

GRADER FIX (Residual Remediation Phase 1, spec §三–§六). v1 (git debd742, file SHA16
e814fb31dda9b629) matched regex tables independently, so a short PROCESS lexeme
firing inside a longer MATERIAL noun corrupted the intent: 光刻胶 →
processes={lithography}, which gated material caps (photoresist evidence is
process=None) into grade 1 while process-tagged interferers took grade 2 — the
107 inverted 半导体光刻胶 training rows (triage Case A). Same class: 外延 ⊂ 外延片,
and 刻蚀液/清洗液 had no material surface at all (query mis-typed as equipment).

v2 design (no query-specific hardcode; every lexeme is (surface, type, payload)):

  raw query
    → CONTENT span scan (EQUIPMENT / PROCESS / MATERIAL / COMPONENT lexemes)
    → overlap resolution: longest span wins, then higher specificity — a lexeme
      fully inside a claimed span never fires (光刻 inside 光刻胶 is gone), while
      the same lexeme in a DIFFERENT span still fires (光刻胶 + 光刻设备 ⇒ both)
    → processQualifier: a PROCESS span directly followed by a MATERIAL span
      (ALD前驱体 / PVD靶材 / CMP抛光液 / 刻蚀液) becomes a qualifier of the material,
      NOT an equipment intent
    → ROLE / EXCLUSION / DOMAIN lexemes match globally (v1 parity: vendor suffixes
      never open a role by themselves; exclusions are query-level operators)
    → only unmatched text can trigger broader lexemes (guaranteed by span ownership)

Grading rubric is unchanged from v1 (3/2/1/0, §12 hard-negative band, role
adjacency) with ONE internal addition (spec §六: processIntent vs processQualifier
expressed at scoring time, no schema break): under a material-intent query the
equipment-side process spans do not gate material caps, and a processQualifier is
satisfied by process=None (unevidenced ≠ wrong) or by the qualifier process.

Ground rules (inherited from LAYA_V4 spec §12/§13/§30/§31):
  - Company facts come ONLY from the Stage 3 enrichment — never from teacher
    memory. A company the enrichment cannot evidence a role for is UNKNOWN, and
    this grader returns None for it (caller may not invent a grade).
  - Grades are query-relative: the same company must score differently under
    "ALD设备" vs "ALD前驱体".
  - AMBIGUOUS companies never get a grade from this module.

Usage: import from the miner / dataset builder / held-out labeler. Every produced
dataset/benchmark/queue row must record graderVersion = GRADER_VERSION.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENRICHMENT_FILE = ROOT / "data" / "enrichment" / "semiconductor" / "enrichment.json"
PROFILES_FILE = ROOT / "data" / "search_profiles_v3.json"

GRADER_VERSION = "role-grader-v2"

# Stage 3.1 audit residuals: equipment-label表达力边界 (reports/STAGE3_1_EQUIPMENT_LABEL_AUDIT.md,
# data/eval/stage3_1_equipment_audit_after.json). Never strong supervision (spec §31).
AMBIGUOUS_CODES = {
    # judgment=AMBIGUOUS(15):设备标签无主营佐证
    "002459", "300398", "300416", "300606", "300667", "301095", "600525",
    "688181", "688371", "688392", "688502", "688757", "920368", "920570", "920981",
    # judgment=MATERIAL_SUPPLIER(8):主营只支持材料,设备标签来自次级窗口
    "002943", "300655", "300708", "600703", "601908", "603800", "688556", "688720",
}

ROLES = ("equipment_supplier", "material_supplier", "component_supplier")

# ---------------------------------------------------------------------------
# Typed lexemes (deterministic; mirrors knowledge, does not create it)
# ---------------------------------------------------------------------------
# kind: EQUIPMENT (process + equipment intent, 机-suffix heads imply the role),
#       PROCESS (bare process word — roles stay unconstrained, v1 parity),
#       MATERIAL (typed material span; implies_role marks the v1 role-word subset),
#       COMPONENT, ROLE (global), EXCLUSION (global), DOMAIN (global).

MATERIAL_WET = "wet_chemicals"


@dataclass(frozen=True)
class Lexeme:
    pattern: str
    kind: str
    specificity: int
    processes: tuple[str, ...] = ()
    equipment_subtypes: tuple[str, ...] = ()
    implied_role: str | None = None
    material_subtypes: tuple[str, ...] = ()
    component_subtypes: tuple[str, ...] = ()
    implies_role: bool = False
    qualifier: str | None = None  # fixed processQualifier for self-qualifying materials
    payload: dict = field(default_factory=dict, compare=False)


def _lx(pattern: str, kind: str, spec: int, **kw) -> Lexeme:
    return Lexeme(pattern=pattern, kind=kind, specificity=spec, **kw)


# --- EQUIPMENT: 复合装备词面 = 工艺 + 装备头. 机-suffix machines imply the role
# (v1 ROLE_PATTERNS parity); bare X设备 compounds keep roles unconstrained (v1
# parity: process gating does the work, neighbour roles stay at 1/2 per rubric).
EQUIPMENT_LEXEMES: list[Lexeme] = [
    # machines: role-implying
    _lx(r"光刻机", "EQUIPMENT", 45, processes=("lithography",), equipment_subtypes=("lithography_equipment",), implied_role="equipment_supplier"),
    _lx(r"刻蚀机", "EQUIPMENT", 45, processes=("etching",), equipment_subtypes=("etcher",), implied_role="equipment_supplier"),
    _lx(r"清洗机", "EQUIPMENT", 45, processes=("cleaning",), equipment_subtypes=("cleaning_equipment",), implied_role="equipment_supplier"),
    _lx(r"抛光机", "EQUIPMENT", 45, implied_role="equipment_supplier"),
    _lx(r"镀膜机", "EQUIPMENT", 45, implied_role="equipment_supplier"),
    _lx(r"量测机|检测机", "EQUIPMENT", 45, processes=("metrology_inspection",), equipment_subtypes=("metrology_equipment",), implied_role="equipment_supplier"),
    _lx(r"沉积机器", "EQUIPMENT", 45, implied_role="equipment_supplier"),
    _lx(r"离子注入机", "EQUIPMENT", 45, processes=("ion_implantation",), equipment_subtypes=("ion_implanter",), implied_role="equipment_supplier"),
    # X设备 compounds: equipment intent without forcing the role (v1 parity)
    _lx(r"光刻设备|光刻装备", "EQUIPMENT", 40, processes=("lithography",), equipment_subtypes=("lithography_equipment",)),
    _lx(r"刻蚀设备|刻蚀装备", "EQUIPMENT", 40, processes=("etching",), equipment_subtypes=("etcher",)),
    _lx(r"清洗设备|清洗装备", "EQUIPMENT", 40, processes=("cleaning",), equipment_subtypes=("cleaning_equipment",)),
    _lx(r"外延设备|外延片设备|MOCVD设备|MBE设备", "EQUIPMENT", 40, processes=("epitaxy",), equipment_subtypes=("epitaxy_equipment", "MOCVD_equipment")),
    _lx(r"ALD设备|原子层沉积设备", "EQUIPMENT", 40, processes=("deposition",), equipment_subtypes=("ALD_equipment",)),
    _lx(r"PVD设备|溅射设备|磁控溅射设备|物理气相沉积设备|蒸发镀膜设备", "EQUIPMENT", 40, processes=("deposition",), equipment_subtypes=("PVD_equipment",)),
    _lx(r"CVD设备|化学气相沉积设备|薄膜沉积设备|沉积设备", "EQUIPMENT", 40, processes=("deposition",), equipment_subtypes=("CVD_equipment",)),
    _lx(r"PECVD设备", "EQUIPMENT", 42, processes=("deposition",), equipment_subtypes=("PECVD_equipment",)),
    _lx(r"LPCVD设备", "EQUIPMENT", 42, processes=("deposition",), equipment_subtypes=("LPCVD_equipment",)),
    _lx(r"CMP设备|抛光设备|化学机械抛光设备|机械抛光设备", "EQUIPMENT", 40, processes=("cmp",), equipment_subtypes=("CMP_equipment",)),
    _lx(r"涂胶显影设备|track设备", "EQUIPMENT", 40, processes=("photoresist_track",), equipment_subtypes=("track_equipment",)),
    _lx(r"量测设备|测量设备|检测设备", "EQUIPMENT", 40, processes=("metrology_inspection",), equipment_subtypes=("metrology_equipment",)),
    _lx(r"测试设备|测试机|测试系统", "EQUIPMENT", 40, processes=("testing",), equipment_subtypes=("test_equipment",)),
    _lx(r"探针台|prober", "EQUIPMENT", 40, processes=("wafer_probing",), equipment_subtypes=("prober",)),
    _lx(r"切割设备|划片机|划片设备|dicing设备", "EQUIPMENT", 40, processes=("dicing",), equipment_subtypes=("dicing_equipment",)),
    _lx(r"封装设备|封测设备", "EQUIPMENT", 40, processes=("packaging_assembly",), equipment_subtypes=("packaging_equipment",)),
    _lx(r"退火设备|氧化炉|扩散炉|管式炉|热处理设备", "EQUIPMENT", 40, processes=("thermal_processing",), equipment_subtypes=("furnace",)),
    _lx(r"单晶炉|长晶炉|晶体生长炉", "EQUIPMENT", 40, processes=("crystal_growth",), equipment_subtypes=("growth_furnace",)),
    _lx(r"减薄设备|减薄机|grinding设备", "EQUIPMENT", 40, processes=("thinning",), equipment_subtypes=("grinding_equipment",)),
]

# --- PROCESS: bare process words. Roles stay unconstrained (v1 parity: an
# etcher company under "光刻" is 同域不同工艺=2, a material neighbour is 1).
PROCESS_LEXEMES: list[Lexeme] = [
    _lx(r"ALD|原子层沉积|原子层", "PROCESS", 20, processes=("deposition",), equipment_subtypes=("ALD_equipment",)),
    _lx(r"PVD|物理气相沉积|溅射镀膜|磁控溅射|蒸发镀膜", "PROCESS", 20, processes=("deposition",), equipment_subtypes=("PVD_equipment",)),
    _lx(r"CVD|化学气相沉积|薄膜沉积", "PROCESS", 20, processes=("deposition",), equipment_subtypes=("CVD_equipment",)),
    _lx(r"PECVD", "PROCESS", 22, processes=("deposition",), equipment_subtypes=("PECVD_equipment",)),
    _lx(r"LPCVD", "PROCESS", 22, processes=("deposition",), equipment_subtypes=("LPCVD_equipment",)),
    _lx(r"外延|MOCVD|MBE", "PROCESS", 20, processes=("epitaxy",), equipment_subtypes=("epitaxy_equipment", "MOCVD_equipment")),
    _lx(r"刻蚀|蚀刻|etch", "PROCESS", 20, processes=("etching",), equipment_subtypes=("etcher",)),
    _lx(r"CCP|电容耦合", "PROCESS", 20, processes=("etching",), equipment_subtypes=("etcher",)),
    _lx(r"ICP|电感耦合", "PROCESS", 20, processes=("etching",), equipment_subtypes=("etcher",)),
    _lx(r"清洗", "PROCESS", 20, processes=("cleaning",), equipment_subtypes=("cleaning_equipment",)),
    _lx(r"CMP|化学机械抛光|机械抛光", "PROCESS", 20, processes=("cmp",), equipment_subtypes=("CMP_equipment",)),
    _lx(r"涂胶显影|光刻-track|track设备|Track", "PROCESS", 20, processes=("photoresist_track",), equipment_subtypes=("track_equipment",)),
    _lx(r"光刻", "PROCESS", 20, processes=("lithography",), equipment_subtypes=("lithography_equipment",)),
    _lx(r"量测", "PROCESS", 20, processes=("metrology_inspection",), equipment_subtypes=("metrology_equipment",)),
    _lx(r"test", "PROCESS", 20, processes=("testing",), equipment_subtypes=("test_equipment",)),
    _lx(r"离子注入", "PROCESS", 20, processes=("ion_implantation",), equipment_subtypes=("ion_implanter",)),
    _lx(r"切割|划片|dicing", "PROCESS", 20, processes=("dicing",), equipment_subtypes=("dicing_equipment",)),
    _lx(r"热处理|退火|氧化炉|扩散炉|管式炉", "PROCESS", 20, processes=("thermal_processing",), equipment_subtypes=("furnace",)),
    _lx(r"晶体生长|长晶", "PROCESS", 20, processes=("crystal_growth",), equipment_subtypes=("growth_furnace",)),
    _lx(r"减薄|grinding", "PROCESS", 20, processes=("thinning",), equipment_subtypes=("grinding_equipment",)),
]

# --- MATERIAL: typed material spans. implies_role marks the nouns that were
# v1 role-word surfaces (vendor-suffix queries like 电子特气厂商 read as material
# queries). qualifier marks self-qualifying 工艺限定材料 (刻蚀液 = etchant FOR etching).
MATERIAL_LEXEMES: list[Lexeme] = [
    _lx(r"前驱体", "MATERIAL", 30, material_subtypes=("precursor",), implies_role=True),
    _lx(r"靶材", "MATERIAL", 30, material_subtypes=("target_material",), implies_role=True),
    _lx(r"光刻胶", "MATERIAL", 30, material_subtypes=("photoresist",), implies_role=True),
    _lx(r"电子特种气体|电子级特气|电子级气体|电子特气|电子气体|特种气体|特气", "MATERIAL", 30, material_subtypes=("electronic_special_gas",), implies_role=True),
    _lx(r"湿电子化学品|湿化学品", "MATERIAL", 32, material_subtypes=(MATERIAL_WET,), implies_role=True),
    _lx(r"电子化学品", "MATERIAL", 30, material_subtypes=(MATERIAL_WET,), implies_role=True),
    _lx(r"试剂", "MATERIAL", 30, material_subtypes=(MATERIAL_WET,), implies_role=True),
    _lx(r"抛光液|研磨液", "MATERIAL", 32, material_subtypes=("CMP_slurry",), implies_role=True),
    _lx(r"抛光垫", "MATERIAL", 32, material_subtypes=("CMP_pad",), implies_role=True),
    _lx(r"刻蚀液|蚀刻液", "MATERIAL", 34, material_subtypes=(MATERIAL_WET,), implies_role=True, qualifier="etching"),
    _lx(r"清洗液", "MATERIAL", 34, material_subtypes=(MATERIAL_WET,), implies_role=True, qualifier="cleaning"),
    _lx(r"硅片|硅料", "MATERIAL", 30, material_subtypes=("silicon_wafer",)),
    _lx(r"外延片|外延晶片", "MATERIAL", 32, material_subtypes=("epi_wafer",)),
    _lx(r"碳化硅|SiC", "MATERIAL", 30, material_subtypes=("sic_substrate",)),
    _lx(r"掩膜版|光罩|photomask", "MATERIAL", 30, material_subtypes=("photomask",)),
    _lx(r"引线框架", "MATERIAL", 30, material_subtypes=("lead_frame",)),
    _lx(r"封装基板|载板", "MATERIAL", 30, material_subtypes=("package_substrate",)),
    _lx(r"键合线|焊线", "MATERIAL", 30, material_subtypes=("bonding_wire",)),
]

# --- COMPONENT: typed component spans (v1 role-word subset implies the role)
COMPONENT_LEXEMES: list[Lexeme] = [
    _lx(r"零部件", "COMPONENT", 34, component_subtypes=("precision_component",), implies_role=True),
    _lx(r"零组件", "COMPONENT", 34, component_subtypes=("precision_component",), implies_role=True),
    _lx(r"石英件", "COMPONENT", 36, component_subtypes=("quartz_component",), implies_role=True),
    _lx(r"陶瓷件", "COMPONENT", 36, component_subtypes=("ceramic_component",), implies_role=True),
    _lx(r"真空件", "COMPONENT", 36, component_subtypes=("vacuum_component",), implies_role=True),
    _lx(r"硅部件", "COMPONENT", 36, component_subtypes=("silicon_component",), implies_role=True),
    _lx(r"精密零件", "COMPONENT", 36, component_subtypes=("precision_component",), implies_role=True),
    _lx(r"组件(供应商|厂商|公司)", "COMPONENT", 36, component_subtypes=("precision_component",), implies_role=True),
    _lx(r"部件(供应商|厂商|厂|公司)", "COMPONENT", 36, component_subtypes=("precision_component",), implies_role=True),
    _lx(r"石英", "COMPONENT", 30, component_subtypes=("quartz_component",)),
    _lx(r"陶瓷", "COMPONENT", 30, component_subtypes=("ceramic_component",)),
    _lx(r"真空", "COMPONENT", 30, component_subtypes=("vacuum_component",)),
    _lx(r"硅零件", "COMPONENT", 34, component_subtypes=("silicon_component",)),
    _lx(r"精密", "COMPONENT", 30, component_subtypes=("precision_component",)),
    _lx(r"零件", "COMPONENT", 30, component_subtypes=("precision_component",)),
    _lx(r"组件", "COMPONENT", 30, component_subtypes=("precision_component",)),
    _lx(r"部件", "COMPONENT", 30, component_subtypes=("precision_component",)),
]

# --- ROLE: global matches, v1 parity (vendor suffixes never open a role alone)
ROLE_LEXEMES: list[Lexeme] = [
    _lx(r"零部件|零组件|组件(供应商|厂商|公司)|部件(供应商|厂商|厂|公司)|石英件|陶瓷件|真空件|硅部件|精密零件", "ROLE", 0, implied_role="component_supplier"),
    _lx(r"设备(的)?(厂商|制造商|供应商|公司|厂|企业|商)|装备(厂商|公司|企业)|机器(厂商|供应商|公司)|机(厂商|企业)|设备商|整机(厂商|厂|公司)|整机设备", "ROLE", 0, implied_role="equipment_supplier"),
    _lx(r"刻蚀机|沉积机器|镀膜机|清洗机|抛光机|光刻机|量测机|检测机|(做|生产|造|卖|研发|供应).{0,4}设备", "ROLE", 0, implied_role="equipment_supplier"),
    _lx(r"材料(的)?(供应商|厂商|公司|厂|企业|商)|材料商|(做|生产|产|卖|供应|只做|只产)材料", "ROLE", 0, implied_role="material_supplier"),
]

EXCLUSION_LEXEMES: list[Lexeme] = [
    _lx(r"不做设备|不产设备|不生产设备|非设备|不含设备|不要设备|无设备|设备(厂|公司|商)?(除外|以外)", "EXCLUSION", 0, implied_role="equipment_supplier"),
    _lx(r"不做材料|不产材料|不生产材料|非材料|不要材料|无材料|材料(厂|公司|商)?(除外|以外)", "EXCLUSION", 0, implied_role="material_supplier"),
    _lx(r"不做零部件|不产零部件|非零部件|不产整机|不做整机|不要零部件|零部件(厂|公司|商)?(除外|以外)|整机(厂|公司|商)?(除外|以外)", "EXCLUSION", 0, implied_role="component_supplier"),
]

DOMAIN_LEXEMES: list[Lexeme] = [
    _lx(r"半导体|晶圆|芯片|集成电路|微电子|wafer|IC", "DOMAIN", 0),
]

CONTENT_LEXEMES: list[Lexeme] = EQUIPMENT_LEXEMES + PROCESS_LEXEMES + MATERIAL_LEXEMES + COMPONENT_LEXEMES

_RE_CACHE: dict[str, re.Pattern] = {}


def _rx(pattern: str) -> re.Pattern:
    if pattern not in _RE_CACHE:
        _RE_CACHE[pattern] = re.compile(pattern)
    return _RE_CACHE[pattern]


@dataclass
class Span:
    start: int
    end: int
    lexeme: Lexeme


def resolve_spans(raw: str) -> list[Span]:
    """Longest/most-specific-first overlap resolution over CONTENT lexemes.

    A span fully inside an accepted span never fires (光刻 ⊂ 光刻胶); the same
    lexeme in a different position still gets its own span (光刻胶+光刻设备).
    Deterministic tie-break: length desc, specificity desc, position asc, table order.
    """
    candidates: list[tuple[int, int, int, int, Lexeme]] = []
    for order, lex in enumerate(CONTENT_LEXEMES):
        for m in _rx(lex.pattern).finditer(raw):
            candidates.append((-(m.end() - m.start()), -lex.specificity, m.start(), order, lex))
    candidates.sort(key=lambda t: (t[0], t[1], t[2], t[3]))
    spans: list[Span] = []
    for neg_len, neg_spec, start, _order, lex in candidates:
        end = start - neg_len
        if any(start < s.end and end > s.start for s in spans):
            continue
        spans.append(Span(start, end, lex))
    spans.sort(key=lambda s: s.start)
    return spans


class Intent:
    """Parsed query intent (role-grader-v2). `requested_roles` empty = role not expressed."""

    __slots__ = ("raw", "grader_version", "requested_roles", "excluded_roles", "processes",
                 "process_qualifiers", "equipment_subtypes", "material_subtypes",
                 "component_subtypes", "spans", "semi_domain")

    def __init__(self, raw: str) -> None:
        self.raw = raw
        self.grader_version = GRADER_VERSION
        spans = resolve_spans(raw)
        self.spans = spans

        processes: set[str] = set()
        equipment_subtypes: set[str] = set()
        material_subtypes: set[str] = set()
        component_subtypes: set[str] = set()
        qualifiers: set[str] = set()
        has_material = has_equipment = False

        # self-qualifying materials first: 刻蚀液/清洗液 carry their process context
        mat_spans = [s for s in spans if s.lexeme.kind == "MATERIAL"]
        for s in mat_spans:
            if s.lexeme.qualifier:
                qualifiers.add(s.lexeme.qualifier)

        for i, s in enumerate(spans):
            lx = s.lexeme
            if lx.kind == "MATERIAL":
                material_subtypes.update(lx.material_subtypes)
                has_material = True
            elif lx.kind == "COMPONENT":
                component_subtypes.update(lx.component_subtypes)
            elif lx.kind in ("PROCESS", "EQUIPMENT"):
                # processQualifier: PROCESS span directly attached to a MATERIAL span
                # (ALD前驱体/PVD靶材/CMP抛光液; 的 tolerated) — context for the material,
                # not an equipment intent
                nxt = spans[i + 1] if i + 1 < len(spans) else None
                gap_ok = nxt is not None and nxt.lexeme.kind == "MATERIAL" and (
                    nxt.start - s.end == 0 or (nxt.start - s.end == 1 and raw[s.end] == "的"))
                if lx.kind == "PROCESS" and gap_ok:
                    qualifiers.update(lx.processes)
                    continue
                processes.update(lx.processes)
                equipment_subtypes.update(lx.equipment_subtypes)
                if lx.kind == "EQUIPMENT":
                    has_equipment = True

        roles: set[str] = set()
        for lex in ROLE_LEXEMES:
            if _rx(lex.pattern).search(raw):
                roles.add(lex.implied_role)
        _role_of_kind = {"EQUIPMENT": "equipment_supplier", "MATERIAL": "material_supplier",
                         "COMPONENT": "component_supplier"}
        for s in spans:
            if s.lexeme.implies_role and s.lexeme.kind in _role_of_kind:
                roles.add(_role_of_kind[s.lexeme.kind])
            elif s.lexeme.implied_role and s.lexeme.kind == "EQUIPMENT":
                roles.add(s.lexeme.implied_role)
        # §四 compound intent: material spans + equipment spans ⇒ the query asks for
        # both roles ("既做光刻胶，也做光刻设备的公司")
        if has_material and has_equipment:
            roles.add("equipment_supplier")

        excluded: set[str] = set()
        for lex in EXCLUSION_LEXEMES:
            if _rx(lex.pattern).search(raw):
                excluded.add(lex.implied_role)
        self.requested_roles: set[str] = roles - excluded
        # compound-modifier precedence (v1 parity): "设备零部件/设备用石英件" asks for
        # the component side; equipment words inside the modifier must not compete
        if "component_supplier" in self.requested_roles and _rx(r"设备(的)?(零|部|组|石英|陶瓷|硅部|真空)").search(raw):
            self.requested_roles.discard("equipment_supplier")
        if "material_supplier" in self.requested_roles and _rx(r"设备(的)?(材料|耗材|用)").search(raw):
            self.requested_roles.discard("equipment_supplier")
        self.excluded_roles: set[str] = excluded
        self.processes: set[str] = processes
        self.process_qualifiers: set[str] = qualifiers
        self.equipment_subtypes: set[str] = equipment_subtypes
        self.material_subtypes: set[str] = material_subtypes
        self.component_subtypes: set[str] = component_subtypes
        # subtype-only queries ("超纯湿化学品制造商") imply the role of the subtype
        if not self.requested_roles:
            if self.material_subtypes:
                self.requested_roles = {"material_supplier"}
            elif self.component_subtypes:
                self.requested_roles = {"component_supplier"}
        semi = False
        for lex in DOMAIN_LEXEMES:
            if _rx(lex.pattern).search(raw):
                semi = True
        self.semi_domain = semi

    @property
    def gradeable(self) -> bool:
        """A query this module may hand out grades for: some role/process signal."""
        return bool(self.requested_roles or self.processes or self.material_subtypes or self.component_subtypes)

    def has_subtype_hint(self) -> bool:
        return bool(self.equipment_subtypes or self.material_subtypes or self.component_subtypes)

    def to_dict(self) -> dict:
        return {
            "graderVersion": GRADER_VERSION,
            "requestedRoles": sorted(self.requested_roles),
            "excludedRoles": sorted(self.excluded_roles),
            "processes": sorted(self.processes),
            "processQualifiers": sorted(self.process_qualifiers),
            "equipmentSubtypes": sorted(self.equipment_subtypes),
            "materialSubtypes": sorted(self.material_subtypes),
            "componentSubtypes": sorted(self.component_subtypes),
            "spans": [{"surface": self.raw[s.start:s.end], "kind": s.lexeme.kind,
                       "concepts": sorted(set(s.lexeme.processes) | set(s.lexeme.material_subtypes)
                                          | set(s.lexeme.component_subtypes) | set(s.lexeme.equipment_subtypes))}
                      for s in self.spans],
            "semiDomain": self.semi_domain,
        }


# role adjacency for role-intent-without-process queries (spec §一: 零部件>整机>泛半导体)
_ROLE_ADJACENCY: dict[str, dict[str, int]] = {
    "equipment_supplier": {"component_supplier": 2, "material_supplier": 1},
    "component_supplier": {"equipment_supplier": 2, "material_supplier": 1},
    "material_supplier": {"equipment_supplier": 1, "component_supplier": 1},
}


def _cap_fields(cap: dict) -> tuple[str | None, str, str | None, str | None]:
    """(process, role, kind, subtype) from an enrichment processCapability."""
    subtype = cap.get("equipmentType") or cap.get("materialType") or cap.get("componentType")
    kind = "equipment_supplier" if cap.get("equipmentType") else (
        "material_supplier" if cap.get("materialType") else (
            "component_supplier" if cap.get("componentType") else None))
    role = cap.get("role") or kind
    return cap.get("process"), role, kind, subtype


def grade_caps(intent: Intent, caps: list[dict]) -> tuple[int | None, str]:
    """Deterministic role-aware target grade for one company's capabilities.

    Returns (grade, reason); grade None = company facts do not support grading
    (no evidenced capability / AMBIGUOUS) — caller must not invent one.
    """
    if not intent.gradeable:
        # no role/process/material signal parsed (e.g. 高端白酒品牌公司): v1
        # unconstrained-all-matches here and graded every cap 3; v2 refuses —
        # the same guard the miner always applied, now inside the module
        return None, "query_not_role_expressive"
    if not caps:
        return None, "no_enriched_capability"
    best: int | None = None
    best_reason = "no_matching_capability"
    for cap in caps:
        process, role, _kind, subtype = _cap_fields(cap)
        if role not in ROLES:
            continue
        if role in intent.excluded_roles:
            # explicit role exclusion is a hard band: this cap can only justify 0
            g, reason = 0, f"excluded_role:{role}"
        else:
            role_ok = (not intent.requested_roles) or role in intent.requested_roles
            proc_ok = (not intent.processes) or (process in intent.processes)
            if role == "material_supplier" and "material_supplier" in intent.requested_roles:
                # material-INTENT queries (v2, spec §六): equipment-side process spans
                # ("光刻胶和刻蚀设备") must not gate material caps; a processQualifier
                # ("ALD前驱体"/"刻蚀液") is satisfied by the qualifier process or by
                # process=None — unevidenced is not wrong for materials. A material
                # span that is only an incidental modifier ("清洗半导体硅片的设备")
                # leaves requested_roles without material_supplier and does not open
                # this rescue.
                proc_ok = (not intent.process_qualifiers) or process is None or process in intent.process_qualifiers
            hint = (intent.equipment_subtypes if role == "equipment_supplier"
                    else intent.material_subtypes if role == "material_supplier"
                    else intent.component_subtypes)
            sub_ok = (not hint) or (subtype in hint if subtype else False)
            if role_ok and proc_ok and sub_ok:
                g = 3
            elif role_ok and proc_ok:
                g = 2  # right role+process family, different subtype (问ALD答CVD)
            elif role_ok:
                # right role: evidenced different process = 次匹配(2);
                # generic domain cap with no process evidence = 弱相关(1)
                g = 2 if process else 1
            elif proc_ok and intent.requested_roles and intent.processes:
                g = 1  # §12 hard-negative band: same process, wrong role
            elif intent.requested_roles and not intent.processes:
                g = _ROLE_ADJACENCY.get(next(iter(intent.requested_roles)), {}).get(role, 1)
            else:
                g = 0  # process-named query, no role asked, cap has no process: weak
        if best is None or g > best:
            best, best_reason = g, f"{role}:{process or 'generic'}:{subtype or '-'}"
    return best, best_reason

# grade 0 is a legitimate output (excluded role / nothing matches); None means
# "cannot grade from facts" — the call site must not invent a number.


def load_enrichment() -> dict[str, dict]:
    data = json.loads(ENRICHMENT_FILE.read_text(encoding="utf-8"))
    return {r["code"]: r for r in data["records"]}


def company_caps(record: dict | None) -> list[dict]:
    return (record or {}).get("processCapabilities") or []


def record_profile_summary(record: dict | None) -> dict:
    """§8 queue `profile` block: role facts straight from the frozen enrichment."""
    record = record or {}
    caps = []
    for c in record.get("processCapabilities") or []:
        process, role, _kind, subtype = _cap_fields(c)
        caps.append({"process": process, "role": role, "subtype": subtype})
    return {
        "roles": record.get("roles") or [],
        "processCapabilities": caps,
        "processExposure": sorted({c["process"] for c in caps if c["process"]}),
        "equipmentTypes": [t["type"] for t in record.get("equipmentTypes") or []],
        "materialTypes": [t["type"] for t in record.get("materialTypes") or []],
        "componentTypes": [t["type"] for t in record.get("componentTypes") or []],
    }


def parse_intent(query: str) -> Intent:
    return Intent(query)
