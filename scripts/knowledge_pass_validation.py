# -*- coding: utf-8 -*-
"""Knowledge Pass validation (Residual Remediation Phase 2, spec §23/§24).

Computes the §23 metric set on the REBUILT knowledge layer:
  photoresist : true-PR precision + subtype split (typed materialType)
  copper      : CopperTagPrecision / CopperResourcePrecision /
                CopperProcessorVsResourceConfusion / WrongCommodityCopperTagCount
                + §12 per-company audit fields for the Phase-1 61-company enumeration
  thermal     : product/application precision + liquid-vs-general + server-vs-consumer
                + §12-style audit for the Phase-1 37-company enumeration
  protection  : §24 recall protection sets (true PR 8+2, real copper resource,
                evidenced thermal companies) — nothing may lose its label.

Zero company-name rules: every check reads the derived/semantic layers and the
raw SOURCE text; companies are only AUDITED, never special-cased.

Output: data/eval/knowledge_pass_validation.json (+ stdout summary).
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding="utf-8")

companies = {c["code"]: c for c in json.load(open(ROOT / "data/companies.json", encoding="utf-8"))["companies"]}
profiles = json.load(open(ROOT / "data/search_profiles_v3.json", encoding="utf-8"))
enrich = {r["code"]: r for r in json.load(open(ROOT / "data/enrichment/semiconductor/enrichment.json", encoding="utf-8"))["records"]}
enumeration = json.load(open(ROOT / "data/eval/knowledge_pass_enumeration.json", encoding="utf-8"))


def source_text(code):
    c = companies[code]
    return (c.get("businessDescription") or "") + "。" + "、".join(p["name"] for p in c.get("mainProducts", []))


def derived_values(code, dim):
    return [e for e in profiles[code]["derived"] if e["dimension"] == dim]


def semantic_tags(code):
    return [t["tag"] for t in profiles[code]["semantic"]["semanticTags"]]


COPPER_RUNGS = {"copper:mine", "copper:smelting", "copper:processing", "copper:foil", "copper:clad", "copper:heatsink"}
COPPER_ALL = COPPER_RUNGS | {"copper:byproduct", "copper:products"}
RESOURCE_RUNGS = {"copper:mine"}
# copper-specific surface: any copper compound word in SOURCE (铜 + metal/mining/product head)
COPPER_SURFACE = re.compile(r"铜[一-龥A-Za-z]{0,6}|一铜|阳极铜")

out = {"photoresist": {}, "copper": {}, "thermal": {}, "protection": {}}

# ---------------------------------------------------------------- photoresist
pr = {"typed": {}, "materialType_companies": {}}
for code, r in enrich.items():
    types = sorted(m["type"] for m in r["materialTypes"])
    for t in ("photoresist", "photoresist_auxiliary", "photoresist_raw_material"):
        if t in types:
            pr["materialType_companies"].setdefault(t, []).append(code)
for t, codes in pr["materialType_companies"].items():
    pr["typed"][t] = len(codes)
# subtype confusion: any company holding photoresist AND an auxiliary/raw subtype
conflicts = [
    code for code, r in enrich.items()
    if "photoresist" in [m["type"] for m in r["materialTypes"]]
    and ({"photoresist_auxiliary", "photoresist_raw_material"} & {m["type"] for m in r["materialTypes"]})
]
pr["subtype_conflict_companies"] = conflicts
out["photoresist"] = pr

# -------------------------------------------------------------------- copper
copper = {}
# §12 audit over the Phase-1 61-entry enumeration, re-adjudicated on the new layer
rows = []
for entry in enumeration["copper"]:
    code = entry["code"]
    if code not in profiles:
        continue
    src = source_text(code)
    entries = derived_values(code, "commodityExposure")
    rungs = sorted(e["value"] for e in entries)
    copper_surface = bool(COPPER_SURFACE.search(src))
    resource_rung = bool(RESOURCE_RUNGS & set(rungs))
    processing_only = bool(rungs) and set(rungs) <= {"copper:processing", "copper:foil", "copper:clad", "copper:heatsink"}
    rows.append({
        "code": code,
        "name": entry["name"],
        "oldRung": entry["rung"],
        "newRungs": rungs,
        "copperEvidencePresent": copper_surface,
        "resourceEvidencePresent": resource_rung,
        "processingOnly": processing_only,
        "genericMiningOnly": bool(rungs) and set(rungs) == {"copper:products"},
        "wrongCommodity": bool(rungs) and not copper_surface,
        "kept": bool(rungs),
        "removed": not rungs,
    })
copper["enumeration_readjudication"] = rows
copper["enumeration_total"] = len(rows)
copper["removed_count"] = sum(1 for r in rows if r["removed"])
copper["wrongCommodity_count"] = sum(1 for r in rows if r["wrongCommodity"])

# whole-universe copper checks
tag_bad, rung_bad, wrong_commodity_all = [], [], []
for code in profiles:
    if code not in companies:
        continue
    src = source_text(code)
    tags = semantic_tags(code)
    rungs = {e["value"] for e in derived_values(code, "commodityExposure")}
    if "铜资源" in tags and not COPPER_SURFACE.search(src):
        tag_bad.append(code)
    if RESOURCE_RUNGS & rungs and not COPPER_SURFACE.search(src):
        rung_bad.append(code)
    if (COPPER_ALL & rungs or "铜资源" in tags) and "铜" not in src:
        wrong_commodity_all.append(code)
copper["CopperTagPrecision_violations"] = tag_bad
copper["CopperResourcePrecision_violations"] = rung_bad
copper["WrongCommodityCopperTagCount"] = len(wrong_commodity_all)
copper["WrongCommodityCopperTag_companies"] = wrong_commodity_all
copper["CopperProcessorVsResourceConfusion"] = {
    "foil_mine_same_band_note": "rungs are separate values; foil companies cannot hold copper:mine without mining evidence",
    "companies_with_both_mine_and_foil": [
        code for code in profiles
        if RESOURCE_RUNGS & {e["value"] for e in derived_values(code, "commodityExposure")}
        and "copper:foil" in {e["value"] for e in derived_values(code, "commodityExposure")}
    ],
}
# 全体带 copper:* 敞口公司数(kp1 后)
copper["companies_with_copper_exposure"] = sum(
    1 for code in profiles if COPPER_ALL & {e["value"] for e in derived_values(code, "commodityExposure")}
)
out["copper"] = copper

# ------------------------------------------------------------------- thermal
thermal = {"enumeration_readjudication": []}
for entry in enumeration["thermal"]:
    code = entry["code"]
    if code not in profiles:
        continue
    seg = [e["label"] for e in derived_values(code, "thermalSegment")]
    prod = [e["label"] for e in derived_values(code, "thermalProduct")]
    src = source_text(code)
    has_server_word = bool(re.search(r"服务器", src))
    has_dc_word = bool(re.search(r"数据中心|机房|算力|智算|机柜|IDC", src))
    old_value = entry["value"]
    kept = any(
        e["value"] == old_value or (old_value, e["value"]) in {
            ("thermal:dc_thermal", "thermal:dc_thermal"),
        }
        for e in derived_values(code, "thermalSegment")
    )
    thermal["enumeration_readjudication"].append({
        "code": code,
        "name": entry["name"],
        "oldValue": old_value,
        "oldEvidence": entry["evidence"],
        "newSegments": seg,
        "newProducts": prod,
        "kept": kept,
        "removed": old_value not in {e["value"] for e in derived_values(code, "thermalSegment")}
        and old_value != "thermal:dc_thermal",
    })
# server cooling requires a 服务器 surface somewhere in SOURCE
thermal["server_label_without_server_word"] = [
    code for code in profiles
    if "thermal:server_cooling" in {e["value"] for e in derived_values(code, "thermalSegment")}
    and "服务器" not in source_text(code)
]
# dc liquid requires DC-context word
thermal["dc_liquid_without_dc_word"] = [
    code for code in profiles
    if "thermal:dc_liquid_cooling" in {e["value"] for e in derived_values(code, "thermalSegment")}
    and not re.search(r"数据中心|机房|服务器|算力|智算|机柜|IDC|IT设备", source_text(code))
]
thermal["consumer_label_companies"] = [
    code for code in profiles
    if "thermal:consumer_thermal" in {e["value"] for e in derived_values(code, "thermalSegment")}
]
out["thermal"] = thermal

# ---------------------------------------------------------------- protection
protection = {}
TRUE_PR = ["002409", "300054", "300236", "300346", "300398", "300576", "300655", "603650"]
protection["photoresist"] = {
    code: {
        "photoresist_kept": "photoresist" in [m["type"] for m in enrich.get(code, {}).get("materialTypes", [])],
        "label_kept": "光刻胶" in (profiles[code].get("domainKnowledge", {}).get("semiconductor", {}) or {}).get("materialTypes", []) and True or any(
            m["type"] == "photoresist" for m in enrich.get(code, {}).get("materialTypes", [])
        ),
    }
    for code in TRUE_PR
}
COPPER_PROTECT = ["600362", "601899", "000630", "000878", "000737", "601212", "000060", "603993", "600338", "300618", "600531", "000751", "002237", "600577"]
protection["copper"] = {}
for code in COPPER_PROTECT:
    if code not in profiles:
        protection["copper"][code] = "missing"
        continue
    rungs = sorted(e["value"] for e in derived_values(code, "commodityExposure"))
    tags = semantic_tags(code)
    protection["copper"][code] = {"name": companies[code]["name"], "rungs": rungs, "tag": "铜资源" in tags, "kept": bool(rungs)}
THERMAL_PROTECT = ["003018", "002837", "301489", "301667", "002126", "002239", "002454", "301157", "300507"]
protection["thermal"] = {}
for code in THERMAL_PROTECT:
    if code not in profiles:
        protection["thermal"][code] = "missing"
        continue
    seg = [e["label"] for e in derived_values(code, "thermalSegment")]
    prod = [e["label"] for e in derived_values(code, "thermalProduct")]
    protection["thermal"][code] = {"name": companies[code]["name"], "segments": seg, "products": prod, "kept": bool(seg or prod)}
out["protection"] = protection

out["versions"] = {
    "ontologyVersion": profiles["000001"]["ontologyVersion"],
    "semiconductorEnrichmentVersion": json.load(open(ROOT / "data/search_index_manifest.json", encoding="utf-8")).get("semiconductorEnrichmentVersion"),
    "photoresistCleanupVersion": json.load(open(ROOT / "data/search_index_manifest.json", encoding="utf-8")).get("photoresistCleanupVersion"),
    "commodityOntologyVersion": json.load(open(ROOT / "data/search_index_manifest.json", encoding="utf-8")).get("commodityOntologyVersion"),
    "thermalEnrichmentVersion": json.load(open(ROOT / "data/search_index_manifest.json", encoding="utf-8")).get("thermalEnrichmentVersion"),
}

with open(ROOT / "data/eval/knowledge_pass_validation.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

print("photoresist typed:", out["photoresist"]["typed"], "conflicts:", conflicts)
print("copper: enum", copper["enumeration_total"], "removed", copper["removed_count"],
      "wrongCommodity", copper["WrongCommodityCopperTagCount"],
      "tagViolations", len(tag_bad), "rungViolations", len(rung_bad),
      "exposureCompanies", copper["companies_with_copper_exposure"])
print("thermal: serverWithoutWord", len(thermal["server_label_without_server_word"]),
      "dcLiquidWithoutDC", len(thermal["dc_liquid_without_dc_word"]),
      "consumerCompanies", thermal["consumer_label_companies"])
pr_kept = sum(1 for v in protection["photoresist"].values() if v["photoresist_kept"])
cu_kept = sum(1 for v in protection["copper"].values() if isinstance(v, dict) and v.get("kept"))
th_kept = sum(1 for v in protection["thermal"].values() if isinstance(v, dict) and v.get("kept"))
print(f"protection recall: photoresist {pr_kept}/{len(TRUE_PR)} copper {cu_kept}/{len(COPPER_PROTECT)} thermal {th_kept}/{len(THERMAL_PROTECT)}")
