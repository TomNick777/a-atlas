"""role-grader-v2 contract tests (Residual Remediation Phase 1, spec §九).

Locks the typed span semantics that v1 got wrong (光刻 ⊂ 光刻胶 class) plus the
first-batch semantics table (spec §五/§六). Every assertion is on the parse
(process / material / roles / qualifiers) or on the target grade computed from
the frozen Stage 3.2 enrichment — never on a query-specific hardcode.

Run: .venv/Scripts/python.exe -m unittest tests.test_laya_v4_roles_v2 -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_roles import (  # noqa: E402
    GRADER_VERSION,
    Intent,
    company_caps,
    grade_caps,
    load_enrichment,
    parse_intent,
)


def parse(query: str) -> Intent:
    return parse_intent(query)


def grade(query: str, caps: list[dict]) -> int | None:
    g, _ = grade_caps(parse(query), caps)
    return g


def cap(role: str, process: str | None = None, subtype: str | None = None) -> dict:
    c: dict = {"role": role}
    if role == "material_supplier":
        c["materialType"] = subtype
    elif role == "equipment_supplier":
        c["equipmentType"] = subtype
    else:
        c["componentType"] = subtype
    if process:
        c["process"] = process
    return c


PR_MAT = [cap("material_supplier", None, "photoresist")]              # 真 photoresist,无 process 证据
TARGET_DEP = [cap("material_supplier", "deposition", "target_material")]  # 带 process 的同族干扰
SLURRY_NONE = [cap("material_supplier", None, "CMP_slurry")]
WET_NONE = [cap("material_supplier", None, "wet_chemicals")]
PRE_NONE = [cap("material_supplier", None, "precursor")]
PRE_DEP = [cap("material_supplier", "deposition", "precursor")]
EPI_NONE = [cap("material_supplier", None, "epi_wafer")]
PHOTOMASK_LITHO = [cap("material_supplier", "lithography", "photomask")]
LITHO_EQ = [cap("equipment_supplier", "lithography", "lithography_equipment")]
ETCH_EQ = [cap("equipment_supplier", "etching", "etcher")]
ALD_EQ = [cap("equipment_supplier", "deposition", "ALD_equipment")]
CMP_EQ = [cap("equipment_supplier", "cmp", "CMP_equipment")]


class VersionTests(unittest.TestCase):
    def test_grader_version_is_v2(self):
        self.assertEqual(GRADER_VERSION, "role-grader-v2")
        intent = parse("光刻胶")
        self.assertEqual(intent.to_dict()["graderVersion"], "role-grader-v2")

    def test_unparseable_query_refuses_to_grade(self):
        """v1 graded every cap 3 on out-of-domain queries (白酒); v2 refuses (None)."""
        g, reason = grade_caps(parse("高端白酒品牌公司"), [cap("material_supplier", None, "photoresist")])
        self.assertIsNone(g)
        self.assertEqual(reason, "query_not_role_expressive")


class PhotoresistSpanTests(unittest.TestCase):
    """§五 第一批:光刻胶 = MATERIAL photoresist,内部「光刻」不再触发 lithography."""

    def test_photoresist_material_no_lithography(self):
        for q in ("光刻胶", "半导体光刻胶", "国产光刻胶", "做光刻胶材料的上市公司"):
            i = parse(q)
            self.assertEqual(i.material_subtypes, {"photoresist"}, q)
            self.assertNotIn("lithography", i.processes, q)
            self.assertNotIn("lithography_equipment", i.equipment_subtypes, q)
            self.assertEqual(i.requested_roles, {"material_supplier"}, q)

    def test_true_photoresist_beats_process_tagged_interferers(self):
        self.assertEqual(grade("光刻胶", PR_MAT), 3)
        self.assertEqual(grade("半导体光刻胶", PR_MAT), 3)
        # 同族其他材料 = 次匹配(2),方向不能再倒挂
        self.assertEqual(grade("光刻胶", TARGET_DEP), 2)
        self.assertEqual(grade("半导体光刻胶", TARGET_DEP), 2)
        self.assertEqual(grade("光刻胶", PHOTOMASK_LITHO), 2)

    def test_equipment_neighbour_still_band_1(self):
        # 光刻胶 query 下光刻/刻蚀设备商 = 上下游邻带 1(v1 由 §12 硬负带给出同值)
        self.assertEqual(grade("光刻胶", LITHO_EQ), 1)
        self.assertEqual(grade("光刻胶", ETCH_EQ), 1)

    def test_separate_lithography_span_still_fires(self):
        """§四:光刻胶 + 光刻设备 ⇒ MATERIAL 与 PROCESS 并存,两个半区都判 3."""
        i = parse("光刻胶和光刻设备")
        self.assertEqual(i.material_subtypes, {"photoresist"})
        self.assertIn("lithography", i.processes)
        self.assertEqual(i.requested_roles, {"material_supplier", "equipment_supplier"})
        self.assertEqual(grade("光刻胶和光刻设备", PR_MAT), 3)
        self.assertEqual(grade("光刻胶和光刻设备", LITHO_EQ), 3)
        self.assertEqual(grade("光刻胶和光刻设备", ETCH_EQ), 2)  # 同角色不同工艺

    def test_lithography_equipment_queries_unchanged(self):
        i = parse("光刻机")
        self.assertIn("lithography", i.processes)
        self.assertEqual(i.requested_roles, {"equipment_supplier"})
        self.assertEqual(grade("光刻机", LITHO_EQ), 3)
        self.assertEqual(grade("光刻机", PR_MAT), 0)  # v1 同值(角色不符且无工艺匹配)
        i = parse("光刻设备")
        self.assertIn("lithography", i.processes)
        self.assertEqual(i.requested_roles, set())  # v1 parity:角色不设限
        self.assertEqual(grade("光刻设备", LITHO_EQ), 3)
        self.assertEqual(grade("光刻设备", ETCH_EQ), 2)


class EtchantCleaningTests(unittest.TestCase):
    """§五:刻蚀液/清洗液 = MATERIAL wet_chemicals + processQualifier,不是装备 query."""

    def test_etchant_is_material_with_qualifier(self):
        for q in ("刻蚀液", "蚀刻液"):
            i = parse(q)
            self.assertEqual(i.material_subtypes, {"wet_chemicals"}, q)
            self.assertEqual(i.process_qualifiers, {"etching"}, q)
            self.assertNotIn("etcher", i.equipment_subtypes, q)
            self.assertEqual(i.requested_roles, {"material_supplier"}, q)

    def test_etchant_direction_fixed(self):
        self.assertEqual(grade("刻蚀液", WET_NONE), 3)   # 湿法化学品(无 process 证据)是正确答案
        self.assertEqual(grade("刻蚀液", ETCH_EQ), 1)    # 刻蚀设备商 = 同工艺错角色硬负带
        self.assertEqual(grade("刻蚀液", PR_MAT), 2)     # 同族其他材料

    def test_cleaning_chemical(self):
        i = parse("清洗液")
        self.assertEqual(i.material_subtypes, {"wet_chemicals"})
        self.assertEqual(i.process_qualifiers, {"cleaning"})
        self.assertEqual(grade("清洗液", WET_NONE), 3)
        self.assertEqual(grade("清洗液", [cap("equipment_supplier", "cleaning", "cleaning_equipment")]), 1)

    def test_wet_chemicals_unchanged(self):
        i = parse("湿电子化学品")
        self.assertEqual(i.material_subtypes, {"wet_chemicals"})
        self.assertEqual(i.processes, set())
        self.assertEqual(grade("湿电子化学品", WET_NONE), 3)

    def test_etching_equipment_queries_unchanged(self):
        self.assertEqual(parse("刻蚀机").requested_roles, {"equipment_supplier"})
        self.assertEqual(parse("刻蚀设备").requested_roles, set())
        self.assertEqual(grade("刻蚀设备", ETCH_EQ), 3)
        self.assertEqual(grade("刻蚀液和刻蚀设备", WET_NONE), 3)   # 材料半区
        self.assertEqual(grade("刻蚀液和刻蚀设备", ETCH_EQ), 3)    # 装备半区(§四 并存)


class EpitaxialWaferTests(unittest.TestCase):
    """§五:外延片 = PRODUCT/MATERIAL epi_wafer,不再触发 epitaxy 装备语义."""

    def test_epi_wafer_no_epitaxy_process(self):
        i = parse("外延片")
        self.assertEqual(i.material_subtypes, {"epi_wafer"})
        self.assertNotIn("epitaxy", i.processes)
        self.assertEqual(i.requested_roles, {"material_supplier"})
        self.assertEqual(grade("外延片", EPI_NONE), 3)
        self.assertEqual(grade("外延片", [cap("equipment_supplier", "epitaxy", "MOCVD_equipment")]), 1)

    def test_epitaxy_equipment_unchanged(self):
        self.assertIn("epitaxy", parse("外延设备").processes)
        self.assertIn("epitaxy", parse("外延片设备").processes)  # 复合:装备头优先
        self.assertEqual(grade("外延设备", [cap("equipment_supplier", "epitaxy", "epitaxy_equipment")]), 3)
        self.assertEqual(grade("外延片", EPI_NONE), 3)


class ProcessQualifierTests(unittest.TestCase):
    """§六:工艺限定材料 = MATERIAL + processQualifier,不是装备 intent."""

    def test_ald_precursor(self):
        i = parse("ALD前驱体")
        self.assertEqual(i.material_subtypes, {"precursor"})
        self.assertEqual(i.process_qualifiers, {"deposition"})
        self.assertNotIn("ALD_equipment", i.equipment_subtypes)
        self.assertEqual(i.processes, set())
        self.assertEqual(grade("ALD前驱体", PRE_NONE), 3)   # 无 process 证据的前驱体 cap 是正确答案
        self.assertEqual(grade("ALD前驱体", PRE_DEP), 3)
        self.assertEqual(grade("ALD前驱体", ALD_EQ), 1)     # ALD 设备商 = 同工艺错角色
        self.assertEqual(grade("ALD前驱体", PR_MAT), 2)

    def test_pvd_target(self):
        i = parse("PVD靶材")
        self.assertEqual(i.material_subtypes, {"target_material"})
        self.assertEqual(i.process_qualifiers, {"deposition"})
        self.assertEqual(grade("PVD靶材", TARGET_DEP), 3)
        self.assertEqual(grade("PVD靶材", [cap("material_supplier", None, "target_material")]), 3)
        self.assertEqual(grade("PVD靶材", [cap("equipment_supplier", "deposition", "PVD_equipment")]), 1)

    def test_cmp_slurry_and_pad(self):
        for q, sub in (("CMP抛光液", "CMP_slurry"), ("CMP抛光垫", "CMP_pad"), ("抛光液", "CMP_slurry")):
            i = parse(q)
            self.assertEqual(i.material_subtypes, {sub}, q)
            self.assertEqual(grade(q, SLURRY_NONE if sub == "CMP_slurry" else [cap("material_supplier", None, "CMP_pad")]), 3)
        self.assertEqual(grade("CMP抛光液", CMP_EQ), 1)

    def test_bare_process_queries_still_unconstrained(self):
        """v1 parity:裸工艺 query 角色不设限(邻带 1/2 由 adjacency/rubric 给出)."""
        for q in ("ALD设备", "PVD设备", "CMP设备", "光刻"):
            self.assertEqual(parse(q).requested_roles, set(), q)
        self.assertEqual(grade("ALD设备", ALD_EQ), 3)
        self.assertEqual(grade("ALD设备", PR_MAT), 1)  # 上游邻居(v1 同值)


class ExclusionTests(unittest.TestCase):
    def test_do_not_want_material(self):
        i = parse("半导体设备企业，不要材料公司")
        self.assertEqual(i.requested_roles, {"equipment_supplier"})
        self.assertIn("material_supplier", i.excluded_roles)
        self.assertEqual(grade("半导体设备企业，不要材料公司", PR_MAT), 0)
        self.assertEqual(grade("半导体设备企业，不要材料公司", ALD_EQ), 3)

    def test_no_equipment(self):
        i = parse("只做材料不产设备的半导体公司")
        self.assertEqual(i.requested_roles, {"material_supplier"})
        self.assertEqual(grade("只做材料不产设备的半导体公司", PR_MAT), 3)

    def test_except_suffix(self):
        i = parse("设备整机厂商，材料厂除外")
        self.assertEqual(i.requested_roles, {"equipment_supplier"})
        self.assertEqual(grade("设备整机厂商，材料厂除外", PR_MAT), 0)


class ComponentSpanTests(unittest.TestCase):
    def test_component_queries_unchanged(self):
        i = parse("刻蚀机用的硅部件企业")
        self.assertEqual(i.component_subtypes, {"silicon_component"})
        self.assertEqual(i.requested_roles, {"component_supplier", "equipment_supplier"})
        self.assertEqual(grade("刻蚀机用的硅部件企业", [cap("component_supplier", "etching", "silicon_component")]), 3)

    def test_quartz(self):
        i = parse("半导体设备用石英件厂商")
        self.assertEqual(i.component_subtypes, {"quartz_component"})
        self.assertEqual(i.requested_roles, {"component_supplier"})


class EnrichmentSanityTests(unittest.TestCase):
    """真实冻结 enrichment(stage3.2)上的方向性断言(§十五 的 grader 侧锚点)."""

    @classmethod
    def setUpClass(cls):
        cls.enrichment = load_enrichment()
        cls.by_name = {r.get("name"): r for r in cls.enrichment.values()}

    def test_true_photoresist_top_band(self):
        for name in ("雅克科技", "彤程新材", "容大感光", "南大光电", "上海新阳", "晶瑞电材", "鼎龙股份"):
            rec = self.by_name.get(name)
            if rec is None:
                continue
            for q in ("光刻胶", "半导体光刻胶"):
                g, _ = grade_caps(parse(q), company_caps(rec))
                self.assertEqual(g, 3, f"{name} under {q!r}")

    def test_interferer_stays_secondary(self):
        # 江丰(target+deposition)/清溢(photomask+lithography) 无 photoresist 证据 → 2;
        # 安集科技 photoresist cap 已在 Knowledge Pass(s3-derive-v4)摘除——其
        # 「晶圆制造材料包括硅片、光刻胶…」证据系行业分类枚举(INDUSTRY_CONTEXT),
        # 现在只剩 CMP_slurry/wet_chemicals 的 role+家族匹配 → 2(§十二:不预设干扰恒低)
        self.assertEqual(grade_caps(parse("半导体光刻胶"), company_caps(self.by_name["江丰电子"]))[0], 2)
        self.assertEqual(grade_caps(parse("半导体光刻胶"), company_caps(self.by_name["清溢光电"]))[0], 2)
        self.assertEqual(grade_caps(parse("半导体光刻胶"), company_caps(self.by_name["安集科技"]))[0], 2)

    def test_photoresist_subtype_typed_caps(self):
        # kp1 typed materialType:配套(auxiliary)/上游原材料(raw_material)是
        # material_supplier 家族成员,不是光刻胶本体 → 2,不得判 3
        for name in ("江化微", "格林达", "强力新材"):
            rec = self.by_name.get(name)
            if rec is None:
                continue
            g, _ = grade_caps(parse("半导体光刻胶"), company_caps(rec))
            self.assertEqual(g, 2, f"{name} under 半导体光刻胶")
        # 真光刻胶本体(PCB 级广信材料)仍判 3(词面 光刻胶 本体证据成立)
        rec = self.by_name.get("广信材料")
        if rec is not None:
            g, _ = grade_caps(parse("光刻胶"), company_caps(rec))
            self.assertEqual(g, 3, "广信材料 under 光刻胶")


if __name__ == "__main__":
    unittest.main()
