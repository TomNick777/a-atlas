"""V4 role-aware query sets: TRAIN / VAL / TEST tables + isolation rules.

The teacher (GLM, in-context) authors QUERY SURFACE FORMS only. Company facts are
never authored here — grades for TRAIN come from the deterministic role grader over
the Stage 3.1 enrichment; grades for VAL/TEST are frozen in the benchmark manifest
(grader + documented 公知 overrides, same discipline as the Stage 3 benchmark:
"标签=冻结时点行业公知公司事实,与被测 enrichment 独立").

Isolation (spec §17):
  - TRAIN, VAL, TEST query TEXTS are disjoint (exact match AND substring check);
  - EV-* / Stage3 held-out texts are never train rows (inherited from V2/V3);
  - VAL is the checkpoint-selection split (§22); TEST is frozen, evaluated once.

Usage: imported by build_train_pairs_v4.py and the held-out pool builder
(scripts/build_v4_role_pools.ts reads the exported JSON via `python -m` dump).
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# ---------------------------------------------------------------------------
# P1 synthetic role-contrast TRAIN queries (canonical phrasings).
# Grades: deterministic grader over enrichment; where the Stage3 benchmark truth
# covers the same query text, truth wins on codes it labels (no contradictions).
# ---------------------------------------------------------------------------
TRAIN_ROLE_QUERIES: list[dict] = [
    # --- Equipment vs Material (spec §11.1) ---
    {"family": "V4-TR-EQM-ALD", "queries": ["ALD设备", "做ALD设备的公司"]},
    {"family": "V4-TR-EQM-PVD", "queries": ["PVD设备", "PVD镀膜设备公司"]},
    {"family": "V4-TR-EQM-ETCH", "queries": ["刻蚀设备厂商"]},
    {"family": "V4-TR-EQM-CLEAN", "queries": ["半导体清洗设备"]},
    {"family": "V4-TR-EQM-CMP", "queries": ["CMP设备厂商"]},
    {"family": "V4-TR-EQM-DEP", "queries": ["薄膜沉积设备企业"]},
    {"family": "V4-TR-EQM-TRACK", "queries": ["涂胶显影设备"]},
    {"family": "V4-TR-EQM-MEAS", "queries": ["半导体量测设备厂商"]},
    {"family": "V4-TR-EQM-IMP", "queries": ["离子注入机公司"]},
    # --- Equipment vs Component (spec §11.2) ---
    {"family": "V4-TR-EQC-GEN", "queries": ["半导体设备零部件"]},
    {"family": "V4-TR-EQC-QUARTZ", "queries": ["半导体石英件"]},
    {"family": "V4-TR-EQC-CERAMIC", "queries": ["电子陶瓷零部件"]},
    {"family": "V4-TR-EQC-VAC", "queries": ["半导体真空零部件"]},
    {"family": "V4-TR-EQC-SI", "queries": ["刻蚀机硅部件"]},
    # --- Material-specific (spec §11.3) ---
    {"family": "V4-TR-MAT-TARGET", "queries": ["PVD靶材", "溅射靶材厂商"]},
    {"family": "V4-TR-MAT-PRE", "queries": ["ALD前驱体"]},
    {"family": "V4-TR-MAT-SLURRY", "queries": ["CMP抛光液"]},
    {"family": "V4-TR-MAT-PAD", "queries": ["CMP抛光垫"]},
    {"family": "V4-TR-MAT-RESIST", "queries": ["半导体光刻胶"]},
    {"family": "V4-TR-MAT-GAS", "queries": ["电子特气厂商"]},
    {"family": "V4-TR-MAT-WET", "queries": ["湿电子化学品"]},
    {"family": "V4-TR-MAT-GEN", "queries": ["半导体材料公司"]},
    {"family": "V4-TR-MAT-WAFER", "queries": ["半导体硅片厂"]},
    # --- Process-specific (spec §11.4) ---
    {"family": "V4-TR-PROC-DEP", "queries": ["CVD设备公司"]},
    {"family": "V4-TR-PROC-CLEAN", "queries": ["单片清洗设备企业"]},
    {"family": "V4-TR-PROC-CMP", "queries": ["CMP工艺设备"]},
    {"family": "V4-TR-PROC-MEAS", "queries": ["量测检测设备"]},
    # --- Generic equipment + role exclusion (spec §32.5/§32.6 shape) ---
    {"family": "V4-TR-EQ-GEN", "queries": ["半导体设备公司", "半导体设备厂"]},
    {"family": "V4-TR-EQ-EXCLM", "queries": ["半导体设备企业，不要材料公司"]},
    {"family": "V4-TR-MAT-EXCLE", "queries": ["半导体材料企业，不做设备"]},
]

# ---------------------------------------------------------------------------
# VAL (checkpoint selection, spec §22) — 8 queries, phrasings disjoint from TRAIN
# and TEST. Labels frozen alongside TEST (same grader + overrides + review).
# ---------------------------------------------------------------------------
VAL_ROLE_QUERIES: list[dict] = [
    {"family": "V4-VAL-EQ-ALD", "expect": "equipment", "query": "哪家公司生产ALD机器"},
    {"family": "V4-VAL-EQ-ETCH", "expect": "equipment", "query": "刻蚀机的上市公司"},
    {"family": "V4-VAL-EQ-CLEAN", "expect": "equipment", "query": "清洗半导体硅片的设备企业"},
    {"family": "V4-VAL-MAT-TARGET", "expect": "material", "query": "靶材材料供应商"},
    {"family": "V4-VAL-MAT-PRE", "expect": "material", "query": "前驱体化学材料公司"},
    {"family": "V4-VAL-COMP-GEN", "expect": "component", "query": "半导体设备用的零部件厂"},
    {"family": "V4-VAL-EQVSMAT", "expect": "equipment", "query": "卖薄膜沉积机器的不是卖材料的"},
    {"family": "V4-VAL-EQ-GEN", "expect": "equipment", "query": "晶圆厂用的设备制造商"},
]

# ---------------------------------------------------------------------------
# TEST (frozen role-aware held-out, spec §17) — paraphrase / colloquial / implicit
# role surfaces, never "change two words" of a train query. The TS pool builder
# (build_v4_role_pools.ts) mirrors production retrieval for these texts.
# ---------------------------------------------------------------------------
TEST_ROLE_QUERIES: list[dict] = [
    {"family": "V4R-ALD-EQ", "expect": "equipment", "query": "给晶圆厂卖原子层沉积机器的"},
    {"family": "V4R-ALD-EQ", "expect": "equipment", "query": "生产ALD镀膜机的企业"},
    {"family": "V4R-PVD-EQ", "expect": "equipment", "query": "制造磁控溅射设备的厂商"},
    {"family": "V4R-PVD-EQ", "expect": "equipment", "query": "物理气相沉积装备公司"},
    {"family": "V4R-ETCH-EQ", "expect": "equipment", "query": "做等离子体刻蚀机的公司"},
    {"family": "V4R-ETCH-EQ", "expect": "equipment", "query": "半导体干法刻蚀设备制造商"},
    {"family": "V4R-CLEAN-EQ", "expect": "equipment", "query": "晶圆清洗机设备企业"},
    {"family": "V4R-CMP-EQ", "expect": "equipment", "query": "化学机械抛光机生产商"},
    {"family": "V4R-DEP-EQ", "expect": "equipment", "query": "造薄膜沉积设备的厂家"},
    {"family": "V4R-MAT-TARGET", "expect": "material", "query": "溅射用金属靶材的企业"},
    {"family": "V4R-MAT-TARGET", "expect": "material", "query": "高纯金属靶材制造商"},
    {"family": "V4R-MAT-PRE", "expect": "material", "query": "半导体工艺前驱体试剂厂商"},
    {"family": "V4R-MAT-SLURRY", "expect": "material", "query": "抛光液研磨液供应商"},
    {"family": "V4R-MAT-RESIST", "expect": "material", "query": "做光刻胶材料的上市公司"},
    {"family": "V4R-MAT-GAS", "expect": "material", "query": "电子级特种气体企业"},
    {"family": "V4R-MAT-WET", "expect": "material", "query": "超纯湿化学品制造商"},
    {"family": "V4R-COMP-QUARTZ", "expect": "component", "query": "半导体设备用石英件厂商"},
    {"family": "V4R-COMP-GEN", "expect": "component", "query": "半导体设备核心零部件供应商"},
    {"family": "V4R-COMP-VAC", "expect": "component", "query": "真空阀门零部件公司"},
    {"family": "V4R-COMP-SI", "expect": "component", "query": "刻蚀机用的硅部件企业"},
    {"family": "V4R-EQ-EXCLM", "expect": "equipment", "query": "设备整机厂商，材料厂除外"},
    {"family": "V4R-MAT-EXCLE", "expect": "material", "query": "只做材料不产设备的半导体公司"},
    {"family": "V4R-EQ-GEN", "expect": "equipment", "query": "芯片厂设备供应商"},
    {"family": "V4R-EQ-GEN", "expect": "equipment", "query": "卖半导体整机设备的"},
]

# 公知 label overrides for VAL/TEST freezing (documented, tiny). Grounds: broad-line
# makers whose FY2025 annual-report windows under-derive one subtype (the Stage 3.1
# audit's known表达力边界). Applied AFTER the grader; recorded in the manifest.
# "KNOWLEDGE_BACKLOG: derive 边界 — 不改 enrichment,只记公知标签。"
PUBLIC_KNOWLEDGE_OVERRIDES: dict[str, dict[str, int]] = {
    # 北方华创 does market ALD tools (platform maker); enrichment lacks the subtype.
    "002371": {"ALD_equipment": 3},
}

# families that must NEVER appear as train rows (inherited isolation from V2/V3)
FORBIDDEN_TRAIN_PREFIXES = ("EV-", "V-", "V4R-", "V4-VAL-")
STAGE3_FAMILIES_FILE = "data/eval/stage3_benchmark_manifest.json"


def all_train_queries() -> list[dict]:
    out = []
    for fam in TRAIN_ROLE_QUERIES:
        for qi, q in enumerate(fam["queries"]):
            out.append({"query_id": f"{fam['family']}::q{qi}", "family": fam["family"], "query": q})
    return out


def isolation_check(train_texts: set[str]) -> list[str]:
    """Return violations list (empty = pass). Text-level disjointness: exact match,
    or the shorter text (>=4 chars) appearing contiguously inside the longer one.
    2-3 char term overlap (半导体/光刻胶/石英件…) is unavoidable for same-topic
    paraphrases and is NOT a violation."""
    violations = []
    val_test = [q["query"] for q in VAL_ROLE_QUERIES] + [q["query"] for q in TEST_ROLE_QUERIES]
    for vt in val_test:
        for tt in train_texts:
            if vt == tt:
                violations.append(f"exact overlap: train '{tt}' ↔ held-out '{vt}'")
                continue
            short, long = (tt, vt) if len(tt) <= len(vt) else (vt, tt)
            if len(short) >= 4 and short in long:
                violations.append(f"containment: '{short}' inside '{long}'")
    return violations


if __name__ == "__main__":
    # dump VAL+TEST queries for the frozen-pool builder (scripts/build_v4_role_pools.ts)
    import json

    out = [{"split": "val", **q} for q in VAL_ROLE_QUERIES] + [{"split": "test", **q} for q in TEST_ROLE_QUERIES]
    path = ROOT / "data/eval/v4_role_queries.json"
    path.write_text(json.dumps({"queries": out, "overrides": PUBLIC_KNOWLEDGE_OVERRIDES}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(out)} held-out queries -> {path}")
