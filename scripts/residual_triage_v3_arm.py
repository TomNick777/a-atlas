"""Residual triage V3 arm: grade the residual_triage pools with the V3 checkpoint.

Same pools, same prompts, same score head as eval_v4_1.py / eval_role_ranking.py —
this script only OBSERVES. Run while the V4.1 sidecar is STOPPED (single GPU slot
project rule); restart the sidecar afterwards.

Usage:
  .venv/Scripts/python.exe -u scripts/residual_triage_v3_arm.py \
    --checkpoint models/a-share-laya-v3/checkpoint_best \
    --out data/eval/residual_triage_grades_v3.json
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def collate(chunk):
    """Minimal copy of eval_role_ranking.collate_local (kept local to avoid importing torch there)."""
    import torch
    n = len(chunk)
    L = max(len(it["ids"]) for it in chunk)
    kmax = max(len(it["markers"]) for it in chunk)
    pad_id = tok.pad_token_id if tok.pad_token_id is not None else 0
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    for i, it in enumerate(chunk):
        ids[i, : len(it["ids"])] = torch.tensor(it["ids"])
        att[i, : len(it["ids"])] = 1
        k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"])
        mmask[i, :k] = True
    return {"input_ids": ids, "attention_mask": att, "marker_pos": mpos, "marker_mask": mmask,
            "qtype": torch.tensor([it["qtype"] for it in chunk])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--micro-batch", type=int, default=48)
    args = parser.parse_args()

    import torch
    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import QTYPES, build_model, build_sequence
    from safetensors.torch import load_file

    from eval_role_ranking import HOW, SCORE_LEVELS, SCORE_QUESTION

    LEVELS = [0.0, 1.0, 2.0, 3.0]

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))
    ckpt = Path(args.checkpoint)
    cfg = json.loads((ckpt / "rl_agent_config.json").read_text(encoding="utf-8"))
    cfg["gradient_checkpointing"] = False
    model = build_model(cfg, encoder_dir=str(ckpt / "encoder"))
    model.load_state_dict(load_file(str(ckpt / "model.safetensors")), strict=True)
    model.to(device).eval()

    pools = json.loads((ROOT / "data/eval/residual_triage_pools.json").read_text(encoding="utf-8"))
    out = {}
    t0 = time.time()
    for key, doc in pools.items():
        query = doc["query"]
        items = []
        for cand in doc["candidates"]:
            ins = json.dumps({"company": {"name": cand["name"], "code": cand["code"], "profile": cand["profile"]},
                              "question": SCORE_QUESTION}, ensure_ascii=False)
            state = {"looking_for": query[:300], "how_to_judge": HOW}
            seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
            if len(markers) != 4:
                continue
            items.append({"code": cand["code"], "name": cand["name"], "rrfRank": cand["rrfRank"],
                          "ids": seq, "markers": markers, "qtype": QTYPES["score"]})
        grades = {}
        with torch.no_grad():
            for at in range(0, len(items), args.micro_batch):
                chunk = items[at: at + args.micro_batch]
                batch = collate(chunk)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    logits, _ = model(batch["input_ids"].to(device), batch["attention_mask"].to(device),
                                      batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                                      batch["qtype"].to(device))
                logits = logits.float().cpu()
                for j, it in enumerate(chunk):
                    k = len(it["markers"])
                    probs = torch.softmax(logits[j, :k], -1) * torch.tensor(LEVELS[:k])
                    grades[it["code"]] = round(float(probs.sum()), 3)
        out[key] = {"query": query, "checkpoint": str(ckpt), "graded": len(grades),
                    "grades": [{"code": c["code"], "name": c["name"], "rrfRank": c["rrfRank"],
                                "grade": grades.get(c["code"])} for c in doc["candidates"]]}
        top = sorted(out[key]["grades"], key=lambda r: -(r["grade"] or 0))[:8]
        print(f"[v3] {key}: " + " ".join(f"{r['name']}@{r['grade']}" for r in top), flush=True)

    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[done] {len(out)} pools in {time.time() - t0:.0f}s -> {args.out}", flush=True)
