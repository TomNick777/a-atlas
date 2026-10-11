"""V4 Training Candidate Miner (spec §7/§8/§29/§30/§31).

Scores every candidate of the FROZEN pools (Stage3 87×Top200 + Stage3.1 focus 8×20,
plus live search-log runs) through the current production reranker (V3 checkpoint),
then compares against DETERMINISTIC role-aware target grades (laya_v4_roles — facts
only from the Stage 3.1 enrichment, benchmark truth where frozen). Emits:

  data/train/v4_candidate_queue.jsonl   — training candidates with reason tags:
      HARD_POSITIVE   retrieval/evidence strong, V3 grade/rank too low
      HARD_NEGATIVE   process-related but wrong role, V3 grade too high
      ROLE_INVERSION  wrong-role company ranked above a matching-role company
      EXCLUSION_VIOLATION  known-excluded company scored grade>=2
      AMBIGUOUS_*     audit-residual companies — never strong supervision (§31)
      CANDIDATE_UNVERIFIED  search-log rows no deterministic truth can confirm (§30)
  reports data (stdout JSON) → summarised into reports/LAYA_V4_HARD_NEGATIVE_MINING.md

Re-runnable: output is rewritten deterministically (sorted). The search never
changes; retrieval stays frozen — this only OBSERVES the current V3 on frozen pools.

Usage: npm run laya:v4:mine   (= .venv/Scripts/python.exe -u scripts/laya_v4_mine.py)
  --skip-v3        don't load the model; only emit rows already scored (search log)
  --micro-batch N  forward batch (default 32)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
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
    record_profile_summary,
)

HOW = (
    "looking_for 是一个人用自己的话说想找的公司。"
    "每一题是一家候选公司，profile 是它的公开业务资料。"
    "判断这家公司的主营业务是否就是这句话在找的东西。"
    "概念标签沾边但主营无关，回答要低。"
    "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。"
    "几家公司可以同时符合。"
)
SCORE_QUESTION = "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。"
SCORE_LEVELS = [
    "0=无关:主营业务与查询要找的无关",
    "1=沾边:概念/名字/大类相邻,主营业务并不符合",
    "2=部分相关:产业链上下游,或组合条件只满足一半",
    "3=直接相关:主营业务就是查询要找的东西",
]
LEVELS = [0.0, 1.0, 2.0, 3.0]

STAGE3_POOLS = ROOT / "data/eval/stage3_ranking_candidates_v3.json"
STAGE3_TRUTH = ROOT / "data/eval/stage3_semiconductor_benchmark.jsonl"
FOCUS_POOLS = ROOT / "data/eval/stage3_1_focus_pools.json"
SEARCH_LOG = ROOT / "data/search_log/search_log.jsonl"
OUT_QUEUE = ROOT / "data/train/v4_candidate_queue.jsonl"
CKPT = ROOT / "models/a-share-laya-v3/checkpoint_best"


def load_truth() -> dict[str, dict]:
    truth: dict[str, dict] = {}
    for line in STAGE3_TRUTH.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        labels = {r["code"]: 3 for r in row.get("relevant3", [])}
        labels.update({r["code"]: 2 for r in row.get("relevant2", [])})
        for r in row.get("hard1", []) + row.get("known_hard_negatives", []):
            labels.setdefault(r["code"], 1)
        for r in row.get("known_excludes", []):
            labels.setdefault(r["code"], 0)
        truth[row["query"]] = labels
    return truth


def truth_grade(labels: dict[str, int], code: str) -> int | None:
    return labels.get(code)


def queue_row(query: str, query_spec: dict, code: str, name: str, profile_summary: dict,
              retrieval: dict, v3_grade: float | None, v3_rank: int | None,
              target_grade: int | None, reason: str, evidence_ids: list[str],
              origin: str, ambiguous: bool = False, needs_validation: bool = False,
              extra: dict | None = None) -> dict:
    row = {
        "query": query,
        "querySpec": query_spec,
        "companyCode": code,
        "companyName": name,
        "profile": profile_summary,
        "retrieval": retrieval,
        "v3": {"grade": v3_grade, "rank": v3_rank},
        "targetGrade": target_grade,
        "targetRole": query_spec.get("requestedRoles") or [],
        "reason": reason,
        "evidenceIds": evidence_ids,
        "origin": origin,
        "ambiguous": ambiguous,
        "needsValidation": needs_validation,
    }
    if extra:
        row["extra"] = extra
    return row


def classify_query_rows(rows: list[dict]) -> None:
    """Second pass per query: promote false-high wrong-role rows to ROLE_INVERSION
    when a matching-role company sits behind them in V3's order (spec §20)."""
    ranked = sorted((r for r in rows if r["v3"]["rank"] is not None), key=lambda r: r["v3"]["rank"])
    first_good_rank = next((r["v3"]["rank"] for r in ranked if (r["targetGrade"] or 0) >= 2), None)
    if first_good_rank is None:
        return
    for r in rows:
        if (r["reason"] == "HARD_NEGATIVE" and r["v3"]["rank"] is not None
                and r["v3"]["rank"] < first_good_rank and (r["v3"]["grade"] or 0) >= 2
                and not r["ambiguous"]):
            r["reason"] = "ROLE_INVERSION"
            r["inversionBefore"] = first_good_rank


