"""Offline tests for the a-atlas-data service (services/stock-data/server.py).

The transport seams (the generated stock_data functions) are monkeypatched, so
these tests pin the CONTRACT layer: EMPTY vs UNAVAILABLE vs ERROR classification
(refocus §二十四), the fundamentals derivation from raw Sina statements, the TTL
cache, and the canonical-symbol gate. No network access.

Stdlib + requests only (server imports the generated module which imports requests).
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services" / "stock-data"))

import server as svc  # noqa: E402


def lrb_rows():
    return [
        {"报告期": "2026-06-30", "营业总收入": "51,442,530,102.55", "营业总收入_同比": "10.714953",
         "营业总成本": "4,347,880,123.20", "归属于母公司所有者的净利润": "26,585,231,023.11",
         "归属于母公司所有者的净利润_同比": "11.402841", "基本每股收益": "33.19"},
        {"报告期": "2026-03-31", "营业总收入": "24,aker", "基本每股收益": "16.77"},
    ]


def fzb_rows():
    return [
        {"报告期": "2026-06-30", "归属于母公司股东权益合计": "149,231,006,240.00"},
        {"报告期": "2026-03-31", "归属于母公司股东权益合计": "146,000,000,000.00"},
    ]


class TestQuoteBlock(unittest.TestCase):
    def setUp(self):
        svc._cache.clear()

    def test_ok_contract_fields(self):
        prefixed = {"sh600519": {"name": "贵州茅台", "price": 1523.5, "last_close": 1505.02,
                                 "change_pct": 1.23, "pe_ttm": 22.4, "pb": 8.9,
                                 "mcap_yi": 19125.6, "turnover_pct": 0.51,
                                 "is_stale": False, "stale_reason": None}}
        with mock.patch.object(svc.sd, "get_prefix", return_value="sh"), \
             mock.patch.object(svc.sd, "tencent_quote_snapshot", return_value=prefixed):
            row = svc.quote_block("600519")
        self.assertEqual(row["available"], "ok")
        self.assertEqual(row["source"], "腾讯")
        self.assertEqual(row["name"], "贵州茅台")
        self.assertEqual(row["marketCapYi"], 19125.6)
        self.assertFalse(row["stale"])

    def test_zero_pe_pbecomes_null_not_fake(self):
        prefixed = {"sh600519": {"name": "贵州茅台", "price": 10.0, "last_close": 10.0, "change_pct": 0.0,
                                 "pe_ttm": 0, "pb": 0, "mcap_yi": 0, "turnover_pct": 0,
                                 "is_stale": True, "stale_reason": "成交量为 0（停牌 / 未开盘 / 废码），报价非当日真实成交"}}
        with mock.patch.object(svc.sd, "get_prefix", return_value="sh"), \
             mock.patch.object(svc.sd, "tencent_quote_snapshot", return_value=prefixed):
            row = svc.quote_block("600519")
        self.assertIsNone(row["peTtm"])
        self.assertTrue(row["stale"])
        self.assertIn("停牌", row["staleReason"])

    def test_missing_row_is_empty_not_error(self):
        with mock.patch.object(svc.sd, "get_prefix", return_value="sh"), \
             mock.patch.object(svc.sd, "tencent_quote_snapshot", return_value={}):
            row = svc.quote_block("600519")
        self.assertEqual(row["available"], "empty")

    def test_transport_failure_is_error(self):
        import requests
        with mock.patch.object(svc.sd, "get_prefix", return_value="sh"), \
             mock.patch.object(svc.sd, "tencent_quote_snapshot", side_effect=requests.Timeout("timed out")):
            row = svc.quote_block("600519")
        self.assertEqual(row["available"], "error")
        self.assertIn("Timeout", row["error"])

    def test_ttl_cache_serves_second_call_without_recompute(self):
        prefixed = {"sh600519": {"name": "贵州茅台", "price": 1.0, "last_close": 1.0, "change_pct": 0.0,
                                 "pe_ttm": 0, "pb": 0, "mcap_yi": 0, "turnover_pct": 0,
                                 "is_stale": False, "stale_reason": None}}
        with mock.patch.object(svc.sd, "get_prefix", return_value="sh"), \
             mock.patch.object(svc.sd, "tencent_quote_snapshot", return_value=prefixed) as tq:
            svc.quote_block("600519")
            svc.quote_block("600519")
        self.assertEqual(tq.call_count, 1)


class TestFundamentalsDerivation(unittest.TestCase):
    def setUp(self):
        svc._cache.clear()

    def test_derives_gross_margin_roe_and_keeps_raw_strings(self):
        with mock.patch.object(svc.sd, "sina_financial_report", side_effect=[lrb_rows(), fzb_rows()]):
            row = svc.fundamentals_block("600519")
        self.assertEqual(row["available"], "ok")
        self.assertEqual(row["reportPeriod"], "2026-06-30")
        self.assertEqual(row["asOf"], "2026-06-30")
        self.assertEqual(row["revenue"], "51,442,530,102.55")  # 上游原始字符串
        revenue = 51_442_530_102.55
        cost = 4_347_880_123.20
        self.assertAlmostEqual(row["grossMarginPct"], round((revenue - cost) / revenue * 100, 2), places=2)
        roe_expected = round(26_585_231_023.11 / 149_231_006_240.00 * 100, 2)
        self.assertAlmostEqual(row["roePct"], roe_expected, places=2)
        self.assertEqual(row["eps"], "33.19")

    def test_missing_statements_is_empty(self):
        with mock.patch.object(svc.sd, "sina_financial_report", return_value=[]):
            row = svc.fundamentals_block("600519")
        self.assertEqual(row["available"], "empty")

    def test_missing_cost_fields_leaves_ratios_null(self):
        lrb = [{"报告期": "2026-06-30", "营业总收入": "100.00", "归属于母公司所有者的净利润": "10.00"}]
        with mock.patch.object(svc.sd, "sina_financial_report", side_effect=[lrb, []]):
            row = svc.fundamentals_block("600519")
        self.assertEqual(row["available"], "ok")
        self.assertIsNone(row["grossMarginPct"])
        self.assertIsNone(row["roePct"])


class TestAnnouncementsAndReports(unittest.TestCase):
    def setUp(self):
        svc._cache.clear()

    def test_announcements_mapping_and_error_items_empty(self):
        cninfo_rows = [{"title": "半年报", "type": "半年报", "date": "2026-08-20",
                        "url": "https://www.cninfo.com.cn/new/disclosure/detail?annoId=1"}]
        with mock.patch.object(svc.sd, "cninfo_announcements", return_value=cninfo_rows):
            row = svc.announcements_block("600519")
        self.assertEqual(row["available"], "ok")
        self.assertEqual(row["items"][0]["title"], "半年报")

        svc._cache.clear()  # 缓存条目过期后的重新拉取走分类路径
        with mock.patch.object(svc.sd, "cninfo_announcements", side_effect=ValueError("no such org")):
            row = svc.announcements_block("600519")
        self.assertEqual(row["available"], "unavailable")
        self.assertEqual(row["items"], [])

    def test_reports_bse_old_segment_is_unavailable(self):
        with mock.patch.object(svc.sd, "eastmoney_reports", side_effect=ValueError("43/83/87 老号段")):
            row = svc.reports_block("832982")
        self.assertEqual(row["available"], "unavailable")

    def test_reports_map_rating_and_pdf_url(self):
        recs = [{"title": "宁德时代点评", "orgSName": "某证券", "publishDate": "2026-09-20 00:00:00",
                 "infoCode": "AP202609201234", "emRatingName": "买入", "researcher": "张三"}]
        with mock.patch.object(svc.sd, "eastmoney_reports", return_value=recs):
            row = svc.reports_block("300750")
        item = row["items"][0]
        self.assertEqual(item["rating"], "买入")
        self.assertEqual(item["analyst"], "张三")
        self.assertEqual(item["url"], "https://pdf.dfcfw.com/pdf/H3_AP202609201234_1.pdf")
        self.assertEqual(item["date"], "2026-09-20")


class TestHandlerRouting(unittest.TestCase):
    def setUp(self):
        svc._cache.clear()
        self.handler = svc.Handler.__new__(svc.Handler)
        self.sent = {}

    def _respond(self, code, payload):
        self.sent = {"code": code, "payload": payload}

    def test_health_identity(self):
        with mock.patch.object(svc.Handler, "_send", side_effect=self._respond):
            self.handler.path = "/health"
            self.handler.do_GET()
        self.assertEqual(self.sent["code"], 200)
        self.assertEqual(self.sent["payload"]["service"], "a-atlas-data")
        self.assertTrue(self.sent["payload"]["ok"])

    def test_non_canonical_symbol_rejected(self):
        for bad in ("600519.SH", "sh600519", "60051", "abcdef", ""):
            with mock.patch.object(svc.Handler, "_send", side_effect=self._respond):
                self.handler.path = f"/quote?symbol={bad}"
                self.handler.do_GET()
            self.assertEqual(self.sent["code"], 400, bad)

    def test_unknown_resource_404(self):
        with mock.patch.object(svc.Handler, "_send", side_effect=self._respond):
            self.handler.path = "/kline?symbol=600519"
            self.handler.do_GET()
        self.assertEqual(self.sent["code"], 404)

    def test_route_dispatch_produces_contract(self):
        fake_block = lambda s: {"symbol": s, "available": "empty", "items": []}  # noqa: E731
        with mock.patch.object(svc.Handler, "_send", side_effect=self._respond), \
             mock.patch.dict(svc.BLOCKS, {"quote": fake_block}):
            self.handler.path = "/quote?symbol=600519"
            self.handler.do_GET()
        self.assertEqual(self.sent["code"], 200)
        self.assertEqual(self.sent["payload"]["available"], "empty")


if __name__ == "__main__":
    unittest.main()
