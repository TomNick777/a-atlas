"""Stage 3 ranking A/B: score frozen candidate pools through the SAME Laya V3 sidecar.

规格第二十/二十三节:同一 checkpoint、同一 QuerySpec/RRF 候选池,唯一变量是
profile 底文(v2 vs v2+Stage3)。对每个 edition 各跑一次:

  .venv/Scripts/python.exe -u scripts/stage3_ranking_ab.py --edition v2 \
    --sidecar-url http://127.0.0.1:8787 --out reports/acceptance/stage3_ranking_v2.json
  ... --edition v3 --out reports/acceptance/stage3_ranking_v3.json

Truth: data/eval/stage3_semiconductor_benchmark.jsonl (rel3/rel2/negativeWatch)。
Stage 3 专属指标:
  ProcessAccuracy@20   = P@20 over process_word families (rel3 命中占比)
  ProcessSpecificRecall@20 = R@20(rel3) over specific-process families
  Confusion@20         = Top20 中 negativeWatch 命中数,按 reason 分组聚合
"""

from __future__ import annotations

import argparse
import json
import math
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
SCORE_QUESTION = "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。"
SCORE_LEVELS = [
    "0=无关:主营业务与查询要找的无关",
    "1=沾边:概念/名字/大类相邻,主营业务并不符合",
    "2=部分相关:产业链上下游,或组合条件只满足一半",
    "3=直接相关:主营业务就是查询要找的东西",
]
CHUNK = 100
SPECIFIC_FAMILIES_PREFIX = ("S3-ETCH-CCP", "S3-DEP-ALD", "S3-DEP-MOCVD", "S3-CLEAN", "S3-TRACK", "S3-IMPLANT")


