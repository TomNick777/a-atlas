"""Format V3 ranking-eval output into the raw acceptance document for external review.

Input: the JSON produced by eval_ranking_v3.py (mode=score on the V3 checkpoint).
Output: reports/acceptance/LAYA_V3_REAL_SEARCH_ACCEPTANCE_RAW.md — same discipline as
the V2 acceptance file: raw rankings + scores only, no internal relevance verdicts in
the table body; the referee judges independently. Internal metrics live in the JSON.

Usage: .venv/Scripts/python scripts/make_v3_acceptance_md.py <in.json> <out.md>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "reports" / "acceptance" / "ranking_v3_rerank.json"
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "reports" / "acceptance" / "LAYA_V3_REAL_SEARCH_ACCEPTANCE_RAW.md"
    doc = json.loads(src.read_text(encoding="utf-8"))
    meta = doc["summary"]

    lines = [
        "# Laya V3 真实搜索验收 · 原始结果(未评审)",
        "",
        f"- pipeline: QuerySpec 检索(Top{200}候选,含排除硬过滤)→ Laya V3 score 头 graded rerank → Top20",
        f"- sidecar: {meta.get('sidecar', {}).get('model')} on {meta.get('sidecar', {}).get('device')}",
        f"- 用时 {meta['elapsed_s']}s;queries {meta['n_queries']}",
        "",
        "本文件只保存原始输出;相关性判定由外部独立裁判完成。分数为 V3 的 0-3 等级期望值。",
    ]
    for q in doc["queries"]:
        lines += ["", f"# {q['query_id']}", "", f"> {q['query']}", ""]
        lines += ["| Rank | Code | Company | Grade |", "| ---- | ---- | ------- | ----- |"]
        for row in q["top20"]:
            lines.append(f"| {row['rank']} | {row['code']} | {row['name']} | {row['score']:.3f} |")
    dst.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"written {dst}")


if __name__ == "__main__":
    main()
