"""V4 role-aware reranker fine-tune (spec §5/§21/§22/§23/§26).

Delta vs the V3 trainer (train_laya_v3.py), everything else identical:
  1. Listwise ListNet loss on the score head's expected grade, computed per
     same-query group inside the micro-batch (in-query negatives only, §5) —
     the query-relative signal V3 never had.
  2. Role-band pairwise margin: hinge pairs whose labels straddle the §12
     role boundary (3 vs ≤1) get a 1.4x margin — "同工艺不同角色" must separate.
  3. Checkpoint selection on the FROZEN V4-VAL role pools (8 held-out queries ×
     Top200, production text shape): primary nDCG@10, tie-break RoleInversionRate
     then P@10 (§22). noul AUC on the legacy V3 VAL split is logged, not used.
  4. Early stop: 3 epochs without a new best → stop (§23). No fixed epoch count.

Same RLCD group objective and soft-target CE as V3; same bf16/gradient-
checkpointing/single-4060 recipe (§26). V3 checkpoint untouched (§27).

Usage: .venv/Scripts/python scripts/train_laya_v4.py --out models/a-share-laya-v4
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

from train_laya import HOW, collate, fit_one_temp, save_checkpoint  # noqa: E402
from eval_ranking_v3 import SCORE_LEVELS, SCORE_QUESTION  # noqa: E402  (production strings)
from train_laya_v3 import LEVELS  # noqa: E402

ROLE_OF_EXPECT = {"equipment": "equipment_supplier", "material": "material_supplier", "component": "component_supplier"}


def load_val_role_items(tok, build_sequence):
    """Frozen V4-VAL role pools → items + per-query labels + role evidence."""
    pools = json.loads((ROOT / "data/eval/v4_role_ranking_candidates.json").read_text(encoding="utf-8"))
    truth = {}
    for line in (ROOT / "data/eval/v4_role_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            if row["split"] == "val":
                truth[row["query"]] = row
    enrichment = {r["code"]: r for r in json.loads(
        (ROOT / "data/enrichment/semiconductor/enrichment.json").read_text(encoding="utf-8"))["records"]}
    companies = {c["code"]: c for c in json.loads(
        (ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))

    items, meta = [], []
    for q in pools["queries"]:
        t = truth.get(q["query"])
        if t is None:
            continue
        labels = {c: 3 for c in t["relevant3"]} | {c: 2 for c in t["relevant2"]}
        for c in t["hard1"]:
            labels.setdefault(c, 1)
        for c in t.get("negativeWatch", []):
            labels.setdefault(c, 0)
        expect = ROLE_OF_EXPECT[t["expect"]]
        # rank the FULL frozen pool (unlabeled candidates default to label 0) —
        # same convention as eval_role_ranking.py so selection matches evaluation
        for cand in q["candidates"]:
            code = cand["code"]
            c = companies.get(code)
            if c is None:
                continue
            label = labels.get(code, 0)
            profile = profiles.get(code, {}).get("searchText") or c["judgeText"]
            ins = json.dumps({"company": {"name": c["name"], "code": code, "profile": profile},
                              "question": SCORE_QUESTION}, ensure_ascii=False)
            state = {"looking_for": q["query"][:300], "how_to_judge": HOW}
            seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
            if len(markers) != 4:
                continue
            roles = set((enrichment.get(code) or {}).get("roles") or [])
            items.append({"ids": seq, "markers": markers, "qtype": QTYPES["score"],
                          "target": [0.0] * 4, "label": label})
            meta.append({"query": q["query"], "code": code, "label": label,
                         "roleMatched": expect in roles, "hasRole": bool(roles)})
    return items, meta


@torch.no_grad()
def val_role_metrics(model, tok, device, val_items, val_meta):
    """nDCG@10 / P@10 / RoleInversionRate on the frozen V4-VAL role pools."""
    model.eval()
    scores: list[float] = []
    for at in range(0, len(val_items), 24):
        chunk = val_items[at : at + 24]
        batch = collate(chunk, tok.pad_token_id)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits, _ = model(batch["input_ids"].to(device), batch["attention_mask"].to(device),
                              batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                              batch["qtype"].to(device))
        logits = logits.float().cpu()
        for j, it in enumerate(chunk):
            k = len(it["markers"])
            probs = torch.softmax(logits[j, :k], -1)
            scores.append(float((probs * LEVELS[:k]).sum()))
    model.train()

    by_query: dict[str, list[dict]] = defaultdict(list)
    for m, s in zip(val_meta, scores):
        by_query[m["query"]].append({**m, "score": s})
    ndcgs, p10s, inv_rates = [], [], []
    for q, rows in by_query.items():
        rows.sort(key=lambda r: -r["score"])
        gains = [2 ** r["label"] - 1 if r["label"] >= 2 else 0.0 for r in rows]
        ideal = sorted(gains, reverse=True)
        dcg = sum(g / math.log2(i + 2) for i, g in enumerate(gains[:10]))
        idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal[:10]))
        if idcg > 0:
            ndcgs.append(dcg / idcg)
        top10 = rows[:10]
        if any(r["label"] >= 2 for r in top10):
            p10s.append(sum(1 for r in top10 if r["label"] >= 2) / 10)
        first_good = next((i for i, r in enumerate(rows) if r["label"] >= 2), None)
        wrong = [i for i, r in enumerate(rows[:20]) if r["label"] <= 1 and r["hasRole"] and not r["roleMatched"]]
        if first_good is not None and wrong:
            inv_rates.append(sum(1 for i in wrong if i < first_good) / len(wrong))
    inv = sum(inv_rates) / len(inv_rates) if inv_rates else 0.0
    sel = (sum(ndcgs) / max(1, len(ndcgs)), -inv, sum(p10s) / max(1, len(p10s)))
    return {"ndcg10": round(sel[0], 4), "inv_rate": round(inv, 4), "p10": round(sel[2], 4)}, sel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="models/a-share-laya-v4")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--micro-batch", type=int, default=8)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--pairwise-weight", type=float, default=0.5)
    parser.add_argument("--pairwise-margin", type=float, default=0.5)
    parser.add_argument("--listwise-weight", type=float, default=0.5)
    parser.add_argument("--role-margin-boost", type=float, default=1.4)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_model, build_sequence, proper_reward

    torch.manual_seed(args.seed)
    random.seed(args.seed)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        raise SystemExit("训练需要 CUDA。当前 torch 未检测到 GPU,拒绝在 CPU 上假装训练。")

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/*"])
    _fix_tokenizer_config(model_dir)
    base_dir = str(Path(model_dir) / "multilingual")
    with open(f"{base_dir}/rl_agent_config.json", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["gradient_checkpointing"] = True

    tok = AutoTokenizer.from_pretrained(f"{base_dir}/tokenizer")
    model = build_model(cfg, encoder_dir=f"{base_dir}/encoder")
    from safetensors.torch import load_file
    model.load_state_dict(load_file(f"{base_dir}/model.safetensors"), strict=True)
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    model.to(device)
    model.train()

    items = torch.load(ROOT / "data/train/v4_train_items.pt", weights_only=False)
    by_query: dict[str, list[dict]] = defaultdict(list)
    for it in items:
        by_query[it["meta"]["query_id"]].append(it)
    n_score = sum(1 for it in items if it["qtype"] == QTYPES["score"])
    print(f"device={device} items={len(items)} (score {n_score}) queries={len(by_query)} epochs={args.epochs}", flush=True)

    val_items, val_meta = load_val_role_items(tok, build_sequence)
    print(f"val role pools: {len(val_items)} scored rows / {len({m['query'] for m in val_meta})} queries", flush=True)

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
    log = {"started": time.strftime("%Y-%m-%d %H:%M:%S"),
           "config": vars(args) | {"base": "convaiinnovations/laya:multilingual",
                                   "train_data": "data/train/v4_train_pairs.jsonl (v4 role-aware mix)",
                                   "selection": "V4-VAL role pools: nDCG@10 → -RoleInversionRate → P@10 (§22)"},
           "epochs": []}
    best, best_epoch, epochs_since_best = (-1.0, 0.0, -1.0), -1, -1

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
            # §12 role band: a 3 must beat a ≤1 by more (same-process wrong-role rows)
            band = (((labels_t.unsqueeze(1) == 3) & (labels_t.unsqueeze(0) <= 1))
                    | ((labels_t.unsqueeze(0) == 3) & (labels_t.unsqueeze(1) <= 1))).float()
            margin = args.pairwise_margin * (1.0 + (args.role_margin_boost - 1.0) * band)
            diff = g.unsqueeze(1) - g.unsqueeze(0)
            loss_rank = (torch.relu(margin - diff) * hi).sum() / hi.sum().clamp(min=1.0)

            # ListNet per same-query group (in-query negatives, query-relative §13)
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
            chunk = pool[b : b + args.micro_batch]
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

        metrics, sel = val_role_metrics(model, tok, device, val_items, val_meta)
        entry = {
            "epoch": epoch + 1,
            "loss": round(epoch_loss.item() / max(1, n_batches), 4),
            "loss_rank": round(rank_sum.item() / max(1, n_batches), 4),
            "loss_list": round(list_sum.item() / max(1, n_batches), 4),
            "sigma": round(sigma, 3),
            "seconds": round(time.time() - t0),
            **metrics,
        }
        log["epochs"].append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

        if sel > best:
            best, best_epoch, epochs_since_best = sel, epoch + 1, 0
            save_checkpoint(model, tok, cfg, out_root / "checkpoint_best", meta_note={
                "best_epoch": best_epoch, "val_role_ndcg10": metrics["ndcg10"],
                "val_role_inv_rate": metrics["inv_rate"], "val_role_p10": metrics["p10"],
                "selection": "V4-VAL role pools (ndcg10, -inv, p10)"})
            print(f"  new best V4-VAL ndcg10={metrics['ndcg10']} inv={metrics['inv_rate']} p10={metrics['p10']} -> checkpoint_best", flush=True)
        else:
            epochs_since_best += 1
            if epochs_since_best >= args.patience:
                print(f"  early stop: no VAL improvement for {args.patience} epochs (§23)", flush=True)
                stop = True

    model.eval()
    calib = [it for it in items if it["qtype"] == QTYPES["noul"]][::7][:400]
    preds = []
    with torch.no_grad():
        for i in range(0, len(calib), 16):
            chunk = calib[i : i + 16]
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
        "base": "convaiinnovations/laya:multilingual",
        "train_data": "data/train/v4_train_pairs.jsonl (7923 rows: P0 mined 606 / P1 role contrast 4206 / P2 v3 inherit 3087 / P3 random 60)",
        "objective": "RLCD + soft-target CE + role-banded pairwise margin + ListNet listwise (score head)",
        "selection": "V4-VAL role pools: nDCG@10 → -RoleInversionRate → P@10; patience 3 (§22/§23)",
        "seed": args.seed,
        "epochs": args.epochs,
        "best_epoch": best_epoch,
        "best_val_role": {"ndcg10": best[0], "inv_rate": -best[1], "p10": best[2]},
        "teacher": "GLM-5.3-Flash (ZCode agent, in-context)",
    }
    save_checkpoint(model, tok, cfg, out_root, temperatures=[round(t, 4) for t in temps], meta_note=note)
    save_checkpoint(model, tok, cfg, out_root / "checkpoint_last", temperatures=[round(t, 4) for t in temps], meta_note=note)
    log["final_note"] = note
    (ROOT / "data/train/v4_train_log.json").write_text(json.dumps(log, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"saved {out_root} (best epoch {best_epoch} val ndcg10={best[0]:.4f} inv={-best[1]:.4f} p10={best[2]:.4f})", flush=True)


if __name__ == "__main__":
    main()
