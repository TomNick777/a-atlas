"""V4.2 corrective fine-tune (LAYA_V4_2 spec §4/§16/§29/§30/§31).

Continued training FROM the V4.1 production checkpoint
(models/a-share-laya-v4.1/checkpoint_best, SHA16 2742affc3f677d71) — never a
V3 restart (§4). Loss is IDENTICAL to V4/V4.1 (RLCD + soft-target CE +
role-banded pairwise margin + ListNet) plus ONE optional term (§16, the
minimal-invasive consistency objective):

    loss_cons = mean over (paraphraseGroupId, code) groups present in the
                micro-batch with >=2 rows of  |score_i - score_j|

applied to the already-computed scalar grades — no architecture change, no
new head. §17's fallback (same-intent wordings in one ranking batch) is
realized by company-major ordering inside each paraphrase block so wording
pairs co-occur in micro-batches. §39 guard: the consistency weight is small
(0.25) and the §31 selection rule ranks preservation + subtype/copper
inversions ABOVE the paraphrase delta, so a variant that flattens scores
cannot win selection.

Variant C = variant B data + consistency objective (--consistency-weight
0.25). Variants A/B train with weight 0.

CHECKPOINT SELECTION RULE (§31) — frozen BEFORE training, implemented here
and pre-registered in reports/LAYA_V4_2_BASELINE.md:

  VAL per epoch = V4-VAL role pools + VAL-B anchor pools + V4.2 VAL-M/C/P.
  An epoch is ELIGIBLE iff
    role nDCG@10               >= 0.675  (V4.1 selected epoch 0.6961 - 0.02)
    role InversionRate         <= 0.111  (V4.1 selected epoch level)
    role P@10                  >= 0.690  (V4.1 selected epoch 0.725 - 0.035)
    VAL-B anchorHighRate       <= 0.150  (V4.1 selected epoch 0.111 + margin)
  Among eligible epochs pick LEXICOGRAPHICALLY (§31 order):
    1. min VAL-M MaterialSubtypeInversion
    2. tie: min VAL-C CopperRoleInversion
    3. tie: min VAL-P ParaphraseMeanAbsDelta
    4. tie: max role P@10
  If no epoch is eligible, the best role tuple wins and the run is flagged
  at-risk (same fallback precedent as V4.1 §19). Patience 2 on this rule.

Usage: .venv/Scripts/python scripts/train_laya_v4_2.py --variant B \
         --out models/a-share-laya-v4.2-candidate-B
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
from train_laya_v4_1 import load_val_b_items, val_b_metrics  # noqa: E402

# §31 thresholds, frozen pre-training (derived from the V4.1 selected epoch)
ELIGIBLE_NDCG10_MIN = 0.675
ELIGIBLE_INV_MAX = 0.111
ELIGIBLE_P10_MIN = 0.690
ELIGIBLE_ANCHOR_HIGH_MAX = 0.150
SELECTION_RULE = (
    "eligible: role ndcg10>=0.675 and role inv<=0.111 and role p10>=0.690 and valB anchorHighRate<=0.150; "
    "then min valM MaterialSubtypeInversion, tie min valC CopperRoleInversion, "
    "tie min valP ParaphraseMeanAbsDelta, tie max role p10 (§31, frozen pre-training)")

DEBUG_PHASES = bool(os.environ.get("V42_DEBUG_PHASES"))


@torch.no_grad()
def val_42_metrics(model, tok, device, items):
    """VAL-M/C/P: subtype inversion, copper role inversion, paraphrase delta."""
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

    by_query: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for it, s in zip(items, scores):
        m = it["meta"]
        by_query[(m["kind"], m["query"])].append((m["label"], s))

    # MaterialSubtypeInversion: P(s(true-subtype 3) < s(other-material 2))
    inv_m, pairs_m = 0, 0
    p10_m = []
    for (kind, _q), rows in by_query.items():
        if kind != "VAL_M":
            continue
        threes = [s for l, s in rows if l >= 3]
        twos = [s for l, s in rows if l == 2]
        for sa in threes:
            for sb in twos:
                pairs_m += 1
                inv_m += sa < sb
        rel = [r for _, r in sorted([(l, s) for l, s in rows], key=lambda x: -x[1]) if True]
        top = [s for l, s in rows if l >= 2]
        if rows:
            top10 = sorted(rows, key=lambda x: -x[1])[:10]
            p10_m.append(sum(1 for l, _ in top10 if l >= 2) / 10)
    # CopperRoleInversion: P(s(3) < s(<=1)) within a query pool
    inv_c, pairs_c = 0, 0
    for (kind, _q), rows in by_query.items():
        if kind != "VAL_C":
            continue
        threes = [s for l, s in rows if l >= 3]
        lows = [s for l, s in rows if l <= 1]
        for sa in threes:
            for sb in lows:
                pairs_c += 1
                inv_c += sa < sb
    # ParaphraseMeanAbsDelta per (pgid, code)
    by_pair: dict[tuple[str, str], dict[str, float]] = defaultdict(dict)
    for it, s in zip(items, scores):
        m = it["meta"]
        if m["kind"] == "VAL_P":
            by_pair[(m["pgid"], m["code"])][m["query"]] = s
    deltas = []
    for _k, ws in by_pair.items():
        if len(ws) >= 2:
            vals = list(ws.values())
            deltas.append(abs(vals[0] - vals[1]))
    return {
        "valM_inv": round(inv_m / max(1, pairs_m), 4),
        "valM_p10": round(sum(p10_m) / max(1, len(p10_m)), 4),
        "valC_inv": round(inv_c / max(1, pairs_c), 4),
        "valP_delta": round(sum(deltas) / max(1, len(deltas)), 4),
        "valP_groups": len(by_pair),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=["A", "B", "C"], default="B")
    parser.add_argument("--out", default=None)
    parser.add_argument("--init", default="models/a-share-laya-v4.1/checkpoint_best")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--micro-batch", type=int, default=8)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--pairwise-weight", type=float, default=0.5)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--listwise-weight", type=float, default=0.5)
    parser.add_argument("--role-margin-boost", type=float, default=1.4)
    parser.add_argument("--consistency-weight", type=float, default=None,
                        help="variant C default 0.25; A/B force 0")
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--smoke", action="store_true", help="debug: 200 items, 1 epoch, no save")
    args = parser.parse_args()

    if args.consistency_weight is None:
        args.consistency_weight = 0.25 if args.variant == "C" else 0.0
    if args.variant in ("A", "B") and args.consistency_weight > 0:
        raise SystemExit("variants A/B train with consistency-weight 0 (spec §30)")
    if args.out is None:
        args.out = f"models/a-share-laya-v4.2-candidate-{args.variant}"

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

    # continued training: load the V4.1 production checkpoint (§4), not a restart
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
    print(f"initialized from V4.1 production: {init_dir} (2742affc3f677d71)", flush=True)

    items = torch.load(ROOT / f"data/train/v4_2_train_items_{args.variant if args.variant != 'C' else 'B'}.pt",
                       weights_only=False)
    if args.smoke:
        items = items[-300:]  # tail = transfer/xdom rows, exercises the pgid paths
    by_query: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        by_query[it["meta"]["query_id"]].append(it)
    n_score = sum(1 for it in items if it["qtype"] == QTYPES["score"])
    print(f"device={device} variant={args.variant} items={len(items)} (score {n_score}) "
          f"queries={len(by_query)} consistency_w={args.consistency_weight} epochs={args.epochs}", flush=True)

    val_items, val_meta = load_val_role_items(tok, build_sequence)
    vb_items, vb_meta = load_val_b_items(tok, build_sequence)
    val42 = torch.load(ROOT / "data/train/v4_2_val_items.pt", weights_only=False)
    print(f"val: role {len(val_items)} / VAL-B {len(vb_items)} / V4.2 M-C-P {len(val42)}", flush=True)

    # §29: LR below the V4.1 corrective pass (which halved V4's)
    enc_params = [p for n, p in model.named_parameters() if "encoder." in n]
    head_params = [p for n, p in model.named_parameters() if "encoder." not in n]
    optimizer = torch.optim.AdamW(
        [{"params": enc_params, "lr": 5.0e-6}, {"params": head_params, "lr": 2.5e-5}],
        weight_decay=0.01,
    )
    steps_per_epoch = math.ceil(len(items) / (args.micro_batch * args.grad_accum))
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, steps_per_epoch * args.epochs), eta_min=1e-6)

    GROUP_SIZE = 4
    SIGMA_START, SIGMA_END = 0.4, 0.1
    out_root = ROOT / args.out
    log = {"started": time.strftime("%Y-%m-%d %H:%M:%S"),
           "config": vars(args) | {"init": "models/a-share-laya-v4.1/checkpoint_best (2742affc3f677d71)",
                                   "train_data": f"data/train/v4_2_train_items_{args.variant if args.variant != 'C' else 'B'}.pt",
                                   "loss": "identical to V4.1 (RLCD + soft CE + role-banded pairwise + ListNet)"
                                           + (f" + consistency({args.consistency_weight})" if args.consistency_weight else ""),
                                   "selection": SELECTION_RULE},
           "epochs": []}
    best, best_epoch, epochs_since_best = None, -1, -1

    def sel_key(role, vb, m42, eligible):
        if eligible:
            # §31 lexicographic: min valM inv, min valC inv, min valP delta, max p10
            return (1, -m42["valM_inv"], -m42["valC_inv"], -m42["valP_delta"], role["p10"])
        # at-risk fallback (V4.1 §19 precedent): preservation-first among ineligible
        return (0, -vb["anchorHighRate"], -vb["intrusion20"], role["p10"])

    def flush_batches(batch_items, sigma):
        _t_fw = time.time()
        batch = collate(batch_items, tok.pad_token_id)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits, act = model(
                batch["input_ids"].to(device), batch["attention_mask"].to(device),
                batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                batch["qtype"].to(device))
        if DEBUG_PHASES:
            torch.cuda.synchronize()
            print(f"    [phase] fw {time.time()-_t_fw:.3f}s", flush=True)
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
        loss_cons = torch.zeros((), device=device)
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

            # §16 consistency: same (pgid, code), same intent, multiple wordings
            if args.consistency_weight > 0:
                pc_groups: dict[tuple[str, str], list[int]] = defaultdict(list)
                for pos, i in enumerate(score_rows):
                    pgid = batch_items[i]["meta"].get("pgid")
                    if pgid:
                        pc_groups[(pgid, batch_items[i]["meta"]["code"])].append(pos)
                cons_terms = []
                for _key, idx in pc_groups.items():
                    if len(idx) >= 2:
                        gv = g[idx]
                        diffs = (gv.unsqueeze(1) - gv.unsqueeze(0)).abs()
                        off = ~torch.eye(len(idx), dtype=torch.bool, device=device)
                        cons_terms.append(diffs[off].mean())
                if cons_terms:
                    loss_cons = torch.stack(cons_terms).mean()

        loss = (loss_rl + 1.0 * loss_ce + args.pairwise_weight * loss_rank
                + args.listwise_weight * loss_list
                + args.consistency_weight * loss_cons) / args.grad_accum + 0.0 * act.sum()
        _t_bw = time.time()
        loss.backward()
        if DEBUG_PHASES:
            torch.cuda.synchronize()
            print(f"    [phase] bw {time.time()-_t_bw:.3f}s batch={len(batch_items)}", flush=True)
        return (loss.detach() * args.grad_accum,
                (loss_rank.detach(), loss_list.detach(), loss_cons.detach()))

    if args.smoke:
        args.epochs = 1
    stop = False
    for epoch in range(args.epochs):
        if stop:
            break
        sigma = SIGMA_START + (SIGMA_END - SIGMA_START) * epoch / max(1, args.epochs - 1)
        # epoch pool: pgid blocks company-major (§17 wordings co-occur in
        # micro-batches), other queries shuffled as in V4/V4.1
        qids = list(by_query.keys())
        random.shuffle(qids)
        pgid_blocks: dict[str, list[str]] = defaultdict(list)
        pool: list[dict] = []
        for qid in qids:
            pgid = by_query[qid][0]["meta"].get("pgid")
            if pgid:
                pgid_blocks[pgid].append(qid)
            else:
                group = by_query[qid][:]
                random.shuffle(group)
                pool.extend(group)
        for pgid in list(pgid_blocks):
            random.shuffle(pgid_blocks[pgid])
        pgids = list(pgid_blocks.keys())
        random.shuffle(pgids)
        for pgid in pgids:
            codes: dict[str, list[str]] = defaultdict(list)
            for qid in pgid_blocks[pgid]:
                for it in by_query[qid]:
                    code = it["meta"]["code"]
                    if qid not in codes[code]:
                        codes[code].append(qid)
            code_order = list(codes.keys())
            random.shuffle(code_order)
            for code in code_order:
                for qid in codes[code]:
                    pool.extend(x for x in by_query[qid] if x["meta"]["code"] == code)

        epoch_loss = torch.zeros((), device=device)
        rank_sum = torch.zeros((), device=device)
        list_sum = torch.zeros((), device=device)
        cons_sum = torch.zeros((), device=device)
        n_batches = 0
        optimizer.zero_grad(set_to_none=True)
        accum = 0
        t0 = time.time()
        n_batches_total = math.ceil(len(pool) / args.micro_batch)
        for b in range(0, len(pool), args.micro_batch):
            chunk = pool[b: b + args.micro_batch]
            if not chunk:
                continue
            if b % (args.micro_batch * 100) == 0:
                now = time.time()
                print(f"  [progress] epoch {epoch + 1} batch {b // args.micro_batch}/{n_batches_total} "
                      f"({now - t0:.0f}s, {100 * args.micro_batch / max(1e-9, now - t0):.2f} b/s)", flush=True)
            loss_v, (rank_v, list_v, cons_v) = flush_batches(chunk, sigma)
            epoch_loss += loss_v
            rank_sum += rank_v
            list_sum += list_v
            cons_sum += cons_v
            n_batches += 1
            accum += 1
            if accum % args.grad_accum == 0 or (b + args.micro_batch) >= len(pool):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)

        role_m, _role_sel = val_role_metrics(model, tok, device, val_items, val_meta)
        vb_m = val_b_metrics(model, tok, device, vb_items, vb_meta)
        m42 = val_42_metrics(model, tok, device, val42)
        eligible = (role_m["ndcg10"] >= ELIGIBLE_NDCG10_MIN and role_m["inv_rate"] <= ELIGIBLE_INV_MAX
                    and role_m["p10"] >= ELIGIBLE_P10_MIN and vb_m["anchorHighRate"] <= ELIGIBLE_ANCHOR_HIGH_MAX)
        entry = {
            "epoch": epoch + 1,
            "loss": round(epoch_loss.item() / max(1, n_batches), 4),
            "loss_rank": round(rank_sum.item() / max(1, n_batches), 4),
            "loss_list": round(list_sum.item() / max(1, n_batches), 4),
            "loss_cons": round(cons_sum.item() / max(1, n_batches), 5),
            "sigma": round(sigma, 3),
            "seconds": round(time.time() - t0),
            **{f"role_{k}": v for k, v in role_m.items()},
            **{f"valB_{k}": v for k, v in vb_m.items()},
            **m42,
            "eligible": eligible,
        }
        log["epochs"].append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

        key = sel_key(role_m, vb_m, m42, eligible)
        if best is None or key > best[0]:
            best, best_epoch, epochs_since_best = (key, role_m, vb_m, m42, eligible), epoch + 1, 0
            save_checkpoint(model, tok, cfg, out_root / "checkpoint_best", meta_note={
                "best_epoch": best_epoch, "variant": args.variant,
                "val_role": role_m, "val_b": vb_m, "val_42": m42, "eligible": eligible,
                "selection": SELECTION_RULE})
            print(f"  new best (epoch {best_epoch}) role={role_m} valB={vb_m} v42={m42} eligible={eligible}", flush=True)
        else:
            epochs_since_best += 1
            if epochs_since_best >= args.patience:
                print(f"  early stop: no §31-rule improvement for {args.patience} epochs", flush=True)
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

    at_risk = not (best and best[4])
    note = {
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "base": "models/a-share-laya-v4.1/checkpoint_best (2742affc3f677d71, continued)",
        "train_data": f"data/train/v4_2_train_pairs_{args.variant if args.variant != 'C' else 'B'}.jsonl (corrected 693 + tracks)",
        "objective": "identical to V4.1" + (f" + consistency {args.consistency_weight} (§16)" if args.consistency_weight else ""),
        "selection": SELECTION_RULE,
        "at_risk_fallback": at_risk,
        "seed": args.seed,
        "epochs": args.epochs,
        "best_epoch": best_epoch,
        "best_val": ({"role": best[1], "val_b": best[2], "val_42": best[3], "eligible": best[4]} if best else None),
        "teacher": "GLM-5.3-Flash (ZCode agent, in-context)",
    }
    log["final_note"] = note
    if not args.smoke:
        save_checkpoint(model, tok, cfg, out_root, temperatures=[round(t, 4) for t in temps], meta_note=note)
        save_checkpoint(model, tok, cfg, out_root / "checkpoint_last", temperatures=[round(t, 4) for t in temps], meta_note=note)
        (ROOT / f"data/train/v4_2_train_log_{args.variant}.json").write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"saved {out_root} variant={args.variant} (best epoch {best_epoch}, at_risk={at_risk})", flush=True)


if __name__ == "__main__":
    main()
