"""Source Coverage Pass 1 — Phase 7 coverage scan driver.

对 5567 家全池做「可扩展性调查」：分层随机样本（按交易所等比）抓 Source A
三 feed（不做年报），再跑提取器到临时目录，统计覆盖率/解析成功率/事实类型
分布/特异度分桶。只调查，不扩量、不进 corpus。

Usage:
  python -u scripts/source_coverage_scan.py --sample 220
  python -u scripts/source_coverage_scan.py --report  # 只出统计（抓取已完成时）
"""
from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SCAN_OUT = ROOT / "data" / "raw" / "source_coverage_scan"
FETCH = ROOT / "scripts" / "source_coverage_fetch.py"
EXTRACT = ROOT / "scripts" / "source_coverage_extract_facts.py"


def stratified_sample(n: int) -> list[str]:
    companies = json.loads((ROOT / "data" / "companies.json").read_text(encoding="utf-8"))["companies"]
    by_exchange: dict[str, list[str]] = {}
    for company in companies:
        by_exchange.setdefault(company["exchange"], []).append(company["code"])
    rng = random.Random(0x50DA)  # 固定种子：样本可复现
    sample: list[str] = []
    total = len(companies)
    for exchange, codes in sorted(by_exchange.items()):
        take = round(n * len(codes) / total)
        sample.extend(rng.sample(sorted(codes), take))
    return sorted(set(sample))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=220)
    parser.add_argument("--report", action="store_true", help="skip fetching, stats only")
    args = parser.parse_args()
    SCAN_OUT.mkdir(parents=True, exist_ok=True)

    sample_path = SCAN_OUT / "sample.json"
    if sample_path.exists():
        codes = json.loads(sample_path.read_text(encoding="utf-8"))
    else:
        codes = stratified_sample(args.sample)
        sample_path.write_text(json.dumps(codes, ensure_ascii=False), encoding="utf-8")
    print(f"scan sample: {len(codes)} companies")

    if not args.report:
        batch = 25
        for at in range(0, len(codes), batch):
            chunk = codes[at: at + batch]
            print(f"[{at + 1}..{at + len(chunk)}/{len(codes)}] fetching...", flush=True)
            subprocess.run(
                [sys.executable, "-u", str(FETCH), "--codes", ",".join(chunk), "--skip-annual"],
                check=True,
            )
        # annual-channel spot check: 10 家随机子样本抓年报（PDF 下载+解析成功率）
        rng = random.Random(0x50DA)
        annual_codes = rng.sample(codes, 10)
        (SCAN_OUT / "annual_sample.json").write_text(json.dumps(annual_codes, ensure_ascii=False), encoding="utf-8")
        print(f"annual spot check: {annual_codes}", flush=True)
        subprocess.run(
            [sys.executable, "-u", str(FETCH), "--codes", ",".join(annual_codes)],
            check=True,
        )

    # 提取到 scan 输出目录（不覆盖 pilot facts.jsonl）
    subprocess.run(
        [sys.executable, "-u", str(EXTRACT), "--out", str(SCAN_OUT)],
        check=True,
    )
    print("scan extract done ->", SCAN_OUT)


if __name__ == "__main__":
    main()
