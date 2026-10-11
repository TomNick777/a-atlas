"""Company-prior audit (spec §14): does the reranker score the COMPANY or the
QUERY×COMPANY interaction?

Runs a fixed battery of queries × companies through two checkpoints and reports:
  companyPriorVarianceShare  between-company variance / total variance of scores
                             (lower = less "this company is always high")
  crossQueryCorrelation      mean Pearson correlation between score vectors of
                             query pairs (lower = more query-relative ordering)
  per-company score spread   std of a company's scores across the query battery

The battery mixes TRAIN texts and held-out texts on purpose: if V4 only improved
held-out but still memorised train companies, the audit exposes it (§35).

Usage:
  .venv/Scripts/python.exe -u scripts/laya_v4_prior_audit.py \
    --a models/a-share-laya-v3/checkpoint_best --tag-a v3 \
    --b models/a-share-laya-v4/checkpoint_best --tag-b v4 \
    --out reports/v4_eval/prior_audit.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from eval_role_ranking import HOW, SCORE_LEVELS, SCORE_QUESTION, LEVELS, collate_local  # noqa: E402

ANCHOR_EQUIPMENT = ["688012", "002371", "688072", "688082", "688120", "688037", "300604", "300666"]
ANCHOR_MATERIAL_COMPONENT = ["300666", "002409", "300054", "688019", "688056", "603688", "301611", "605358"]
ANCHOR_UNRELATED = ["600519", "601318", "600036", "000651", "601899", "600900", "601166", "000333"]


def battery_queries():
    queries = []
    doc = json.loads((ROOT / "data/eval/v4_role_ranking_candidates.json").read_text(encoding="utf-8"))
    for q in doc["queries"]:
        queries.append(q["query"])
    s3 = json.loads((ROOT / "data/eval/stage3_ranking_candidates_v3.json").read_text(encoding="utf-8"))
    for q in s3["queries"][:8]:
        queries.append(q["query"])
    # cross-domain + negative queries: without these the battery never asks a
    # question where a semiconductor anchor SHOULD score 0, and every semi model
    # would correlate with the "semi-ness" prior for trivial reasons
    seen = set(queries)
    for line in (ROOT / "data/eval/v3_search_benchmark.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row["family"].startswith("EV-") and row["query"] not in seen:
            queries.append(row["query"])
            seen.add(row["query"])
    return queries


def score_matrix(model, tok, device, companies, queries):
    from laya.common import QTYPES, build_sequence
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    matrix: dict[str, dict[str, float]] = {}
    for query in queries:
        items = []
        for code, c in companies.items():
            profile = profiles.get(code, {}).get("searchText") or c["judgeText"]
            ins = json.dumps({"company": {"name": c["name"], "code": code, "profile": profile},
                              "question": SCORE_QUESTION}, ensure_ascii=False)
            state = {"looking_for": query[:300], "how_to_judge": HOW}
            seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
            if len(markers) != 4:
                continue
            items.append({"code": code, "ids": seq, "markers": markers, "qtype": QTYPES["score"]})
        scores = {}
        import torch
        with torch.no_grad():
            for at in range(0, len(items), 24):
                chunk = items[at : at + 24]
                batch = collate_local(chunk, tok.pad_token_id)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    logits, _ = model(batch["input_ids"].to("cuda"), batch["attention_mask"].to("cuda"),
                                      batch["marker_pos"].to("cuda"), batch["marker_mask"].to("cuda"),
                                      batch["qtype"].to("cuda"))
                logits = logits.float().cpu()
                for j, it in enumerate(chunk):
                    k = len(it["markers"])
                    scores[it["code"]] = float((torch.softmax(logits[j, :k], -1) * torch.tensor(LEVELS[:k])).sum())
        matrix[query] = scores
        print(f"  scored {query[:26]}", flush=True)
    return matrix


def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    vx = sum((a - mx) ** 2 for a in xs) ** 0.5
    vy = sum((b - my) ** 2 for b in ys) ** 0.5
    return cov / (vx * vy) if vx and vy else 0.0


def audit(matrix, companies):
    codes = sorted(companies)
    all_scores = [matrix[q][c] for q in matrix for c in codes]
    total_var = statistics.pvariance(all_scores)
    company_means = {c: statistics.mean(matrix[q][c] for q in matrix) for c in codes}
    between_var = statistics.pvariance(list(company_means.values()))
    share = between_var / total_var if total_var else 0.0
    qkeys = sorted(matrix)
    corrs = []
    for i in range(len(qkeys)):
        for j in range(i + 1, len(qkeys)):
            qa, qb = qkeys[i], qkeys[j]
            shared = [c for c in codes if c in matrix[qa] and c in matrix[qb]]
            corrs.append(pearson([matrix[qa][c] for c in shared], [matrix[qb][c] for c in shared]))
    # scale-invariant prior dependence (§14 intent): per query, Spearman-style
    # Pearson corr between the query's score vector and the company prior-mean
    # vector over ranks. High = the model ranks by "is this company generally
    # good" (prior); low = rankings move with the query (query-relative).
    import math as _math

    def _ranks(vs):
        order = sorted(range(len(vs)), key=lambda i: vs[i])
        rk = [0.0] * len(vs)
        for pos, idx in enumerate(order):
            rk[idx] = float(pos)
        return rk

    prior_corrs = []
    prior_corrs_domain = []  # cross-domain queries only: semi anchors SHOULD sink
    semi_markers = ("半导体", "晶圆", "芯片", "ALD", "PVD", "CVD", "刻蚀", "CMP", "前驱体", "靶材", "光刻胶", "特气", "湿化学", "清洗", "涂胶显影", "量测", "离子注入", "硅片", "设备")
    for q in qkeys:
        shared = [c for c in codes if c in matrix[q]]
        pc = pearson(_ranks([matrix[q][c] for c in shared]), _ranks([company_means[c] for c in shared]))
        prior_corrs.append(pc)
        if not any(m in q for m in semi_markers):
            prior_corrs_domain.append(pc)
    per_company = {
        companies[c]["name"]: {
            "mean": round(company_means[c], 3),
            "std": round(statistics.pstdev([matrix[q][c] for q in matrix]), 3),
        }
        for c in codes
    }
    return {
        "companyPriorVarianceShare": round(share, 4),
        "priorRankCorrelation": round(sum(prior_corrs) / max(1, len(prior_corrs)), 4),
        "priorRankCorrelationCrossDomainOnly": round(sum(prior_corrs_domain) / max(1, len(prior_corrs_domain)), 4) if prior_corrs_domain else None,
        "nCrossDomainQueries": len(prior_corrs_domain),
        "crossQueryCorrelation": round(sum(corrs) / max(1, len(corrs)), 4),
        "perCompany": per_company,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", required=True)
    parser.add_argument("--tag-a", default="a")
    parser.add_argument("--b", default=None)
    parser.add_argument("--tag-b", default="b")
    parser.add_argument("--c", default=None)
    parser.add_argument("--tag-c", default="c")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import torch
    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import build_model
    from safetensors.torch import load_file

    companies: dict[str, dict] = {}
    all_companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    for code in dict.fromkeys(ANCHOR_EQUIPMENT + ANCHOR_MATERIAL_COMPONENT + ANCHOR_UNRELATED):
        if code in all_companies:
            companies[code] = all_companies[code]
    queries = battery_queries()
    print(f"audit battery: {len(queries)} queries × {len(companies)} companies", flush=True)

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))

    device = torch.device("cuda")
    results = {}
    for path, tag in ((args.a, args.tag_a), (args.b, args.tag_b), (args.c, args.tag_c)):
        if not path:
            continue
        ckpt = Path(path)
        cfg = json.loads((ckpt / "rl_agent_config.json").read_text(encoding="utf-8"))
        cfg["gradient_checkpointing"] = False
        model = build_model(cfg, encoder_dir=str(ckpt / "encoder"))
        model.load_state_dict(load_file(str(ckpt / "model.safetensors")), strict=True)
        model.to(device).eval()
        print(f"scoring with {tag}: {ckpt}", flush=True)
        matrix = score_matrix(model, tok, device, companies, queries)
        results[tag] = {"checkpoint": str(ckpt), **audit(matrix, companies)}
        results[tag]["_matrix"] = matrix  # kept in JSON for offline forensics
        print(tag, "prior metrics:", json.dumps({k: v for k, v in results[tag].items() if k.startswith(("prior", "cross", "company"))}), flush=True)
        del model
        torch.cuda.empty_cache()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"battery": {"queries": len(queries), "companies": len(companies)}, "results": results}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("saved", out)


if __name__ == "__main__":
    main()
