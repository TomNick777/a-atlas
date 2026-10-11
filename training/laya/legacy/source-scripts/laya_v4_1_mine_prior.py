"""V4.1 prior-failure miner (spec §六/§七 P0): find the (query, company) pairs the
V4 checkpoint ACTUALLY scores high where the frozen evidence says mismatch.

Sources (both frozen, evaluation-only — the search stack is untouched):
  - EV cross-domain pools  data/eval/v3_ranking_candidates_v2.json (38×200),
    EV-IND-SEM* rows skipped (those ARE semiconductor queries)
  - live search log        data/search_log/search_log.jsonl (re-scored with V4
    locally; logged grades are NOT trusted — they predate this audit)

Emission rules (deterministic, facts from frozen data only):
  CROSS_DOMAIN_PRIOR   semiconductor-enriched company, query domain != company
                       domain (EV family mapping below), V4 score >= 1.5,
                       cross-domain grader target <= 1 → target grade with
                       DOMAIN_MISMATCH / WEAK_ASSOCIATION_ONLY reason (§九/§十)
  UNIVERSAL_HIGH_SCORE same but score >= 2.0 — recorded additionally, feeds the
                       repeat-offender watch (§二十三)
  ANCHOR_INTRUSION     one of the 12 frozen anchors in the real (non-injected)
                       Top20 of a cross-domain query with no evidence (§二十三)
  AMBIGUOUS companies are never emitted (§31 discipline).

Output: data/train/v4_1_prior_negatives.jsonl + data/train/v4_1_mining_stats.json
Usage: npm run laya:v4.1:mine-prior
  (= .venv/Scripts/python.exe -u scripts/laya_v4_1_mine_prior.py)
"""

from __future__ import annotations

import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_roles import AMBIGUOUS_CODES, company_caps, load_enrichment  # noqa: E402
from laya_v4_1_cross_domain import ANCHOR_CODES, grade_cross_domain, company_evidence  # noqa: E402
from eval_role_ranking import HOW, SCORE_LEVELS, SCORE_QUESTION, LEVELS, collate_local  # noqa: E402

CKPT = ROOT / "models/a-share-laya-v4-candidate/checkpoint_best"
EV_POOLS = ROOT / "data/eval/v3_ranking_candidates_v2.json"
SEARCH_LOG = ROOT / "data/search_log/search_log.jsonl"
OUT_QUEUE = ROOT / "data/train/v4_1_prior_negatives.jsonl"
OUT_STATS = ROOT / "data/train/v4_1_mining_stats.json"

THRESHOLD_PRIOR = 1.5
THRESHOLD_UNIVERSAL = 2.0

# EV family → cross-domain family (deterministic surface mapping; None = the EV
# family is cross-domain but has no keyword family — semiconductor companies
# still grade 0 there by domain evidence, reason DOMAIN_MISMATCH)
EV_FAMILY_DOMAIN: dict[str, str | None] = {
    "EV-CHAIN-DC-LIQCOOL": "dc_liquid_cooling",
    "EV-NEG-COPPER-RESOURCE": "copper_resource",
    "EV-NEG-AIHW-NOSOFT": None,
    "EV-FUZZ-LIKEHC2": "industrial_automation",
    "EV-NEG-HUMANOID-PARTS": None,
    "EV-CHAIN-DEXHAND": None,
    "EV-COMBO-AUTO-EXPORT": "consumer_electronics",
    "EV-COMBO-INDAUTO-EXPORT": "industrial_automation",
    "EV-ATTR-OVERSEAS2": None,
    "EV-NEG-NEVMAT2": "nev_material",
    "EV-NEG-AIDC-NOALGO": None,
    "EV-CHAIN-DC-POWER": None,
    "EV-FUZZ-AISHOVEL2": None,
    "EV-FUZZ-ROBOTUP2": None,
    "EV-CHAIN-ROBOTPARTS2": None,
    "EV-IND-ROBOT2": None,
}


