"""commodity-role-rubric-kp1: deterministic commodity rung-intent grading for V4.2.

Track B (LAYA_V4_2 spec §11/§12) needs grades for queries like 铜资源 / 铜箔 /
铜加工 that express a COMMODITY + RUNG intent, not a semiconductor role.
role-grader-v2 is frozen (§三) and has no commodity lexemes, so this module is a
SEPARATE deterministic rubric, grounded entirely in the Knowledge Pass typed
commodity ladder (search/ontology/commodities.ts @ commodity-ontology-kp1) as it
lands in company profiles as derived `commodityExposure` values:

    copper:mine / copper:smelting / copper:processing / copper:foil /
    copper:clad / copper:byproduct / copper:products / copper:heatsink
    lithium:mine / lithium:salt / lithium:cathode
    aluminum:mine / aluminum:smelting / aluminum:processing
    gold:mine / gold:smelting

Rules (spec §11/§12):
  - The rung-intent is parsed from the query with a small lexicon (资源端 vs
    加工端 vs 深加工); the same intent family shared by all paraphrases of one
    group is what makes labels variant-invariant by construction.
  - mine (resource owner)  = 3 under a resource intent, 1/0 under processing
    intents (§12: "copper mine → 0/1" reversed; upstream neighbour band = 1,
    the LAYA_V4 §12 hard-negative band).
  - smelting = 2 under a resource intent (resource side, one rung off).
  - every OTHER rung of the SAME commodity = 1 under a resource intent (same
    commodity, wrong rung = hard-negative band); under a processing intent the
    matching rung = 3, sibling deep-processing rung = 2, upstream = 1.
  - company with NO tag of that commodity at all = 0 (cross-domain negative,
    includes semiconductor-material companies: spec §10 hard negatives).
  - 铜涨价/受益/弹性 queries are REFUSED (spec §13: no revenue-share/production/
    equity/cost/hedge evidence exists — SOURCE_GAP, never strong supervision).

This rubric never inspects company names and never hardcodes a company: grades
are a pure function of (parsed rung-intent, profile commodityExposure values).
Version: commodity-role-rubric-kp1 (lineage field `graderVersion` on every row).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILES_FILE = ROOT / "data" / "search_profiles_v3.json"

RUBRIC_VERSION = "commodity-role-rubric-kp1"

# ---------------------------------------------------------------------------
# query-side rung-intent lexicon (deterministic, order = priority)
# ---------------------------------------------------------------------------

# (commodity, rungIntent) — first match wins; 受益/涨价 intents are refused.
_INTENT_RULES: list[tuple[str, str, re.Pattern[str]]] = [
    # --- refusals (spec §13) ------------------------------------------------
    ("copper", "REFUSED_BENEFICIARY", re.compile(r"涨价|受益|弹性|利好|赚钱")),
    ("lithium", "REFUSED_BENEFICIARY", re.compile(r"涨价|受益|弹性|利好|赚钱")),
    ("aluminum", "REFUSED_BENEFICIARY", re.compile(r"涨价|受益|弹性|利好|赚钱")),
    ("gold", "REFUSED_BENEFICIARY", re.compile(r"涨价|受益|弹性|利好|赚钱")),
    # --- copper -------------------------------------------------------------
    ("copper", "foil", re.compile(r"铜箔|电解铜箔|压延铜箔")),
    ("copper", "clad", re.compile(r"覆铜板|CCL")),
    ("copper", "resource", re.compile(r"铜矿|铜资源|铜金属|铜精矿|上游铜|有铜|铜采选|铜冶炼矿山")),
    ("copper", "smelting", re.compile(r"铜冶炼|阴极铜|电解铜|电积铜|粗铜")),
    ("copper", "processing", re.compile(r"铜加工|铜材|铜板|铜管|铜棒|铜线|铜杆|铜带|铜排|铜合金|铜产品")),
    # --- lithium ------------------------------------------------------------
    ("lithium", "cathode", re.compile(r"正极材料|正极|锂电材料")),
    ("lithium", "salt", re.compile(r"碳酸锂|氢氧化锂|锂盐|盐湖提锂|锂化合物")),
    ("lithium", "resource", re.compile(r"锂矿|锂资源|锂辉石|盐湖|上游锂|锂云母")),
    # --- aluminum -----------------------------------------------------------
    ("aluminum", "processing", re.compile(r"铝加工|铝材|铝板带箔|铝型材|铝箔")),
    ("aluminum", "smelting", re.compile(r"电解铝|氧化铝|原铝")),
    ("aluminum", "resource", re.compile(r"铝土矿|铝矿|铝土")),
    # --- gold ---------------------------------------------------------------
    ("gold", "smelting", re.compile(r"黄金冶炼|合质金|金锭")),
    ("gold", "resource", re.compile(r"金矿|黄金矿产|金资源|上游金|采金")),
]

# A bare 「铜加工」 must NOT be caught by the copper resource pattern (it is
# not), and 「铜资源不要铜加工」 carries an exclusion — the exclusion operator
# is handled by the caller (this rubric only grades positive intents; excluded
# rung queries are not used for training in this round).

# ---------------------------------------------------------------------------
# grade tables: (commodity, rungIntent) -> {profileRung: grade}
# mine under non-resource intents = 1 (upstream neighbour, §12); the matching
# processing rung = 3; sibling deep-processing rung = 2; other same-commodity
# rungs = 1.
# ---------------------------------------------------------------------------

_GRADES: dict[tuple[str, str], dict[str, int]] = {
    ("copper", "resource"): {"mine": 3, "smelting": 2, "products": 1, "byproduct": 1,
                             "processing": 1, "foil": 1, "clad": 1, "heatsink": 1},
    ("copper", "smelting"): {"smelting": 3, "mine": 2, "products": 1, "byproduct": 1,
                             "processing": 1, "foil": 1, "clad": 1, "heatsink": 1},
    ("copper", "processing"): {"processing": 3, "foil": 2, "clad": 2, "products": 1,
                               "smelting": 1, "byproduct": 1, "mine": 1, "heatsink": 1},
    ("copper", "foil"): {"foil": 3, "clad": 2, "processing": 1, "products": 1,
                         "smelting": 1, "byproduct": 1, "mine": 1, "heatsink": 1},
    ("copper", "clad"): {"clad": 3, "foil": 2, "processing": 1, "products": 1,
                         "smelting": 1, "byproduct": 1, "mine": 1, "heatsink": 1},
    ("lithium", "resource"): {"mine": 3, "salt": 2, "cathode": 1},
    ("lithium", "salt"): {"salt": 3, "mine": 2, "cathode": 1},
    ("lithium", "cathode"): {"cathode": 3, "salt": 2, "mine": 1},
    ("aluminum", "resource"): {"mine": 3, "smelting": 2, "processing": 1},
    ("aluminum", "smelting"): {"smelting": 3, "mine": 2, "processing": 1},
    ("aluminum", "processing"): {"processing": 3, "smelting": 2, "mine": 1},
    ("gold", "resource"): {"mine": 3, "smelting": 2},
    ("gold", "smelting"): {"smelting": 3, "mine": 2},
}


@dataclass
class CommodityIntent:
    query: str
    commodity: str | None = None
    rung_intent: str | None = None
    refused_reason: str | None = None

    @property
    def gradeable(self) -> bool:
        return self.commodity is not None and self.rung_intent is not None


def parse_commodity_intent(query: str) -> CommodityIntent:
    q = query.strip()
    for commodity, intent, rx in _INTENT_RULES:
        if rx.search(q):
            if intent.startswith("REFUSED"):
                return CommodityIntent(query=q, commodity=commodity, refused_reason=intent)
            return CommodityIntent(query=q, commodity=commodity, rung_intent=intent)
    return CommodityIntent(query=q)


def grade_commodity(intent: CommodityIntent, exposure_values: list[str]) -> tuple[int | None, str]:
    """Grade one company from its derived commodityExposure values.

    Returns (grade, reason); grade None = query not commodity-expressive (caller
    must not invent one). A company with no tag of the requested commodity = 0
    (cross-domain negative, deterministic — absence of the commodity tag is the
    frozen profile's own statement, the same authority the cross-domain grader
    uses for zero-touch domains).
    """
    if not intent.gradeable:
        return None, intent.refused_reason or "query_not_commodity_expressive"
    table = _GRADES[(intent.commodity, intent.rung_intent)]
    rungs = sorted({v.split(":", 1)[1] for v in exposure_values
                    if v.startswith(intent.commodity + ":")})
    if not rungs:
        return 0, f"no_{intent.commodity}_exposure"
    best, best_reason = None, "no_matching_rung"
    for rung in rungs:
        g = table.get(rung)
        if g is None:
            continue
        if best is None or g > best:
            best, best_reason = g, f"{intent.commodity}:{rung}"
    if best is None:
        return 0, f"no_{intent.commodity}_exposure"
    return best, best_reason


def load_exposure(profiles: dict) -> dict[str, list[str]]:
    """code -> [commodityExposure values] from the frozen profile derived block."""
    out: dict[str, list[str]] = {}
    for code, p in profiles.items():
        vals = [d["value"] for d in p.get("derived", [])
                if d.get("dimension") == "commodityExposure"]
        if vals:
            out[code] = vals
    return out