def score_pool_v3(queries: list[dict], micro_batch: int) -> dict[str, dict[str, float]]:
    """V3 score-head expected grade for every (query, candidate); production shape.
    Cached (frozen pools + frozen checkpoint → deterministic), so re-mining after
    lexicon fixes doesn't repay the 3.5-minute forward pass."""
    cache = ROOT / "data/train/v4_v3_pool_scores.cache.json"
    if cache.exists():
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if all(q["query_id"] in cached for q in queries):
                print(f"  V3 scores: cache hit ({len(cached)} queries)", flush=True)
                return cached
        except Exception:
            pass
    import torch
    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import QTYPES, build_sequence
    from safetensors.torch import load_file

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))
    sys.path.insert(0, str(ROOT / "scripts"))
    from train_laya import collate  # exact training-time collate → identical batch shape

    from laya.common import build_model
    cfg = json.loads((CKPT / "rl_agent_config.json").read_text(encoding="utf-8"))
    cfg["gradient_checkpointing"] = False
    model = build_model(cfg, encoder_dir=str(CKPT / "encoder"))
    model.load_state_dict(load_file(str(CKPT / "model.safetensors")), strict=True)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device).eval()

    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}

    out: dict[str, dict[str, float]] = {}
    started = time.time()
    n_items = 0
    with torch.no_grad():
        for qi, q in enumerate(queries):
            items = []
            for cand in q["candidates"]:
                code = cand["code"]
                c = companies.get(code)
                if c is None:
                    continue
                profile = profiles.get(code, {}).get("searchText") or c["judgeText"]
                ins = json.dumps({
                    "company": {"name": c["name"], "code": code, "profile": profile},
                    "question": SCORE_QUESTION,
                }, ensure_ascii=False)
                state = {"looking_for": q["query"][:300], "how_to_judge": HOW}
                seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
                if len(markers) != 4:
                    continue
                items.append({"code": code, "ids": seq, "markers": markers,
                              "qtype": QTYPES["score"], "target": [0.0] * 4, "label": -1})
            scores: dict[str, float] = {}
            for at in range(0, len(items), micro_batch):
                chunk = items[at : at + micro_batch]
                batch = collate(chunk, tok.pad_token_id)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    logits, _ = model(
                        batch["input_ids"].to(device), batch["attention_mask"].to(device),
                        batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                        batch["qtype"].to(device))
                logits = logits.float().cpu()
                for j, it in enumerate(chunk):
                    probs = torch.softmax(logits[j, : len(it["markers"])], -1)
                    scores[it["code"]] = float((probs * torch.tensor(LEVELS[: len(it["markers"])])).sum())
            out[q["query_id"]] = scores
            n_items += len(items)
            if (qi + 1) % 10 == 0:
                rate = n_items / max(1e-9, time.time() - started)
                print(f"  scored {qi + 1}/{len(queries)} queries ({n_items} items, {rate:.0f}/s)", flush=True)
    print(f"  V3 scoring done: {n_items} items in {time.time() - started:.0f}s", flush=True)
    cache.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-v3", action="store_true")
    parser.add_argument("--micro-batch", type=int, default=32)
    parser.add_argument("--out", default=str(OUT_QUEUE))
    parser.add_argument("--failures-report", default=None,
                        help="also write the §29 rerank-failure bundle (repeat offenders, "
                             "role inversions, false-high hard negatives) to this JSON path")
    args = parser.parse_args()

    enrichment = load_enrichment()
    truth = load_truth()
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}

    pool_queries: list[dict] = []
    stage3_doc = json.loads(STAGE3_POOLS.read_text(encoding="utf-8"))
    for q in stage3_doc["queries"]:
        pool_queries.append({"query_id": q["query_id"], "family": q["family"], "query": q["query"],
                             "candidates": q["candidates"], "origin": "stage3_benchmark", "pool_size": len(q["candidates"])})
    if FOCUS_POOLS.exists():
        focus_doc = json.loads(FOCUS_POOLS.read_text(encoding="utf-8"))
        for q in focus_doc["queries"]:
            pool_queries.append({"query_id": f"FOCUS::{q['group']}::{q['expect']}", "family": f"FOCUS-{q['group']}",
                                 "query": q["query"], "candidates": q["candidates"],
                                 "origin": "stage3.1_focus_pool", "pool_size": len(q["candidates"])})

    v3_scores: dict[str, dict[str, float]] = {}
    if not args.skip_v3:
        print(f"scoring {len(pool_queries)} frozen-pool queries with V3 (checkpoint_best)…", flush=True)
        v3_scores = score_pool_v3(pool_queries, args.micro_batch)

    rows: list[dict] = []
    stats: Counter = Counter()
    inversion_examples: list[dict] = []

    for pq in pool_queries:
        intent = parse_intent(pq["query"])
        labels = truth.get(pq["query"], {})
        qrows: list[dict] = []
        for rank, cand in enumerate(pq["candidates"], start=1):
            code = cand["code"]
            rec = enrichment.get(code)
            caps = company_caps(rec)
            ambiguous = code in AMBIGUOUS_CODES
            # role logic may only grade when the query actually expresses a role/
            # process intent — otherwise every enriched company would vacuously
            # match (empty requested_roles + empty processes ⇒ role_ok∧proc_ok)
            det_grade, det_reason = (None, "ambiguous_audit_residual") if ambiguous else (
                grade_caps(intent, caps) if intent.gradeable else (None, "query_not_role_expressive"))
            t_label = truth_grade(labels, code)
            if ambiguous:
                target, basis = None, "AMBIGUOUS"
            elif t_label is not None:
                target, basis = t_label, "benchmark_truth"
            elif det_grade is not None:
                target, basis = det_grade, "role_logic"
            else:
                target, basis = None, "no_truth_no_caps"
            vg = v3_scores.get(pq["query_id"], {}).get(code)
            base = {
                "query": pq["query"],
                "querySpec": intent.to_dict(),
                "companyCode": code,
                "companyName": companies.get(code, {}).get("name", ""),
                "profile": record_profile_summary(rec),
                "retrieval": {"rank": rank, "bm25": None, "vector": None, "rrf": None},
                "v3": {"grade": vg, "rank": rank if vg is not None else None},
                "targetGrade": target,
                "targetRole": sorted(intent.requested_roles),
                "origin": pq["origin"],
                "ambiguous": ambiguous,
                "needsValidation": target is None,
                "reason": None,
            }
            qrows.append(base)
            stats[f"pool:{pq['origin']}:graded"] += 1
            if ambiguous:
                stats["ambiguous_rows"] += 1
            if target is None:
                stats["ungraded_rows"] += 1
                continue
            if vg is None:
                continue
            if basis == "AMBIGUOUS":
                reason = "AMBIGUOUS_NOT_SUPERVISED"
            elif target >= 2 and vg <= target - 1 and rank > 10:
                # grade underestimated (or right-grade-but-deep only when grade gap
                # exists) — a correct grade buried at rank 50 under other 3s is NOT
                # a reranker error and must not be queued
                reason = "HARD_POSITIVE"
            elif target <= 1 and vg >= 2:
                reason = "HARD_NEGATIVE"
            else:
                reason = "CORRECT"
            base["reason"] = reason
            base["gradeBasis"] = basis
            base["detReason"] = det_reason
            base["evidenceIds"] = sorted({e for c in caps for e in (c.get("evidenceIds") or [])})[:12]
        classify_query_rows(qrows)
        for r in qrows:
            if r.get("reason") in ("HARD_POSITIVE", "HARD_NEGATIVE", "ROLE_INVERSION", "AMBIGUOUS_NOT_SUPERVISED"):
                rows.append(r)
                stats[r["reason"]] += 1
                if r["reason"] == "ROLE_INVERSION":
                    inversion_examples.append({"query": r["query"], "wrongCompany": r["companyName"],
                                               "wrongGrade3": r["v3"]["grade"], "matchedRoleBehindRank": r.get("inversionBefore")})
            elif r.get("reason") == "CORRECT":
                stats["correct_rows"] += 1

    # ---- search log channel (§30: CANDIDATE only, never auto-truth) ----
    log_rows = 0
    if SEARCH_LOG.exists():
        for line in SEARCH_LOG.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            run = json.loads(line)
            query = run["query"]["raw"]
            intent = parse_intent(query)
            for cand in run.get("candidates", [])[:200]:
                code = cand["code"]
                rec = enrichment.get(code)
                det_grade, _ = (None, "") if code in AMBIGUOUS_CODES else grade_caps(intent, company_caps(rec))
                rer = cand.get("reranker") or {}
                rank = cand.get("rank")
                grade = rer.get("grade")
                anomalous = (det_grade is not None and det_grade <= 1 and (grade or 0) >= 2) or \
                            (det_grade is not None and det_grade >= 2 and (grade or 0) <= det_grade - 2)
                if det_grade is not None and anomalous:
                    rows.append(queue_row(
                        query, intent.to_dict(), code, companies.get(code, {}).get("name", ""),
                        record_profile_summary(rec),
                        {"rank": rank, "bm25": (cand.get("retrieval") or {}).get("bm25Score"),
                         "vector": (cand.get("retrieval") or {}).get("vectorScore"),
                         "rrf": (cand.get("retrieval") or {}).get("rrfScore")},
                        # log grades are ints 0-3; log score is grade/3 — store 0-3 everywhere
                        round((rer or {}).get("score", 0) * 3, 2), rank, det_grade,
                        "HARD_POSITIVE" if det_grade >= 2 else "HARD_NEGATIVE",
                        sorted({e for c in company_caps(rec) for e in (c.get("evidenceIds") or [])})[:12],
                        "search_log"))
                    stats[f"log:{'HARD_POSITIVE' if det_grade >= 2 else 'HARD_NEGATIVE'}"] += 1
                    log_rows += 1
                elif det_grade is None and (grade or 0) >= 2 and rank and rank <= 10:
                    # strong V3 claim we cannot confirm from facts — kept, never trained (§30)
                    rows.append(queue_row(
                        query, intent.to_dict(), code, companies.get(code, {}).get("name", ""),
                        record_profile_summary(rec),
                        {"rank": rank, "bm25": (cand.get("retrieval") or {}).get("bm25Score"),
                         "vector": (cand.get("retrieval") or {}).get("vectorScore"),
                         "rrf": (cand.get("retrieval") or {}).get("rrfScore")},
                        (rer or {}).get("score"), rank, None, "CANDIDATE_UNVERIFIED", [],
                        "search_log", ambiguous=code in AMBIGUOUS_CODES, needs_validation=True))
                    stats["log:CANDIDATE_UNVERIFIED"] += 1
                    log_rows += 1

    rows.sort(key=lambda r: (r["origin"], r["query"], r["reason"], r["companyCode"]))
    # same real query searched repeatedly (or covered by both pool and log) → keep
    # one row per (query, code, reason); origin sort order makes stage3 pools win
    seen: set[tuple] = set()
    deduped = []
    for r in rows:
        key = (r["query"], r["companyCode"], r["reason"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    rows = deduped
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    summary = {
        "checkpoint": "models/a-share-laya-v3/checkpoint_best (419daa881b727083)",
        "pools": {"stage3_queries": sum(1 for q in pool_queries if q["origin"] == "stage3_benchmark"),
                  "focus_queries": sum(1 for q in pool_queries if q["origin"] == "stage3.1_focus_pool")},
        "queue_rows": len(rows),
        "stats": dict(sorted(stats.items())),
        "role_inversions": len(inversion_examples),
        "inversion_examples": inversion_examples[:20],
    }
    (ROOT / "data/train/v4_mining_stats.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    if args.failures_report:
        offender = Counter(r["companyCode"] for r in rows if r["reason"] in ("HARD_POSITIVE", "HARD_NEGATIVE", "ROLE_INVERSION"))
        failures = {
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "checkpoint": summary["checkpoint"],
            "strong_retrieval_low_rerank": [
                {"query": r["query"], "code": r["companyCode"], "name": r["companyName"],
                 "v3Grade": r["v3"]["grade"], "targetGrade": r["targetGrade"]}
                for r in rows if r["reason"] == "HARD_POSITIVE"][:200],
            "hard_negative_false_high": [
                {"query": r["query"], "code": r["companyCode"], "name": r["companyName"],
                 "v3Grade": r["v3"]["grade"], "targetGrade": r["targetGrade"]}
                for r in rows if r["reason"] == "HARD_NEGATIVE"],
            "role_inversion": summary["inversion_examples"],
            "repeat_offenders": [
                {"code": code, "name": companies.get(code, {}).get("name", code), "occurrences": n}
                for code, n in offender.most_common(15) if n >= 3],
            "exclusion_anomaly": [
                {"query": r["query"], "code": r["companyCode"], "name": r["companyName"],
                 "v3Grade": r["v3"]["grade"]}
                for r in rows if r["reason"] == "HARD_NEGATIVE" and r["targetGrade"] == 0],
        }
        Path(args.failures_report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.failures_report).write_text(json.dumps(failures, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"failures report -> {args.failures_report}", flush=True)
    print(json.dumps({k: v for k, v in summary.items() if k != "inversion_examples"}, ensure_ascii=False, indent=1), flush=True)


if __name__ == "__main__":
    main()
