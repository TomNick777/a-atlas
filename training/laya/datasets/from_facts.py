"""Reviewable rule-labelled continuation set; never modifies production facts."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from artifacts import ROOT, sha, atomic_json, private_path
from groups import isolate, validate_coverage

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exclude-manifest", required=True)
    parser.add_argument("--templates", required=True, help="Frozen capability-prompt examples, not model responses")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = private_path(args.out, "data")
    if output.exists():
        raise ValueError("Dataset output exists; do not overwrite frozen labels")
    exclusions = json.loads(Path(args.exclude_manifest).read_text(encoding="utf-8"))
    excluded = set(exclusions["excludedCompanies"])
    corpus_file = ROOT / "data/company-corpus/companies.jsonl"
    facts_file = ROOT / "data/source_facts/facts.jsonl"
    rows = {row["symbol"]: row for row in map(json.loads, corpus_file.read_text(encoding="utf-8").splitlines())}
    facts = {fact["factId"]: fact for fact in map(json.loads, facts_file.read_text(encoding="utf-8").splitlines())}
    source_templates = json.loads(Path(args.templates).read_text(encoding="utf-8"))
    templates = {task["capability"]: task for task in source_templates["tasks"]}
    tasks, audit, counts = [], [], {}

    def split(code):
        bucket = int(hashlib.sha256(code.encode()).hexdigest()[:4], 16) % 10
        return "validation" if bucket == 0 else "blind" if bucket == 1 else "train"

    def append(row, span, capability, query, label, rationale):
        template = templates[capability]
        question = json.loads(json.dumps(template["question"]))
        question["instructions"]["company"] = {"name": row["name"], "code": row["symbol"], "profile": span["text"][:420]}
        target = [1 - label, 0, 0, label] if capability == "semantic_comparison" else [1 - label, label]
        tasks.append({"capability": capability, "groupId": row["symbol"], "split": split(row["symbol"]), "labelSource": "deterministic-rule", "labelRationale": rationale, "label": label * 3, "target": target, "state": {"looking_for": query[:300], "how_to_judge": template["state"]["how_to_judge"]}, "question": question, "evidenceRefs": [{"companyId": row["symbol"], "ref": span["evidence"], "text": span["text"]}], "sourceProvenance": facts.get(span["evidence"], {}).get("source", row["sources"])})

    for row in rows.values():
        if row["symbol"] in excluded:
            continue
        for span in row.get("evidenceSpans", []):
            source = facts.get(span["evidence"], {}).get("source", {}).get("sourceId", "")
            text, pairs, kind = span["text"], [], None
            if source.startswith("cninfo:announcement#bid:planned") and re.search(r"尚处|预中标|拟中标|为.{0,12}中标候选", text) and not re.search(r"收到.{0,40}中标通知|确认.{0,40}中标单位|签署.{0,20}合同", text):
                kind = "bid-planned"
                pairs = [("公司仍处于候选或预中标阶段", 1), ("公司已获得正式中标通知", 0), ("相关项目已通过竣工验收", 0)]
            elif source.startswith("cninfo:announcement#bid:confirmed") and "中标通知" in text:
                kind = "bid-confirmed"
                pairs = [("公司已获得正式中标通知", 1)]
                if "候选" not in text and "预中标" not in text and "拟中标" not in text:
                    pairs.append(("公司仍处于候选或预中标阶段", 0))
                if not any(word in text for word in ("竣工", "验收", "交付完成")):
                    pairs.append(("相关项目已通过竣工验收", 0))
            elif source.startswith("cninfo:announcement#cooperation:planned") and any(word in text for word in ("拟签", "拟与", "计划", "拟开展")):
                kind = "cooperation-planned"
                pairs = [("披露了一项拟开展或拟签署的合作安排", 1), ("文中合作已经完成签约并全部履行结束", 0)]
            elif "送样" in text and any(word in text for word in ("不确定", "验证", "测试")):
                kind = "sampling"
                pairs = [("文中提到开展送样验证或测试，属于客户认证与开拓过程", 1), ("资料证实文中全部送样产品都已通过验证并形成稳定大批量订单", 0)]
            elif source.startswith("cninfo:announcement#customer:confirmed:sells_to") and "供货合同" in text and re.search(r"(公司|子公司).{0,65}签订.{0,25}供货合同", text):
                kind = "supplier-direction"
                pairs = [("公司在文中供货合同中是供方，客户是需方", 1), ("文中客户反过来向本公司供应同一产品，公司是采购方", 0)]
            if not pairs and re.search(r"项目.{0,8}已完成.{0,6}竣工验收|项目.{0,8}已通过.{0,6}竣工验收", text) and not re.search(r"(尚未|未能|计划|预计|拟|将).{0,14}(完成|验收|交付)", text):
                kind = "completed-delivery"
                pairs = [("相关项目已通过竣工验收", 1)]
            if not pairs or counts.get(kind, 0) >= 30:
                continue
            counts[kind] = counts.get(kind, 0) + 1
            if sum(sample["kind"] == kind for sample in audit) < 5:
                audit.append({"kind": kind, "code": row["symbol"], "text": text, "source": source, "labels": pairs})
            pairs.append(("截至今日该项目或合作依然持续履行，没有任何变化", 0))
            for query, label in pairs:
                for capability in ("semantic_relation", "evidence_explanation"):
                    append(row, span, capability, query, label, "Source strength and exact lexical gate: confirmation does not establish completion/current continuity; sampling does not establish all-product mass supply. Label is evidential support, not a claim about undisclosed reality.")
            break

    added = 0
    for row in rows.values():
        if row["symbol"] in excluded or not row.get("business"):
            continue
        business = row["business"][0]
        if not 8 <= len(business) <= 140:
            continue
        if business not in row["searchableText"][:420]:
            continue
        others = [candidate for candidate in rows.values() if candidate["symbol"] not in excluded and candidate["identity"]["industry"] != row["identity"]["industry"] and candidate.get("business") and 12 <= len(candidate["business"][0]) <= 130 and candidate["business"][0] not in row["searchableText"]]
        if not others:
            continue
        other = others[int(hashlib.sha256(row["symbol"].encode()).hexdigest()[:8], 16) % len(others)]
        span = {"evidence": "corpus-profile:" + row["symbol"], "text": row["searchableText"]}
        for query, label in [("找主营业务为" + business, 1), ("找主营业务为" + other["business"][0], 0)]:
            for capability in ("semantic_match", "semantic_comparison"):
                append(row, span, capability, query, label, "Positive is disclosed primary business; negative is a different-industry business absent from supplied facts. Rule label, never teacher score.")
        added += 1
        if added == 40:
            break
    original_count = len(tasks)
    for task in tasks:
        task["companyGroupId"] = task["groupId"]
        source = task["sourceProvenance"]
        source = source if isinstance(source, dict) else {}
        # Shared disclosure artifacts cannot cross splits, even across companies.
        task["sourceGroupId"] = source.get("artifactSha256") or source.get("artifactSha") or (source.get("locator", "").split("#", 1)[0]) or task["evidenceRefs"][0]["ref"]
        # All generated rephrasings of a claim must retain this family ID.
        task["queryGroupId"] = hashlib.sha256(task["state"]["looking_for"].strip().encode()).hexdigest()
    tasks = isolate(tasks, balanced=True)
    validate_coverage(tasks)
    if not tasks:
        raise ValueError("No evidence remains after group isolation")
    output.mkdir(parents=True)
    manifest = {"schemaVersion": 1, "mode": "corpus", "purpose": "product continuation with rule labels; independent qualification required", "corpusSha256": sha(corpus_file), "sourceFactsSha256": sha(facts_file), "tokenizerModel": "v4.1", "maxLen": 1024, "headMaxLen": 512, "groupPolicy": "company/source/query-family disjoint v3; stratified reviewed labels; incompatible cross-group pairs excluded", "tasksBeforeIsolation": original_count, "exclusionManifestSha256": sha(Path(args.exclude_manifest)), "excludedGroups": sorted(excluded), "tasks": tasks}
    atomic_json(output / "source.json", manifest)
    (output / "source.sha256").write_text(sha(output / "source.json") + "\n")
    atomic_json(output / "label-audit.json", {"labelSource": "deterministic rules; needs review, no human sign-off claimed", "counts": counts, "samples": audit})
    print(json.dumps({"tasks": len(tasks), "kinds": counts, "splits": {split: sum(task["split"] == split for task in tasks) for split in ("train", "validation", "blind")}, "sourceSha256": sha(output / "source.json")}))

if __name__ == "__main__":
    main()
