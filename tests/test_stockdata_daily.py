import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("daily_bars", Path(__file__).resolve().parents[1] / "services/stock-data/daily_bars.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DailyAvailability(unittest.TestCase):
    def test_coverage_empty_corrupt_and_valid_are_different(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "000001.json"
            self.assertEqual(module.daily_bars("000001", directory)["available"], "unavailable")
            payload = {"code": "000001", "adjust": "qfq", "timeframe": "1d", "source": "test collector", "fetchedAt": "2026-10-12T00:00:00+08:00", "volumeUnit": "手", "bars": []}
            path.write_text(json.dumps(payload))
            self.assertEqual(module.daily_bars("000001", directory)["available"], "empty")
            payload["bars"] = [{"t": 100, "o": 1, "c": 2, "l": 1, "h": 2, "v": 0}]
            payload["end"] = "1970-01-01"
            path.write_text(json.dumps(payload))
            self.assertEqual(module.daily_bars("000001", directory)["available"], "ok")
            self.assertEqual(module.daily_bars("000001", directory)["fetchedAt"], payload["fetchedAt"])
            payload["volumeUnit"] = "unknown"
            path.write_text(json.dumps(payload))
            self.assertEqual(module.daily_bars("000001", directory)["available"], "error")
            payload["volumeUnit"] = "手"
            payload["bars"][0]["h"] = 0.5
            path.write_text(json.dumps(payload))
            self.assertEqual(module.daily_bars("000001", directory)["available"], "error")
            path.write_text("{broken")
            self.assertEqual(module.daily_bars("000001", directory)["available"], "error")

    def test_cache_cannot_impersonate_another_company_or_adjustment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "000001.json"
            path.write_text(json.dumps({"code": "000002", "adjust": "qfq", "timeframe": "1d", "bars": []}))
            self.assertEqual(module.daily_bars("000001", directory)["available"], "error")

if __name__ == "__main__":
    unittest.main()
