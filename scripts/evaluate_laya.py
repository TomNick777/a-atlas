"""Evaluate a Laya checkpoint on the frozen A-share benchmark.

Mirrors lib/jev/judge.ts exactly: state = {looking_for, how_to_judge}, one noul
question per company with the same instructions block, judgeText as profile.
Reports pooled and per-category binary metrics (relevant = label >= 2), ranking
quality against the ordinal 0-3 labels, calibration, and FP/FN exemplars.

Usage:
  .venv/Scripts/python scripts/evaluate_laya.py --checkpoint multilingual \
      --eval data/eval/a_share_laya_eval.jsonl --report reports/laya_baseline
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
ROOT = Path(__file__).resolve().parents[1]

# Same judge instructions as lib/jev/judge.ts.
HOW = (
    "looking_for 是一个人用自己的话说想找的公司。"
    "每一题是一家候选公司，profile 是它的公开业务资料。"
    "判断这家公司的主营业务是否就是这句话在找的东西。"
    "概念标签沾边但主营无关，回答要低。"
    "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。"
    "几家公司可以同时符合。"
)


def sidecar_ins(question: dict) -> dict:
    """Mirror scripts/laya_server.py: pre-serialize instructions with
    ensure_ascii=False so evaluation sees exactly what the sidecar feeds the model
    (Agent._to_internal keeps string instructions as-is)."""
    ins = question.get("instructions")
    if isinstance(ins, dict):
        return {**question, "instructions": json.dumps(ins, ensure_ascii=False)}
    return question


def auc(pairs: list[tuple[int, float]]) -> float:
    pos = [p for label, p in pairs if label == 1]
    neg = [p for label, p in pairs if label == 0]
    if not pos or not neg:
        return float("nan")
    wins = sum(1 for a in pos for b in neg if a > b) + 0.5 * sum(1 for a in pos for b in neg if a == b)
    return wins / (len(pos) * len(neg))


def average_precision(pairs: list[tuple[int, float]]) -> float:
    rows = sorted(pairs, key=lambda t: -t[1])
    total_pos = sum(label for label, _ in pairs)
    if not total_pos:
        return float("nan")
    hits, prec = 0, 0.0
    for i, (label, _) in enumerate(rows, 1):
        if label:
            hits += 1
            prec += hits / i
    return prec / total_pos


def ece(conf: list[float], correct: list[int], bins: int = 15) -> float:
    if not conf:
        return float("nan")
    total = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [i for i in range(len(conf)) if (lo < conf[i] <= hi) or (b == 0 and conf[i] == 0)]
        if sel:
            total += (len(sel) / len(conf)) * abs(sum(conf[i] for i in sel) / len(sel) - sum(correct[i] for i in sel) / len(sel))
    return total


def spearman(xs: list[float], ys: list[float]) -> float:
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for at, i in enumerate(order):
            r[i] = at
        return r

    rx, ry = rank(xs), rank(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else float("nan")


def load_checkpoint(name: str, device: str):
    import laya

    built_in = {"english": ("convaiinnovations/laya", None), "multilingual": ("convaiinnovations/laya", "multilingual"), "typed-decisions": ("convaiinnovations/laya", "typed-decisions")}
    if name in built_in:
        repo, sub = built_in[name]
        agent = laya.load(repo, subfolder=sub, device=device)
    else:
        agent = laya.load(name, device=device)  # local path (fine-tuned)
    # Production sidecar settings (see scripts/laya_server.py).
    agent.cfg["max_len"] = 2048
    agent.cfg["head_max_len"] = 512
    return agent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", default="multilingual")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--eval", default="data/eval/a_share_laya_eval.jsonl")
    parser.add_argument("--report", default=None, help="write <report>.md and <report>.json")
    parser.add_argument("--dump", default=None, help="write every scored row (query, code, prob, label) for error analysis")
    parser.add_argument("--limit", type=int, default=0, help="only first N queries (smoke)")
    args = parser.parse_args()

    rows = [json.loads(line) for line in (ROOT / args.eval).read_text(encoding="utf-8").splitlines() if line.strip()]
    by_query: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_query[r["query_id"]].append(r)

    agent = load_checkpoint(args.checkpoint, args.device)
    print(f"checkpoint={args.checkpoint} device={agent.device} queries={len(by_query)} rows={len(rows)}", flush=True)

    preds: dict[tuple[str, str], float] = {}
    started = time.time()
    for qi, (qid, group) in enumerate(sorted(by_query.items())):
        query = group[0]["query"]
        state = {"looking_for": query[:300], "how_to_judge": HOW}
        questions = {
            f"c{i}": sidecar_ins(
                {
                    "type": "noul",
                    "instructions": {
                        "company": {"name": r["name"], "code": r["code"], "profile": r["judgeText"]},
                        "question": "company 是否符合 looking_for 要找的公司？",
                        "yes": "主营业务就是这句话在找的，地域等硬条件也对得上。",
                        "no": "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
                    },
                }
            )
            for i, r in enumerate(group)
        }
        out = agent.predict(state, questions)
        for i, r in enumerate(group):
            preds[(qid, r["code"])] = float(out["answers"][f"c{i}"]["noul"])
        if (qi + 1) % 10 == 0:
            print(f"  {qi + 1}/{len(by_query)} queries in {time.time() - started:.0f}s", flush=True)

    scored = []
    for r in rows:
        p = preds[(r["query_id"], r["code"])]
        scored.append({**r, "prob": p, "relevant": int(r["label"] >= 2)})

    if args.dump:
        dump_path = ROOT / args.dump
        dump_path.parent.mkdir(parents=True, exist_ok=True)
        dump_path.write_text(
            "\n".join(
                json.dumps({k: s[k] for k in ("query_id", "family", "category", "query", "code", "name", "label", "relevant", "prob")}, ensure_ascii=False)
                for s in scored
            ),
            encoding="utf-8",
        )
        print(f"dump: {dump_path}")

    def summarize(subset: list[dict]) -> dict:
        pairs = [(s["relevant"], s["prob"]) for s in subset]
        best_f1, best_at = 0.0, 0.5
        for step in range(1, 100):
            at = step / 100
            tp = sum(1 for rel, p in pairs if p >= at and rel)
            fp = sum(1 for rel, p in pairs if p >= at and not rel)
            fn = sum(1 for rel, p in pairs if p < at and rel)
            f1 = 2 * tp / (2 * tp + fp + fn) if tp else 0.0
            if f1 > best_f1:
                best_f1, best_at = f1, at
        out = {}
        for at_name, at in (("050", 0.5), ("030", 0.3), ("best", best_at)):
            tp = sum(1 for rel, p in pairs if p >= at and rel)
            fp = sum(1 for rel, p in pairs if p >= at and not rel)
            fn = sum(1 for rel, p in pairs if p < at and rel)
            tn = len(pairs) - tp - fp - fn
            prec = tp / (tp + fp) if tp + fp else float("nan")
            rec = tp / (tp + fn) if tp + fn else float("nan")
            out[at_name] = {
                "threshold": round(at, 2),
                "accuracy": round((tp + tn) / len(pairs), 4),
                "precision": round(prec, 4) if prec == prec else None,
                "recall": round(rec, 4) if rec == rec else None,
                "f1": round(2 * prec * rec / (prec + rec), 4) if prec == prec and rec == rec and prec + rec else None,
                "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            }
        conf = [max(p, 1 - p) for _, p in pairs]
        correct = [int((p >= 0.5) == bool(rel)) for rel, p in pairs]
        out.update(
            {
                "auc": round(auc(pairs), 4),
                "ap": round(average_precision(pairs), 4),
                "n": len(subset),
                "n_relevant": sum(s["relevant"] for s in subset),
                "ece": round(ece(conf, correct), 4),
            }
        )
        # ordinal: prob vs 0-3 label
        out["spearman_label"] = round(spearman([s["prob"] for s in subset], [s["label"] for s in subset]), 4)
        hard = [s["prob"] for s in subset if s["label"] == 1]
        out["mean_prob_level1"] = round(sum(hard) / len(hard), 4) if hard else None
        return out

    overall = summarize(scored)
    categories: dict[str, dict] = {}
    for cat in sorted({s["category"] for s in scored}):
        categories[cat] = summarize([s for s in scored if s["category"] == cat])

    # per-query AUC (ranking within one search)
    per_query_auc = [
        auc([(s["relevant"], s["prob"]) for s in group])
        for group in ({k: [s for s in scored if s["query_id"] == k] for k in {s["query_id"] for s in scored}}).values()
        if len({s["relevant"] for s in group}) == 2
    ]
    mean_q_auc = sum(per_query_auc) / len(per_query_auc)

    fps = sorted((s for s in scored if not s["relevant"]), key=lambda s: -s["prob"])[:12]
    fns = sorted((s for s in scored if s["relevant"]), key=lambda s: s["prob"])[:12]

    result = {
        "checkpoint": args.checkpoint,
        "eval": args.eval,
        "device": str(agent.device),
        "elapsed_s": round(time.time() - started, 1),
        "overall": overall,
        "mean_per_query_auc": round(mean_q_auc, 4),
        "n_queries_scored_for_auc": len(per_query_auc),
        "categories": categories,
        "false_positives": [{k: s[k] for k in ("query", "code", "name", "label", "prob", "evidence")} for s in fps],
        "false_negatives": [{k: s[k] for k in ("query", "code", "name", "label", "prob", "evidence")} for s in fns],
    }

    if args.report:
        report_path = ROOT / args.report
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.with_suffix(".json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

        o = result["overall"]
        lines = [
            f"# Laya 评测:{args.checkpoint}",
            "",
            f"- benchmark: `{args.eval}`({result['overall']['n']} 行,二值定义:label≥2 为 relevant)",
            f"- device: {result['device']} | 用时 {result['elapsed_s']}s",
            "",
            "## 总体",
            f"- AUC **{o['auc']}** | AP {o['ap']} | 逐查询平均 AUC {result['mean_per_query_auc']}",
            f"- @{o['050']['threshold']}:acc {o['050']['accuracy']} / P {o['050']['precision']} / R {o['050']['recall']} / F1 {o['050']['f1']} (TP {o['050']['tp']} FP {o['050']['fp']} FN {o['050']['fn']})",
            f"- @0.30(生产浮起阈值):acc {o['030']['accuracy']} / P {o['030']['precision']} / R {o['030']['recall']} / F1 {o['030']['f1']}",
            f"- @best({o['best']['threshold']}):acc {o['best']['accuracy']} / P {o['best']['precision']} / R {o['best']['recall']} / F1 {o['best']['f1']}",
            f"- ECE {o['ece']} | Spearman(prob, 0-3 label) {o['spearman_label']} | 沾边类(1)平均分 {o['mean_prob_level1']}",
            "",
            "## 按题型",
            "| 题型 | n | AUC | AP | F1@0.5 | F1@best | 沾边(1)均分 |",
            "| --- | --- | --- | --- | --- | --- | --- |",
        ]
        for cat, c in categories.items():
            lines.append(f"| {cat} | {c['n']} | {c['auc']} | {c['ap']} | {c['050']['f1']} | {c['best']['f1']} | {c['mean_prob_level1']} |")
        lines += ["", "## 典型 false positive(应低分却高分)"]
        for s in fps[:8]:
            lines.append(f"- {s['prob']:.3f} 「{s['query']}」← {s['name']}({s['code']}) 标签{s['label']} | {s['evidence']}")
        lines += ["", "## 典型 false negative(应高分却低分)"]
        for s in fns[:8]:
            lines.append(f"- {s['prob']:.3f} 「{s['query']}」← {s['name']}({s['code']}) 标签{s['label']} | {s['evidence']}")
        report_path.with_suffix(".md").write_text("\n".join(lines), encoding="utf-8")
        print(f"report: {report_path}.md / .json")

    o = result["overall"]
    print(json.dumps({k: o[k] for k in ("auc", "ap", "050", "best", "ece", "spearman_label", "mean_prob_level1")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
