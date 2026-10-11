"""Fail closed on PID reuse and failed candidate loading; no private inputs/CUDA."""
import argparse
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import atlas_runtime as runtime

class Lifecycle(unittest.TestCase):
    def test_reused_pid_is_never_killed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "laya.json").write_text(json.dumps({"pid": 17, "entry": "registered-server.py", "identityArgs": ["registered-checkpoint"]}))
            with patch.object(runtime, "STATE", state), patch.object(runtime, "command_line", return_value="other-process.exe"), patch.object(runtime.subprocess, "run") as kill:
                with self.assertRaisesRegex(RuntimeError, "ownership mismatch"):
                    runtime.stop("laya")
                kill.assert_not_called()

    def test_queue_cancel_never_launches_training(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "queue").mkdir()
            queued = state / "queue/run-a.json"
            queued.write_text(json.dumps({"state": "queued", "arguments": {"run": "run-a"}}))
            with patch.object(runtime, "STATE", state), patch.object(runtime, "launch") as launch:
                runtime.execute(argparse.Namespace(command="cancel", run="run-a"))
                self.assertEqual(json.loads(queued.read_text())["state"], "cancelled")
                launch.assert_not_called()

    def model_fixture(self, root, qualified):
        # Deliberately synthetic report in an isolated root; never a real qualification.
        report = root / "reports/laya-evaluation/synthetic/qualification.json"
        report.parent.mkdir(parents=True)
        report.write_text(json.dumps({"qualified": qualified, "sha256": "synthetic", "artifactDigest": "synthetic", "actualModel": "synthetic-runtime"}))
        row = {"sha256": "synthetic", "artifactDigest": "synthetic", "qualification": str(report.relative_to(root)), "qualificationSha256": runtime.sha(report), "status": "candidate"}
        registry = {"active": "old", "history": [], "models": {"old": {"status": "active"}, "candidate": row}}
        return registry, row

    def test_failed_qualification_does_not_drain_active_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry, row = self.model_fixture(root, False)
            with patch.object(runtime, "ROOT", root), patch.object(runtime, "STATE", root), patch.object(runtime, "registry", return_value=registry), patch.object(runtime, "model_path", return_value=(root, row)), patch.object(runtime, "stop") as stop:
                with self.assertRaisesRegex(ValueError, "failed qualification"):
                    runtime.switch_model("candidate")
                stop.assert_not_called()
                self.assertEqual(registry["active"], "old")

    def test_cold_load_failure_restores_original_without_changing_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry, row = self.model_fixture(root, True)
            original = copy.deepcopy(registry)
            with patch.object(runtime, "ROOT", root), patch.object(runtime, "STATE", root), patch.object(runtime, "registry", return_value=registry), patch.object(runtime, "model_path", return_value=(root, row)), patch.object(runtime, "stop"), patch.object(runtime, "serve", side_effect=[RuntimeError("synthetic load failure"), {"model": "old-runtime"}]) as serve, patch.object(runtime, "atomic_json") as write:
                with self.assertRaisesRegex(RuntimeError, "synthetic load failure"):
                    runtime.switch_model("candidate")
                self.assertEqual([call.args[0] for call in serve.call_args_list], ["candidate", "old"])
                self.assertEqual(registry, original)
                write.assert_not_called()

if __name__ == "__main__":
    unittest.main()
