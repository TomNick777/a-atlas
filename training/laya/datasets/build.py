"""Tokenize reviewed, evidence-bound tasks; frozen evaluation groups never train."""
from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path
os.environ.setdefault("USE_TF", "0")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from artifacts import ROOT, atomic_json, sha, model_path, private_path

CAPABILITIES = {"semantic_match": "noul", "semantic_relation": "noul", "semantic_comparison": "score", "evidence_explanation": "noul"}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["corpus", "legacy"], required=True)
    parser.add_argument("--manifest", required=True, help="Private reviewed source manifest JSON path")
    args = parser.parse_args()
    source = private_path(args.manifest, "data")
    seal = source.with_suffix(".sha256")
    if not seal.exists() or seal.read_text().strip() != sha(source):
        raise ValueError("Source manifest must be sealed before tokenization")
    manifest = json.loads(source.read_text(encoding="utf-8"))
    if manifest["mode"] != args.mode:
        raise ValueError("Dataset mode does not match manifest")
    corpus = ROOT / "data/company-corpus/companies.jsonl"
    if args.mode == "corpus" and sha(corpus) != manifest["corpusSha256"]:
        raise ValueError("Frozen corpus identity mismatch")
    rows = {row["symbol"]: row for row in (json.loads(line) for line in corpus.read_text(encoding="utf-8").splitlines())} if args.mode == "corpus" else {}
    groups = {}
    tasks = manifest["tasks"]
    if args.mode == "corpus":
        from groups import validate
        validate(tasks)
    if not tasks:
        raise ValueError("No reviewed tasks")
    for task in tasks:
        if task["capability"] not in CAPABILITIES or task["labelSource"] not in ("human-reviewed", "existing-teacher", "deterministic-rule", "agent-reviewed") or not task["evidenceRefs"]:
            raise ValueError("Task requires supported capability, reviewed label and evidence references")
        group, split = task["groupId"], task["split"]
        if split not in ("train", "validation", "blind") or (group in groups and groups[group] != split):
            raise ValueError("Invalid split or group leakage")
        groups[group] = split
        if task["question"]["type"] != CAPABILITIES[task["capability"]]:
            raise ValueError("Task head violates capability contract")
        if args.mode == "corpus":
            # Exact text/refs must resolve in frozen corpus; labels never enrich facts.
            for ref in task["evidenceRefs"]:
                if not (ref["ref"] == "corpus-profile:" + ref["companyId"] and ref["text"] == rows.get(ref["companyId"], {}).get("searchableText")) and not any(ref["text"] == span.get("text") and ref["ref"] == span.get("evidence") for span in rows.get(ref["companyId"], {}).get("evidenceSpans", [])):
                    raise ValueError("Task evidence text is absent from corpus")
    from transformers import AutoTokenizer
    import torch
    from laya.common import build_sequence, QTYPES
    from laya.agent import Agent
    checkpoint, model = model_path(manifest["tokenizerModel"])
    tokenizer = AutoTokenizer.from_pretrained(checkpoint / "tokenizer", local_files_only=True)
    items = []
    for task in tasks:
        question = dict(task["question"])
        if not isinstance(question.get("instructions"), str):
            question["instructions"] = json.dumps(question.get("instructions", ""), ensure_ascii=False)
        sequence = build_sequence(tokenizer, task["state"], Agent._to_internal(question), manifest.get("maxLen", 2048), manifest.get("headMaxLen", 512))
        ids, markers = sequence[:2]
        target = task["target"]
        if len(markers) != len(target) or abs(sum(target) - 1) > 1e-6 or any(v < 0 for v in target):
            raise ValueError("Invalid target distribution")
        items.append({"ids": ids, "markers": markers, "target": target, "qtype": QTYPES[question["type"]], "label": task["label"], "split": task["split"], "groupId": task["groupId"], "capability": task["capability"]})
    output = source.parent / "items.pt"
    temporary = output.with_suffix(".tmp")
    torch.save(items, temporary)
    os.replace(temporary, output)
    atomic_json(source.parent / "tokenized.json", {"schemaVersion": 1, "source": str(source.relative_to(ROOT)), "sourceSha256": sha(source), "items": str(output.relative_to(ROOT)), "itemsSha256": sha(output), "tokenizerSha256": model["sha256"], "count": len(items), "groups": groups})
    print(json.dumps({"items": str(output.relative_to(ROOT)), "count": len(items)}))

if __name__ == "__main__":
    main()
