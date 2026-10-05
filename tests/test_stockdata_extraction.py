"""Offline tests for the a-stock-data extraction + the generated parsers.

Refocus §三十六: parser errors must be findable without network access, so every
transport seam (urllib / requests / EM_SESSION) is monkeypatched with synthetic
fixtures shaped like the real upstream payloads. The generated module itself is
never edited — extraction regenerates it from vendor/a-stock-data/SKILL.md and
these tests pin that determinism and the four first-stage capabilities' parse
contracts (quote / research reports / fundamentals / announcements).

Stdlib + requests only. Python 3.9+.
"""

from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services" / "stock-data" / "generated"))
sys.path.insert(0, str(REPO / "scripts"))

import stock_data as sd  # noqa: E402  (path inserted above)
import extract_stock_data as ex  # noqa: E402


def tencent_row(name, price, last_close, amount_wan, pe_ttm, mcap_yi, pb, code_field=None):
    """Build one qt.gtimg.cn `~` row with the field indices tencent_quote reads."""
    vals = [""] * 53
    vals[1] = name
    vals[2] = code_field or ""
    vals[3] = str(price)
    vals[4] = str(last_close)
    vals[31] = "0.15"
    vals[32] = "1.2"
    vals[37] = str(amount_wan)
    vals[38] = "0.51"
    vals[39] = str(pe_ttm)
    vals[43] = "2.1"
    vals[44] = str(mcap_yi * 0.8)
    vals[45] = str(mcap_yi)
    vals[46] = str(pb)
    return "~".join(vals)


def tencent_payload(rows):
    body = ";".join(f'v_{code}="{row}"' for code, row in rows)
    return (body + ";").encode("gbk")


class FakeResponse:
    def __init__(self, payload=None, text="", content=b"", status_code=200):
        self._payload = payload
        self.text = text
        self.content = content
        self.status_code = status_code

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class TestExtractionProvenance(unittest.TestCase):
    """The generated file is a pinned, deterministic artifact of the vendor snapshot."""

    def test_manifest_matches_vendor_snapshot_and_output(self):
        manifest = json.loads((ex.OUT_DIR / "manifest.json").read_text(encoding="utf-8"))
        skill = ex.SKILL.read_text(encoding="utf-8")
        self.assertEqual(manifest["skillSha256"], hashlib.sha256(skill.encode("utf-8")).hexdigest())
        generated = ex.OUT.read_text(encoding="utf-8")
        self.assertEqual(manifest["generatedSha256"], hashlib.sha256(generated.encode("utf-8")).hexdigest())
        self.assertEqual(len(manifest["commit"]), 40)
        self.assertIn("a-stock-data", manifest["upstream"])

    def test_regeneration_is_deterministic(self):
        generated, _ = ex.extract()
        self.assertEqual(generated, ex.OUT.read_text(encoding="utf-8"))

    def test_all_four_capability_roots_present(self):
        for fn in ("tencent_quote", "eastmoney_reports", "sina_financial_report", "cninfo_announcements"):
            self.assertTrue(callable(getattr(sd, fn)), fn)
        for helper in ("get_prefix", "norm_ticker", "em_get"):
            self.assertTrue(callable(getattr(sd, helper)), helper)
        # Market Intelligence ingestion root (full-market daily package)
        self.assertTrue(callable(getattr(sd, "tdx_daily_package")), "tdx_daily_package")
        self.assertTrue(callable(getattr(sd, "_tdx_parse_package")), "_tdx_parse_package")


class TestTencentQuoteParser(unittest.TestCase):
    def test_normal_row_fields_and_routing(self):
        rows = [
            ("sh600519", tencent_row("贵州茅台", 1523.5, 1500.0, 23456.0, 22.4, 19100.0, 8.9)),
            ("sz000001", tencent_row("平安银行", 12.34, 12.2, 98765.0, 4.8, 2390.0, 0.62)),
        ]
        fake = mock.mock_open(read_data=b"")
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = mock.MagicMock(read=lambda: tencent_payload(rows))
            result = sd.tencent_quote(["600519", "000001"])
        self.assertEqual(set(result), {"600519", "000001"})  # 裸入参 → 裸键
        mt = result["600519"]
        self.assertEqual(mt["name"], "贵州茅台")
        self.assertAlmostEqual(mt["price"], 1523.5)
        self.assertAlmostEqual(mt["pb"], 8.9)
        self.assertAlmostEqual(mt["mcap_yi"], 19100.0)
        self.assertAlmostEqual(mt["pe_ttm"], 22.4)
        self.assertFalse(mt["is_stale"])

    def test_malformed_row_silently_skipped(self):
        rows = [("sh600519", tencent_row("贵州茅台", 1523.5, 1500.0, 100.0, 22.4, 19100.0, 8.9))]
        payload = tencent_payload(rows) + b'v_sz000001="too~short~row";'
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = mock.MagicMock(read=lambda: payload)
            result = sd.tencent_quote(["600519", "000001"])
        self.assertEqual(set(result), {"600519"})

    def test_stale_quote_flagged_with_reason(self):
        row = tencent_row("某退市迁移股", 112.6, 112.6, 0.0, 0.0, 5.0, 0.4, code_field="bj832982")
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = mock.MagicMock(read=lambda: tencent_payload([("bj832982", row)]))
            result = sd.tencent_quote(["832982"])
        q = result["832982"]
        self.assertTrue(q["is_stale"])
        self.assertIn("920", q["stale_reason"])

    def test_explicit_prefix_key_passthrough(self):
        row = tencent_row("上证指数", 3456.78, 3450.0, 123456.0, 0.0, 0.0, 0.0)
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = mock.MagicMock(read=lambda: tencent_payload([("sh000001", row)]))
            result = sd.tencent_quote(["sh000001"])
        self.assertIn("sh000001", result)

    def test_bj_920_routing(self):
        row = tencent_row("某北交所股", 10.0, 9.9, 500.0, 15.0, 12.0, 1.8)
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value = mock.MagicMock(read=lambda: tencent_payload([("bj920982", row)]))
            result = sd.tencent_quote(["920982"])
        self.assertIn("920982", result)


