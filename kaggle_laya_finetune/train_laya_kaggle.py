"""Kaggle 2xT4 DDP version of the A-share Laya fine-tune (fallback path).

Local training on the RTX 4060 is the primary path (scripts/train_laya.py). This
script is the official-notebook DDP adaptation for Kaggle's 2xT4 if a bigger run
is ever needed. Same data: data/train/train_items.pt (portable plain-dict items).

Kaggle setup:
  1. New Dataset: upload data/train/train_items.pt and this file.
  2. New Notebook, Accelerator = GPU T4 x2, Internet on.
  3. !pip install -q "laya>=0.3.5" && python -c "import laya" (warm the wheel)
  4. Copy the dataset into /kaggle/working, then:
       torchrun --standalone --nproc_per_node=2 train_laya_kaggle.py /kaggle/working/train_items.pt /kaggle/working/laya_a_share
  5. Download /kaggle/working/laya_a_share -> models/a-share-laya
"""

import copy
import json
import math
import os
import random
import sys
import time

import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer
from huggingface_hub import snapshot_download
from laya.agent import _fix_tokenizer_config
from laya.common import QTYPES, build_model, proper_reward

os.environ.setdefault("USE_TF", "0")

BASE = "convaiinnovations/laya"
SUBFOLDER = "multilingual"


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
        "input_ids": ids, "attention_mask": att, "marker_pos": mpos, "marker_mask": mmask,
        "target": target, "qtype": torch.tensor([it["qtype"] for it in items]),
        "label": torch.tensor([it["label"] for it in items]),
    }


def main():
    dist.init_process_group("nccl")
    rank = dist.get_rank()
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    device = torch.device("cuda", local_rank)
    torch.manual_seed(42 + rank)
    random.seed(42)

    items_path, out_path = sys.argv[1], sys.argv[2]
    model_dir = snapshot_download(BASE, allow_patterns=[f"{SUBFOLDER}/*"])
    _fix_tokenizer_config(model_dir)
    base_dir = os.path.join(model_dir, SUBFOLDER)
    with open(os.path.join(base_dir, "rl_agent_config.json")) as f:
        cfg = json.load(f)
    cfg["gradient_checkpointing"] = True

    tok = AutoTokenizer.from_pretrained(os.path.join(base_dir, "tokenizer"))
    model = build_model(cfg, encoder_dir=os.path.join(base_dir, "encoder"))
    model.load_state_dict(load_file(os.path.join(base_dir, "model.safetensors")), strict=True)
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.to(device)
    model.train()
    ddp = DDP(model, device_ids=[local_rank], find_unused_parameters=True)

    items = torch.load(items_path, weights_only=False)
    mine = items[rank::dist.get_world_size()]
    EPOCHS, MICRO, ACCUM = 8, 8, 2
    GROUP = 4
    optimizer = torch.optim.AdamW(
        [{"params": [p for n, p in ddp.named_parameters() if "encoder." in n], "lr": 2.5e-5},
         {"params": [p for n, p in ddp.named_parameters() if "encoder." not in n], "lr": 1.0e-4}],
        weight_decay=0.01,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, (len(mine) // (MICRO * ACCUM)) * EPOCHS), eta_min=1e-6)

    for epoch in range(EPOCHS):
        random.shuffle(mine)
        sigma = 0.4 + (0.1 - 0.4) * epoch / max(1, EPOCHS - 1)
        accum, t0 = 0, time.time()
        for b in range(0, len(mine), MICRO):
            chunk = mine[b : b + MICRO]
            if not chunk:
                continue
            batch = collate(chunk, tok.pad_token_id)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits, act = ddp(
                    batch["input_ids"].to(device), batch["attention_mask"].to(device),
                    batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                    batch["qtype"].to(device),
                )
            logits = logits.float()
            mask = batch["marker_mask"].to(device)
            k = mask.sum(-1, keepdim=True).float()
            target = batch["target"].to(device)
            eps = torch.randn((GROUP,) + logits.shape, device=device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps
            q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                r = proper_reward(q, target.unsqueeze(0), batch["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                adv = r - r.mean(0, keepdim=True)
                adv = adv / (adv.std() + 1e-6)
            logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma**2)
            loss = (-(adv * logp).mean() + 1.0 * -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()) / ACCUM + 0.0 * act.sum()
            loss.backward()
            accum += 1
            if accum % ACCUM == 0 or (b + MICRO) >= len(mine):
                torch.nn.utils.clip_grad_norm_(ddp.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
        if rank == 0:
            print(f"epoch {epoch+1}/{EPOCHS} in {time.time()-t0:.0f}s", flush=True)
        dist.barrier()

    if rank == 0:
        out = os.path.join(out_path, "checkpoint_last")
        os.makedirs(out, exist_ok=True)
        sd = {k: v.half().contiguous().cpu() for k, v in model.state_dict().items()}
        save_file(sd, os.path.join(out, "model.safetensors"))
        model.encoder.config.save_pretrained(os.path.join(out, "encoder"))
        tok.save_pretrained(os.path.join(out, "tokenizer"))
        cfg_out = copy.deepcopy(cfg)
        cfg_out["fine_tuned"] = True
        cfg_out["model_name"] = "laya-a-share-v1-kaggle"
        cfg_out["temperature"] = [1.0, 1.0, 1.0]
        with open(os.path.join(out, "rl_agent_config.json"), "w") as f:
            json.dump(cfg_out, f, ensure_ascii=False, indent=2)
        print("saved", out, flush=True)
    dist.destroy_process_group()


if __name__ == "__main__":
    main()
