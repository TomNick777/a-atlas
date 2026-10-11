"""Freeze existing teacher-labelled tasks without relabelling them as corpus facts."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from artifacts import ROOT, private_path, sha, atomic_json

HOW = ("looking_for 是一个人用自己的话说想找的公司。每一题是一家候选公司，profile 是它的公开业务资料。"
       "判断这家公司的主营业务是否就是这句话在找的东西。概念标签沾边但主营无关，回答要低。"
       "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。几家公司可以同时符合。")
LEVELS = ["0=无关:主营业务与查询要找的无关", "1=沾边:概念/名字/大类相邻,主营业务并不符合", "2=部分相关:产业链上下游,或组合条件只满足一半", "3=直接相关:主营业务就是查询要找的东西"]
TARGETS = {3: [0.02, 0.03, 0.15, 0.80], 2: [0.02, 0.13, 0.70, 0.15], 1: [0.10, 0.70, 0.15, 0.05], 0: [0.80, 0.15, 0.03, 0.02]}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    source = (ROOT / args.source).resolve()
    if not any(source.is_relative_to((ROOT / directory).resolve()) for directory in ("data", ".local/merger/legacy/data")):
        raise ValueError("Historical source must be a migrated private snapshot")
    output = private_path(args.out, "data")
    if output.exists():
        raise ValueError("Do not overwrite frozen replay")
    digest = sha(source)
    rows = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.limit:
        rows = rows[:args.limit]
    tasks = []
    for row in rows:
        label = int(row["label"])
        common = {"groupId": row["query_id"], "split": "train", "label": label, "labelSource": "existing-teacher", "historicalTeacher": row.get("teacher"), "historicalGenerationVersion": row.get("generation_version"), "state": {"looking_for": row["query"][:300], "how_to_judge": HOW}, "evidenceRefs": [{"companyId": row["code"], "ref": f"legacy:{digest}:{row['query_id']}:{row['code']}", "text": row["judgeText"]}]}
        company = {"name": row["name"], "code": row["code"], "profile": row["judgeText"]}
        probability = {3: 1.0, 2: 0.5, 1: 0.1, 0: 0.0}[label]
        tasks.append({**common, "label": int(probability >= 0.5), "historicalGrade": label, "capability": "semantic_match", "target": [1 - probability, probability], "question": {"type": "noul", "instructions": {"company": company, "question": "company 是否符合 looking_for 要找的公司？", "yes": "主营业务就是这句话在找的，地域等硬条件也对得上。", "no": "只是概念沾边、名字像、或者属于这句话明确排除的那一类。"}}})
        tasks.append({**common, "capability": "semantic_comparison", "target": TARGETS[label], "question": {"type": "score", "instructions": {"company": company, "question": "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。"}, "criteria": LEVELS}})
    output.mkdir(parents=True)
    manifest = {"schemaVersion": 1, "mode": "legacy", "purpose": "controlled historical engineering replay; never production qualification", "historicalSource": str(source.relative_to(ROOT)), "historicalSourceSha256": digest, "tokenizerModel": "v4.1", "maxLen": 2048, "headMaxLen": 512, "tasks": tasks}
    atomic_json(output / "source.json", manifest)
    (output / "source.sha256").write_text(sha(output / "source.json") + "\n")
    print(json.dumps({"tasks": len(tasks), "historicalSourceSha256": digest, "manifestSha256": sha(output / "source.json")}))

if __name__ == "__main__":
    main()