def score_pool(queries: list[dict], micro_batch: int) -> dict[str, dict[str, float]]:
    """V4 score-head expected grade for every (query, candidate); production shape."""
    import torch
    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import QTYPES, build_model, build_sequence
    from safetensors.torch import load_file

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))
    cfg = json.loads((CKPT / "rl_agent_config.json").read_text(encoding="utf-8"))
    cfg["gradient_checkpointing"] = False
    model = build_model(cfg, encoder_dir=str(CKPT / "encoder"))
    model.load_state_dict(load_file(str(CKPT / "model.safetensors")), strict=True)
    device = torch.device("cuda")
    model.to(device).eval()

    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}

    out: dict[str, dict[str, float]] = {}
    started, n_items = time.time(), 0
    with torch.no_grad():
        for qi, q in enumerate(queries):
            items = []
            for cand in q["candidates"]:
                code = cand["code"]
                c = companies.get(code)
                if c is None:
                    continue
                profile = (profiles.get(code) or {}).get("searchText") or c["judgeText"]
                ins = json.dumps({"company": {"name": c["name"], "code": code, "profile": profile},
                                  "question": SCORE_QUESTION}, ensure_ascii=False)
                state = {"looking_for": q["query"][:300], "how_to_judge": HOW}
                seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
                if len(markers) != 4:
                    continue
                items.append({"code": code, "ids": seq, "markers": markers, "qtype": QTYPES["score"]})
            scores: dict[str, float] = {}
            for at in range(0, len(items), micro_batch):
                chunk = items[at:at + micro_batch]
                batch = collate_local(chunk, tok.pad_token_id)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    logits, _ = model(batch["input_ids"].to(device), batch["attention_mask"].to(device),
                                      batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                                      batch["qtype"].to(device))
                logits = logits.float().cpu()
                for j, it in enumerate(chunk):
                    k = len(it["markers"])
                    scores[it["code"]] = float((torch.softmax(logits[j, :k], -1) * torch.tensor(LEVELS[:k])).sum())
            out[q["query_id"]] = scores
            n_items += len(items)
            if (qi + 1) % 10 == 0:
                print(f"  scored {qi + 1}/{len(queries)} queries ({n_items} items, {n_items / max(1e-9, time.time() - started):.0f}/s)", flush=True)
    print(f"  V4 scoring done: {n_items} items in {time.time() - started:.0f}s", flush=True)
    return out


