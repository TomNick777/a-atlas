"""V4.1 prior-correction fine-tune (LAYA_V4_1 spec §二/§十六/§十九/§二十七).

Continued training FROM the V4 checkpoint (models/a-share-laya-v4-candidate/
checkpoint_best) — never a V3 restart (§二). Loss is IDENTICAL to V4 (RLCD +
soft-target CE + role-banded pairwise margin + ListNet listwise): the correction
is a training-distribution fix, so no new loss knobs (§十六). Halved LRs for the
corrective pass.

CHECKPOINT SELECTION RULE (§十九) — frozen BEFORE training, implemented here and
in reports/LAYA_V4_1_BASELINE.md:

  Per-epoch VAL = V4-VAL role pools (8 queries, role ability) + VAL-B anchor
  cross-domain pools (6 queries, prior behavior). An epoch is ELIGIBLE iff
    role nDCG@10        >= 0.680   (V4 best 0.7099 - 0.03, "不明显回退")
    role InversionRate  <= 0.020   (V4 best 0.0 + tolerance)
    role P@10           >= 0.682   (V4 best 0.7125 - 0.03)
  Among eligible epochs, pick LEXICOGRAPHICALLY:
    1. min  VAL-B IrrelevantAnchorHighScoreRate  (P(score>=1.5 | label<=1))
    2. tie: min VAL-B IrrelevantAnchorIntrusion@20 (non-injected anchors)
    3. tie: max role P@10
  If no epoch is eligible, the best role tuple wins and the run is flagged
  at-risk (selection had to fall back). Patience 2 on this rule.

Usage: .venv/Scripts/python scripts/train_laya_v4_1.py --variant B \
         --out models/a-share-laya-v4.1-candidate
"""

from __future__ import annotations

import argparse
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

from laya.common import QTYPES
from train_laya import collate, fit_one_temp, save_checkpoint  # noqa: E402
from train_laya_v3 import LEVELS  # noqa: E402
from train_laya_v4 import load_val_role_items, val_role_metrics  # noqa: E402
from eval_role_ranking import HOW, SCORE_LEVELS, SCORE_QUESTION  # noqa: E402
from laya_v4_1_cross_domain import ANCHOR_CODES, labels_for_pool  # noqa: E402

# §19 thresholds (V4-VAL best: ndcg10 0.7099 / inv 0.0 / p10 0.7125)
ELIGIBLE_NDCG10_MIN = 0.680
ELIGIBLE_INV_MAX = 0.020
ELIGIBLE_P10_MIN = 0.682
SELECTION_RULE = ("eligible: role ndcg10>=0.680 and role inv<=0.020 and role p10>=0.682; "
                  "then min valB anchorHighRate, tie min valB intrusion@20, tie max role p10 (§19, frozen pre-training)")


def load_val_b_items(tok, build_sequence):
    """Frozen VAL-B anchor cross-domain pools → items + labels + anchor flags."""
    pools = json.loads((ROOT / "data/eval/v4_1_cross_domain_ranking_candidates.json").read_text(encoding="utf-8"))
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    enrichment = {r["code"]: r for r in json.loads(
        (ROOT / "data/enrichment/semiconductor/enrichment.json").read_text(encoding="utf-8"))["records"]}

    items, meta = [], []
    for q in pools["queries"]:
        if q["split"] != "val-b":
            continue
        labels = labels_for_pool(q, companies, profiles, enrichment)
        for cand in q["candidates"]:
            code = cand["code"]
            c = companies.get(code)
            lab = labels.get(code)
            if c is None or lab is None:
                continue
            profile = (profiles.get(code) or {}).get("searchText") or c["judgeText"]
            ins = json.dumps({"company": {"name": c["name"], "code": code, "profile": profile},
                              "question": SCORE_QUESTION}, ensure_ascii=False)
            state = {"looking_for": q["query"][:300], "how_to_judge": HOW}
            seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
            if len(markers) != 4:
                continue
            items.append({"ids": seq, "markers": markers, "qtype": QTYPES["score"],
                          "target": [0.0] * 4, "label": lab["label"]})
            meta.append({"query": q["query"], "code": code, "label": lab["label"],
                         "anchor": lab["anchor"], "injected": lab["injected"]})
    return items, meta


