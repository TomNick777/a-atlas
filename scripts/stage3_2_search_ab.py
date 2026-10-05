"""Stage 3.2 搜索 A/B 打分(规格第二十六/二十七/二十八节)。

同一 V4.1 sidecar(production checkpoint 2742affc3f677d71,全程不动),对两臂
冻结候选池分别打分 —— 唯一变量是 Search Profile(Stage 3.1 vs Stage 3.2):

  .venv/Scripts/python.exe -u scripts/stage3_2_search_ab.py --arm 31 \
    --sidecar-url http://127.0.0.1:8787 --out reports/acceptance/stage3_2_ranking_31.json
  ... --arm 32 --out reports/acceptance/stage3_2_ranking_32.json

题集:data/eval/stage3_2_ranking_candidates_<arm>.json(87 题基准 + 10 聚焦题)。
真值:87 题来自 data/eval/stage3_semiconductor_benchmark.jsonl;聚焦题 rel3
内嵌在池文件里(由已核实的 DIRECT_COMPANY_CAPABILITY 数据标注)。
聚焦题额外跟踪三家修复公司的 rank 移动(§27 验收观察)。
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
TRACK_CODES = {"688361": "中科飞测", "688809": "强一股份", "688371": "菲沃泰"}


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
    parser.add_argument("--arm", choices=("31", "32"), required=True)
    parser.add_argument("--sidecar-url", default="http://127.0.0.1:8787")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    companies = {c["code"]: c for c in json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles_path = ROOT / ("data/eval/snapshot_stage3_1/search_profiles_v3.json" if args.arm == "31" else "data/search_profiles_v3.json")
    profiles = json.loads(profiles_path.read_text(encoding="utf-8"))
    candidates_doc = json.loads((ROOT / f"data/eval/stage3_2_ranking_candidates_{args.arm}.json").read_text(encoding="utf-8"))
    truth = {}
    for line in (ROOT / "data/eval/stage3_semiconductor_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            truth[row["query_id"]] = row

    health = json.loads(urllib.request.urlopen(f"{args.sidecar_url}/health", timeout=10).read())
    print(f"sidecar: {json.dumps(health)[:160]}  arm={args.arm}")

    per_query = []
    started = time.time()
    for qrow in candidates_doc["queries"]:
        qid, query, family = qrow["query_id"], qrow["query"], qrow["family"]
        if qid in truth:
            t = truth[qid]
            rel3 = {r["code"] for r in t["relevant3"]}
            rel2 = {r["code"] for r in t.get("relevant2", [])}
        else:
            rel3 = set(qrow.get("relevant3") or [])
            rel2 = set()
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

        # §27 修复公司 rank 跟踪(池内 rank,score 排序后)
        tracked = {}
        rank_map = {c["code"]: i + 1 for i, c in enumerate(ordered)}
        for code, name in TRACK_CODES.items():
            if code in rank_map and (code in rel3 or any(code in {x for x in rel2} for _ in [0]) or code in rank_map):
                tracked[name] = {"poolRank": rank_map[code], "score": scores.get(code)}
        focus_tracked = tracked if family == "focus" else {}

        per_query.append({
            "query_id": qid, "query": query, "family": family,
            "p@5": p[5], "p@10": p[10], "p@20": p[20],
            "ndcg@10": ndcg10, "ndcg@20": ndcg20, "mrr": mrr,
            "recall3@20": r3_20, "recall3@200": r3_200,
            "tracked": focus_tracked,
            "top10": [{"rank": i + 1, "code": c["code"], "name": c["name"], "score": scores.get(c["code"]), "label": lbl(c["code"])} for i, c in enumerate(ordered[:10])],
        })
        mark = "FOCUS" if family == "focus" else "    "
        print(f"{mark} {qid:<26} P@10={p[10]:.2f} nDCG@20={ndcg20:.3f} R3@200={r3_200:.2f} | {query[:24]}")

    def avg(key: str, rows) -> float:
        vals = [q[key] for q in rows]
        return sum(vals) / len(vals) if vals else 0.0

    bench_rows = [q for q in per_query if q["family"] not in ("focus", "real")]
    focus_rows = [q for q in per_query if q["family"] in ("focus", "real")]
    summary = {
        "arm": args.arm,
        "sidecar": health,
        "profiles": str(profiles_path.relative_to(ROOT)),
        "elapsedSec": round(time.time() - started, 1),
        "benchmark87": {
            "p@5": avg("p@5", bench_rows), "p@10": avg("p@10", bench_rows), "p@20": avg("p@20", bench_rows),
            "ndcg@10": avg("ndcg@10", bench_rows), "ndcg@20": avg("ndcg@20", bench_rows),
            "mrr": avg("mrr", bench_rows),
            "recall3@20": avg("recall3@20", bench_rows), "recall3@200": avg("recall3@200", bench_rows),
        },
        "focus10": {
            "p@5": avg("p@5", focus_rows), "p@10": avg("p@10", focus_rows), "p@20": avg("p@20", focus_rows),
            "ndcg@20": avg("ndcg@20", focus_rows), "mrr": avg("mrr", focus_rows),
            "recall3@20": avg("recall3@20", focus_rows),
        },
    }
    out = {"summary": summary, "per_query": per_query}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