def main() -> None:
    enrichment = load_enrichment()
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))

    work: list[dict] = []
    ev_doc = json.loads(EV_POOLS.read_text(encoding="utf-8"))
    for q in ev_doc["queries"]:
        if q["family"].startswith("EV-IND-SEM"):
            continue  # semiconductor queries: not prior material
        work.append({"query_id": q["query_id"], "family": q["family"], "query": q["query"],
                     "candidates": q["candidates"], "origin": "ev_pool",
                     "domain": EV_FAMILY_DOMAIN.get(q["family"], "__unknown__")})
    if SEARCH_LOG.exists():
        for line in SEARCH_LOG.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            run = json.loads(line)
            work.append({"query_id": f"LOG::{run['id'] if 'id' in run else len(work)}",
                         "family": "search-log", "query": run["query"]["raw"],
                         "candidates": [{"code": c["code"]} for c in run.get("candidates", [])[:200]],
                         "origin": "search_log", "domain": "__log__"})
    print(f"mining {len(work)} cross-domain queries × ~200 candidates with V4…", flush=True)
    scores = score_pool(work, micro_batch=32)

    rows: list[dict] = []
    stats: Counter = Counter()
    per_company: dict[str, dict] = defaultdict(lambda: {"n": 0, "high": 0, "queries": set(), "maxScore": 0.0})
    intrusions: list[dict] = []

    for w in work:
        domain = w["domain"]
        query_semi = any(m in w["query"] for m in ("半导体", "晶圆", "芯片", "ALD", "PVD", "CVD", "刻蚀", "CMP",
                                                   "前驱体", "靶材", "光刻胶", "特气", "湿化学", "清洗", "涂胶",
                                                   "量测", "离子注入", "硅片", "光刻", "沉积"))
        q_scores = scores.get(w["query_id"], {})
        ranked = sorted(q_scores, key=lambda c: -q_scores[c])
        for rank, (code, score) in enumerate(sorted(q_scores.items(), key=lambda kv: -kv[1]), start=1):
            rec = enrichment.get(code)
            if rec is None or code in AMBIGUOUS_CODES or not company_caps(rec):
                continue  # only companies with a graded physical supply-chain role can
                          # carry a domain verdict (same discipline as the V4 grader:
                          # design houses / distributors have no caps → ungradable)
            if query_semi:
                continue
            if domain == "__unknown__" and w["origin"] == "ev_pool":
                continue  # un-mapped EV family: skip rather than guess
            # target grade: family grader when mapped, else plain domain mismatch
            if domain and domain != "__log__":
                ind_fields, prof = company_evidence(code, companies, profiles)
                target, reason = grade_cross_domain(domain, ind_fields, prof)
            else:
                target, reason = 0, "domain_mismatch"
            if target >= 2:
                continue  # company genuinely answers this cross-domain query
            per_company[code]["n"] += 1
            per_company[code]["queries"].add(w["query"])
            per_company[code]["maxScore"] = max(per_company[code]["maxScore"], score)
            if score >= THRESHOLD_PRIOR:
                per_company[code]["high"] += 1
                universal = score >= THRESHOLD_UNIVERSAL
                row = {
                    "query": w["query"], "queryDomain": domain or None, "evFamily": w["family"],
                    "companyCode": code, "companyName": companies.get(code, {}).get("name", ""),
                    "v4Score": round(score, 3), "v4Rank": rank,
                    "targetGrade": target, "reason": reason,
                    "roles": rec.get("roles") or [],
                    "evidence": {"source": "stage3.1-semiconductor-v1/s3-derive-v2",
                                 "profileSections": "工艺:/标签: injected sections are the audited trigger"},
                    "tags": (["CROSS_DOMAIN_PRIOR"] + (["UNIVERSAL_HIGH_SCORE"] if universal else [])),
                    "origin": w["origin"],
                }
                rows.append(row)
                stats["CROSS_DOMAIN_PRIOR" + ("_UNIVERSAL" if universal else "")] += 1
            if code in ANCHOR_CODES and rank <= 20 and target <= 1:
                intrusions.append({"query": w["query"], "anchor": companies.get(code, {}).get("name", ""),
                                   "rank": rank, "score": round(score, 3), "origin": w["origin"]})
                stats["ANCHOR_INTRUSION_TOP20"] += 1

    # dedupe (query, code), keep max score
    best: dict[tuple, dict] = {}
    for r in rows:
        key = (r["query"], r["companyCode"])
        if key not in best or r["v4Score"] > best[key]["v4Score"]:
            best[key] = r
    rows = sorted(best.values(), key=lambda r: (-r["v4Score"], r["query"], r["companyCode"]))
    OUT_QUEUE.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    offenders = sorted(
        ({"companyCode": c, "companyName": companies.get(c, {}).get("name", ""),
          **{k: (v if k != "queries" else len(v)) for k, v in p.items()}}
         for c, p in per_company.items()),
        key=lambda r: (-r["high"], -r["maxScore"]),
    )
    summary = {
        "checkpoint": "models/a-share-laya-v4-candidate/checkpoint_best (c3069e65)",
        "thresholds": {"prior": THRESHOLD_PRIOR, "universal": THRESHOLD_UNIVERSAL},
        "queriesScanned": len(work),
        "rows": len(rows),
        "stats": dict(sorted(stats.items())),
        "anchorIntrusions": intrusions[:40],
        "repeatOffenderWatch": offenders[:15],
    }
    OUT_STATS.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("anchorIntrusions", "repeatOffenderWatch")}, ensure_ascii=False, indent=1))
    print("saved", OUT_QUEUE)


if __name__ == "__main__":
    main()
