"""Single-GPU RLCD fine-tune of Laya multilingual for A-share relevance judging.

Adapted from the official notebook laya_finetune_typed_decisions_2xT4_kaggle.ipynb
(REINFORCE with group-mean baseline + proper-scoring-rule reward + soft CE guidance),
with DDP removed for one RTX 4060 8GB and bf16 autocast instead of fp16+scaler.

Every epoch evaluates noul AUC on the frozen VAL split (data/eval/a_share_laya_val.jsonl)
and keeps both the best-by-AUC and the last checkpoint. Failures raise loudly: no fake
success. Post-training temperature fitting follows the official recipe.

Usage: .venv/Scripts/python scripts/train_laya.py --out models/a-share-laya
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
ROOT = Path(os.environ.get("ATLAS_ARTIFACT_ROOT", Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(ROOT / "scripts"))

import torch
from safetensors.torch import load_file, save_file
from laya.common import QTYPES, build_sequence

HOW = (
    "looking_for 是一个人用自己的话说想找的公司。"
    "每一题是一家候选公司，profile 是它的公开业务资料。"
    "判断这家公司的主营业务是否就是这句话在找的东西。"
    "概念标签沾边但主营无关，回答要低。"
    "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。"
    "几家公司可以同时符合。"
)

BASE_REPO = "convaiinnovations/laya"
BASE_SUBFOLDER = "multilingual"


def collate(items, pad_id):
    n = len(items)
    L = max(len(it["ids"]) for it in items)
    kmax = max(len(it["markers"]) for it in items)
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    target = torch.zeros((n, kmax), dtype=torch.float32)
    for i, it in enumerate(items):
        ids[i, : len(it["ids"])] = torch.tensor(it["ids"])
        att[i, : len(it["ids"])] = 1
        k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"])
        mmask[i, :k] = True
        target[i, : len(it["target"])] = torch.tensor(it["target"], dtype=torch.float32)
    return {
        "input_ids": ids,
        "attention_mask": att,
        "marker_pos": mpos,
        "marker_mask": mmask,
        "target": target,
        "qtype": torch.tensor([it["qtype"] for it in items]),
        "label": torch.tensor([it["label"] for it in items]),
    }


def fit_one_temp(sel):
    """Official post-training temperature fit (LBFGS on held logits), clamped."""
    if len(sel) < 10:
        return 1.0
    kmax = max(len(z) for z, _ in sel)
    Z = torch.full((len(sel), kmax), -1e4)
    T = torch.zeros((len(sel), kmax))
    for i, (z, t) in enumerate(sel):
        Z[i, : len(z)] = torch.tensor(z)
        T[i, : len(t)] = torch.tensor(t, dtype=torch.float32)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = -(T * torch.log_softmax(Z / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss

    opt.step(closure)
    return float(torch.clamp(log_t.exp(), 0.5, 5.0).item())


@torch.no_grad()
def val_noul_auc(model, tok, device):
    """Frozen VAL split, noul questions in the exact production shape."""
    rows = [json.loads(line) for line in (ROOT / "data/eval/a_share_laya_val.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    by_query = defaultdict(list)
    for r in rows:
        by_query[r["query_id"]].append(r)
    model.eval()
    pairs = []
    for qid, group in sorted(by_query.items()):
        state = {"looking_for": group[0]["query"][:300], "how_to_judge": HOW}
        questions = {
            f"c{i}": {
                "t": "noul",
                # 与生产 sidecar 的 sidecar_ins 一致:ensure_ascii=False 原生中文
                "ins": json.dumps(
                    {
                        "company": {"name": r["name"], "code": r["code"], "profile": r["judgeText"]},
                        "question": "company 是否符合 looking_for 要找的公司？",
                        "yes": "主营业务就是这句话在找的，地域等硬条件也对得上。",
                        "no": "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
                    },
                    ensure_ascii=False,
                ),
                "crit": {},
            }
            for i, r in enumerate(group)
        }
        items = []
        for qid_q, q in questions.items():
            seq, markers = build_sequence(tok, state, q, 2048, 512)
            items.append({"ids": seq, "markers": markers, "qtype": QTYPES["noul"], "target": [0.0, 0.0], "label": -1})
        batch = collate(items, tok.pad_token_id)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits, _ = model(
                batch["input_ids"].to(device),
                batch["attention_mask"].to(device),
                batch["marker_pos"].to(device),
                batch["marker_mask"].to(device),
                batch["qtype"].to(device),
            )
        logits = logits.float().cpu()
        for i, r in enumerate(group):
            k = len(items[i]["markers"])
            z = logits[i, :k]
            p = torch.softmax(z, -1)[1].item()  # noul: index 1 = true
            pairs.append((int(r["label"] >= 2), p))
    model.train()
    pos = [p for rel, p in pairs if rel]
    neg = [p for rel, p in pairs if not rel]
    if not pos or not neg:
        return float("nan")
    wins = sum(1 for a in pos for b in neg if a > b) + 0.5 * sum(1 for a in pos for b in neg if a == b)
    return wins / (len(pos) * len(neg))


def save_checkpoint(model, tok, cfg, out_dir: Path, temperatures=None, meta_note=""):
    out_dir.mkdir(parents=True, exist_ok=True)
    sd = {k: v.half().contiguous().cpu() for k, v in model.state_dict().items()}
    # Windows:Defender 会短暂锁住新写入的大文件(拒绝访问),目标与 tmp 都可能被锁。
    # 宽捕获 + 递增退避 + 每次换唯一 tmp 名;重试耗尽才允许失败。
    target = out_dir / "model.safetensors"
    last_error = None
    for attempt in range(6):
        tmp = out_dir / f"model.safetensors.tmp{attempt}"
        try:
            save_file(sd, str(tmp))
            os.replace(str(tmp), str(target))
            for older in out_dir.glob("model.safetensors.tmp*"):
                older.unlink(missing_ok=True)
            break
        except Exception as error:  # safetensors raises its own error type
            last_error = error
            print(f"  save retry {attempt + 1}: {error}", flush=True)
            time.sleep(1.5 * (attempt + 1))
    else:
        raise last_error
    model.encoder.config.save_pretrained(out_dir / "encoder")
    tok.save_pretrained(out_dir / "tokenizer")
    cfg_out = copy.deepcopy(cfg)
    if temperatures:
        cfg_out["temperature"] = temperatures
    cfg_out["fine_tuned"] = True
    cfg_out["model_name"] = "laya-a-share-v1"
    if meta_note:
        cfg_out["a_share_training"] = meta_note
    (out_dir / "rl_agent_config.json").write_text(json.dumps(cfg_out, ensure_ascii=False, indent=2), encoding="utf-8")



if __name__ == "__main__":
    raise SystemExit("Helper module only; use the unified named RLCD run.")
