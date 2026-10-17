"""Synthetic checks for a candidate extractor, without production company facts."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/search-quality"))
from product_evidence_preview import extract_candidates


class ProductEvidencePreviewTests(unittest.TestCase):
    def test_preserves_source_language_and_page_without_inferred_product_tags(self):
        sentence = "在本报告期，公司推出ZQ27-A系列产品，并持续开发多种配套方案，以满足不同客户的实际使用需求。"
        rows = extract_candidates(["第一页没有相关句子。", sentence])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["page"], 2)
        self.assertEqual(rows[0]["text"], sentence)
        self.assertEqual(rows[0]["literalLocators"], ["ZQ27-A"])
        self.assertEqual(rows[0]["terms"], [])
        self.assertFalse(rows[0]["ownershipInferred"])

    def test_does_not_join_separate_sentences_into_ownership_evidence(self):
        text = "公司持续研发多种系列产品，以满足长期客户的实际使用需求。其他企业的ZQ27-A设备参与了展会展示，相关资料仅用于行业交流。"
        self.assertEqual(extract_candidates([text]), [])

    def test_boilerplate_and_plain_numbers_are_not_model_evidence(self):
        for text in [
            "公司董事曾参与ZQ27-A系列产品研发，毕业后曾在多家企业任职并取得相关学历证书。",
            "公司推出本系列产品并于2025年实现了年度销售目标，为客户提供多种新的应用选择。",
            "公司推出本系列产品并通过ISO认证，当前产品已进入多个市场并获得广泛的关注。",
        ]:
            self.assertEqual(extract_candidates([text]), [])

    def test_exact_dedup_and_determinism(self):
        text = "在本报告期，公司布局AB42系列产品，为用户提供多种不同配置，满足复杂环境下的实际应用需要。"
        self.assertEqual(len(extract_candidates([text, text])), 1)
        self.assertEqual(extract_candidates([text]), extract_candidates([text]))


if __name__ == "__main__":
    unittest.main()
