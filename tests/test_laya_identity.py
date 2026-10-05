"""Sidecar identity + telemetry tests (scripts/laya_identity.py).

Product Evidence Layer v1 (规格 §6/§9/§44): health payload identity fields,
sha16 streaming, append-only event writes, port-ownership probe. Run:
  .venv/Scripts/python.exe -m unittest tests.test_laya_identity -v
"""

from __future__ import annotations

import hashlib
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_identity import (  # noqa: E402
    TELEMETRY_SCHEMA_VERSION,
    build_envelope,
    build_health_payload,
    checkpoint_safetensors,
    append_event,
    port_owner_pid,
    sha16_of_file,
)


class Sha16Tests(unittest.TestCase):
    def test_matches_hashlib_streamed(self):
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            handle.write(b"0123456789" * 4096)
            path = Path(handle.name)
        expected = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
        self.assertEqual(sha16_of_file(path), expected)
        path.unlink(missing_ok=True)

    def test_missing_file_returns_none(self):
        self.assertIsNone(sha16_of_file(Path("Z:/definitely/not/here.safetensors")))


class CheckpointTests(unittest.TestCase):
    def test_resolves_checkpoint_best_nesting(self):
        with tempfile.TemporaryDirectory() as tmp:
            leaf = Path(tmp) / "checkpoint_best"
            leaf.mkdir()
            (leaf / "model.safetensors").write_bytes(b"x")
            resolved = checkpoint_safetensors(tmp)
            self.assertIsNotNone(resolved)
            self.assertEqual(resolved.name, "model.safetensors")
            self.assertEqual(resolved.parent.name, "checkpoint_best")

    def test_missing_dir_is_none(self):
        self.assertIsNone(checkpoint_safetensors("Z:/no/such/checkpoint"))


class HealthPayloadTests(unittest.TestCase):
    def test_keeps_legacy_fields_and_adds_identity(self):
        payload = build_health_payload(
            ok=True, model="laya-x/y", device="cuda:0", checkpoint_path="C:/m/model.safetensors",
            sha16="2742affc3f677d71", startup_ms=1234.5, cuda=True, vram={"usedMb": 1660, "totalMb": 8192},
        )
        # Harbor ADR-008 anchor fields unchanged
        self.assertEqual(payload["service"], "a-share-laya-sidecar")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["model"], "laya-x/y")
        # new identity fields (规格 §6: actual, not expected)
        self.assertEqual(payload["sha16"], "2742affc3f677d71")
        self.assertEqual(payload["checkpointPath"], "C:/m/model.safetensors")
        self.assertEqual(payload["startupMs"], 1234)  # python round() banker's rounding
        self.assertEqual(payload["vram"]["totalMb"], 8192)


class EventWriteTests(unittest.TestCase):
    def test_append_event_writes_one_complete_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            event = build_envelope("SIDECAR_STARTED", "runtime", {"sha16": "abc"}, "sidecar", "run_sidecar_1_2")
            self.assertTrue(append_event(event, directory=Path(tmp) / "events"))
            files = list((Path(tmp) / "events").glob("*.jsonl"))
            self.assertEqual(len(files), 1)
            line = files[0].read_text(encoding="utf-8").strip()
            self.assertEqual(json.loads(line)["telemetrySchemaVersion"], TELEMETRY_SCHEMA_VERSION)
            self.assertEqual(json.loads(line)["eventType"], "SIDECAR_STARTED")

    def test_append_event_never_raises_on_bad_dir(self):
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            blocker = Path(handle.name)
        # a FILE where the directory should be → mkdir fails → return False, no raise
        self.assertFalse(append_event(build_envelope("X", "runtime", {}, "sidecar", "r"), directory=blocker))
        blocker.unlink(missing_ok=True)

    def test_envelope_shape(self):
        event = build_envelope("SIDECAR_IDENTITY_VERIFIED", "runtime", {}, "sidecar", "run_sidecar_9_1")
        for key in ("eventId", "eventType", "timestamp", "appRunId", "gitHead", "component", "runtime", "versions", "payload"):
            self.assertIn(key, event)
        self.assertEqual(event["component"], "sidecar")
        self.assertIsNone(event["searchId"])  # startup events have no searchId (规格 §3)


class PortOwnerTests(unittest.TestCase):
    def test_true_when_listening(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.listen(1)
        try:
            self.assertTrue(port_owner_pid(port))
        finally:
            server.close()

    def test_false_when_free(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.close()
        self.assertFalse(port_owner_pid(port))


if __name__ == "__main__":
    unittest.main()
