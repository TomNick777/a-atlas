"""V4.1 prior root-cause audit (spec §三): WHY does V4 lift semiconductor anchors
on irrelevant queries? Four evidence tracks, all frozen-data only:

  A. company-level prior   — from the V4 frozen audit battery matrix
                             (reports/v4_eval/prior_audit.json, 77 queries × 23
                             companies, V3+V4): per-company mean/median/P90 grade,
                             P(>=1.5), P(>=2.0) on the non-semiconductor queries.
  B. profile-feature prior — per-company V4-V3 lift correlated with profile
                             structure (工艺 section, tag count, role count); plus
                             a live PROFILE-PERMUTATION probe (§25): keep the
                             company identity, swap the profile text with a
                             non-semiconductor company's — does the score follow
                             the profile or the identity?
  C. training-frequency    — from data/train/v4_train_pairs.jsonl: anchor row
                             counts, label mix, positive-supervision concentration,
                             and THE smoking gun: how many (anchor x cross-domain
                             query) rows with grade<=1 supervision V4 ever saw.
  D. role prior            — V4 anchor scores on cross-domain queries split by
                             anchor role band: does the mere presence of
                             equipment/material/component role tags raise scores?

Outputs: reports/v4_1_eval/prior_root_cause.json (+ stdout summary MD tables).
Usage: .venv/Scripts/python.exe -u scripts/laya_v4_1_prior_audit.py
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from laya_v4_1_cross_domain import FAMILIES, ANCHOR_CODES, grade_cross_domain, company_evidence  # noqa: E402
from laya_v4_roles import AMBIGUOUS_CODES, load_enrichment  # noqa: E402
from eval_role_ranking import HOW, SCORE_LEVELS, SCORE_QUESTION, LEVELS, collate_local  # noqa: E402

SEMI_MARKERS = ("半导体", "晶圆", "芯片", "ALD", "PVD", "CVD", "刻蚀", "CMP", "前驱体", "靶材", "光刻胶",
                "特气", "湿化学", "清洗", "涂胶显影", "量测", "离子注入", "硅片", "设备", "光刻")
PERM_ANCHORS = ["300666", "688012", "002371", "688072", "002409", "688019"]
PERM_PARTNERS = ["600519", "000651", "600900", "601899"]  # 茅台/格力/长电/紫金 — non-semi profiles
PROBE_QUERIES = [
    ("EV", "铜价上涨可能直接受益的资源类公司，不要铜加工企业"),
    ("EV", "人形机器人上游核心零部件，但不要整机厂"),
    ("EV", "主营业务和服务器散热、机房温控、液冷有关的公司"),
    ("EV", "汽车热管理公司"),
    ("EV", "AI 算力相关的硬件公司，但不要纯软件公司"),
    ("VAL-B", "主营高端白酒的公司"),
    ("VAL-B", "股份制商业银行"),
    ("VAL-B", "特高压输变电设备制造商"),
]


def pct(values: list[float], q: float) -> float:
    vs = sorted(values)
    at = min(len(vs) - 1, int(q * len(vs)))
    return vs[at]


def anchor_track_a() -> dict:
    """A: per-company irrelevant-query grade stats from the frozen V4 audit matrix."""
    doc = json.loads((ROOT / "reports/v4_eval/prior_audit.json").read_text(encoding="utf-8"))
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    out = {}
    for tag, res in doc["results"].items():
        matrix = res["_matrix"]
        per = {}
        for code in sorted(next(iter(matrix.values()))):
            name = companies.get(code, {}).get("name", code)
            semi_scores, xdom_scores = [], []
            for query, scores in matrix.items():
                if code not in scores:
                    continue
                (semi_scores if any(m in query for m in SEMI_MARKERS) else xdom_scores).append(scores[code])
            if not xdom_scores:
                continue
            per[code] = {
                "name": name,
                "nXdom": len(xdom_scores),
                "mean": round(statistics.mean(xdom_scores), 3),
                "median": round(statistics.median(xdom_scores), 3),
                "p90": round(pct(xdom_scores, 0.9), 3),
                "p_ge_1_5": round(sum(1 for s in xdom_scores if s >= 1.5) / len(xdom_scores), 3),
                "p_ge_2_0": round(sum(1 for s in xdom_scores if s >= 2.0) / len(xdom_scores), 3),
                "semiMean": round(statistics.mean(semi_scores), 3) if semi_scores else None,
            }
        out[tag] = per
    return out


def intrusion_track_a() -> dict:
    """A2: anchor intrusion into the ev-crossdomain Top20 (frozen v3/v4_full.json)."""
    anchors = dict.fromkeys(list(ANCHOR_CODES))
    out = {}
    for tag in ("v3", "v4"):
        doc = json.loads((ROOT / f"reports/v4_eval/{tag}_full.json").read_text(encoding="utf-8"))
        rows = [q for q in doc["queries"] if q["set"] == "ev-crossdomain"]
        per = {c: {"n": 0, "top20": 0, "top10": 0, "ranks": []} for c in anchors}
        for q in rows:
            for item in q["top20"]:
                c = item["code"]
                if c in per and item["label"] <= 1:  # no benchmark truth says it is relevant
                    per[c]["n"] += 1
                    per[c]["top20"] += 1
                    per[c]["top10"] += 1 if item["rank"] <= 10 else 0
                    per[c]["ranks"].append(item["rank"])
        out[tag] = {
            companies_name(c): {
                "evQueries": len(rows),
                "top20Hits": p["top20"],
                "top10Hits": p["top10"],
                "meanRankWhenPresent": round(statistics.mean(p["ranks"]), 1) if p["ranks"] else None,
            } for c, p in per.items()
        }
    return out


def companies_name(code: str) -> str:
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    return companies.get(code, {}).get("name", code)


def training_track_c() -> dict:
    """C: training-frequency prior in data/train/v4_train_pairs.jsonl."""
    rows = [json.loads(l) for l in (ROOT / "data/train/v4_train_pairs.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    enr = load_enrichment()
    per_anchor = {}
    for code, name in ANCHOR_CODES.items():
        rs = [r for r in rows if r["code"] == code]
        labels = [r["label"] for r in rs]
        xdom = [r for r in rs if not any(m in r["query"] for m in SEMI_MARKERS)]
        xdom_low = [r for r in xdom if r["label"] <= 1]
        per_anchor[name] = {
            "rows": len(rs),
            "labelDist": {str(l): labels.count(l) for l in sorted(set(labels))},
            "positiveShare(>=2)": round(sum(1 for l in labels if l >= 2) / max(1, len(labels)), 3),
            "crossDomainRows": len(xdom),
            "crossDomainLowRows": len(xdom_low),
        }
    total_pos = sum(1 for r in rows if r["label"] >= 2)
    by_code = {}
    for r in rows:
        if r["label"] >= 2:
            by_code[r["code"]] = by_code.get(r["code"], 0) + 1
    top10 = sorted(by_code.values(), reverse=True)[:10]
    # domain exposure of grade>=2 supervision: semiconductor-enriched vs not
    enr_codes = set(enr)
    pos_semi = sum(1 for r in rows if r["label"] >= 2 and r["code"] in enr_codes)
    label0_semi = sum(1 for r in rows if r["label"] == 0 and r["code"] in enr_codes)
    label0_semi_xdomq = sum(1 for r in rows if r["label"] == 0 and r["code"] in enr_codes
                            and not any(m in r["query"] for m in SEMI_MARKERS))
    label0_semi_semiq = label0_semi - label0_semi_xdomq
    return {
        "perAnchor": per_anchor,
        "positiveSupervision": {
            "totalPositiveRows": total_pos,
            "top10CompanyShare": round(sum(top10) / max(1, total_pos), 3),
            "top10Companies": top10,
            "positiveRowsOnSemiCompanies": pos_semi,
            "positiveRowsOnNonSemiCompanies": total_pos - pos_semi,
        },
        "grade0Supervision": {
            "onSemiCompaniesTotal": label0_semi,
            "onSemiCompaniesUnderSemiQuery": label0_semi_semiq,
            "onSemiCompaniesUnderCrossDomainQuery": label0_semi_xdomq,
            "onNonSemiCompanies": sum(1 for r in rows if r["label"] == 0 and r["code"] not in enr_codes),
        },
        "nRows": len(rows),
    }


def feature_track_b() -> dict:
    """B: which profile features carry the V4 lift (frozen matrix + profiles)."""
    doc = json.loads((ROOT / "reports/v4_eval/prior_audit.json").read_text(encoding="utf-8"))
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))
    enr = load_enrichment()
    comps = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    companies = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    v3, v4 = doc["results"]["v3"]["_matrix"], doc["results"]["v4"]["_matrix"]
    codes = sorted(next(iter(v4.values())))
    rows = []
    for code in codes:
        xdom_q = [q for q in v4 if code in v4[q] and not any(m in q for m in SEMI_MARKERS)]
        if not xdom_q:
            continue
        lift = statistics.mean(v4[q][code] for q in xdom_q) - statistics.mean(v3[q][code] for q in xdom_q)
        st = (profiles.get(code) or {}).get("searchText") or ""
        rec = enr.get(code)
        rows.append({
            "name": companies[code]["name"],
            "v4XdomMean": round(lift + statistics.mean(v3[q][code] for q in xdom_q), 3),
            "v3XdomMean": round(statistics.mean(v3[q][code] for q in xdom_q), 3),
            "lift": round(lift, 3),
            "hasProcessSection": "工艺:" in st,
            "hasTagSection": "标签:" in st,
            "tagListLen": len(st.split("标签:")[-1]) if "标签:" in st else 0,
            "profileLen": len(st),
            "nRoles": len((rec or {}).get("roles") or []),
            "nCaps": len((rec or {}).get("processCapabilities") or []),
            "isEnriched": code in enr,
            "isAnchor": code in ANCHOR_CODES,
            "ambiguous": code in AMBIGUOUS_CODES,
        })

    def corr(xs, ys):
        n = len(xs)
        mx, my = sum(xs) / n, sum(ys) / n
        cov = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
        vx = sum((a - mx) ** 2 for a in xs) ** 0.5
        vy = sum((b - my) ** 2 for b in ys) ** 0.5
        return round(cov / (vx * vy), 3) if vx and vy else 0.0

    enriched = [r for r in rows if r["isEnriched"]]
    return {
        "perCompany": rows,
        "pearsonLiftVs": {
            "nRoles": corr([r["nRoles"] for r in enriched], [r["lift"] for r in enriched]),
            "nCaps": corr([r["nCaps"] for r in enriched], [r["lift"] for r in enriched]),
            "tagListLen": corr([r["tagListLen"] for r in enriched], [r["lift"] for r in enriched]),
            "profileLen": corr([r["profileLen"] for r in enriched], [r["lift"] for r in enriched]),
        },
        "meanLiftEnriched": round(statistics.mean(r["lift"] for r in enriched), 3),
        "meanLiftNonEnriched": round(statistics.mean(r["lift"] for r in rows if not r["isEnriched"]), 3),
    }


def permutation_probe() -> dict:
    """B/§25: identity vs profile. Same forward pass, three conditions per
    anchor × probe query:
      own        (real name, real profile)
      swapped    (real name, partner company's profile)   ← score follows profile?
      anon       (某公司/******, real profile)             ← score depends on name?
    """
    import torch
    from transformers import AutoTokenizer
    from huggingface_hub import snapshot_download
    from laya.agent import _fix_tokenizer_config
    from laya.common import QTYPES, build_model, build_sequence
    from safetensors.torch import load_file

    comps = {c["code"]: c for c in json.loads((ROOT / "data/companies.json").read_text(encoding="utf-8"))["companies"]}
    profiles = json.loads((ROOT / "data/search_profiles_v3.json").read_text(encoding="utf-8"))

    def prof(code):
        return (profiles.get(code) or {}).get("searchText") or comps[code]["judgeText"]

    model_dir = snapshot_download("convaiinnovations/laya", allow_patterns=["multilingual/tokenizer/*"])
    _fix_tokenizer_config(model_dir)
    tok = AutoTokenizer.from_pretrained(str(Path(model_dir) / "multilingual" / "tokenizer"))
    ckpt = ROOT / "models/a-share-laya-v4-candidate/checkpoint_best"
    cfg = json.loads((ckpt / "rl_agent_config.json").read_text(encoding="utf-8"))
    cfg["gradient_checkpointing"] = False
    model = build_model(cfg, encoder_dir=str(ckpt / "encoder"))
    model.load_state_dict(load_file(str(ckpt / "model.safetensors")), strict=True)
    model.to("cuda").eval()

    import re as _re

    def prof_stripped(code):
        """searchText with the Stage3.1-injected sections (工艺/标签/应用/角色/商品/
        细分/排除 tails) removed — keeps 主营/产品/行业 only. Isolates whether the
        ENRICHMENT sections are the prior's trigger."""
        st = prof(code)
        cut = len(st)
        for marker in (" | 工艺:", " | 标签:", " | 应用:", " | 角色:", " | 商品:", " | 细分:", " | 排除:"):
            at = st.find(marker)
            if at != -1:
                cut = min(cut, at)
        return st[:cut]

    results = {}
    for a_code in PERM_ANCHORS:
        for p_code in PERM_PARTNERS:
            if a_code == p_code:
                continue
            rows = []
            for origin, q in PROBE_QUERIES:
                for cond, (name, code_field, profile) in {
                    "own": (comps[a_code]["name"], a_code, prof(a_code)),
                    "swapped": (comps[a_code]["name"], a_code, prof(p_code)),
                    "anon": ("某公司", "******", prof(a_code)),
                    "stripped": (comps[a_code]["name"], a_code, prof_stripped(a_code)),
                }.items():
                    ins = json.dumps({"company": {"name": name, "code": code_field, "profile": profile},
                                      "question": SCORE_QUESTION}, ensure_ascii=False)
                    state = {"looking_for": q[:300], "how_to_judge": HOW}
                    seq, markers = build_sequence(tok, state, {"t": "score", "ins": ins, "crit": SCORE_LEVELS}, 2048, 512)
                    if len(markers) != 4:
                        continue
                    rows.append({"cond": cond, "query": q, "origin": origin, "ids": seq, "markers": markers, "qtype": QTYPES["score"]})
            with torch.no_grad():
                for at in range(0, len(rows), 24):
                    chunk = rows[at:at + 24]
                    batch = collate_local(chunk, tok.pad_token_id)
                    with torch.autocast("cuda", dtype=torch.bfloat16):
                        logits, _ = model(batch["input_ids"].to("cuda"), batch["attention_mask"].to("cuda"),
                                          batch["marker_pos"].to("cuda"), batch["marker_mask"].to("cuda"),
                                          batch["qtype"].to("cuda"))
                    logits = logits.float().cpu()
                    for j, it in enumerate(chunk):
                        k = len(it["markers"])
                        it["score"] = round(float((torch.softmax(logits[j, :k], -1) * torch.tensor(LEVELS[:k])).sum()), 3)
            for cond in ("own", "swapped", "anon", "stripped"):
                key = f"{comps[a_code]['name']}|{comps[p_code]['name']}|{cond}"
                results[key] = round(statistics.mean(r["score"] for r in rows if r["cond"] == cond), 3)
        print(f"  permuted {comps[a_code]['name']}", flush=True)
    return results


def main() -> None:
    do_gpu = "--no-gpu" not in sys.argv
    out = {"generatedAt": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
           "checkpoints": {"v3": "models/a-share-laya-v3/checkpoint_best (419daa88)",
                           "v4": "models/a-share-laya-v4-candidate/checkpoint_best (c3069e65)"}}
    print("track A: company-level prior from frozen audit matrix…", flush=True)
    out["A_companyPrior"] = anchor_track_a()
    out["A_anchorIntrusionEvTop20"] = intrusion_track_a()
    print("track B: profile-feature prior…", flush=True)
    out["B_profileFeature"] = feature_track_b()
    print("track C: training-frequency prior…", flush=True)
    out["C_trainingFrequency"] = training_track_c()
    if do_gpu:
        print("track B2: profile-permutation probe (GPU)…", flush=True)
        out["B2_permutation"] = permutation_probe()
    out_path = ROOT / "reports/v4_1_eval/prior_root_cause.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("saved", out_path)


if __name__ == "__main__":
    main()
