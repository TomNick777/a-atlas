"""V3 ranking benchmark: rerank frozen candidate pools through the sidecar, score metrics.

Same wire shape as production (state + score/noul questions in chunks); candidates come
from data/eval/v3_ranking_candidates.json (QuerySpec + profile retrieval, Top200).
Ground truth: data/eval/v3_search_benchmark.jsonl (graded rules, teacher-reviewed).

Modes (run twice for the A/B):
  --mode score  V3 reranker: rank by score-head expected grade (0-3)
  --mode noul   V2 judge as reranker: rank by noul P(yes) on the same pool

Metrics: P@5/10/20 (label>=2), nDCG@10/20 (gain 2^label-1, label>=2 relevant),
MRR (first label>=2), ExclViolation@20 (top20 hits on known_excludes),
HardNeg@10 rate (top10 hits on label-1 沾边 rows / 10).

Usage:
  .venv/Scripts/python.exe -u scripts/eval_ranking_v3.py --mode noul \
    --sidecar-url http://127.0.0.1:8787 --out reports/acceptance/ranking_v2_rerank.json
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

HOW = (
    "looking_for 是一个人用自己的话说想找的公司。"
    "每一题是一家候选公司，profile 是它的公开业务资料。"
    "判断这家公司的主营业务是否就是这句话在找的东西。"
    "概念标签沾边但主营无关，回答要低。"
    "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。"
    "几家公司可以同时符合。"
)
NOUL_QUESTION = "company 是否符合 looking_for 要找的公司？"
SCORE_QUESTION = "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。"
SCORE_LEVELS = [
    "0=无关:主营业务与查询要找的无关",
    "1=沾边:概念/名字/大类相邻,主营业务并不符合",
    "2=部分相关:产业链上下游,或组合条件只满足一半",
    "3=直接相关:主营业务就是查询要找的东西",
]
YES = "主营业务就是这句话在找的，地域等硬条件也对得上。"
NO = "只是概念沾边、名字像、或者属于这句话明确排除的那一类。"
CHUNK = 100


def ask(sid: str, url: str, query: str, part: list[dict], mode: str) -> dict[str, float]:
    questions = {}
    for i, c in enumerate(part):
        instructions = {
            "company": {"name": c["name"], "code": c["code"], "profile": c["profileText"]},
            "question": SCORE_QUESTION if mode == "score" else NOUL_QUESTION,
        }
        if mode != "score":
            instructions["yes"] = YES
            instructions["no"] = NO
        questions[f"c{i}"] = {"type": "score" if mode == "score" else "noul", "instructions": instructions, **({"criteria": SCORE_LEVELS} if mode == "score" else {})}
    body = json.dumps({"state": {"looking_for": query[:300], "how_to_judge": HOW}, "questions": questions}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{url}/v1/systemone", data=body, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as resp:
        out = json.loads(resp.read())
    result = {}
    for i, c in enumerate(part):
        answer = out["answers"].get(f"c{i}")
        if answer is None:
            continue
        if mode == "score":
            if "score" in answer:
                result[c["code"]] = float(answer["score"])
        else:
            if "noul" in answer:
                result[c["code"]] = float(answer["noul"])
    return result


def dcg(gains: list[float], k: int) -> float:
    return sum(g / math.log2(pos + 2) for pos, g in enumerate(gains[:k]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("score", "noul"), required=True)
    parser.add_argument("--sidecar-url", default="http://127.0.0.1:8787")
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--candidates",
        default="data/eval/v3_ranking_candidates.json",
        help="frozen candidate pools (V1 baseline file by default; V2 file for the profile A/B)",
    )
    parser.add_argument(
        "--profiles",
        default="data/search_profiles.json",
        help="profile file the score-mode profileText reads from (pair with --candidates edition)",
    )
    args = parser.parse_args()

    companies = {c["code"]: c for c in json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / args.profiles).read_text(encoding="utf-8"))
    candidates_doc = json.loads((ROOT / args.candidates).read_text(encoding="utf-8"))
    truth = {json.loads(l)["query_id"]: json.loads(l) for l in (ROOT / "data" / "eval" / "v3_search_benchmark.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()}

    health = json.loads(urllib.request.urlopen(f"{args.sidecar_url}/health", timeout=10).read())
    print(f"sidecar: {health}")

    # acceptance queries (Q01-Q20) have no internal truth rows; map to their EV twin
    acceptance_to_ev = {}
    for qid, row in truth.items():
        if row.get("benchmark") == "ranking":
            acceptance_to_ev[row["query"]] = qid

    per_query = []
    started = time.time()
    for qrow in candidates_doc["queries"]:
        qid, query = qrow["query_id"], qrow["query"]
        truth_id = qid if qid in truth else acceptance_to_ev.get(query)
        t = truth.get(truth_id) if truth_id else None
        rel = {r["code"] for r in (t["relevant3"] + t["relevant2"])} if t else set()
        rel3 = {r["code"] for r in t["relevant3"]} if t else set()
        hard1 = {r["code"] for r in t["hard1"]} if t else set()
        hard1 |= {r["code"] for r in t.get("known_hard_negatives", [])} if t else set()
        excludes = {r["code"] for r in t.get("known_excludes", [])} if t else set()

        part_companies = []
        for cand in qrow["candidates"]:
            c = companies[cand["code"]]
            # V2 (noul) trained on judgeText; V3 (score) on searchProfile searchText
            profile = c["judgeText"] if args.mode == "noul" else (profiles.get(c["code"], {}).get("searchText") or c["judgeText"])
            part_companies.append({"code": c["code"], "name": c["name"], "profileText": profile})

        scores: dict[str, float] = {}
        for at in range(0, len(part_companies), CHUNK):
            scores.update(ask(qid, args.sidecar_url, query, part_companies[at : at + CHUNK], args.mode))

        # rank: score desc, tie -> retrieval order
        ordered = [c for c in part_companies if c["code"] in scores]
        ordered.sort(key=lambda c: -scores[c["code"]])
        top20 = ordered[:20]
        labels = {r["code"]: 3 for r in t["relevant3"]} | {r["code"]: 2 for r in t["relevant2"]} | {r["code"]: 1 for r in t["hard1"]} if t else {}

        def lbl(code: str) -> int:
            return labels.get(code, 0)

        p = {k: (sum(1 for c in top20[:k] if lbl(c["code"]) >= 2) / k if t else None) for k in (5, 10, 20)}
        gains = [2 ** lbl(c["code"]) - 1 if lbl(c["code"]) >= 1 else 0.0 for c in top20]
        ideal = sorted((2 ** l - 1 for l in labels.values() if l >= 1), reverse=True)
        ndcg10 = dcg(gains, 10) / dcg(ideal, 10) if t and dcg(ideal, 10) > 0 else None
        ndcg20 = dcg(gains, 20) / dcg(ideal, 20) if t and dcg(ideal, 20) > 0 else None
        first_rel = next((i + 1 for i, c in enumerate(top20) if lbl(c["code"]) >= 2), None)
        mrr = 1.0 / first_rel if first_rel and t else None
        excl_v = sum(1 for c in top20 if c["code"] in excludes) if t else None
        hardneg_rate = (sum(1 for c in top20[:10] if c["code"] in hard1) / 10) if t else None
        r20 = (sum(1 for c in top20 if c["code"] in rel) / max(1, len(rel))) if t and rel else None
        r3_20 = (sum(1 for c in top20 if c["code"] in rel3) / max(1, len(rel3))) if t and rel3 else None

        per_query.append(
            {
                "query_id": qid,
                "query": query,
                "truth_id": truth_id,
                "has_truth": t is not None,
                "p@5": p[5], "p@10": p[10], "p@20": p[20],
                "ndcg@10": ndcg10, "ndcg@20": ndcg20,
                "mrr": mrr,
                "recall3@20": r3_20, "recallrel@20": r20,
                "excl_violation@20": excl_v,
                "hardneg@10_rate": hardneg_rate,
                "top20": [{"rank": i + 1, "code": c["code"], "name": c["name"], "score": scores.get(c["code"]), "label": lbl(c["code"]) if t else None} for i, c in enumerate(top20)],
            }
        )
        if t:
            print(f"{qid:<30} P@10={p[10]:.2f} nDCG@10={ndcg10:.3f} exclV={excl_v} | {query[:26]}")
        else:
            print(f"{qid:<30} (no internal truth) | {query[:30]}")

    have = [q for q in per_query if q["has_truth"]]
    def avg(key):
        vals = [q[key] for q in have if q[key] is not None]
        return round(sum(vals) / len(vals), 4) if vals else None

    summary = {
        "mode": args.mode,
        "sidecar": health,
        "elapsed_s": round(time.time() - started, 1),
        "n_queries": len(per_query),
        "n_scored_with_truth": len(have),
        "P@5": avg("p@5"), "P@10": avg("p@10"), "P@20": avg("p@20"),
        "nDCG@10": avg("ndcg@10"), "nDCG@20": avg("ndcg@20"),
        "MRR": avg("mrr"),
        "Recall3@20": avg("recall3@20"),
        "ExclViolation@20_avg": avg("excl_violation@20"),
        "HardNeg@10_rate": avg("hardneg@10_rate"),
        "queries_with_excl_violation": sum(1 for q in have if (q["excl_violation@20"] or 0) > 0),
    }
    (ROOT / args.out).parent.mkdir(parents=True, exist_ok=True)
    (ROOT / args.out).write_text(json.dumps({"summary": summary, "queries": per_query}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
