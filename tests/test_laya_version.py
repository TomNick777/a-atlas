"""Version-grammar tests for models/ production dirs (scripts/laya_version.py).

TS twin: tests/model-version.test.ts. Regression guard for the V4.1 lesson —
the old `a-share-laya-v\\d+` regex could not see a-share-laya-v4.1, so `latest`
silently stayed on V3 (and int("4.1") would have raised). Run:
  .venv/Scripts/python.exe -m unittest tests.test_laya_version -v
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_version import latest_versioned_name, parse_model_version, resolve_latest_model_dir  # noqa: E402


class ParseTests(unittest.TestCase):
    def test_accepts_formal_versions_including_future_lines(self):
        self.assertEqual(parse_model_version("a-share-laya-v3"), (3,))
        self.assertEqual(parse_model_version("a-share-laya-v4"), (4,))
        self.assertEqual(parse_model_version("a-share-laya-v4.1"), (4, 1))
        self.assertEqual(parse_model_version("a-share-laya-v4.2"), (4, 2))
        self.assertEqual(parse_model_version("a-share-laya-v5.1"), (5, 1))
        self.assertEqual(parse_model_version("a-share-laya-v5.1.2"), (5, 1, 2))
        self.assertEqual(parse_model_version("a-share-laya-v10"), (10,))

    def test_rejects_candidate_suffixed_and_unversioned(self):
        for name in (
            "a-share-laya-v4.1-candidate",
            "a-share-laya-v4.1-candidate-A",
            "a-share-laya-v4-rc1",
            "a-share-laya-v4.1.0-beta",
            "a-share-laya",
            "a-share-laya-v",
            "a-share-laya-v4.x",
            "a-share-laya-v4.1.",
            "share-laya-v4.1",
            "",
        ):
            self.assertIsNone(parse_model_version(name), name)


class LatestTests(unittest.TestCase):
    def test_required_matrix(self):
        self.assertEqual(
            latest_versioned_name(["a-share-laya-v3", "a-share-laya-v4", "a-share-laya-v4.1", "a-share-laya-v4.2"]),
            "a-share-laya-v4.2",
        )

    def test_v4_1_resolves_above_v4(self):
        self.assertEqual(latest_versioned_name(["a-share-laya-v3", "a-share-laya-v4.1"]), "a-share-laya-v4.1")

    def test_numeric_not_lexicographic(self):
        self.assertEqual(latest_versioned_name(["a-share-laya-v4.9", "a-share-laya-v4.10"]), "a-share-laya-v4.10")
        self.assertEqual(latest_versioned_name(["a-share-laya-v9", "a-share-laya-v10"]), "a-share-laya-v10")

    def test_ignores_candidates_and_unversioned(self):
        self.assertEqual(
            latest_versioned_name(
                [
                    "a-share-laya",
                    "a-share-laya-v3",
                    "a-share-laya-v4-candidate",
                    "a-share-laya-v4.1-candidate",
                    "a-share-laya-v4.1-candidate-A",
                ]
            ),
            "a-share-laya-v3",
        )

    def test_future_v5_1_needs_no_code_change(self):
        self.assertEqual(latest_versioned_name(["a-share-laya-v4.1", "a-share-laya-v5.1"]), "a-share-laya-v5.1")

    def test_none_when_no_formal_version(self):
        self.assertIsNone(latest_versioned_name(["a-share-laya", "a-share-laya-v4.1-candidate"]))
        self.assertIsNone(latest_versioned_name([]))

    def test_v4_vs_v4_0_tie_is_deterministic(self):
        self.assertEqual(latest_versioned_name(["a-share-laya-v4", "a-share-laya-v4.0"]), "a-share-laya-v4.0")


class ResolveLatestModelDirTests(unittest.TestCase):
    def _mk(self, root: Path, name: str, with_best: bool = True) -> None:
        d = root / name
        d.mkdir(parents=True)
        if with_best:
            (d / "checkpoint_best").mkdir()

    def test_resolution_over_a_realistic_models_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in (
                "a-share-laya",
                "a-share-laya-v1",
                "a-share-laya-v3",
                "a-share-laya-v4-candidate",
                "a-share-laya-v4.1-candidate",
                "a-share-laya-v4.1-candidate-A",
            ):
                self._mk(root, name)
            self.assertEqual(resolve_latest_model_dir(root), root / "a-share-laya-v3" / "checkpoint_best")

    def test_after_promotion_v4_1_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("a-share-laya-v3", "a-share-laya-v4.1"):
                self._mk(root, name)
            self.assertEqual(resolve_latest_model_dir(root), root / "a-share-laya-v4.1" / "checkpoint_best")

    def test_future_v5_1_promotion_needs_no_code_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("a-share-laya-v4.1", "a-share-laya-v5.1"):
                self._mk(root, name)
            self.assertEqual(resolve_latest_model_dir(root), root / "a-share-laya-v5.1" / "checkpoint_best")

    def test_falls_back_to_unversioned_then_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._mk(root, "a-share-laya")  # unversioned fallback still probes checkpoint leaves
            self.assertEqual(resolve_latest_model_dir(root), root / "a-share-laya" / "checkpoint_best")
            self.assertIsNone(resolve_latest_model_dir(root / "missing"))
            (root / "no_formal_dirs").mkdir()  # exists, but only candidate-style dirs inside
            self.assertIsNone(resolve_latest_model_dir(root / "no_formal_dirs"))

    def test_prefers_checkpoint_best_over_last_and_bare_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            version = root / "a-share-laya-v4.1"
            (version / "checkpoint_last").mkdir(parents=True)
            self.assertEqual(resolve_latest_model_dir(root), version / "checkpoint_last")
            (version / "checkpoint_best").mkdir()
            self.assertEqual(resolve_latest_model_dir(root), version / "checkpoint_best")


if __name__ == "__main__":
    unittest.main()