class TestEastmoneyReportsParser(unittest.TestCase):
    def _report(self, title="公司研究报告"):
        return {"title": title, "publishDate": "2026-09-20 00:00:00", "orgSName": "某证券",
                "infoCode": "AP202609201234", "emRatingName": "买入", "indvInduName": "电子"}

    def test_records_pass_through_and_pagination_stops(self):
        pages = [
            FakeResponse(payload={"data": [self._report("p1")], "TotalPage": 2}),
            FakeResponse(payload={"data": [self._report("p2")], "TotalPage": 2}),
            FakeResponse(payload={"data": [], "TotalPage": 2}),  # must never be fetched
        ]
        with mock.patch.object(sd, "em_get", side_effect=pages) as em:
            result = sd.eastmoney_reports("600519")
        self.assertEqual([r["title"] for r in result], ["p1", "p2"])
        self.assertEqual(em.call_count, 2)

    def test_empty_coverage_is_empty_not_error(self):
        with mock.patch.object(sd, "em_get", return_value=FakeResponse(payload={"data": [], "TotalPage": 1})):
            self.assertEqual(sd.eastmoney_reports("688138"), [])

    def test_old_bse_segment_raises_valueerror(self):
        with mock.patch.object(sd, "em_get", return_value=FakeResponse(payload={"data": [], "TotalPage": 1})):
            with self.assertRaises(ValueError):
                sd.eastmoney_reports("832982")

    def test_bad_format_raises_valueerror_upstream(self):
        # norm_ticker 拒绝不合法写法（绝不猜），这是上游明文契约。
        with self.assertRaises(ValueError):
            sd.norm_ticker("60051X")
        with self.assertRaises(ValueError):
            sd.norm_ticker("SH600519.SH")

    def test_timeout_propagates_for_service_layer_to_classify(self):
        import requests as requests_mod

        with mock.patch.object(sd, "em_get", side_effect=requests_mod.Timeout("timed out")):
            with self.assertRaises(requests_mod.Timeout):
                sd.eastmoney_reports("600519")


class TestSinaFinancialReportParser(unittest.TestCase):
    def _payload(self, periods):
        return {"result": {"data": {"report_list": periods}}}

    def test_periods_desc_and_raw_string_values(self):
        payload = self._payload({
            "20251231": {"data": [{"item_title": "营业收入", "item_value": "1,743.6亿", "item_tongbi": "15.66"},
                                  {"item_title": "净利润", "item_value": "862.3亿", "item_tongbi": ""}]},
            "20260331": {"data": [{"item_title": "营业收入", "item_value": "514.4亿", "item_tongbi": "10.71"}]},
        })
        with mock.patch("requests.get", return_value=FakeResponse(payload=payload)) as get:
            rows = sd.sina_financial_report("600519", "lrb")
        get.assert_called_once()
        self.assertEqual([r["报告期"] for r in rows], ["2026-03-31", "2025-12-31"])
        self.assertEqual(rows[0]["营业收入"], "514.4亿")  # 新浪原始字符串，不伪造数值
        self.assertEqual(rows[0]["营业收入_同比"], "10.71")
        self.assertNotIn("净利润_同比", rows[1])  # 空 tongbi 不造键

    def test_empty_report_list_is_empty(self):
        with mock.patch("requests.get", return_value=FakeResponse(payload=self._payload({}))):
            self.assertEqual(sd.sina_financial_report("600519", "lrb"), [])

    def test_null_layers_do_not_crash(self):
        with mock.patch("requests.get", return_value=FakeResponse(payload={"result": {"data": None}})):
            self.assertEqual(sd.sina_financial_report("600519", "lrb"), [])


class TestCninfoAnnouncementsParser(unittest.TestCase):
    def test_mapping_and_provenance_fields(self):
        orgid = FakeResponse(payload={"stockList": [{"code": "600519", "orgId": "gssh0600519"}, {"code": "688017", "orgId": "9900041602"}]})
        query = FakeResponse(payload={"announcements": [
            {"announcementTitle": "2026年半年度报告", "announcementTypeName": "半年报",
             "announcementTime": 1759030000000, "announcementId": "123456"},
        ]})
        with mock.patch("requests.get", return_value=orgid), mock.patch("requests.post", return_value=query) as post:
            rows = sd.cninfo_announcements("688017")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["title"], "2026年半年度报告")
        self.assertEqual(rows[0]["type"], "半年报")
        self.assertEqual(rows[0]["date"], "2025-09-28")
        self.assertTrue(rows[0]["url"].startswith("https://www.cninfo.com.cn/new/disclosure/detail?annoId="))
        sent = post.call_args.kwargs["data"]["stock"]
        self.assertEqual(sent, "688017,9900041602")

    def test_no_announcements_is_empty(self):
        orgid = FakeResponse(payload={"stockList": [{"code": "600519", "orgId": "gssh0600519"}]})
        query = FakeResponse(payload={"announcements": None})
        with mock.patch("requests.get", return_value=orgid), mock.patch("requests.post", return_value=query):
            self.assertEqual(sd.cninfo_announcements("600519"), [])


if __name__ == "__main__":
    unittest.main()
