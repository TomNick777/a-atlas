"""Build V4.2 corrective training pairs (LAYA_V4_2 spec §5/§6/§8–§12/§21/§24/§30).

Composition (variants, §30):
  A = corrected V4.1-A base + Track A material-subtype matrix + Track B copper
      role rows, ONE canonical wording per intent.
  B = A + paraphrase wording rows (same intents) + transfer families
      (lithium / aluminum / gold rung ladders, robot_reducer,
      industrial_automation) — the phrase-robustness mass (§14–§18).

Base inheritance with label authority (§5/§6 — the round's first principle):
  every v4-role-contrast row (grader-authority rows) takes its label from the
  role-grader-v2 regrade (data/train/v4_1_regraded_preview.jsonl, 693 changed);
  non-grader-origin rows keep their original label (label authority is not the
  role grader there; v2=None refusals keep the original too). Old and new
  grades never coexist as two training rows — the old grade survives only as
  provenance (originalGrade).

Lineage on EVERY row (§6): originalDataset / originalGrade / correctedGrade /
graderVersion / knowledgeVersion / correctionReason / queryFamily /
companyCode / evidenceIds (+ paraphraseGroupId / canonicalIntent where
applicable).

Graders (no hand-written company labels, §8):
  material rows  -> role-grader-v2 (frozen, scripts/laya_v4_roles.py)
  copper/transfer-> commodity-role-rubric-kp1 (scripts/laya_v4_2_commodity_roles.py)
  robot/automation-> grade_cross_domain (frozen V4.1 cross-domain grader)

Every phrase group is graded ONCE on its canonical wording; paraphrases
inherit those labels verbatim — variant-invariance (§14/§15) is by
construction, so the §16 consistency objective never fights the labels.

Axis hygiene discovered at build time (documented, not fixed — knowledge layer
is frozen per spec §3):
  silicon_wafer / photomask typed caps carry M1-class contamination (industry
  policy enumerations, e.g. 南大光电 ev_300346_051), so those subtype axes get
  NO label-bearing rows this round (no verifiable grade-3 supervision from
  frozen data). Recorded as knowledge BACKLOG. Verified-clean axes:
  photoresist, target_material, CMP_slurry, CMP_pad, wet_chemicals,
  electronic_special_gas.

Isolation (§18/§24/§32): every train wording is checked against the frozen
30-pool strings, every V4.1 held-out text (isolation_check_v41 semantics:
exact match or >=4-char containment, both directions) and the new frozen
V4.2 eval/val wordings (data/train/v4_2_eval_queries.json). One inherited-base
string (半导体光刻胶) predates the 30-pool and is grandfathered (reported).

Caps (§21): per company per intent-family 8, per company new-row total 40,
per company new grade-3 total 16, grade-0 sample 12/query (P1 pattern; for
copper intents the 0-sample is stratified: 6 random + 6 semiconductor-material
companies = the §10 photoresist×copper hard negatives). No random easy
negatives added (inherited 60 stay, §21).

Usage: .venv/Scripts/python scripts/build_train_pairs_v4_2.py
  → data/train/v4_2_train_pairs_A.jsonl / _B.jsonl / v4_2_manifest.json
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_roles import (  # noqa: E402
    AMBIGUOUS_CODES,
    company_caps,
    grade_caps,
    load_enrichment,
    parse_intent,
)
from laya_v4_2_commodity_roles import (  # noqa: E402
    RUBRIC_VERSION,
    grade_commodity,
    load_exposure,
    parse_commodity_intent,
)
from laya_v4_1_cross_domain import (  # noqa: E402
    ANCHOR_CODES,
    all_heldout_queries,
    company_evidence,
    grade_cross_domain,
)

SEED = 20260926
TEACHER = "GLM-5.3-Flash (ZCode agent, in-context)"
GENERATION_VERSION = "2026-09-26-v1-v4.2"
KNOWLEDGE_VERSION = "residual-knowledge-pass-v1"
GRADER_V2 = "role-grader-v2"
XDOM_GRADER = "xdomain-grader-v1"

BASE_PAIRS = ROOT / "data/train/v4_1_train_pairs_A.jsonl"
REGRADE = ROOT / "data/train/v4_1_regraded_preview.jsonl"
EVAL_QUERIES = ROOT / "data/train/v4_2_eval_queries.json"
OUT_A = ROOT / "data/train/v4_2_train_pairs_A.jsonl"
OUT_B = ROOT / "data/train/v4_2_train_pairs_B.jsonl"
OUT_MANIFEST = ROOT / "data/train/v4_2_manifest.json"

# caps (§21)
FAMILY_COMPANY_CAP = 8        # new rows per (company, intent family)
COMPANY_NEW_TOTAL_CAP = 40    # new rows per company, all tracks
COMPANY_NEW_G3_CAP = 16       # new grade-3 rows per company
GRADE0_SAMPLE = 12            # P1 pattern
GRADE0_SEMI_MATERIAL = 6      # §10 stratified hard negatives per copper query

# ---------------------------------------------------------------------------
# intent/wording tables. Wordings were chosen under the isolation rule; the
# mechanical check below is the authority and fails loudly on any violation.
# ---------------------------------------------------------------------------

MATERIAL_INTENTS = [
    {"pgid": "PG-MAT-RESIST", "family": "V42-TR-MAT-RESIST", "subtype": "photoresist",
     "canonical": "光刻胶研发生产企业", "paraphrases": ["生产光刻胶的企业", "光刻胶厂商"]},
    {"pgid": "PG-MAT-TARGET", "family": "V42-TR-MAT-TARGET", "subtype": "target_material",
     "canonical": "溅射靶材企业", "paraphrases": ["PVD靶材制造商", "靶材材料公司"]},
    {"pgid": "PG-MAT-SLURRY", "family": "V42-TR-MAT-SLURRY", "subtype": "CMP_slurry",
     "canonical": "CMP抛光液供应商", "paraphrases": ["化学机械抛光液企业", "晶圆研磨液厂商"]},
    {"pgid": "PG-MAT-PAD", "family": "V42-TR-MAT-PAD", "subtype": "CMP_pad",
     "canonical": "CMP抛光垫企业", "paraphrases": ["抛光垫材料厂商"]},
    {"pgid": "PG-MAT-WET", "family": "V42-TR-MAT-WET", "subtype": "wet_chemicals",
     "canonical": "电子级湿化学品企业", "paraphrases": ["高纯湿化学品厂商"]},
    {"pgid": "PG-MAT-GAS", "family": "V42-TR-MAT-GAS", "subtype": "electronic_special_gas",
     "canonical": "电子特气企业", "paraphrases": ["电子特气制造商", "高纯特气生产商"]},
]

COPPER_INTENTS = [
    {"pgid": "PG-CU-RES", "family": "V42-TR-CU-RES", "intent": "copper:resource",
     "canonical": "铜矿采选企业", "paraphrases": ["开采铜矿的上市公司", "主营铜矿开采的企业"]},
    {"pgid": "PG-CU-FOIL", "family": "V42-TR-CU-FOIL", "intent": "copper:foil",
     "canonical": "铜箔生产企业", "paraphrases": ["锂电铜箔厂商", "电子电路铜箔企业"]},
    {"pgid": "PG-CU-PROC", "family": "V42-TR-CU-PROC", "intent": "copper:processing",
     "canonical": "铜材加工企业", "paraphrases": ["铜棒铜管制造企业", "铜板带铜杆加工企业"]},
]

TRANSFER_INTENTS = [
    {"pgid": "PG-LI-RES", "family": "V42-TR-LI-RES", "intent": "lithium:resource",
     "canonical": "锂矿采选企业", "paraphrases": ["含锂盐湖开发企业", "锂辉石矿企业"]},
    {"pgid": "PG-LI-CATH", "family": "V42-TR-LI-CATH", "intent": "lithium:cathode",
     "canonical": "锂电正极材料企业", "paraphrases": ["生产锂电正极的公司"]},
    {"pgid": "PG-AL-RES", "family": "V42-TR-AL-RES", "intent": "aluminum:resource",
     "canonical": "铝土矿企业", "paraphrases": ["含铝土矿的企业"]},
    {"pgid": "PG-AL-PROC", "family": "V42-TR-AL-PROC", "intent": "aluminum:processing",
     "canonical": "铝加工材企业", "paraphrases": ["铝型材铝板带企业"]},
    {"pgid": "PG-AU-RES", "family": "V42-TR-AU-RES", "intent": "gold:resource",
     "canonical": "金矿采选企业", "paraphrases": ["拥有金矿资源的公司"]},
]

XDOM_INTENTS = [
    {"pgid": "PG-ROBOT-RED", "family": "V42-TR-ROBOT-RED", "domain": "robot_reducer",
     "canonical": "机器人用减速器制造企业", "paraphrases": ["机器人精密减速器企业"]},
    {"pgid": "PG-IND-AUTO", "family": "V42-TR-IND-AUTO", "domain": "industrial_automation",
     "canonical": "工业自动化企业", "paraphrases": ["做伺服控制器电机的自动化公司"]},
]


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def containment_violation(train_text: str, eval_text: str) -> str | None:
    if train_text == eval_text:
        return f"exact overlap: train '{train_text}' ↔ eval '{eval_text}'"
    short, long = (train_text, eval_text) if len(train_text) <= len(eval_text) else (eval_text, train_text)
    if len(short) >= 4 and short in long:
        return f"containment: '{short}' inside eval '{eval_text}' ↔ train '{train_text}'"
    return None


def main() -> None:
    rng = random.Random(SEED)
    enrichment = load_enrichment()
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    companies = {c["code"]: c for c in json.loads(
        (ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    exposure = load_exposure(profiles)
    evalq = json.loads(EVAL_QUERIES.read_text(encoding="utf-8"))

    # ------------------------------------------------------------------
    # 1. isolation checks on ALL new train wordings (fail loudly, §18/§24)
    # ------------------------------------------------------------------
    eval_texts: set[str] = set(evalq["frozen30Pool"])
    for section in ("val", "sets"):
        for rows_ in evalq[section].values():
            for r in rows_:
                eval_texts.update(r.get("queries") or [r["query"]])
    from laya_v4_query_sets import VAL_ROLE_QUERIES, TEST_ROLE_QUERIES  # noqa: E402
    eval_texts.update(q["query"] for q in VAL_ROLE_QUERIES)
    eval_texts.update(q["query"] for q in TEST_ROLE_QUERIES)
    eval_texts.update(q["query"] for q in all_heldout_queries())

    all_intents = MATERIAL_INTENTS + COPPER_INTENTS + TRANSFER_INTENTS + XDOM_INTENTS
    train_wordings: list[str] = []
    for spec in all_intents:
        train_wordings.append(spec["canonical"])
        train_wordings.extend(spec["paraphrases"])
    violations = []
    for tt in train_wordings:
        for et in sorted(eval_texts):
            v = containment_violation(tt, et)
            if v:
                violations.append(v)
    base_pairs = load_jsonl(BASE_PAIRS)
    regrade = {(r["query"], r["code"]): r for r in load_jsonl(REGRADE)}
    grandfathered = sorted({r["query"] for r in base_pairs for et in sorted(evalq["frozen30Pool"])
                            if r["query"] != et and (et in r["query"] or r["query"] in et)
                            and len(min((et, r["query"]), key=len)) >= 4})
    if violations:
        print("ISOLATION VIOLATIONS (must fix wordings, §18):")
        for v in sorted(set(violations)):
            print("  ", v)
        raise SystemExit(1)
    print(f"[isolation] {len(train_wordings)} train wordings × {len(eval_texts)} eval texts: clean; "
          f"grandfathered base strings: {grandfathered}")

    # ------------------------------------------------------------------
    # 2. corrected base inheritance (§5/§6)
    # ------------------------------------------------------------------
    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    base_corrected = base_kept_grader = base_kept_authority = missing_regrade = 0
    for r in base_pairs:
        key = (r["query"], r["code"])
        rg = regrade.get(key)
        if rg is None:
            missing_regrade += 1
            continue
        label = int(r["label"])
        orig = rg.get("labelOriginal")
        new = {**r,
               "originalDataset": "v4.1-A",
               "originalGrade": orig if orig is not None else label,
               "correctedGrade": None,
               "graderVersion": rg.get("graderVersion", GRADER_V2),
               "knowledgeVersion": KNOWLEDGE_VERSION,
               "correctionReason": rg.get("relabelReason", "inherited-unchanged"),
               "paraphraseGroupId": None, "canonicalIntent": None}
        if r.get("category") == "v4-role-contrast":
            v2 = rg.get("labelV2")
            if v2 is not None and int(v2) != label:
                new["label"] = int(v2)
                new["correctedGrade"] = int(v2)
                base_corrected += 1
            elif v2 is None:
                base_kept_authority += 1
            else:
                base_kept_grader += 1
        else:
            base_kept_authority += 1
        seen.add(key)
        rows.append(new)
    print(f"[base] {len(rows)} inherited ({base_corrected} relabelled by {GRADER_V2}, "
          f"{base_kept_grader} unchanged grader-origin, {base_kept_authority} kept by row authority); "
          f"missing regrade {missing_regrade}")

    per_family_company: Counter = Counter()
    per_company_new: Counter = Counter()
    per_company_g3: Counter = Counter()

    def cap_ok(code: str, family: str, label: int) -> bool:
        return (per_family_company[(family, code)] < FAMILY_COMPANY_CAP
                and per_company_new[code] < COMPANY_NEW_TOTAL_CAP
                and not (label >= 3 and per_company_g3[code] >= COMPANY_NEW_G3_CAP))

    def add_row(family: str, category: str, pgid: str | None, canonical_intent: str | None,
                query: str, qid: str, code: str, label: int, reason: str, grader: str,
                evidence_ids: list[str], evidence_text: str, variants: list[str]) -> bool:
        if code in AMBIGUOUS_CODES or code not in companies:
            return False
        key = (query, code)
        if key in seen or not cap_ok(code, family, label):
            return False
        seen.add(key)
        c = companies[code]
        rows.append({
            "query_id": qid, "family": family, "category": category, "query": query,
            "code": code, "name": c["name"], "label": int(label),
            "evidence": evidence_text[:220],
            "source": f"v4.2:{category}",
            "profileText": (profiles.get(code) or {}).get("searchText") or c.get("judgeText") or "",
            "judgeText": c.get("judgeText"),
            "teacher": TEACHER, "generation_version": GENERATION_VERSION,
            "originalDataset": "v4.2-new", "originalGrade": None, "correctedGrade": None,
            "graderVersion": grader, "knowledgeVersion": KNOWLEDGE_VERSION,
            "correctionReason": reason,
            "queryFamily": family, "companyCode": code,
            "evidenceIds": evidence_ids,
            "paraphraseGroupId": pgid, "canonicalIntent": canonical_intent,
            "variants": variants,
        })
        per_family_company[(family, code)] += 1
        per_company_new[code] += 1
        if label >= 3:
            per_company_g3[code] += 1
        return True

    # ------------------------------------------------------------------
    # 3. Track A — material subtype matrix (role-grader-v2, §8/§9/§10)
    # ------------------------------------------------------------------
    trackA = 0
    semi_material_codes = sorted(
        c for c, rec in enrichment.items()
        if any(cap.get("materialType") for cap in (rec.get("processCapabilities") or []))
    )
    for spec in MATERIAL_INTENTS:
        intent = parse_intent(spec["canonical"])
        if not intent.gradeable:
            raise SystemExit(f"material canonical not role-expressive: {spec['canonical']}")
        graded: list[tuple[int, str, str, list[str]]] = []
        for code, rec in enrichment.items():
            grade, reason = grade_caps(intent, company_caps(rec))
            if grade is None:
                continue
            ev_ids: list[str] = []
            for cap in rec.get("processCapabilities") or []:
                if cap.get("materialType") == spec["subtype"]:
                    ev_ids = cap.get("evidenceIds") or []
                    break
            graded.append((grade, code, reason, ev_ids))
        zeros = [x for x in graded if x[0] == 0]
        keep0 = {code for _, code, _, _ in rng.sample(zeros, min(GRADE0_SAMPLE, len(zeros)))} if zeros else set()
        for wi, wording in enumerate([spec["canonical"], *spec["paraphrases"]]):
            for g, code, reason, ev_ids in graded:
                if g == 0 and code not in keep0:
                    continue
                variants = ["A", "B"] if wi == 0 else ["B"]
                if add_row(spec["family"], "v42-material-subtype", spec["pgid"], spec["subtype"],
                           wording, f"{spec['pgid']}::w{wi}", code, g, f"grader:{reason}",
                           GRADER_V2, ev_ids, f"material-subtype:{spec['subtype']}|{reason}", variants):
                    trackA += 1
    print(f"[trackA] material-subtype rows: {trackA}")

    # ------------------------------------------------------------------
    # 4. Track B — copper role (commodity-role-rubric-kp1, §11/§12)
    # ------------------------------------------------------------------
    trackB = 0
    rng_b = random.Random(SEED + 1)
    for spec in COPPER_INTENTS:
        ci = parse_commodity_intent(spec["canonical"])
        if not ci.gradeable:
            raise SystemExit(f"copper canonical not commodity-expressive: {spec['canonical']}")
        graded = [(g, code, reason) for code, vals in exposure.items()
                  for g, reason in [grade_commodity(ci, vals)]]
        zeros = [x for x in graded if x[0] == 0]
        keep0 = {code for _, code, _ in rng_b.sample(
            zeros, min(GRADE0_SAMPLE - GRADE0_SEMI_MATERIAL, len(zeros)))} if zeros else set()
        # §10 stratified hard negatives: semiconductor-material companies at 0
        grade_by_code = {code: g for g, code, _ in graded}
        semi_zero = [c for c in semi_material_codes
                     if c in exposure and grade_by_code.get(c) == 0]
        if semi_zero:
            keep0.update(rng_b.sample(semi_zero, min(GRADE0_SEMI_MATERIAL, len(semi_zero))))
        for wi, wording in enumerate([spec["canonical"], *spec["paraphrases"]]):
            for g, code, reason in graded:
                if g == 0 and code not in keep0:
                    continue
                variants = ["A", "B"] if wi == 0 else ["B"]
                if add_row(spec["family"], "v42-copper-role", spec["pgid"], spec["intent"],
                           wording, f"{spec['pgid']}::w{wi}", code, g, f"rubric:{reason}",
                           RUBRIC_VERSION, [], f"commodity-role:{spec['intent']}|{reason}", variants):
                    trackB += 1
    print(f"[trackB] copper-role rows: {trackB}")

    # ------------------------------------------------------------------
    # 5. Track C — phrase/transfer rows (variant B only, §14–§18)
    # ------------------------------------------------------------------
    trackC = 0
    for spec in TRANSFER_INTENTS:
        ci = parse_commodity_intent(spec["canonical"])
        if not ci.gradeable:
            raise SystemExit(f"transfer canonical not commodity-expressive: {spec['canonical']}")
        graded = [(g, code, reason) for code, vals in exposure.items()
                  for g, reason in [grade_commodity(ci, vals)]]
        zeros = [x for x in graded if x[0] == 0]
        keep0 = {code for _, code, _ in rng_b.sample(zeros, min(GRADE0_SAMPLE, len(zeros)))} if zeros else set()
        for wi, wording in enumerate([spec["canonical"], *spec["paraphrases"]]):
            for g, code, reason in graded:
                if g == 0 and code not in keep0:
                    continue
                if add_row(spec["family"], "v42-transfer-role", spec["pgid"], spec["intent"],
                           wording, f"{spec['pgid']}::w{wi}", code, g, f"rubric:{reason}",
                           RUBRIC_VERSION, [], f"commodity-role:{spec['intent']}|{reason}", ["B"]):
                    trackC += 1

    no_exposure_codes = [c for c in companies if c not in exposure and c not in AMBIGUOUS_CODES]
    for spec in XDOM_INTENTS:
        for wi, wording in enumerate([spec["canonical"], *spec["paraphrases"]]):
            pool_codes: list[str] = []
            for code in companies:
                ind_fields, prof = company_evidence(code, companies, profiles)
                g, _ = grade_cross_domain(spec["domain"], ind_fields, prof)
                if g >= 2:
                    pool_codes.append(code)
            pool_codes.extend(a for a in ANCHOR_CODES if a not in pool_codes)
            extra = [c for c in no_exposure_codes if c not in pool_codes]
            pool_codes.extend(rng_b.sample(extra, min(GRADE0_SAMPLE, len(extra))))
            for code in pool_codes:
                ind_fields, prof = company_evidence(code, companies, profiles)
                g, reason = grade_cross_domain(spec["domain"], ind_fields, prof)
                if add_row(spec["family"], "v42-phrase-xdom", spec["pgid"], spec["domain"],
                           wording, f"{spec['pgid']}::w{wi}", code, g, f"xdom:{reason}",
                           XDOM_GRADER, [], f"xdom:{spec['domain']}|{reason}", ["B"]):
                    trackC += 1
    print(f"[trackC] transfer+phrase rows: {trackC}")

    # ------------------------------------------------------------------
    # 6. variant split + write
    # ------------------------------------------------------------------
    rows_a = [r for r in rows if r.get("originalDataset") == "v4.1-A" or "A" in (r.get("variants") or [])]

    def write(path: Path, rs: list[dict]) -> None:
        with path.open("w", encoding="utf-8", newline="\n") as f:
            for r in rs:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    write(OUT_A, rows_a)
    write(OUT_B, rows)

    def comp(rs: list[dict]) -> dict:
        return {"rows": len(rs),
                "byCategory": dict(Counter(r["category"] for r in rs)),
                "byLabel": {str(k): v for k, v in sorted(Counter(r["label"] for r in rs).items())}}

    manifest = {
        "generationVersion": GENERATION_VERSION,
        "seed": SEED,
        "knowledgeVersion": KNOWLEDGE_VERSION,
        "graders": {"material": GRADER_V2, "commodity": RUBRIC_VERSION, "xdom": XDOM_GRADER},
        "base": {"file": BASE_PAIRS.name, "rows": len(base_pairs),
                 "corrected": base_corrected, "graderOriginKept": base_kept_grader,
                 "authorityKept": base_kept_authority, "missingRegrade": missing_regrade},
        "isolation": {"evalTexts": len(eval_texts), "trainWordings": len(train_wordings),
                      "violations": 0, "grandfatheredBaseStrings": grandfathered},
        "variants": {"A": comp(rows_a), "B": comp(rows)},
        "caps": {"familyCompany": FAMILY_COMPANY_CAP, "companyNewTotal": COMPANY_NEW_TOTAL_CAP,
                 "companyNewG3": COMPANY_NEW_G3_CAP, "grade0Sample": GRADE0_SAMPLE},
        "axisHygiene": {
            "excludedSubtypeAxes": ["silicon_wafer", "photomask"],
            "reason": "M1-class contamination on typed caps (industry policy enumeration evidence, "
                      "e.g. ev_300346_051) — no verifiable grade-3 supervision from frozen data; "
                      "knowledge BACKLOG",
        },
        "pgGroups": {spec["pgid"]: {"canonicalIntent": spec.get("subtype") or spec.get("intent") or spec.get("domain"),
                                    "wordings": [spec["canonical"], *spec["paraphrases"]],
                                    "variants": ["A", "B"] if spec in MATERIAL_INTENTS + COPPER_INTENTS else ["B"]}
                     for spec in all_intents},
    }
    OUT_MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[done] A={len(rows_a)} B={len(rows)} → {OUT_A.name} / {OUT_B.name}")


if __name__ == "__main__":
    main()
