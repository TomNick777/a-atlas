"""Audit training token budgets on CPU; no inference, downloads, labels or weights changed."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import sys

os.environ.setdefault("USE_TF", "0")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def diagnose(tokenizer, task, max_len, head_max_len):
    from laya.agent import Agent
    from laya.common import build_sequence, render_options, serialize_state

    question = dict(task["question"])
    if not isinstance(question.get("instructions"), str):
        question["instructions"] = json.dumps(question.get("instructions", ""), ensure_ascii=False)
    internal = Agent._to_internal(question)
    ids, markers = build_sequence(tokenizer, task["state"], internal, max_len, head_max_len)[:2]
    encode = lambda text: tokenizer(text, add_special_tokens=False)["input_ids"]
    ins = str(internal["ins"]).replace(tokenizer.mask_token, " ")
    head = encode(f'{internal["t"]} question: {ins}')
    options = render_options(internal)
    option_lengths = [1 + min(48, len(encode(" " + option.replace(tokenizer.mask_token, " ")))) for option in options]
    option_budget = head_max_len - sum(option_lengths)
    if option_budget < 16:
        per_option = max(4, (head_max_len - 16) // max(1, len(options)))
        option_lengths = [min(length, per_option) for length in option_lengths]
        option_budget = head_max_len - sum(option_lengths)
    kept_head = min(len(head), max(8, option_budget))
    state = encode(serialize_state(task["state"]).replace(tokenizer.mask_token, " "))
    room = max(0, max_len - (3 + kept_head + sum(option_lengths)) - 1)
    return {
        "instructionTruncated": int(len(head) > kept_head),
        "stateTruncated": int(len(state) > room),
        "markerMismatch": int(len(markers) != len(task["target"])),
        "sequenceAtLimit": int(len(ids) >= max_len),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--runtime-max-len", type=int, default=int(os.environ.get("LAYA_MAX_LEN", "2048")))
    parser.add_argument("--runtime-head-max-len", type=int, default=int(os.environ.get("LAYA_HEAD_MAX_LEN", "512")))
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise ValueError("Diagnostic output already exists; observations cannot be overwritten")
    raw = Path(args.manifest).read_bytes()
    manifest = json.loads(raw)
    from training.laya.artifacts import model_path
    from transformers import AutoTokenizer
    checkpoint, model = model_path(manifest["tokenizerModel"])
    tokenizer = AutoTokenizer.from_pretrained(checkpoint / "tokenizer", local_files_only=True)
    budgets = {
        "training": (manifest.get("maxLen", 2048), manifest.get("headMaxLen", 512)),
        "runtime": (args.runtime_max_len, args.runtime_head_max_len),
    }
    if any(min(values) <= 0 for values in budgets.values()):
        raise ValueError("Token budgets must be positive")
    groups = {}
    for task in manifest["tasks"]:
        key = f'{task["split"]}/{task["capability"]}'
        bucket = groups.setdefault(key, {name: Counter() for name in budgets})
        for name, (max_len, head_max_len) in budgets.items():
            bucket[name].update({"tasks": 1, **diagnose(tokenizer, task, max_len, head_max_len)})
    report = {
        "schemaVersion": 1,
        "purpose": "input-budget-diagnostic-only; no prediction or quality claim",
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "tokenizerModel": manifest["tokenizerModel"],
        "registeredModelSha256": model["sha256"],
        "budgets": budgets,
        "groups": groups,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
