import copy
import hashlib
import json
import sys
import tempfile
import threading
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "stock-data"))
import market_snapshot as ms
import market_runtime as mr


def row(stamp="20261008100000"):
    return {"source_symbol": "sh600000", "source_code": "600000", "source_time": stamp,
            "price": 11, "last_close": 10, "change_pct": 10, "volume_source": 100,
            "amount_precise_wan": 11, "high": 11, "low": 10, "raw_sha256": "fixture"}


class SourceSafety(unittest.TestCase):
    def test_identity_date_missing_time_future_and_unknown_are_rejected(self):
        now = datetime(2026, 10, 8, 10, 0, tzinfo=ms.CN)
        ctx = ms.session(now)
        for key, value, expected in [("source_code", "000001", "INVALID_IDENTITY"), ("source_time", None, "TIME_MISSING"),
                                     ("source_time", "20260930161500", "STALE_DATE"), ("source_time", "20261008100100", "TIME_FUTURE"),
                                     ("price", float("nan"), "INVALID_PRICE")]:
            q = row(); q[key] = value
            self.assertEqual(ms.validate_row("sh600000", q, ctx, now), expected)

    def test_lunch_and_auction_pause_anchor_but_old_trading_quote_is_rejected(self):
        lunch = datetime(2026, 10, 8, 12, 30, tzinfo=ms.CN)
        self.assertEqual(ms.validate_row("sh600000", row("20261008113000"), ms.session(lunch), lunch), "VALID")
        self.assertEqual(ms.validate_row("sh600000", row("20261008100000"), ms.session(lunch), lunch), "STALE_TIME")
        auction = datetime(2026, 10, 8, 9, 29, tzinfo=ms.CN)
        self.assertEqual(ms.validate_row("sh600000", row("20261008092500"), ms.session(auction), auction), "VALID")

    def test_zero_trades_is_not_suspension_and_incomplete_close_is_not_final(self):
        now = datetime(2026, 10, 8, 16, 0, tzinfo=ms.CN)
        ctx = ms.session(now)
        self.assertEqual(ms.validate_row("sh600000", row("20261008145900"), ctx, now), "INCOMPLETE_CLOSE")
        q = row("20261008150000"); q.update(volume_source=0, amount_precise_wan=0)
        self.assertEqual(ms.validate_row("sh600000", q, ctx, now), "NO_TRADES")

    def test_market_units_and_bad_units(self):
        now = datetime(2026, 10, 8, 10, 0, tzinfo=ms.CN)
        q = row(); q["volumeShares"] = 10000
        self.assertEqual(ms.validate_row("sh600000", q, ms.session(now), now), "VALID")
        q["volumeShares"] *= 100
        self.assertEqual(ms.validate_row("sh600000", q, ms.session(now), now), "INVALID_UNITS")

    def test_board_units_and_error_absence_are_separate_in_capture(self):
        companies = [{"code": "600000", "exchange": "SH", "board": "主板"}, {"code": "688000", "exchange": "SH", "board": "科创板"}]
        def fetch(symbols):
            q = row("20260930161500")
            star = copy.deepcopy(q); star.update(source_code="688000", source_symbol="sh688000", volume_source=10000)
            return {"sh600000": q, "sh688000": star}
        result = ms.capture(companies, {"phase": "closed", "tradeDate": "2026-09-30"}, fetch, datetime(2026, 10, 2, tzinfo=ms.CN))
        self.assertEqual(result["counts"], {"VALID": 2})
        self.assertEqual(result["rows"]["600000"]["source"]["volumeShares"], 10000)
        self.assertEqual(result["rows"]["688000"]["source"]["volumeShares"], 10000)
        absent = ms.capture(companies, {"phase": "closed", "tradeDate": "2026-09-30"}, lambda _: {}, datetime(2026, 10, 2, tzinfo=ms.CN))
        self.assertEqual(absent["counts"], {"MISSING": 2}); self.assertFalse(absent["publishable"])
        def broken(_): raise OSError("transport")
        failed = ms.capture(companies, {"phase": "closed", "tradeDate": "2026-09-30"}, broken, datetime(2026, 10, 2, tzinfo=ms.CN))
        self.assertEqual(failed["counts"], {"ERROR": 2})

    def test_generated_projection_preserves_source_time_and_response_hash(self):
        fields = [""] * 58
        for key, value in {1: "测试", 2: "600000", 3: "11", 4: "10", 6: "100", 30: "20261008100000", 32: "10", 57: "11"}.items(): fields[key] = value
        body = ('v_sh600000="' + "~".join(fields) + '";').encode("gbk")
        class Response:
            def read(self): return body
        with patch.object(ms.sd.urllib.request, "urlopen", return_value=Response()):
            projected = ms.sd.tencent_quote_snapshot(["sh600000"])["sh600000"]
        self.assertEqual(projected["source_time"], "20261008100000")
        self.assertEqual(projected["raw_sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(projected["amount_precise_wan"], 11)


class SharedRefresh(unittest.TestCase):
    def tearDown(self):
        if mr._job: mr._job.join(2)
        mr._job = None; mr._failure = None; mr._retry_after = 0

    def test_concurrent_requests_start_one_collection(self):
        entered, release = threading.Event(), threading.Event()
        def work(_): entered.set(); release.wait(2)
        with patch.object(mr, "current", return_value=(Path("."), {"inputs": {"universeSha16": "fixture"}})), patch.object(mr, "_refresh", side_effect=work) as refresh:
            for _ in range(4): mr.market_snapshot(wait=False)
            self.assertTrue(entered.wait(1)); self.assertEqual(refresh.call_count, 1)
            release.set(); mr._job.join(2)

    def test_rejected_capture_keeps_published_pointer_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch); runtime = root / "data" / "market-runtime"
            history = root / "data" / "market"; (history / "state").mkdir(parents=True)
            (history / "state" / "manifest.json").write_text(json.dumps({"tradingDays": ["2026-09-29"]}))
            (root / "data" / "companies.json").write_text(json.dumps({"companies": []}))
            runtime.mkdir(); pointer = runtime / "current.json"; pointer.write_text("original")
            context = {"previousDate": "2026-09-29"}
            with patch.object(mr, "REPO", root), patch.object(mr, "RUNTIME", runtime), patch.object(mr, "current", return_value=(history, {})), patch.object(mr, "capture", return_value={"publishable": False, "failures": ["stale"]}), patch.object(mr.shutil, "which", return_value="node"):
                mr._refresh(context)
            self.assertEqual(pointer.read_text(), "original")
            self.assertFalse((runtime / "refresh.lock").exists())
            self.assertIn("stale", mr._failure)

    def test_retention_failure_does_not_turn_successful_publication_into_source_failure(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch); runtime = root / "data" / "market-runtime"
            history = root / "data" / "market"; (history / "state").mkdir(parents=True)
            (history / "state" / "manifest.json").write_text(json.dumps({"tradingDays": ["2026-09-29"]}))
            (root / "data" / "companies.json").write_text(json.dumps({"companies": []}))
            context = {"previousDate": "2026-09-29", "tradeDate": "2026-09-30", "calendarDate": "2026-10-04", "phase": "closed"}
            calls = []
            def run(args):
                calls.append(args[2])
                if "prune_market_snapshots.ts" in args[2]:
                    self.assertFalse((runtime / "refresh.lock").exists())
                    raise RuntimeError("maintenance busy")
                staging = Path(args[-1]); (staging / "state").mkdir()
                raw = b"{}\n"
                (staging / "state" / "2026-09-30.jsonl").write_bytes(raw)
                (staging / "state" / "manifest.json").write_text(json.dumps({"contentDigest": {"value": hashlib.sha256(raw).hexdigest()}}))
            source = {"publishable": True, "endedAt": "2026-10-04T12:00:00+08:00"}
            with patch.object(mr, "REPO", root), patch.object(mr, "RUNTIME", runtime), patch.object(mr, "current", return_value=(history, {})), patch.object(mr, "capture", return_value=source), patch.object(mr, "session", return_value=context), patch.object(mr.shutil, "which", return_value="node"), patch.object(mr, "_run", side_effect=run), self.assertLogs(level="WARNING") as logs:
                mr._refresh(context)
            self.assertIsNone(mr._failure)
            pointer = json.loads((runtime / "current.json").read_text())
            self.assertTrue((runtime / "snapshots" / pointer["snapshotId"]).is_dir())
            self.assertEqual(calls, ["scripts/build_live_market.ts", "scripts/prune_market_snapshots.ts"])
            self.assertIn("retention deferred", logs.output[0])


if __name__ == "__main__": unittest.main()