@torch.no_grad()
def val_b_metrics(model, tok, device, items, meta):
    """VAL-B: anchorHighRate / anchorMean / intrusion@20 / cross-domain P@10."""
    model.eval()
    scores = []
    for at in range(0, len(items), 24):
        chunk = items[at:at + 24]
        batch = collate(chunk, tok.pad_token_id)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits, _ = model(batch["input_ids"].to(device), batch["attention_mask"].to(device),
                              batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                              batch["qtype"].to(device))
        logits = logits.float().cpu()
        for j, it in enumerate(chunk):
            k = len(it["markers"])
            scores.append(float((torch.softmax(logits[j, :k], -1) * LEVELS[:k]).sum()))
    model.train()

    by_query: dict[str, list[dict]] = defaultdict(list)
    for m, s in zip(meta, scores):
        by_query[m["query"]].append({**m, "score": s})
    anchor_rows, intrusions, p10s = [], 0, []
    for q, rows in by_query.items():
        rows.sort(key=lambda r: -r["score"])
        rel = [r for r in rows if r["label"] >= 2 and not r["anchor"]]
        if rel:
            top10 = rows[:10]
            p10s.append(sum(1 for r in top10 if r["label"] >= 2) / 10)
        for r in rows:
            if r["anchor"] and r["label"] <= 1:
                anchor_rows.append(r["score"])
        top20 = [r for r in rows[:20] if r["anchor"] and r["label"] <= 1 and not r["injected"]]
        if top20:
            intrusions += 1
    high = [s for s in anchor_rows if s >= 1.5]
    return {
        "anchorHighRate": round(len(high) / max(1, len(anchor_rows)), 4),
        "anchorMean": round(sum(anchor_rows) / max(1, len(anchor_rows)), 4),
        "intrusion20": round(intrusions / max(1, len(by_query)), 4),
        "xdomP10": round(sum(p10s) / max(1, len(p10s)), 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=["A", "B", "C"], default="B")
    parser.add_argument("--out", default="models/a-share-laya-v4.1-candidate")
    parser.add_argument("--init", default="models/a-share-laya-v4-candidate/checkpoint_best")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--micro-batch", type=int, default=8)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--pairwise-weight", type=float, default=0.5)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--listwise-weight", type=float, default=0.5)
    parser.add_argument("--role-margin-boost", type=float, default=1.4)
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_model, build_sequence, proper_reward
    from safetensors.torch import load_file

    torch.manual_seed(args.seed)
    random.seed(args.seed)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        raise SystemExit("训练需要 CUDA。当前 torch 未检测到 GPU,拒绝在 CPU 上假装训练。")

    # continued training: load the V4 candidate checkpoint (§二), not the base model
    init_dir = ROOT / args.init
    cfg = json.loads((init_dir / "rl_agent_config.json").read_text(encoding="utf-8"))
    cfg["gradient_checkpointing"] = True

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))
    model = build_model(cfg, encoder_dir=str(init_dir / "encoder"))
    model.load_state_dict(load_file(str(init_dir / "model.safetensors")), strict=True)
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    model.to(device)
    model.train()
    print(f"initialized from V4 candidate: {init_dir} (c3069e65)", flush=True)

    items = torch.load(ROOT / f"data/train/v4_1_train_items_{args.variant}.pt", weights_only=False)
    by_query: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        by_query[it["meta"]["query_id"]].append(it)
    n_score = sum(1 for it in items if it["qtype"] == QTYPES["score"])
    print(f"device={device} variant={args.variant} items={len(items)} (score {n_score}) "
          f"queries={len(by_query)} epochs={args.epochs}", flush=True)

    val_items, val_meta = load_val_role_items(tok, build_sequence)
    vb_items, vb_meta = load_val_b_items(tok, build_sequence)
    print(f"val: V4-VAL role {len(val_items)} rows / VAL-B {len(vb_items)} rows "
          f"({len({m['query'] for m in vb_meta})} queries)", flush=True)

    enc_params = [p for n, p in model.named_parameters() if "encoder." in n]
    head_params = [p for n, p in model.named_parameters() if "encoder." not in n]
    optimizer = torch.optim.AdamW(
        [{"params": enc_params, "lr": 1.0e-5}, {"params": head_params, "lr": 5.0e-5}],
        weight_decay=0.01,
    )
    steps_per_epoch = math.ceil(len(items) / (args.micro_batch * args.grad_accum))
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, steps_per_epoch * args.epochs), eta_min=1e-6)

    GROUP_SIZE = 4
    SIGMA_START, SIGMA_END = 0.4, 0.1
    out_root = ROOT / args.out
    log = {"started": time.strftime("%Y-%m-%d %H:%M:%S"),
           "config": vars(args) | {"init": "models/a-share-laya-v4-candidate/checkpoint_best (c3069e65)",
                                   "train_data": f"data/train/v4_1_train_pairs_{args.variant}.jsonl",
                                   "loss": "identical to V4 (RLCD + soft CE + role-banded pairwise + ListNet); LR halved",
                                   "selection": SELECTION_RULE},
           "epochs": []}
    best, best_epoch, epochs_since_best = None, -1, -1

    def sel_key(role, vb, eligible):
        # lexicographic §19: eligible flag, then -anchorHighRate, -intrusion20, role p10
        return (1 if eligible else 0, -vb["anchorHighRate"], -vb["intrusion20"], role["p10"])

    def flush_batches(batch_items, sigma):
        batch = collate(batch_items, tok.pad_token_id)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits, act = model(
                batch["input_ids"].to(device), batch["attention_mask"].to(device),
                batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                batch["qtype"].to(device))
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

        score_rows = [i for i, it in enumerate(batch_items) if it["qtype"] == QTYPES["score"]]
        loss_rank = torch.zeros((), device=device)
        loss_list = torch.zeros((), device=device)
        if len(score_rows) >= 2:
            probs = torch.softmax(logits.masked_fill(~mask, -1e4), -1)
            grades = torch.zeros(logits.shape[0], device=device)
            for i in score_rows:
                kk = len(batch_items[i]["markers"])
                grades[i] = (probs[i, :kk] * LEVELS[:kk].to(device)).sum()
            labels_t = torch.tensor([batch_items[i]["label"] for i in score_rows], device=device, dtype=torch.float32)
            g = grades[score_rows]
            hi = ((labels_t.unsqueeze(1) - labels_t.unsqueeze(0)) >= 2).float()
            band = (((labels_t.unsqueeze(1) == 3) & (labels_t.unsqueeze(0) <= 1))
                    | ((labels_t.unsqueeze(0) == 3) & (labels_t.unsqueeze(1) <= 1))).float()
            margin = args.pairwise_margin * (1.0 + (args.role_margin_boost - 1.0) * band)
            diff = g.unsqueeze(1) - g.unsqueeze(0)
            loss_rank = (torch.relu(margin - diff) * hi).sum() / hi.sum().clamp(min=1.0)

            qids = [batch_items[i]["meta"]["query_id"] for i in score_rows]
            uniq = sorted(set(qids))
            list_terms, list_weight_sum = [], 0.0
            for qid in uniq:
                idx = [pos for pos, qq in enumerate(qids) if qq == qid]
                if len(idx) < 2:
                    continue
                lg = labels_t[idx]
                if float(lg.max() - lg.min()) == 0:
                    continue
                t_dist = torch.softmax(lg * 1.5, -1)
                p_log = torch.log_softmax(g[idx] / 0.5, -1)
                list_terms.append(-(t_dist * p_log).sum())
                list_weight_sum += 1
            if list_terms:
                loss_list = torch.stack(list_terms).sum() / max(1.0, list_weight_sum)

        loss = (loss_rl + 1.0 * loss_ce + args.pairwise_weight * loss_rank
                + args.listwise_weight * loss_list) / args.grad_accum + 0.0 * act.sum()
        loss.backward()
        return loss.detach() * args.grad_accum, (loss_rank.detach(), loss_list.detach())

    stop = False
    for epoch in range(args.epochs):
        if stop:
            break
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
        list_sum = torch.zeros((), device=device)
        n_batches = 0
        optimizer.zero_grad(set_to_none=True)
        accum = 0
        t0 = time.time()
        for b in range(0, len(pool), args.micro_batch):
            chunk = pool[b: b + args.micro_batch]
            if not chunk:
                continue
            loss_v, (rank_v, list_v) = flush_batches(chunk, sigma)
            epoch_loss += loss_v
            rank_sum += rank_v
            list_sum += list_v
            n_batches += 1
            accum += 1
            if accum % args.grad_accum == 0 or (b + args.micro_batch) >= len(pool):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)

        role_m, _role_sel = val_role_metrics(model, tok, device, val_items, val_meta)
        vb_m = val_b_metrics(model, tok, device, vb_items, vb_meta)
        eligible = (role_m["ndcg10"] >= ELIGIBLE_NDCG10_MIN and role_m["inv_rate"] <= ELIGIBLE_INV_MAX
                    and role_m["p10"] >= ELIGIBLE_P10_MIN)
        entry = {
            "epoch": epoch + 1,
            "loss": round(epoch_loss.item() / max(1, n_batches), 4),
            "loss_rank": round(rank_sum.item() / max(1, n_batches), 4),
            "loss_list": round(list_sum.item() / max(1, n_batches), 4),
            "sigma": round(sigma, 3),
            "seconds": round(time.time() - t0),
            **{f"role_{k}": v for k, v in role_m.items()},
            **{f"valB_{k}": v for k, v in vb_m.items()},
            "eligible": eligible,
        }
        log["epochs"].append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

        key = sel_key(role_m, vb_m, eligible)
        if best is None or key > best[0]:
            best, best_epoch, epochs_since_best = (key, role_m, vb_m, eligible), epoch + 1, 0
            save_checkpoint(model, tok, cfg, out_root / "checkpoint_best", meta_note={
                "best_epoch": best_epoch, "variant": args.variant,
                "val_role": role_m, "val_b": vb_m, "eligible": eligible,
                "selection": SELECTION_RULE})
            print(f"  new best (epoch {best_epoch}) role={role_m} valB={vb_m} eligible={eligible}", flush=True)
        else:
            epochs_since_best += 1
            if epochs_since_best >= args.patience:
                print(f"  early stop: no §19-rule improvement for {args.patience} epochs", flush=True)
                stop = True

    model.eval()
    calib = [it for it in items if it["qtype"] == QTYPES["noul"]][::7][:400]
    preds = []
    with torch.no_grad():
        for i in range(0, len(calib), 16):
            chunk = calib[i: i + 16]
            cb = collate(chunk, tok.pad_token_id)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                l_sub, _ = model(cb["input_ids"].to(device), cb["attention_mask"].to(device),
                                 cb["marker_pos"].to(device), cb["marker_mask"].to(device),
                                 cb["qtype"].to(device))
            for j, it in enumerate(chunk):
                kk = len(it["markers"])
                preds.append((it["qtype"], l_sub[j, :kk].float().cpu().numpy(), it["target"][:kk]))
    temps = [1.0, 1.0, 1.0]
    for qt in range(3):
        sel_rows = [(z, t) for t_, z, t in preds if t_ == qt]
        if sel_rows:
            temps[qt] = fit_one_temp(sel_rows)

    note = {
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "base": "models/a-share-laya-v4-candidate/checkpoint_best (c3069e65, continued)",
        "train_data": f"data/train/v4_1_train_pairs_{args.variant}.jsonl (V4 7923 inherited + prior correction)",
        "objective": "identical to V4: RLCD + soft-target CE + role-banded pairwise margin + ListNet (score head); LRs halved",
        "selection": SELECTION_RULE,
        "seed": args.seed,
        "epochs": args.epochs,
        "best_epoch": best_epoch,
        "best_val": {"role": best[1], "val_b": best[2], "eligible": best[3]} if best else None,
        "teacher": "GLM-5.3-Flash (ZCode agent, in-context)",
    }
    save_checkpoint(model, tok, cfg, out_root, temperatures=[round(t, 4) for t in temps], meta_note=note)
    save_checkpoint(model, tok, cfg, out_root / "checkpoint_last", temperatures=[round(t, 4) for t in temps], meta_note=note)
    log["final_note"] = note
    (ROOT / f"data/train/v4_1_train_log_{args.variant}.json").write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"saved {out_root} variant={args.variant} (best epoch {best_epoch})", flush=True)


if __name__ == "__main__":
    main()
