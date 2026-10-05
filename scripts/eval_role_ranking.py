"""V4 role-aware ranking benchmark: same-pool V3/V4 comparison (spec §19/§21/§16).

Scores FROZEN candidate pools through a given checkpoint locally (production text
shape, score-head expected grade 0-3) and computes:

  P@5/10/20, nDCG@10/20, MRR            (label>=2 relevant; gains 2^label-1)
  RoleMatch@5/10                        (share of top-k that are grade-3 core-role)
  RoleInversionRate                      (§20 definition, evidenced roles only)
  EquipVsMaterial / EquipVsComponent inversion sub-rates
  ProcessSpecificP@10 (stage3 process_word queries only)
  HardNeg@10, ExclusionViolation@20

Pool sets (all frozen; retrieval identical for both checkpoints — §21):
  stage3  data/eval/stage3_ranking_candidates_v3.json  (87×200)
  focus   data/eval/stage3_1_focus_pools.json          (8×20)
  v4role  data/eval/v4_role_ranking_candidates.json    (32×200, val+test)
  ev      data/eval/v3_ranking_candidates_v2.json      (39×200, cross-domain §33)

--ablate-name  replaces the company name with 某公司 and the code with ×× (§16);
run both checkpoints normally AND ablated to fill the ablation table.

Usage:
  .venv/Scripts/python.exe -u scripts/eval_role_ranking.py \
    --checkpoint models/a-share-laya-v3/checkpoint_best --tag v3 \
    --out reports/v4_eval/v3_full.json
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_roles import AMBIGUOUS_CODES, company_caps, grade_caps, load_enrichment, parse_intent  # noqa: E402

HOW = (
    "looking_for 是一个人用自己的话说想找的公司。"
    "每一题是一家候选公司，profile 是它的公开业务资料。"
    "判断这家公司的主营业务是否就是这句话在找的东西。"
    "概念标签沾边但主营无关，回答要低。"
    "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。"
    "几家公司可以同时符合。"
)
SCORE_QUESTION = "company 与 looking_for 的相关程度?0 无关,1 沾边,2 部分相关,3 主营直接相关。"
SCORE_LEVELS = [
    "0=无关:主营业务与查询要找的无关",
    "1=沾边:概念/名字/大类相邻,主营业务并不符合",
    "2=部分相关:产业链上下游,或组合条件只满足一半",
    "3=直接相关:主营业务就是查询要找的东西",
]
LEVELS = [0.0, 1.0, 2.0, 3.0]
ROLE_OF_EXPECT = {"equipment": "equipment_supplier", "material": "material_supplier", "component": "component_supplier"}


def load_stage3_truth():
    truth = {}
    for line in (ROOT / "data/eval/stage3_semiconductor_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            labels = {r["code"]: 3 for r in row.get("relevant3", [])}
            labels.update({r["code"]: 2 for r in row.get("relevant2", [])})
            for r in row.get("hard1", []) + row.get("known_hard_negatives", []):
                labels.setdefault(r["code"], 1)
            for r in row.get("known_excludes", []):
                labels.setdefault(r["code"], 0)
            truth[row["query"]] = (labels, row.get("category"))
    return truth


def load_v4_truth():
    truth = {}
    for line in (ROOT / "data/eval/v4_role_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            labels = {c: 3 for c in row["relevant3"]} | {c: 2 for c in row["relevant2"]}
            for c in row["hard1"]:
                labels.setdefault(c, 1)
            for c in row.get("negativeWatch", []):
                labels.setdefault(c, 0)
            truth[row["query"]] = (labels, row["expect"])
    return truth


def load_ev_truth():
    truth = {}
    for line in (ROOT / "data/eval/v3_search_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            labels = {r["code"]: 3 for r in row.get("relevant3", [])}
            labels.update({r["code"]: 2 for r in row.get("relevant2", [])})
            for r in row.get("hard1", []) + row.get("known_hard_negatives", []):
                labels.setdefault(r["code"], 1)
            for r in row.get("known_excludes", []):
                labels.setdefault(r["code"], 0)
            truth[row["query"]] = (labels, None)
    return truth


def dcg(gains, k):
    return sum(g / math.log2(i + 2) for i, g in enumerate(gains[:k]))


def role_metrics(ranked, labels, expect, enrichment):
    """§20 inversion: evidenced wrong-role rows (AMBIGUOUS never counts, §31)
    ranked above the first label>=2 row. Returns None or a dict with instance
    counts and per-pair role detail for the EquipVsMaterial/Component sub-rates."""
    top20 = ranked[:20]
    first_good = next((i for i, c in enumerate(ranked) if labels.get(c, 0) >= 2), None)
    expect_role = ROLE_OF_EXPECT.get(expect)
    wrong = []
    for i, code in enumerate(top20):
        if labels.get(code, 0) > 1 or code in AMBIGUOUS_CODES:
            continue
        roles = set((enrichment.get(code) or {}).get("roles") or [])
        if not roles or expect_role is None:
            continue
        if expect_role not in roles:
            wrong.append({"rank0": i, "roles": sorted(roles)})
    if first_good is None or not wrong:
        return None
    instances = [w for w in wrong if w["rank0"] < first_good]
    return {"instances": len(instances), "wrong": len(wrong), "detail": instances}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--pool-sets", default="stage3,focus,v4role,ev")
    parser.add_argument("--micro-batch", type=int, default=32)
    parser.add_argument("--ablate-name", action="store_true")
    parser.add_argument("--splits", default="val,test", help="v4role splits to include")
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
                # focus pools carry expect roles but no frozen label lists — grade the
                # pool with the deterministic grader (same facts the V4 benchmark froze)
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
            splits = set(args.splits.split(","))
            for q in doc["queries"]:
                if q["split"] in splits:
                    out.append({"set": f"v4role-{q['split']}", "query_id": q["query_id"], "family": q["family"],
                                "query": q["query"], "candidates": q["candidates"], "truth": truth_v4.get(q["query"]),
                                "expect": q["expect"]})
        if "ev" in want_sets:
            doc = json.loads((ROOT / "data/eval/v3_ranking_candidates_v2.json").read_text(encoding="utf-8"))
            for q in doc["queries"]:
                if q["family"].startswith("EV-") and q["query"] in truth_ev:
                    out.append({"set": "ev-crossdomain", "query_id": q["query_id"], "family": q["family"],
                                "query": q["query"], "candidates": q["candidates"], "truth": truth_ev.get(q["query"])})
        return out

    started = time.time()
    per_query = []
    for q in queries_for():
        labels, extra = q["truth"] if q["truth"] else ({}, None)
        if not labels:
            continue
        expect = q.get("expect") or (extra if extra in ROLE_OF_EXPECT else None)
        items = []
        for cand in q["candidates"]:
            code = cand["code"]
            c = companies.get(code)
            if c is None:
                continue
            name = "某公司" if args.ablate_name else c["name"]
            code_field = "******" if args.ablate_name else code
            profile = profiles.get(code, {}).get("searchText") or c["judgeText"]
            ins = json.dumps({"company": {"name": name, "code": code_field, "profile": profile},
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
                chunk = items[at : at + args.micro_batch]
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
        # grade-0 rows in top20 (frozen watch list) — identical treatment for both
        # checkpoints, so the V3/V4 delta is fair even though this is watch-based
        excl_v = sum(1 for c in ranked[:20] if lbl(c) == 0)
        inv_detail = (inv or {}).get("detail") or []
        per_query.append({
            "set": q["set"], "query_id": q["query_id"], "family": q["family"], "query": q["query"],
            "p@5": p[5], "p@10": p[10], "p@20": p[20], "ndcg@10": ndcg[10], "ndcg@20": ndcg[20],
            "mrr": mrr, "rolematch@5": rolematch[5], "rolematch@10": rolematch[10],
            "inv_instances": (inv or {}).get("instances"), "inv_wrong20": (inv or {}).get("wrong"),
            "inv_detail": inv_detail, "expect": expect, "category": q.get("category"),
            "hardneg@10": hardneg10, "excl_violation@20": excl_v,
            "score_seconds": round(time.time() - t0, 2),
            "top20": [{"rank": i + 1, "code": c, "name": companies.get(c, {}).get("name", "?"),
                       "score": round(scores[c], 3), "label": lbl(c)} for i, c in enumerate(ranked[:20])],
        })
        print(f"[{args.tag}] {q['set']:<16} {q['query'][:24]:<26} P@10={p[10]:.2f} nDCG@10={ndcg[10]:.3f} rm@10={rolematch[10]:.2f} inv={inv['instances'] if inv else '-'}", flush=True)

    summary = {
        "tag": args.tag,
        "checkpoint": str(ckpt),
        "ablate_name": args.ablate_name,
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
        # sub-rates (§19): equipment↔material and equipment↔component inversions
        em_inst = em_wrong = ec_inst = ec_wrong = 0
        for r in rows:
            expect_role = ROLE_OF_EXPECT.get(r.get("expect") or "")
            for w in r.get("inv_detail") or []:
                pairs = {(expect_role, role) for role in w["roles"] if role != expect_role}
                wrong_roles = {role for _, role in pairs}
                if {"equipment_supplier", "material_supplier"} & wrong_roles and expect_role in ("equipment_supplier", "material_supplier"):
                    em_wrong += 1
                if {"equipment_supplier", "component_supplier"} & wrong_roles and expect_role in ("equipment_supplier", "component_supplier"):
                    ec_wrong += 1
        summary[pool_set] = {
            "n": len(rows),
            "P@5": avg("p@5"), "P@10": avg("p@10"), "P@20": avg("p@20"),
            "nDCG@10": avg("ndcg@10"), "nDCG@20": avg("ndcg@20"), "MRR": avg("mrr"),
            "RoleMatch@5": avg("rolematch@5"), "RoleMatch@10": avg("rolematch@10"),
            "ProcessSpecificP@10": avg("p@10", lambda r: r.get("category") == "process_word") if pool_set == "stage3" else None,
            "HardNeg@10": avg("hardneg@10"),
            "ExclWatch@20": avg("excl_violation@20"),
            "RoleInversionRate": round(inv_inst / inv_wrong, 4) if inv_wrong else 0.0,
            "EquipVsMaterialInversionRate": round(em_inst / em_wrong, 4) if em_wrong else 0.0,
            "EquipVsComponentInversionRate": round(ec_inst / ec_wrong, 4) if ec_wrong else 0.0,
            "inv_instances": inv_inst, "inv_wrong20": inv_wrong,
        }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "queries": per_query}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


def collate_local(items, pad_id):
    """Mirror of train_laya.collate without the training-only fields."""
    import torch
    n = len(items)
    L = max(len(it["ids"]) for it in items)
    kmax = max(len(it["markers"]) for it in items)
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    for i, it in enumerate(items):
        ids[i, : len(it["ids"])] = torch.tensor(it["ids"])
        att[i, : len(it["ids"])] = 1
        k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"])
        mmask[i, :k] = True
    return {"input_ids": ids, "attention_mask": att, "marker_pos": mpos, "marker_mask": mmask,
            "qtype": torch.tensor([it["qtype"] for it in items])}


if __name__ == "__main__":
    main()
