"""Group isolation and loader immutability without private data or CUDA."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training/laya/datasets"))
from groups import isolate, validate
spec = importlib.util.spec_from_file_location("immutable_load", ROOT / "services/laya/immutable_load.py")
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)

class Isolation(unittest.TestCase):
    def test_same_query_family_cannot_cross_splits(self):
        rows = [{"companyGroupId": code, "sourceGroupId": code, "queryGroupId": "paraphrase-family", "split": split} for code, split in (("a", "train"), ("b", "blind"))]
        with self.assertRaisesRegex(ValueError, "queryGroupId"):
            validate(rows)

    def test_shared_source_and_company_are_kept_in_one_split(self):
        rows = [{"companyGroupId": str(i), "sourceGroupId": "shared-document" if i < 4 else str(i), "queryGroupId": str(j), "split": "train"} for i in range(30) for j in range(30)]
        result = isolate(rows)
        self.assertTrue(result)
        validate(result)
        self.assertEqual(len({row["split"] for row in result if row["sourceGroupId"] == "shared-document"}), 1)

    def test_loader_metadata_rewrite_does_not_modify_registered_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "model"
            (source / "tokenizer").mkdir(parents=True)
            metadata = source / "tokenizer/tokenizer_config.json"
            metadata.write_text('{"tokenizer_class":"TokenizersBackend"}')
            (source / "model.safetensors").write_bytes(b"immutable weights")
            original = metadata.read_bytes()
            with loader.checkpoint_copy(source, root / "runtime") as staging:
                (staging / "tokenizer/tokenizer_config.json").write_text('{"tokenizer_class":"PreTrainedTokenizerFast"}')
                self.assertEqual(metadata.read_bytes(), original)
                self.assertEqual((staging / "model.safetensors").read_bytes(), b"immutable weights")
            self.assertFalse(staging.exists())
            self.assertEqual(metadata.read_bytes(), original)

if __name__ == "__main__":
    unittest.main()
