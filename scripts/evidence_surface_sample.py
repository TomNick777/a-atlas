"""Evidence Surface Expansion — deterministic pilot sample (Phase 3.7).

从 data/companies.json 全池（唯一 authority）按申万一级行业 + 交易所分层抽
40 家 pilot 公司。分层维度只有行业/交易所/代码序——固定种子、排序后抽样，
与任何 benchmark 锚点无关（§17：production/pilot 机制不得知道 benchmark 公司）。

产物 reports/EVIDENCE_SURFACE_EXPANSION/pilot_sample.json：
  {seed, generatedAt, strata, companies: [{code, name, exchange, swIndustry}]}
决定性：同输入重跑逐字节一致（除 generatedAt）。

Usage: python scripts/evidence_surface_sample.py
"""
from __future__ import annotations

import json
import random
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "reports" / "EVIDENCE_SURFACE_EXPANSION" / "pilot_sample.json"
SEED = 20260930
TOTAL = 40
BJ_QUOTA = 5


def main() -> None:
    data = json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))
    companies = data["companies"]
    by_sw: dict[str, list[dict]] = defaultdict(list)
    for c in companies:
        by_sw[c.get("swLevel1Industry") or "unknown"].append(c)

    # 主体：按申万一级行业轮转抽取（行业多者先抽），每轮一个行业取一家；
    # BJ 单独配额 5 家（北交所渠道单测）；种子固定 → 可复现。
    rng = random.Random(SEED)
    ordered_sws = sorted(by_sw, key=lambda sw: (-len(by_sw[sw]), sw))
    pools = {sw: sorted((c["code"] for c in by_sw[sw]), key=str) for sw in ordered_sws}
    picked: list[str] = []
    bj_pool = [c for sw in ordered_sws for c in pools[sw] if c.startswith("9")]
    other_pools = {sw: [c for c in codes if not c.startswith("9")] for sw, codes in pools.items()}
    bj_ordered = sorted(bj_pool, key=str)
    bj_pick = rng.sample(bj_ordered, BJ_QUOTA)
    picked.extend(bj_pick)
    round_index = 0
    while len(picked) < TOTAL:
        progressed = False
        for sw in ordered_sws:
            if len(picked) >= TOTAL:
                break
            pool = other_pools.get(sw) or []
            if round_index < len(pool):
                # 行业层内以固定种子抽第 round_index 家（洗牌后按序取，稳定可复现）
                if round_index == 0:
                    rng.shuffle(pool)
                    other_pools[sw] = pool
                picked.append(pool[round_index])
                progressed = True
        if not progressed:
            break
        round_index += 1
    picked = sorted(set(picked))[:TOTAL]
    by_code = {c["code"]: c for c in companies}
    rows = [
        {"code": code, "name": by_code[code]["name"], "exchange": by_code[code]["exchange"],
         "swIndustry": by_code[code].get("swLevel1Industry") or "unknown"}
        for code in picked
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(
        {"seed": SEED, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
         "pool": len(companies), "sample": len(rows), "companies": rows},
        ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"pilot sample: {len(rows)} companies -> {OUT}")
    for sw in sorted({r["swIndustry"] for r in rows}):
        n = sum(1 for r in rows if r["swIndustry"] == sw)
        print(f"  {sw}: {n}")


if __name__ == "__main__":
    main()
