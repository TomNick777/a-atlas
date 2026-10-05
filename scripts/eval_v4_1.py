"""V4.1 same-pool evaluation: V3 / V4 / V4.1 on identical frozen pools, plus the
new prior metrics (LAYA_V4_1 spec §五/§二十一/§二十三/§二十四/§三十).

Extends eval_role_ranking.py with:
  setb pools   ANCHOR_CROSS_DOMAIN_SET — VAL-B / TEST-B queries, deterministic
               cross-domain labels, 12 anchors injected (marked) in every pool
  setc pools   cross-domain generalization (zero-touch domains), same labels
  IrrelevantAnchorGrade (mean/median/P90 over anchor x query with label<=1)
  IrrelevantAnchorHighScoreRate  P(score>=1.5) / P(score>=2.0)
  IrrelevantAnchorIntrusion@20  non-injected label<=1 anchors in the real Top20
  CrossDomainScoreMargin        best(label>=2) - max(anchor, label<=1)
  CompanyPriorVarianceShare     between-company / total variance (setb+setc)
  repeat-offender scan          per-company Top20 appearances / mean rank /
                                mean score / distinct query families

Inherited pools (stage3 / focus / v4role val+test / ev) come from
eval_role_ranking.metrics unchanged; this script adds the new sets and the
anchor/repeat-offender layer, so one run yields the full §三十 table inputs.

Usage:
  .venv/Scripts/python.exe -u scripts/eval_v4_1.py \
    --checkpoint models/a-share-laya-v4.1-candidate/checkpoint_best --tag v4.1 \
    --out reports/v4_1_eval/v41_full.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from eval_role_ranking import (  # noqa: E402
    HOW, SCORE_LEVELS, SCORE_QUESTION, LEVELS, collate_local,
    load_stage3_truth, load_v4_truth, load_ev_truth, dcg, role_metrics,
)
from laya_v4_roles import AMBIGUOUS_CODES, company_caps, grade_caps, load_enrichment, parse_intent  # noqa: E402
from laya_v4_1_cross_domain import ANCHOR_CODES, labels_for_pool  # noqa: E402


def pct(values, q):
    vs = sorted(values)
    return vs[min(len(vs) - 1, int(q * len(vs)))] if vs else None


def anchor_metrics(per_query_rows):
    """Aggregate the §五 metrics. Grade stats run over ALL pool positions of
    every irrelevant anchor (score behaviour, §五 definition); the Top20 slice
    feeds the intrusion metric (product visibility)."""
    anchor_scores = []
    visible_scores = []
    intr_q = 0
    margins = []
    for r in per_query_rows:
        anchor_scores += [a["score"] for a in r.get("anchorAll") or []]
        visible_scores += [a["score"] for a in r["anchorRows"]]
        intr_q += 1 if r["anchorIntrusionTop20"] else 0
        if r["margin"] is not None:
            margins.append(r["margin"])

    def rate_block(values):
        high15 = [s for s in values if s >= 1.5]
        high20 = [s for s in values if s >= 2.0]
        return {
            "nAnchorRows": len(values),
            "IrrelevantAnchorMeanGrade": round(statistics.mean(values), 4) if values else None,
            "IrrelevantAnchorMedianGrade": round(statistics.median(values), 4) if values else None,
            "IrrelevantAnchorP90": round(pct(values, 0.9), 4) if values else None,
            "IrrelevantAnchorHighScoreRate>=1.5": round(len(high15) / len(values), 4) if values else None,
            "IrrelevantAnchorHighScoreRate>=2.0": round(len(high20) / len(values), 4) if values else None,
        }

    block = rate_block(anchor_scores)
    block.update({
        "IrrelevantAnchorIntrusion@20": round(intr_q / max(1, len(per_query_rows)), 4),
        "CrossDomainScoreMargin": round(statistics.mean(margins), 4) if margins else None,
        "MarginPositiveShare": round(sum(1 for m in margins if m > 0) / len(margins), 4) if margins else None,
    })
    if visible_scores:
        vis = rate_block(visible_scores)
        block["Top20SliceMeanGrade"] = vis["IrrelevantAnchorMeanGrade"]
        block["Top20SliceHighScoreRate>=1.5"] = vis["IrrelevantAnchorHighScoreRate>=1.5"]
    return block


def prior_variance_share(score_matrix, anchor_codes):
    """CompanyPriorVarianceShare over the anchor population (every row contains
    all 12 anchors, so the pooled and per-company populations match and the
    ratio is a proper between/total decomposition)."""
    rows = [{c: row[c] for c in anchor_codes if c in row} for row in score_matrix]
    rows = [r for r in rows if len(r) == len(anchor_codes)]
    if not rows:
        return None
    all_scores = [s for row in rows for s in row.values()]
    total_var = statistics.pvariance(all_scores) if len(all_scores) > 1 else 0.0
    company_means = [statistics.mean([row[c] for row in rows]) for c in anchor_codes]
    between_var = statistics.pvariance(company_means) if len(company_means) > 1 else 0.0
    return round(between_var / total_var, 4) if total_var else 0.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--pool-sets", default="stage3,focus,v4role,ev,setb,setc",
                        help="comma list; v4role honors --splits")
    parser.add_argument("--splits", default="val,test")
    parser.add_argument("--micro-batch", type=int, default=32)
    args = parser.parse_args()

    import torch
    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import QTYPES, build_model, build_sequence
    from safetensors.torch import load_file

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

    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    enrichment = load_enrichment()

    truth_stage3 = load_stage3_truth()
    truth_v4 = load_v4_truth()
    truth_ev = load_ev_truth()
    want_sets = set(args.pool_sets.split(","))
    want_splits = set(args.splits.split(","))

    def queries_for():
        out = []
        if "stage3" in want_sets:
            doc = json.loads((ROOT / "data/eval/stage3_ranking_candidates_v3.json").read_text(encoding="utf-8"))
            for q in doc["queries"]:
                labels_cat = truth_stage3.get(q["query"])
                out.append({"set": "stage3", "query_id": q["query_id"], "family": q["family"],
                            "query": q["query"], "candidates": q["candidates"],
                            "truth": (labels_cat[0], None) if labels_cat else None,
                            "category": labels_cat[1] if labels_cat else None})
        if "focus" in want_sets:
            doc = json.loads((ROOT / "data/eval/stage3_1_focus_pools.json").read_text(encoding="utf-8"))
            for q in doc["queries"]:
                intent = parse_intent(q["query"])
                labels = {}
                for cand in q["candidates"]:
                    code = cand["code"]
                    if code in AMBIGUOUS_CODES:
                        continue
                    grade, _ = grade_caps(intent, company_caps(enrichment.get(code)))
                    if grade is not None:
                        labels[code] = grade
                out.append({"set": "focus", "query_id": f"FOCUS::{q['group']}::{q['expect']}", "family": f"FOCUS-{q['group']}",
                            "query": q["query"], "candidates": q["candidates"], "truth": (labels, q["expect"]),
                            "expect": q["expect"]})
        if "v4role" in want_sets:
            doc = json.loads((ROOT / "data/eval/v4_role_ranking_candidates.json").read_text(encoding="utf-8"))
            for q in doc["queries"]:
                if q["split"] in want_splits:
                    out.append({"set": f"v4role-{q['split']}", "query_id": q["query_id"], "family": q["family"],
                                "query": q["query"], "candidates": q["candidates"], "truth": truth_v4.get(q["query"]),
                                "expect": q["expect"]})
        if "ev" in want_sets:
            doc = json.loads((ROOT / "data/eval/v3_ranking_candidates_v2.json").read_text(encoding="utf-8"))
            for q in doc["queries"]:
                if q["family"].startswith("EV-") and q["query"] in truth_ev:
                    out.append({"set": "ev-crossdomain", "query_id": q["query_id"], "family": q["family"],
                                "query": q["query"], "candidates": q["candidates"], "truth": truth_ev.get(q["query"])})
        if "setb" in want_sets or "setc" in want_sets:
            doc = json.loads((ROOT / "data/eval/v4_1_cross_domain_ranking_candidates.json").read_text(encoding="utf-8"))
            for q in doc["queries"]:
                want = (q["split"] == "set-c" and "setc" in want_sets) or (q["split"] in ("val-b", "test-b") and "setb" in want_sets)
                if not want:
                    continue
                if q["split"] == "val-b" and "val-b" not in want_splits and "setb" in want_sets:
                    continue  # val-b only on explicit request (it is the selection split)
                out.append({"set": "setb" if q["split"] != "set-c" else "setc", "query_id": q["query_id"],
                            "family": q["family"], "domain": q.get("domain"),
                            "domainInTrain": q.get("domainInTrain"), "query": q["query"],
                            "candidates": q["candidates"], "truth": None})
        return out

    per_query = []
    setbc_matrix = []
    started = time.time()
    for q in queries_for():
        labels, extra = q["truth"] if q["truth"] else ({}, None)
        expect = q.get("expect") or (extra if extra in {"equipment_supplier", "material_supplier", "component_supplier"} else None)
        cross_labels = None
        if q["set"] in ("setb", "setc"):
            cross_labels = labels_for_pool(q, companies, profiles, enrichment)
            labels = {c: v["label"] for c, v in cross_labels.items()}
        items = []
        for cand in q["candidates"]:
            code = cand["code"]
            c = companies.get(code)
            if c is None:
                continue
            profile = (profiles.get(code) or {}).get("searchText") or c["judgeText"]
            ins = json.dumps({"company": {"name": c["name"], "code": code, "profile": profile},
                              "question": SCORE_QUESTION}, ensure_ascii=False)
            state = {"looking_for": q["query"][:300], "how_to_judge": HOW}
            seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
            if len(markers) != 4:
                continue
            items.append({"code": code, "ids": seq, "markers": markers, "qtype": QTYPES["score"], "target": [0.0] * 4, "label": -1})
        scores = {}
        t0 = time.time()
        with torch.no_grad():
            for at in range(0, len(items), args.micro_batch):
                chunk = items[at:at + args.micro_batch]
                batch = collate_local(chunk, tok.pad_token_id)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    logits, _ = model(batch["input_ids"].to(device), batch["attention_mask"].to(device),
                                      batch["marker_pos"].to(device), batch["marker_mask"].to(device),
                                      batch["qtype"].to(device))
                logits = logits.float().cpu()
                for j, it in enumerate(chunk):
                    k = len(it["markers"])
                    scores[it["code"]] = float((torch.softmax(logits[j, :k], -1) * torch.tensor(LEVELS[:k])).sum())
        ranked = [c["code"] for c in q["candidates"] if c["code"] in scores]
        ranked.sort(key=lambda c: -scores[c])

        def lbl(code):
            return labels.get(code, 0)

        p = {k: sum(1 for c in ranked[:k] if lbl(c) >= 2) / k for k in (5, 10, 20)}
        gains = [2 ** lbl(c) - 1 if lbl(c) >= 1 else 0.0 for c in ranked]
        ideal = sorted((2 ** l - 1 for l in labels.values() if l >= 1), reverse=True)
        ndcg = {k: (dcg(gains, k) / dcg(ideal, k) if dcg(ideal, k) > 0 else None) for k in (10, 20)}
        first_rel = next((i + 1 for i, c in enumerate(ranked) if lbl(c) >= 2), None)
        mrr = 1.0 / first_rel if first_rel else None
        rolematch = {k: sum(1 for c in ranked[:k] if lbl(c) == 3) / k for k in (5, 10)}
        inv = role_metrics(ranked, labels, expect or "", enrichment)
        hardneg10 = sum(1 for c in ranked[:10] if lbl(c) == 1) / 10
        excl_v = sum(1 for c in ranked[:20] if lbl(c) == 0)
        inv_detail = (inv or {}).get("detail") or []

        row = {
            "set": q["set"], "query_id": q["query_id"], "family": q["family"], "query": q["query"],
            "domain": q.get("domain"), "domainInTrain": q.get("domainInTrain"),
            "p@5": p[5], "p@10": p[10], "p@20": p[20], "ndcg@10": ndcg[10], "ndcg@20": ndcg[20],
            "mrr": mrr, "rolematch@5": rolematch[5], "rolematch@10": rolematch[10],
            "inv_instances": (inv or {}).get("instances"), "inv_wrong20": (inv or {}).get("wrong"),
            "inv_detail": inv_detail, "expect": expect, "category": q.get("category"),
            "hardneg@10": hardneg10, "excl_violation@20": excl_v,
            "score_seconds": round(time.time() - t0, 2),
            "top20": [{"rank": i + 1, "code": c, "name": companies.get(c, {}).get("name", "?"),
                       "score": round(scores[c], 3), "label": lbl(c)} for i, c in enumerate(ranked[:20])],
        }
        if q["set"] in ("setb", "setc"):
            anchor_rows = []
            intrusion = False
            margin = None
            rel_scores = [scores[c] for c in ranked if labels.get(c, 0) >= 2]
            for i, c in enumerate(ranked[:20]):
                v = cross_labels.get(c)
                if not v or not v["anchor"] or v["label"] > 1:
                    continue
                anchor_rows.append({"code": c, "rank": i + 1, "score": round(scores[c], 3), "injected": v["injected"]})
                if not v["injected"]:
                    intrusion = True
            anchor_all = [{"code": c, "score": round(scores[c], 3), "injected": cross_labels[c]["injected"]}
                          for c in ranked
                          if cross_labels.get(c, {}).get("anchor") and cross_labels[c]["label"] <= 1]
            best_anchor = max((a["score"] for a in anchor_all), default=None)
            if rel_scores and best_anchor is not None:
                margin = round(max(rel_scores) - best_anchor, 3)
            row["anchorRows"] = anchor_rows
            row["anchorAll"] = anchor_all
            row["anchorIntrusionTop20"] = intrusion
            row["anchorMeanAll"] = round(statistics.mean([a["score"] for a in anchor_all]), 3) if anchor_all else None
            row["margin"] = margin
            row["nRelevant"] = sum(1 for c in labels if labels[c] >= 2)
            setbc_matrix.append({c: scores[c] for c in ranked})
        per_query.append(row)
        print(f"[{args.tag}] {q['set']:<16} {q['query'][:24]:<26} P@10={p[10]:.2f} nDCG@10={ndcg[10]:.3f}", flush=True)

    summary = {
        "tag": args.tag,
        "checkpoint": str(ckpt),
        "elapsed_s": round(time.time() - started, 1),
        "n_queries": len(per_query),
    }
    for pool_set in sorted({q["set"] for q in per_query}):
        rows = [q for q in per_query if q["set"] == pool_set]

        def avg(key, pred=None):
            vals = [r[key] for r in rows if r.get(key) is not None and (pred is None or pred(r))]
            return round(sum(vals) / len(vals), 4) if vals else None

        inv_inst = sum(r["inv_instances"] or 0 for r in rows)
        inv_wrong = sum(r["inv_wrong20"] or 0 for r in rows)
        summary[pool_set] = {
            "n": len(rows),
            "P@5": avg("p@5"), "P@10": avg("p@10"), "P@20": avg("p@20"),
            "nDCG@10": avg("ndcg@10"), "nDCG@20": avg("ndcg@20"), "MRR": avg("mrr"),
            "RoleMatch@5": avg("rolematch@5"), "RoleMatch@10": avg("rolematch@10"),
            "ProcessSpecificP@10": avg("p@10", lambda r: r.get("category") == "process_word") if pool_set == "stage3" else None,
            "HardNeg@10": avg("hardneg@10"),
            "ExclWatch@20": avg("excl_violation@20"),
            "RoleInversionRate": round(inv_inst / inv_wrong, 4) if inv_wrong else 0.0,
            "inv_instances": inv_inst, "inv_wrong20": inv_wrong,
        }
        if pool_set in ("setb", "setc"):
            summary[pool_set].update(anchor_metrics(rows))
            summary[pool_set]["CompanyPriorVarianceShare"] = None  # set below over both sets
            # slice: train-covered vs zero-touch domains
            for slice_name, pred in (("domainInTrain", lambda r: r.get("domainInTrain")),
                                     ("domainZeroTouch", lambda r: r.get("domainInTrain") is False)):
                sub = [r for r in rows if pred(r)]
                if sub:
                    summary[pool_set][f"{slice_name}"] = anchor_metrics(sub)
    if setbc_matrix:
        share = prior_variance_share(setbc_matrix, list(ANCHOR_CODES))
        for pool_set in ("setb", "setc"):
            if pool_set in summary:
                summary[pool_set]["CompanyPriorVarianceShare"] = share

    # repeat-offender scan (§二十三): companies freeloading in Top20 across sets
    offender: dict[str, dict] = defaultdict(lambda: {"n": 0, "ranks": [], "scores": [], "families": set(), "labels0": 0})
    for r in per_query:
        for item in r["top20"]:
            if item["label"] >= 2:
                continue  # only watch rows that are NOT label-confirmed relevant
            o = offender[item["code"]]
            o["n"] += 1
            o["ranks"].append(item["rank"])
            o["scores"].append(item["score"])
            o["families"].add(r["family"])
            if item["label"] == 0:
                o["labels0"] += 1
    repeat = sorted(
        ({"code": c, "name": companies.get(c, {}).get("name", "?"), "top20Appearances": o["n"],
          "meanRank": round(statistics.mean(o["ranks"]), 1), "meanScore": round(statistics.mean(o["scores"]), 3),
          "nQueryFamilies": len(o["families"]), "label0Share": round(o["labels0"] / o["n"], 3)}
         for c, o in offender.items() if o["n"] >= 8),
        key=lambda x: (-x["top20Appearances"], x["meanRank"]),
    )
    summary["repeatOffenderWatch"] = repeat[:20]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "queries": per_query}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "repeatOffenderWatch"}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
