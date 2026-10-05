"""Evidence Surface Expansion — human audit sampling (Phase 3.7 §51).

从 committed facts.jsonl 为两类新 surface 各抽 50 条证据做人工抽查，分层保证
覆盖 spec §51 要求的形态：positive（confirmed）/ negative-hedged（stated/planned）/
sampling / certification / bid / duplicate-adjacent / parse edge（截断窗）。

产物 reports/EVIDENCE_SURFACE_EXPANSION/human_audit/：
  relation_sample.json / product_sample.json   —— 抽样行（含 provenance 反查指针）
  audit_sheet.md                                —— 人审工作表（verdict 列留白）

确定性：固定种子分层抽样，可复现。审计只读，绝不改 facts。

Usage (services venv python):
  python -u scripts/evidence_surface_audit_sample.py
"""
from __future__ import annotations

import json
import random
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FACTS_FILE = ROOT / "data" / "source_facts" / "facts.jsonl"
OUT_DIR = ROOT / "reports" / "EVIDENCE_SURFACE_EXPANSION" / "human_audit"
SEED = 20260930
PER_SURFACE = 50


def load_surface_facts(surface: str) -> list[dict]:
    rows = []
    for line in FACTS_FILE.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row["source"]["sourceType"] == surface:
            rows.append(row)
    return rows


def stratified(rows: list[dict], key_fn, n: int, rng: random.Random) -> list[dict]:
    buckets: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        buckets[key_fn(row)].append(row)
    keys = sorted(buckets)
    picked: list[dict] = []
    # 轮转：每层先各抽 1，再循环补齐到 n（层小则重复轮到，层大随机挑）
    round_i = 0
    while len(picked) < n and any(round_i < len(buckets[k]) for k in keys):
        for k in keys:
            if len(picked) >= n:
                break
            pool = buckets[k]
            if round_i < len(pool):
                picked.append(pool[rng.randrange(len(pool))] if round_i == 0 else pool[round_i])
        round_i += 1
    return picked[:n]


def main() -> None:
    rng = random.Random(SEED)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    ann = load_surface_facts("filing_announcement")
    rel = stratified(ann, lambda r: r["source"]["sourceId"].split("#")[1], min(PER_SURFACE, len(ann)), rng)
    prod = load_surface_facts("official_product_page")
    prd = stratified(prod, lambda r: r["source"]["locator"].split("//", 1)[-1].split("/")[0], min(PER_SURFACE, len(prod)), rng)

    def slim(row: dict) -> dict:
        return {
            "factId": row["factId"],
            "code": row["companyCode"],
            "name": row["companyName"],
            "category": row["source"]["sourceId"].split("#")[-1],
            "date": row["source"].get("date"),
            "locator": row["source"].get("locator"),
            "artifactSha256": row.get("artifactSha256"),
            "retrievedAt": row.get("retrievedAt"),
            "rawText": row["rawText"],
        }

    relation_slim = [slim(r) for r in rel]
    product_slim = [slim(r) for r in prd]
    relation_out = {"seed": SEED, "surfaceTotal": len(ann), "sampled": len(rel), "rows": relation_slim}
    product_out = {"seed": SEED, "surfaceTotal": len(prod), "sampled": len(prd), "rows": product_slim}
    (OUT_DIR / "relation_sample.json").write_text(json.dumps(relation_out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (OUT_DIR / "product_sample.json").write_text(json.dumps(product_out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    lines = [
        "# Evidence Surface Expansion — 人工抽查工作表（§51）",
        "",
        f"生成时间：{time.strftime('%Y-%m-%dT%H:%M:%S%z')}；种子 {SEED}。",
        f"公告关系证据 surface 总量 {len(ann)}，抽样 {len(rel)}；官网产品证据总量 {len(prod)}，抽样 {len(prd)}。",
        "",
        "审读规则：verdict ∈ {accurate(原文确为所述关系/产品能力), wrong_relation(关系类型/方向错),",
        "wrong_strength(强度升级或降级错), noise(样板/无关句), unverifiable(无法反查原文)}。",
        "每条 verdict 后给一句 evidence 备注（可反查 locator 指针）。",
        "",
        "## A. 公告关系证据（逐条人工核对 PDF 原文）",
        "",
    ]
    for i, row in enumerate(relation_slim, 1):
        lines.append(f"### R{i:02d} {row['factId']} {row['name']}（{row['code']}）{row['category']} @ {row['date']}")
        lines.append(f"- locator: {row['locator']}")
        lines.append(f"- 原文: {row['rawText']}")
        lines.append("- verdict: ______")
        lines.append("")
    lines += ["## B. 官网产品证据（逐条人工核对页面快照）", ""]
    for i, row in enumerate(product_slim, 1):
        lines.append(f"### P{i:02d} {row['factId']} {row['name']}（{row['code']}）")
        lines.append(f"- locator: {row['locator']}（snapshot sha {str(row['artifactSha256'])[:16]}…）")
        lines.append(f"- 原文: {row['rawText']}")
        lines.append(f"- verdict: ______")
        lines.append("")
    (OUT_DIR / "audit_sheet.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"relation sample {len(rel)}/{len(ann)}; product sample {len(prd)}/{len(prod)} -> {OUT_DIR}")


if __name__ == "__main__":
    main()
