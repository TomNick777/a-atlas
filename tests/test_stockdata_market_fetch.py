"""Offline tests for the Market Intelligence ingestion seam (market_fetch).

Refocus §三十六 discipline: parser/normalizer errors must be findable without
network access. `build_day_rows` (universe filtering + row shaping + byte
serialization) is pure, so it is tested here against synthetic vendor rows —
the vendor package download/parse itself stays covered by the generated-module
tests and the coherence audit at capture time.

Stdlib only.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services" / "stock-data" / "generated"))
sys.path.insert(0, str(REPO / "scripts"))

import market_fetch as mf  # noqa: E402  (path inserted above)


def vendor_row(date, market, code, name, prev, o, h, l, c, volume, amount):
    return {
        "date": date, "market": market, "code": code, "name": name,
        "prev_close": prev, "open": o, "high": h, "low": l, "close": c,
        "volume": volume, "amount": amount,
    }


POOL = {"000001": "sz", "600519": "sh", "920885": "bj", "300750": "sz"}


class TestBuildDayRows(unittest.TestCase):
    def test_filters_on_market_and_code_not_code_alone(self):
        # sh 000001 is the SSE index; the pool's 000001 is 平安银行 in sz.
        # A code-only match would store the index row for the stock.
        rows = [
            vendor_row("2026-09-28", "sh", "000001", "上证指数", 3888.3738, 3878.4, 3878.4, 3806.6, 3823.6, 452350675, 804543704707.9),
            vendor_row("2026-09-28", "sz", "000001", "平安银行", 10.86, 10.9, 11.05, 10.82, 10.98, 82345678, 901234567.8),
        ]
        body, stats = mf.build_day_rows("2026-09-28", rows, POOL)
        lines = body.decode("utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        row = json.loads(lines[0])
        self.assertEqual(row["market"], "sz")
        self.assertEqual(row["name"], "平安银行")
        self.assertEqual(stats["droppedNonPool"], 0)
        self.assertEqual(stats["droppedMarketMismatch"], 1)

    def test_drops_non_pool_codes_and_counts_them(self):
        rows = [
            vendor_row("2026-09-28", "sh", "999999", "上证指数", 1, 1, 1, 1, 1, 0, 0),
            vendor_row("2026-09-28", "sh", "510050", "50ETF", 1, 1, 1, 1, 1, 0, 0),
            vendor_row("2026-09-28", "sz", "000001", "平安银行", 10.86, 10.9, 11.05, 10.82, 10.98, 82345678, 901234567.8),
        ]
        body, stats = mf.build_day_rows("2026-09-28", rows, POOL)
        self.assertEqual(stats["rows"], 1)
        self.assertEqual(stats["droppedNonPool"], 2)

    def test_row_shape_is_objective_vendor_fields_only(self):
        rows = [vendor_row("2026-09-28", "bj", "920885", "星辰科技", 12.26, 12.25, 12.28, 11.74, 11.74, 1421315, 16895460.23)]
        body, _ = mf.build_day_rows("2026-09-28", rows, POOL)
        row = json.loads(body.decode("utf-8").splitlines()[0])
        self.assertEqual(
            list(row.keys()),
            ["date", "code", "market", "name", "prevClose", "open", "high", "low", "close", "volume", "amount"],
        )
        self.assertEqual(row["volume"], 1421315)  # int, 股
        self.assertEqual(row["amount"], 16895460.23)

    def test_bytes_are_deterministic_lf_sorted_by_code(self):
        rows = [
            vendor_row("2026-09-28", "sh", "600519", "贵州茅台", 1237.0, 1236.0, 1244.0, 1228.0, 1243.88, 2821830, 3488720613.0),
            vendor_row("2026-09-28", "sz", "000001", "平安银行", 10.86, 10.9, 11.05, 10.82, 10.98, 82345678, 901234567.8),
            vendor_row("2026-09-28", "sz", "300750", "宁德时代", 293.5, 289.0, 292.66, 286.66, 291.99, 33914360, 9829828126.97),
        ]
        body1, _ = mf.build_day_rows("2026-09-28", rows, POOL)
        body2, _ = mf.build_day_rows("2026-09-28", list(reversed(rows)), POOL)
        self.assertEqual(body1, body2)  # input order must not matter
        self.assertNotIn(b"\r", body1)
        codes = [json.loads(line)["code"] for line in body1.decode("utf-8").splitlines()]
        self.assertEqual(codes, sorted(codes))
        self.assertTrue(body1.endswith(b"\n"))

    def test_non_positive_close_dropped(self):
        rows = [vendor_row("2026-09-28", "sz", "000001", "平安银行", 10.86, 0, 0, 0, 0, 0, 0)]
        body, stats = mf.build_day_rows("2026-09-28", rows, POOL)
        self.assertEqual(stats["rows"], 0)
        self.assertEqual(stats["droppedNonPositiveClose"], 1)
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()
