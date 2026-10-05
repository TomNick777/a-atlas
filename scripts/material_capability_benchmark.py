"""material-attribution-v1.1 capability benchmark (§10 quality gate).

A TEACHER-JUDGED truth set in the Stage3.2 attribution-benchmark style: for every
(company, materialType) pair in scope — all CHANGED pairs (removed caps, the
focus axes) plus a sample of unchanged axes — the evidence texts are read and the
cap judged TRUE_CAPABILITY (subject+predicate+object binding: the company itself
produces/R&Ds/sells the material) or FALSE_ATTRIBUTION (industry/policy
enumeration, market narration, application/inspection object, equipment or
supply-chain context, other-company context).

  precision = TRUE kept / judged kept      (did the guards leave false caps?)
  recall    = TRUE kept / (TRUE kept + TRUE removed)   (did the guards kill true caps?)

The judgments are evaluation data (考卷), NOT rules — zero company logic enters
the derivation. Output: data/eval/material_capability_benchmark_v1_1.json

Usage: .venv/Scripts/python scripts/material_capability_benchmark.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# ---------------------------------------------------------------------------
# Teacher judgments. Every row was judged by reading the company's evidence
# windows for that materialType (rationale records the decisive sentence class).
# Judgement basis: company-as-subject + production/supply predicate + material
# object ⇒ TRUE; enumeration/narration/application/equipment/procurement frame
# without company ownership ⇒ FALSE.
# ---------------------------------------------------------------------------

# silicon_wafer — the focus axis: all 20 kept + all 22 removed
SILICON_WAFER_KEPT_TRUE = {
    "TCL中环": "主营光伏硅片/半导体硅片(公司自身的硅片业务)",
    "沪硅产业": "300mm/200mm半导体硅片生产商(主营直接归属)",
    "立昂微": "硅片/射频芯片业务,6-12英寸硅片自产",
    "有研硅": "半导体硅片(8英寸及以上)研发生产销售",
    "上海合晶": "半导体硅外延片制造商(自产)",
    "西安奕材": "12英寸硅片生产商(主营)",
    "中晶科技": "半导体硅片/硅棒生产(主营)",
    "神工股份": "大直径硅材料/硅零部件(自产单晶硅)",
    "弘元绿能": "单晶硅棒/硅片生产(主营)",
    "京运通": "光伏硅片制造业务(自产)",
    "隆基绿能": "硅片业务为集团主营之一(自产)",
    "晶澳科技": "垂直一体化自供硅片/硅棒(自产)",
    "晶科能源": "垂直一体化自供硅片(自产)",
    "华民股份": "转型硅片制造(子公司主营硅片)",
    "扬杰科技": "功率器件用自制晶圆(自产产线)",
    "TCL科技": "通过TCL中环经营半导体硅片业务(合并口径)",
    "宇晶股份": "硅片切磨抛加工服务(生产性服务,直接归属)",
    "和邦生物": "子公司生产硅片(直接归属)",
    "*ST沐邦": "「光伏单晶硅棒、硅片的研发、生产与销售」+主营构成 硅片硅棒 89%(公司自产)",
    "海泰新能": "主营构成「太阳能多晶硅片收入」1%(公司自有产销,占比小但归属成立)",
}
SILICON_WAFER_KEPT_FALSE: dict[str, str] = {}
SILICON_WAFER_REMOVED_TRUE: dict[str, str] = {}
SILICON_WAFER_REMOVED_FALSE = {
    "*ST和科": "政策/行业叙述(清单包括硅片)", "ST东尼": "行业背景叙述",
    "中巨芯": "电子化学品商,硅片为行业叙述", "中船特气": "电子特气商,硅片为行业叙述",
    "凯德石英": "石英件商,硅片为被加工对象", "华海清科": "CMP设备商,硅片为应用对象",
    "华灿光电": "LED芯片商,硅片为行业叙述", "南大光电": "特气/前驱体/光刻胶商,硅片为政策枚举(ev_300346_051)",
    "坤博精工": "零部件商,硅片为应用语境", "多氟多": "氟化工/新能源材料,硅片为行业叙述",
    "奥特维": "光伏设备商,硅片为加工对象", "彤程新材": "光刻胶/CMP垫商,硅片为政策枚举",
    "恒坤新材": "前驱体/特气/光刻胶配套商,硅片为行业叙述", "捷佳伟创": "电池设备商,硅片为应用对象",
    "捷捷微电": "功率器件封测,硅片为行业叙述", "新恒汇": "引线框架/封装材料,硅片为行业叙述",
    "晶盛机电": "晶体生长设备商,硅片为设备对象", "欧晶科技": "石英坩埚商,硅片为服务对象",
    "江化微": "湿电子化学品商,硅片为应用对象", "连城数控": "设备商,硅片为应用对象",
    "风范股份": "铁塔主业,硅片为行业叙述", "鼎龙股份": "CMP垫/光刻胶商,硅片为政策枚举",
}

# photomask — the second focus axis: kept 4 + removed 4
PHOTOMASK_KEPT_TRUE = {
    "清溢光电": "掩膜版研发生产销售(主营)",
    "路维光电": "掩膜版生产(主营)",
    "龙图光罩": "掩膜版(光罩)制造商(主营)",
    "冠石科技": "光罩/掩膜版业务(子公司自产)",
}
PHOTOMASK_KEPT_FALSE: dict[str, str] = {}
PHOTOMASK_REMOVED_TRUE: dict[str, str] = {}
PHOTOMASK_REMOVED_FALSE = {
    "昌红科技": "模具/精密制造,掩膜版为行业语境", "洪田股份": "设备商(电解铜箔装备等),掩膜版为行业语境",
    "美迪凯": "零部件/AR镀膜,掩膜版为应用语境", "芯碁微装": "直写光刻设备商,掩膜版为应用/替代叙述",
}

# other changed pairs (removed caps on non-focus axes)
OTHER_REMOVED_FALSE = {
    ("上海合晶", "electronic_special_gas"): "晶圆代工,特气为采购/行业叙述",
    ("恒坤新材", "target_material"): "靶材为市场规模叙述(数据来源:中国半导体行业协会,ev_688727_038)",
    ("奥特维", "CMP_slurry"): "设备商,抛光液为应用对象",
    ("路维光电", "epi_wafer"): "掩膜版商,外延片为行业叙述",
    ("赛伍技术", "lead_frame"): "薄膜材料商,引线框架为供应链语境",
    ("华灿光电", "precursor"): "LED芯片商,前驱体为使用对象",
    ("金宏气体", "precursor"): "特气商,前驱体为行业叙述(公司不自产MO源)",
    ("正帆科技", "precursor"): "气体系统/设备商,前驱体为供应系统语境",
    ("晶盛机电", "sic_substrate"): "设备商,碳化硅衬底为设备对象",
    ("新恒汇", "sic_substrate"): "封装材料商,碳化硅为行业叙述",
    ("晶升股份", "sic_substrate"): "长晶设备商,碳化硅衬底为设备对象",
    ("金博股份", "sic_substrate"): "碳基热场材料商,碳化硅为应用/行业语境",
    ("连城数控", "sic_substrate"): "设备商,碳化硅为应用对象",
}
OTHER_REMOVED_TRUE: dict[tuple[str, str], str] = {}

# unchanged-axis sample (friendly-fire proof: these caps SURVIVED and are true)
UNCHANGED_TRUE = {
    ("雅克科技", "precursor"): "前驱体(MO源)自产主营", ("南大光电", "electronic_special_gas"): "特气自产(磷烷/砷烷等)",
    ("金宏气体", "electronic_special_gas"): "电子特气自产", ("中船特气", "electronic_special_gas"): "电子特气自产(主营)",
    ("江化微", "wet_chemicals"): "湿电子化学品自产(主营)", ("格林达", "wet_chemicals"): "显影液自产(主营)",
    ("安集科技", "CMP_slurry"): "CMP抛光液自产(主营)", ("鼎龙股份", "CMP_pad"): "CMP抛光垫自产(主营)",
    ("江丰电子", "target_material"): "溅射靶材自产(主营)", ("欧莱新材", "target_material"): "PVD靶材自产(主营)",
    ("强力新材", "photoresist_raw_material"): "光刻胶原材料(光引发剂)自产", ("瑞联新材", "photoresist_raw_material"): "显示/半导体材料自产",
    ("康强电子", "lead_frame"): "引线框架自产(主营)", ("兴森科技", "package_substrate"): "IC载板自产(主营)",
    ("深南电路", "package_substrate"): "封装基板自产(主营)", ("安泰科技", "cvd_diamond"): "金刚石工具/材料自产",
}


def main() -> None:
    import json

    recs = {r["code"]: r for r in json.loads(
        (ROOT / "data/enrichment/semiconductor/enrichment.json").read_text(encoding="utf-8"))["records"]}
    name2code = {r.get("name"): c for c, r in recs.items()}

    rows = []
    for nm, why in SILICON_WAFER_KEPT_TRUE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": "silicon_wafer",
                     "kept": True, "judgment": "TRUE_CAPABILITY", "rationale": why})
    for nm, why in SILICON_WAFER_KEPT_FALSE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": "silicon_wafer",
                     "kept": True, "judgment": "FALSE_ATTRIBUTION", "rationale": why})
    for nm, why in SILICON_WAFER_REMOVED_TRUE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": "silicon_wafer",
                     "kept": False, "judgment": "TRUE_CAPABILITY", "rationale": why})
    for nm, why in SILICON_WAFER_REMOVED_FALSE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": "silicon_wafer",
                     "kept": False, "judgment": "FALSE_ATTRIBUTION", "rationale": why})
    for nm, why in PHOTOMASK_KEPT_TRUE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": "photomask",
                     "kept": True, "judgment": "TRUE_CAPABILITY", "rationale": why})
    for nm, why in PHOTOMASK_KEPT_FALSE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": "photomask",
                     "kept": True, "judgment": "FALSE_ATTRIBUTION", "rationale": why})
    for nm, why in PHOTOMASK_REMOVED_FALSE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": "photomask",
                     "kept": False, "judgment": "FALSE_ATTRIBUTION", "rationale": why})
    for (nm, mt), why in OTHER_REMOVED_FALSE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": mt,
                     "kept": False, "judgment": "FALSE_ATTRIBUTION", "rationale": why})
    for (nm, mt), why in OTHER_REMOVED_TRUE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": mt,
                     "kept": False, "judgment": "TRUE_CAPABILITY", "rationale": why})
    for (nm, mt), why in UNCHANGED_TRUE.items():
        rows.append({"name": nm, "code": name2code.get(nm), "materialType": mt,
                     "kept": True, "judgment": "TRUE_CAPABILITY", "rationale": why})

    # verify each row against the CURRENT enrichment (kept = cap exists now)
    mismatches = []
    for r in rows:
        mts = {cap["materialType"] for cap in recs.get(r["code"], {}).get("processCapabilities", [])
               if cap.get("materialType") == r["materialType"]}
        actual_kept = bool(mts)
        if actual_kept != r["kept"]:
            mismatches.append(f"{r['name']}×{r['materialType']}: benchmark says kept={r['kept']}, enrichment says {actual_kept}")
        r["keptVerified"] = actual_kept

    kept_rows = [r for r in rows if r["kept"]]
    removed_rows = [r for r in rows if not r["kept"]]
    tp = sum(1 for r in kept_rows if r["judgment"] == "TRUE_CAPABILITY")
    fp = sum(1 for r in kept_rows if r["judgment"] == "FALSE_ATTRIBUTION")
    tn = sum(1 for r in removed_rows if r["judgment"] == "FALSE_ATTRIBUTION")
    fn = sum(1 for r in removed_rows if r["judgment"] == "TRUE_CAPABILITY")
    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)

    out = {
        "benchmarkVersion": "material-capability-benchmark-v1.1",
        "judgedBy": "GLM-5.3-Flash (ZCode agent, in-context) — 考卷不进规则",
        "scope": "all changed pairs (silicon_wafer/photomask focus) + unchanged-axis sample",
        "rows": rows,
        "metrics": {
            "MaterialCapabilityPrecision": round(precision, 4),
            "MaterialCapabilityRecall": round(recall, 4),
            "trueKept": tp, "falseKept": fp, "trueRemoved": fn, "falseRemoved": tn,
            "IndustryEnumerationLeakCount_kept": fp,
            "PolicyEnumerationLeakCount_kept": sum(1 for r in kept_rows if r["judgment"] == "FALSE_ATTRIBUTION" and "枚举" in r["rationale"]),
            "EquipmentContextLeakCount_kept": sum(1 for r in kept_rows if r["judgment"] == "FALSE_ATTRIBUTION" and "设备" in r["rationale"]),
        },
        "enrichmentMismatches": mismatches,
    }
    (ROOT / "data/eval/material_capability_benchmark_v1_1.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(out["metrics"], ensure_ascii=False, indent=1))
    if mismatches:
        print("MISMATCHES:")
        for m in mismatches:
            print("  ", m)
        sys.exit(1)


if __name__ == "__main__":
    main()