def ask(url: str, query: str, part: list[dict]) -> dict[str, float]:
    questions = {}
    for i, c in enumerate(part):
        questions[f"c{i}"] = {
            "type": "score",
            "instructions": {
                "company": {"name": c["name"], "code": c["code"], "profile": c["profileText"]},
                "question": SCORE_QUESTION,
            },
            "criteria": SCORE_LEVELS,
        }
    body = json.dumps({"state": {"looking_for": query[:300], "how_to_judge": HOW}, "questions": questions}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{url}/v1/systemone", data=body, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=300) as resp:
        out = json.loads(resp.read())
    scores = {}
    for i, c in enumerate(part):
        answer = out["answers"].get(f"c{i}")
        if answer is not None and "score" in answer:
            scores[c["code"]] = float(answer["score"])
    return scores


def dcg(gains: list[float], k: int) -> float:
    return sum(g / math.log2(pos + 2) for pos, g in enumerate(gains[:k]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--edition", choices=("v2", "v3"), required=True)
    parser.add_argument("--sidecar-url", default="http://127.0.0.1:8787")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    companies = {c["code"]: c for c in json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / f"data/search_profiles_{args.edition}.json").read_text(encoding="utf-8"))
    candidates_doc = json.loads((ROOT / f"data/eval/stage3_ranking_candidates_{args.edition}.json").read_text(encoding="utf-8"))
    truth = {}
    for line in (ROOT / "data/eval/stage3_semiconductor_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            truth[row["query_id"]] = row

    health = json.loads(urllib.request.urlopen(f"{args.sidecar_url}/health", timeout=10).read())
    print(f"sidecar: {json.dumps(health)[:160]}")

    per_query = []
    confusion_totals: dict[str, int] = {}
    started = time.time()
    for qrow in candidates_doc["queries"]:
        qid, query, family = qrow["query_id"], qrow["query"], qrow["family"]
        t = truth.get(qid)
        if not t:
            continue
        rel3 = {r["code"] for r in t["relevant3"]}
        rel2 = {r["code"] for r in t.get("relevant2", [])}
        neg = {r["code"]: r["reason"] for r in t.get("negativeWatch", [])}
        labels = {**{c: 3 for c in rel3}, **{c: 2 for c in rel2}}

        part_companies = []
        for cand in qrow["candidates"]:
            c = companies[cand["code"]]
            profile = profiles.get(c["code"], {}).get("searchText") or c["judgeText"]
            part_companies.append({"code": c["code"], "name": c["name"], "profileText": profile})

        scores: dict[str, float] = {}
        for at in range(0, len(part_companies), CHUNK):
            scores.update(ask(args.sidecar_url, query, part_companies[at : at + CHUNK]))

        ordered = [c for c in part_companies if c["code"] in scores]
        ordered.sort(key=lambda c: -scores[c["code"]])
        top20 = ordered[:20]

        def lbl(code: str) -> int:
            return labels.get(code, 0)

        p = {k: sum(1 for c in top20[:k] if lbl(c["code"]) >= 2) / k for k in (5, 10, 20)}
        gains = [2 ** lbl(c["code"]) - 1 if lbl(c["code"]) >= 1 else 0.0 for c in top20]
        ideal = sorted((2 ** l - 1 for l in labels.values() if l >= 1), reverse=True)
        ndcg10 = dcg(gains, 10) / dcg(ideal, 10) if dcg(ideal, 10) > 0 else 0.0
        ndcg20 = dcg(gains, 20) / dcg(ideal, 20) if dcg(ideal, 20) > 0 else 0.0
        first_rel = next((i + 1 for i, c in enumerate(top20) if lbl(c["code"]) >= 2), None)
        mrr = 1.0 / first_rel if first_rel else 0.0
        r3_20 = sum(1 for c in top20 if c["code"] in rel3) / max(1, len(rel3))
        r3_200 = sum(1 for c in ordered if c["code"] in rel3) / max(1, len(rel3))
        confusion = {}
        for c in top20:
            reason = neg.get(c["code"])
            if reason:
                confusion[reason] = confusion.get(reason, 0) + 1
                confusion_totals[reason] = confusion_totals.get(reason, 0) + 1

        per_query.append({
            "query_id": qid, "query": query, "family": family,
            "p@5": p[5], "p@10": p[10], "p@20": p[20],
            "ndcg@10": ndcg10, "ndcg@20": ndcg20, "mrr": mrr,
            "recall3@20": r3_20, "recall3@200": r3_200,
            "confusion@20": confusion,
            "top20": [{"rank": i + 1, "code": c["code"], "name": c["name"], "score": scores.get(c["code"]), "label": lbl(c["code"])} for i, c in enumerate(top20)],
        })
        print(f"{qid:<26} P@10={p[10]:.2f} nDCG@10={ndcg10:.3f} R3@20={r3_20:.2f} conf={sum(confusion.values())} | {query[:24]}")

    def avg(key: str, rows=None) -> float:
        vals = [q[key] for q in (rows or per_query)]
        return round(sum(vals) / max(1, len(vals)), 4)

    process_rows = [q for q in per_query if truth[q["query_id"]]["category"] == "process_word"]
    specific_rows = [q for q in per_query if any(q["family"].startswith(p) for p in SPECIFIC_FAMILIES_PREFIX)]
    summary = {
        "edition": args.edition,
        "sidecar": health,
        "elapsed_s": round(time.time() - started, 1),
        "n_queries": len(per_query),
        "P@5": avg("p@5"), "P@10": avg("p@10"), "P@20": avg("p@20"),
        "nDCG@10": avg("ndcg@10"), "nDCG@20": avg("ndcg@20"),
        "MRR": avg("mrr"),
        "Recall3@20": avg("recall3@20"), "Recall3@200": avg("recall3@200"),
        "ProcessAccuracy@20": avg("p@20", process_rows),
        "ProcessSpecificRecall@20": avg("recall3@20", specific_rows),
        "Confusion@20_byReason": confusion_totals,
        "Confusion@20_avgPerQuery": round(sum(confusion_totals.values()) / max(1, len(per_query)), 4),
    }
    out_path = ROOT / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"summary": summary, "per_query": per_query}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
