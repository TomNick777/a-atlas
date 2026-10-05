"""V4 vs V3 rerank inference performance (spec §25): same frozen pool, same device.

Times a full Top-200 rerank (2 chunks of 100, production shape) per checkpoint,
30 reps each → p50/p95; records peak VRAM. Retrieval is frozen and identical, so
the rerank delta is the whole deployment-cost story.

Usage:
  .venv/Scripts/python.exe -u scripts/laya_v4_perf.py \
    --a models/a-share-laya-v3/checkpoint_best --tag-a v3 \
    --b models/a-share-laya-v4/checkpoint_best --tag-b v4 \
    --out reports/v4_eval/perf.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from eval_role_ranking import HOW, SCORE_LEVELS, SCORE_QUESTION, LEVELS, collate_local  # noqa: E402

BENCH_QUERY = "半导体ALD设备厂商"
POOL_CODE_SOURCE = "data/eval/stage3_1_focus_pools.json"


def build_pool(tok):
    from laya.common import QTYPES, build_sequence
    doc = json.loads((ROOT / POOL_CODE_SOURCE).read_text(encoding="utf-8"))
    q = next(q for q in doc["queries"] if q["expect"] == "equipment" and "ALD" in q["group"])
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    items = []
    for cand in q["candidates"]:
        code = cand["code"]
        c = companies.get(code)
        if c is None:
            continue
        profile = profiles.get(code, {}).get("searchText") or c["judgeText"]
        ins = json.dumps({"company": {"name": c["name"], "code": code, "profile": profile},
                          "question": SCORE_QUESTION}, ensure_ascii=False)
        state = {"looking_for": BENCH_QUERY[:300], "how_to_judge": HOW}
        seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
        if len(markers) != 4:
            continue
        items.append({"code": code, "ids": seq, "markers": markers, "qtype": QTYPES["score"]})
    return items


def bench(model, tok, items, reps=30):
    import torch
    times = []
    with torch.no_grad():
        for _ in range(reps):
            t0 = time.time()
            for at in range(0, len(items), 100):
                chunk = items[at : at + 100]
                batch = collate_local(chunk, tok.pad_token_id)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    model(batch["input_ids"].to("cuda"), batch["attention_mask"].to("cuda"),
                          batch["marker_pos"].to("cuda"), batch["marker_mask"].to("cuda"),
                          batch["qtype"].to("cuda"))
            torch.cuda.synchronize()
            times.append(time.time() - t0)
    return {
        "rerank200_p50_s": round(statistics.median(times), 3),
        "rerank200_p95_s": round(sorted(times)[int(0.95 * (len(times) - 1))], 3),
        "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", required=True)
    parser.add_argument("--tag-a", default="v3")
    parser.add_argument("--b", default=None)
    parser.add_argument("--tag-b", default="v4")
    parser.add_argument("--out", required=True)
    parser.add_argument("--reps", type=int, default=30)
    args = parser.parse_args()

    import torch
    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_model
    from safetensors.torch import load_file

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))
    items = build_pool(tok)
    print(f"perf pool: {len(items)} candidates, query={BENCH_QUERY!r}, reps={args.reps}", flush=True)

    results = {}
    for path, tag in ((args.a, args.tag_a), (args.b, args.tag_b)):
        if not path:
            continue
        ckpt = Path(path)
        cfg = json.loads((ckpt / "rl_agent_config.json").read_text(encoding="utf-8"))
        cfg["gradient_checkpointing"] = False
        model = build_model(cfg, encoder_dir=str(ckpt / "encoder"))
        model.load_state_dict(load_file(str(ckpt / "model.safetensors")), strict=True)
        model.to("cuda").eval()
        torch.cuda.reset_peak_memory_stats()
        bench(model, tok, items, 5)  # warmup
        results[tag] = {"checkpoint": str(ckpt), **bench(model, tok, items, args.reps)}
        print(tag, json.dumps(results[tag]), flush=True)
        del model
        torch.cuda.empty_cache()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"pool": len(items), "results": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("saved", out)


if __name__ == "__main__":
    main()
