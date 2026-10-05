"""Run code-only Python tests; source-clock tests need the private calendar."""
from __future__ import annotations

import unittest

suite = unittest.TestSuite()
for filename in (
    "test_stockdata_extraction.py",
    "test_stockdata_market_fetch.py",
    "test_stockdata_service.py",
):
    suite.addTests(unittest.defaultTestLoader.discover("tests", pattern=filename))

if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
