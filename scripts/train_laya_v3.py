"""V3 reranker fine-tune: ranking-oriented Laya training on the RTX 4060.

Changes vs the V2 trainer (train_laya.py), all traceable to the root-cause audit:
  1. Query-grouped batching — micro-batches are drawn from one query at a time, so
     the new pairwise ranking loss has same-query negatives to work with.
  2. Pairwise margin loss on the score head's expected grade (differentiable
     E[level] = Σ softmax·[0,1,2,3]) — directly optimizes ordering inside a query,
     the thing V2 never trained (audit root cause G).
  3. Softened noul targets (from build_laya_items_v3) — no more saturated 1.0.
  4. Checkpoint selection by per-query nDCG@10 on the frozen VAL split (score head),
     alongside noul AUC; both logged. V2 checkpoint stays untouched.

Usage: .venv/Scripts/python scripts/train_laya_v3.py --out models/a-share-laya-v3
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

sys.path.insert(0, str(ROOT / "scripts"))
from train_laya import HOW, collate, fit_one_temp, save_checkpoint  # noqa: E402

BASE_REPO = "convaiinnovations/laya"
BASE_SUBFOLDER = "multilingual"
LEVELS = torch.tensor([0.0, 1.0, 2.0, 3.0])


@torch.no_grad()
def val_metrics(model, tok, device):
    """Frozen VAL split: noul AUC (production shape) + score-head nDCG@10 per query."""
    rows = [json.loads(line) for line in (ROOT / "data/eval/a_share_laya_val.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    by_query = defaultdict(list)
    for r in rows:
        by_query[r["query_id"]].append(r)
    model.eval()

    def build_items(group, qtype_key):
        items = []
        for i, r in enumerate(group):
            state = {"looking_for": group[0]["query"][:300], "how_to_judge": HOW}
            ins = json.dumps(
                {
                    "company": {"name": r["name"], "code": r["code"], "profile": r.get("profileText") or r.get("judgeText") or ""},
                    "question": (
                        "company 是否符合 looking_for 要找的公司？"
                        if qtype_key == "noul"
                        else "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。"
                    ),
                    **({} if qtype_key == "score" else {
                        "yes": "主营业务就是这句话在找的，地域等硬条件也对得上。",
                        "no": "只是概念沾边、名字像、或者属于这句话明确排除的那一类。",
                    }),
                },
                ensure_ascii=False,
            )
            crit = [ "0=无关:主营业务与查询要找的无关", "1=沾边:概念/名字/大类相邻,主营业务并不符合", "2=部分相关:产业链上下游,或组合条件只满足一半", "3=直接相关:主营业务就是查询要找的东西"] if qtype_key == "score" else {}
            seq, markers = build_sequence(tok, state, {"t": qtype_key, "ins": ins, "crit": crit}, 2048, 512)
            items.append({"ids": seq, "markers": markers, "qtype": QTYPES[qtype_key], "target": [0.0] * len(markers), "label": -1})
        return items

    auc_pairs, ndcgs = [], []
    for qid, group in sorted(by_query.items()):
        for qtype_key, collect in (("noul", "auc"), ("score", "ndcg")):
            items = build_items(group, qtype_key)
            scores_out = []
            for at in range(0, len(items), 16):
                batch = collate(items[at : at + 16], tok.pad_token_id)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    logits, _ = model(
                        batch["input_ids"].to(device),
                        batch["attention_mask"].to(device),
                        batch["marker_pos"].to(device),
                        batch["marker_mask"].to(device),
                        batch["qtype"].to(device),
                    )
                logits = logits.float().cpu()
                for j in range(logits.shape[0]):
                    k = len(items[at + j]["markers"])
                    z = logits[j, :k]
                    probs = torch.softmax(z, -1)
                    if qtype_key == "noul":
                        scores_out.append(probs[1].item())
                    else:
                        scores_out.append(float((probs * LEVELS[:k]).sum().item()))
            if collect == "auc":
                for r, p in zip(group, scores_out):
                    auc_pairs.append((int(r["label"] >= 2), p))
            else:
                order = sorted(zip(group, scores_out), key=lambda t: -t[1])
                gains = [2 ** int(r["label"]) - 1 if r["label"] >= 2 else 0.0 for r, _ in order]
                ideal = sorted(gains, reverse=True)
                dcg = sum(g / math.log2(pos + 2) for pos, g in enumerate(gains[:10]))
                idcg = sum(g / math.log2(pos + 2) for pos, g in enumerate(ideal[:10]))
                if idcg > 0:
                    ndcgs.append(dcg / idcg)
    model.train()
    pos = [p for rel, p in auc_pairs if rel]
    neg = [p for rel, p in auc_pairs if not rel]
    auc = float("nan")
    if pos and neg:
        wins = sum(1 for a in pos for b in neg if a > b) + 0.5 * sum(1 for a in pos for b in neg if a == b)
        auc = wins / (len(pos) * len(neg))
    return auc, sum(ndcgs) / max(1, len(ndcgs))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="models/a-share-laya-v3")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--micro-batch", type=int, default=8)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--pairwise-weight", type=float, default=0.5)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
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

    items = torch.load(ROOT / "data/train/v3_train_items.pt", weights_only=False)
    by_query: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        by_query[it["meta"]["query_id"]].append(it)
    n_score = sum(1 for it in items if it["qtype"] == QTYPES["score"])
    print(f"device={device} items={len(items)} (score {n_score}) queries={len(by_query)} epochs={args.epochs}", flush=True)

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
    best_ndcg, best_epoch = -1.0, -1

    def flush_batches(batch_items):
        """One optimizer step-worth of forward/backward for a list of items."""
        batch = collate(batch_items, tok.pad_token_id)
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

        # pairwise ranking loss on the score head's expected grade (same-query items)
        # sync-free: torch.where + sums instead of any()/boolean-mask indexing —
        # data-dependent syncs stall the deep CUDA queue (observed 4x slowdown).
        loss_rank = torch.zeros((), device=device)
        score_rows = [
            i for i, it in enumerate(batch_items)
            if it["qtype"] == QTYPES["score"]
        ]
        if len(score_rows) >= 2:
            probs = torch.softmax(logits.masked_fill(~mask, -1e4), -1)
            grades = torch.zeros(logits.shape[0], device=device)
            for i in score_rows:
                kk = len(batch_items[i]["markers"])
                grades[i] = (probs[i, :kk] * LEVELS[:kk].to(device)).sum()
            labels = torch.tensor([batch_items[i]["label"] for i in score_rows], device=device, dtype=torch.float32)
            g = grades[score_rows]
            hi = ((labels.unsqueeze(1) - labels.unsqueeze(0)) >= 2).float()
            diff = g.unsqueeze(1) - g.unsqueeze(0)
            loss_rank = (torch.relu(args.pairwise_margin - diff) * hi).sum() / hi.sum().clamp(min=1.0)

        loss = (loss_rl + 1.0 * loss_ce + args.pairwise_weight * loss_rank) / args.grad_accum + 0.0 * act.sum()
        loss.backward()
        return loss.detach() * args.grad_accum, loss_rank.detach()

    for epoch in range(args.epochs):
        sigma = SIGMA_START + (SIGMA_END - SIGMA_START) * epoch / max(1, args.epochs - 1)
        qids = list(by_query.keys())
        random.shuffle(qids)
        pool: list[dict] = []
        for qid in qids:
            group = by_query[qid][:]
            random.shuffle(group)
            pool.extend(group)

        epoch_loss = torch.zeros((), device=device)
        rank_sum = torch.zeros((), device=device)
        n_batches = 0
        optimizer.zero_grad(set_to_none=True)
        accum = 0
        t0 = time.time()
        for b in range(0, len(pool), args.micro_batch):
            chunk = pool[b : b + args.micro_batch]
            if not chunk:
                continue
            loss_v, rank_v = flush_batches(chunk)
            epoch_loss += loss_v
            rank_sum += rank_v
            n_batches += 1
            accum += 1
            if accum % args.grad_accum == 0 or (b + args.micro_batch) >= len(pool):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)

        auc, ndcg = val_metrics(model, tok, device)
        entry = {
            "epoch": epoch + 1,
            "loss": round(epoch_loss.item() / max(1, n_batches), 4),
            "loss_rank": round(rank_sum.item() / max(1, n_batches), 4),
            "val_auc": round(auc, 4),
            "val_ndcg10": round(ndcg, 4),
            "sigma": round(sigma, 3),
            "seconds": round(time.time() - t0),
        }
        log["epochs"].append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

        if ndcg > best_ndcg:
            best_ndcg, best_epoch = ndcg, epoch + 1
            save_checkpoint(model, tok, cfg, out_root / "checkpoint_best", meta_note={"best_epoch": best_epoch, "val_ndcg10": round(ndcg, 4), "val_auc": round(auc, 4), "selection": "val_ndcg10"})
            print(f"  new best val_ndcg10={ndcg:.4f} (auc {auc:.4f}) -> checkpoint_best", flush=True)

    model.eval()
    calib = [it for it in items if it["qtype"] == QTYPES["noul"]][::7][:400]
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

    note = {
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "base": f"{BASE_REPO}:{BASE_SUBFOLDER}",
        "train_data": "data/train/v3_train_pairs.jsonl (6122 rows, hard negatives + acceptance mishits)",
        "objective": "RLCD + soft-target CE + pairwise grade margin loss (score head)",
        "selection": "val nDCG@10 (score head), frozen VAL split",
        "seed": args.seed,
        "epochs": args.epochs,
        "best_epoch": best_epoch,
        "best_val_ndcg10": round(best_ndcg, 4),
        "teacher": "GLM-5.3-Flash (ZCode agent, in-context)",
    }
    save_checkpoint(model, tok, cfg, out_root, temperatures=[round(t, 4) for t in temps], meta_note=note)
    save_checkpoint(model, tok, cfg, out_root / "checkpoint_last", temperatures=[round(t, 4) for t in temps], meta_note=note)
    (ROOT / "data/train/v3_train_log.json").write_text(json.dumps(log | {"final_note": note}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"saved {out_root} (best epoch {best_epoch} val_ndcg10={best_ndcg:.4f})", flush=True)


if __name__ == "__main__":
    main()
