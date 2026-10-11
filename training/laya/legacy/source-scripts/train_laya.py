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
ROOT = Path(__file__).resolve().parents[1]
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="models/a-share-laya")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--micro-batch", type=int, default=8)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_model, proper_reward

    torch.manual_seed(args.seed)
    random.seed(args.seed)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        raise SystemExit("训练需要 CUDA。当前 torch 未检测到 GPU,拒绝在 CPU 上假装训练。")

    model_dir = snapshot_download(BASE_REPO, allow_patterns=[f"{BASE_SUBFOLDER}/*"])
    _fix_tokenizer_config(model_dir)
    base_dir = os.path.join(model_dir, BASE_SUBFOLDER)
    with open(os.path.join(base_dir, "rl_agent_config.json")) as f:
        cfg = json.load(f)
    cfg["gradient_checkpointing"] = True

    tok = AutoTokenizer.from_pretrained(os.path.join(base_dir, "tokenizer"))
    model = build_model(cfg, encoder_dir=os.path.join(base_dir, "encoder"))
    model.load_state_dict(load_file(os.path.join(base_dir, "model.safetensors")), strict=True)
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    model.to(device)
    model.train()

    items = torch.load(ROOT / "data/train/train_items.pt", weights_only=False)
    noul_items = [it for it in items if it["qtype"] == QTYPES["noul"]]
    print(f"device={device} items={len(items)} (noul {len(noul_items)}) epochs={args.epochs} micro={args.micro_batch} accum={args.grad_accum}", flush=True)

    enc_params = [p for n, p in model.named_parameters() if "encoder." in n]
    head_params = [p for n, p in model.named_parameters() if "encoder." not in n]
    optimizer = torch.optim.AdamW(
        [{"params": enc_params, "lr": 2.5e-5}, {"params": head_params, "lr": 1.0e-4}],
        weight_decay=0.01,
    )
    steps_per_epoch = math.ceil(len(items) / (args.micro_batch * args.grad_accum))
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, steps_per_epoch * args.epochs), eta_min=1e-6)

    GROUP_SIZE = 4
    SIGMA_START, SIGMA_END = 0.4, 0.1
    out_root = ROOT / args.out
    log = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "epochs": [], "config": vars(args) | {"base": f"{BASE_REPO}:{BASE_SUBFOLDER}"}}
    best_auc, best_epoch = -1.0, -1

    for epoch in range(args.epochs):
        random.shuffle(items)
        sigma = SIGMA_START + (SIGMA_END - SIGMA_START) * epoch / max(1, args.epochs - 1)
        epoch_loss, n_batches = 0.0, 0
        optimizer.zero_grad(set_to_none=True)
        accum = 0
        t0 = time.time()
        for b in range(0, len(items), args.micro_batch):
            chunk = items[b : b + args.micro_batch]
            if not chunk:
                continue
            batch = collate(chunk, tok.pad_token_id)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits, act = model(
                    batch["input_ids"].to(device),
                    batch["attention_mask"].to(device),
                    batch["marker_pos"].to(device),
                    batch["marker_mask"].to(device),
                    batch["qtype"].to(device),
                )
            logits = logits.float()
            mask = batch["marker_mask"].to(device)
            k = mask.sum(-1, keepdim=True).float()
            target = batch["target"].to(device)

            eps = torch.randn((GROUP_SIZE,) + logits.shape, device=device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps
            q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                r = proper_reward(q, target.unsqueeze(0), batch["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                adv = r - r.mean(0, keepdim=True)
                adv = adv / (adv.std() + 1e-6)

            logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma**2)
            loss_rl = -(adv * logp).mean()
            loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (loss_rl + 1.0 * loss_ce) / args.grad_accum + 0.0 * act.sum()

            loss.backward()
            accum += 1
            if accum % args.grad_accum == 0 or (b + args.micro_batch) >= len(items):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)

            epoch_loss += loss.item() * args.grad_accum
            n_batches += 1

        auc = val_noul_auc(model, tok, device)
        entry = {
            "epoch": epoch + 1,
            "loss": round(epoch_loss / max(1, n_batches), 4),
            "val_auc": round(auc, 4),
            "sigma": round(sigma, 3),
            "seconds": round(time.time() - t0),
        }
        log["epochs"].append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

        if auc > best_auc:
            best_auc, best_epoch = auc, epoch + 1
            save_checkpoint(model, tok, cfg, out_root / "checkpoint_best", meta_note={"best_epoch": best_epoch, "val_auc": round(auc, 4)})
            print(f"  new best val_auc={auc:.4f} -> checkpoint_best", flush=True)

    # 最终保存 + 官方式的温度拟合(用训练 noul 项的最终 logits)
    model.eval()
    calib = noul_items[::7][:400]
    preds = []
    with torch.no_grad():
        for i in range(0, len(calib), 16):
            chunk = calib[i : i + 16]
            cb = collate(chunk, tok.pad_token_id)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                l_sub, _ = model(
                    cb["input_ids"].to(device),
                    cb["attention_mask"].to(device),
                    cb["marker_pos"].to(device),
                    cb["marker_mask"].to(device),
                    cb["qtype"].to(device),
                )
            for j, it in enumerate(chunk):
                kk = len(it["markers"])
                preds.append((it["qtype"], l_sub[j, :kk].float().cpu().numpy(), it["target"][:kk]))
    temps = [1.0, 1.0, 1.0]
    for qt in range(3):
        sel = [(z, t) for t_, z, t in preds if t_ == qt]
        if sel:
            temps[qt] = fit_one_temp(sel)
    print("fitted noul temperature:", round(temps[2], 3), flush=True)

    note = {
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "base": f"{BASE_REPO}:{BASE_SUBFOLDER}",
        "train_pool_sha256_16": json.loads((ROOT / "data/train/manifest.json").read_text(encoding="utf-8"))["train_pool_sha256_16"],
        "test_pool_sha256_16": json.loads((ROOT / "data/train/manifest.json").read_text(encoding="utf-8"))["test_pool_sha256_16"],
        "seed": args.seed,
        "epochs": args.epochs,
        "best_epoch": best_epoch,
        "best_val_auc": round(best_auc, 4),
        "teacher": "GLM-5.3-Flash (ZCode agent, in-context)",
        "method": "RLCD per official laya fine-tune notebook, single-GPU adaptation",
    }
    save_checkpoint(model, tok, cfg, out_root, temperatures=[round(t, 4) for t in temps], meta_note=note)
    save_checkpoint(model, tok, cfg, out_root / "checkpoint_last", temperatures=[round(t, 4) for t in temps], meta_note=note)
    (ROOT / "data/train/train_log.json").write_text(json.dumps(log | {"final_note": note}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"saved {out_root} (best epoch {best_epoch} val_auc={best_auc:.4f})", flush=True)


if __name__ == "__main__":
    main()
