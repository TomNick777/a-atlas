"""Qualification rejects tampered or leaked training inputs before promotion."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("qualification", ROOT / "training/laya/evaluation/evaluate.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)

class Qualification(unittest.TestCase):
    def fixture(self, root):
        tasks = [{"companyGroupId": split, "sourceGroupId": split, "queryGroupId": f"{split}-{cap}-{label}", "split": split, "capability": cap, "label": label, "evidenceRefs": [{"ref": split}]} for split in ("train", "validation", "blind") for cap in ("semantic_match", "semantic_relation", "semantic_comparison", "evidence_explanation") for label in (0, 3)]
        source = root / "source.json"
        source.write_text(json.dumps({"corpusSha256": "corpus", "tasks": tasks}))
        items = root / "items.pt"
        items.write_bytes(b"synthetic dataset; never loaded for inference")
        tokenized = root / "tokenized.json"
        tokenized.write_text(json.dumps({"source": source.name, "items": items.name}))
        candidate = {"dataset": {"config": {"dataset": tokenized.name}, "datasetSha256": evaluation.sha(tokenized), "sourceSha256": evaluation.sha(source), "itemsSha256": evaluation.sha(items)}}
        manifest = {"corpusSha256": "corpus", "cases": [{"subjects": [{"companyId": "held-out", "evidence": [{"ref": "held-out"}]}]}]}
        return candidate, manifest, items

    def test_disjoint_validated_dataset_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate, manifest, _ = self.fixture(root)
            with patch.object(evaluation, "ROOT", root):
                self.assertTrue(evaluation.dataset_gate(candidate, manifest))

    def test_tampered_items_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate, manifest, items = self.fixture(root)
            items.write_bytes(b"tampered")
            with patch.object(evaluation, "ROOT", root):
                self.assertFalse(evaluation.dataset_gate(candidate, manifest))

    def test_acceptance_company_in_training_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate, manifest, _ = self.fixture(root)
            manifest["cases"][0]["subjects"][0]["companyId"] = "train"
            with patch.object(evaluation, "ROOT", root):
                self.assertFalse(evaluation.dataset_gate(candidate, manifest))

if __name__ == "__main__":
    unittest.main()
