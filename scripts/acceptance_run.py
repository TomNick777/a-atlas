"""Blind acceptance runner: full-pool Laya scoring for 20 fixed queries.

Start the production sidecar first (`.venv/Scripts/python.exe -u
scripts/laya_server.py --checkpoint models/a-share-laya/checkpoint_best`, i.e.
`npm run laya:ft`), then run this script. It rebuilds the exact production wire
calls of lib/jev/judge.ts — same state, same noul instructions, chunks of 100
questions — but sends every one of the 5,567 companies in data/companies.json
per query instead of the retrieval finalists, so the ranking measured is the
fine-tuned model's own. No filtering, no rerank, no threshold: Top 20 is a pure
sort of all raw noul scores. Nothing is judged or filtered here; the output is
handed to an external referee.

Only deliberate deviation from the Node client, recorded in meta: the HTTP
timeout is 120s (judge.ts uses 12s) so harness networking cannot inject chunk
failures into the sample. Chunk failures still trigger judge.ts's median
fallback and are flagged per query.

Usage: .venv/Scripts/python.exe -u scripts/acceptance_run.py
"""

from __future__ import annotations

import hashlib
import json
import os
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path

os.environ.setdefault("USE_TF", "0")

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "reports" / "acceptance"
SIDECAR = os.environ.get("LAYA_ACCEPT_URL", "http://127.0.0.1:8787")
TIMEOUT_S = 120
CHUNK = 100  # judge.ts CHUNK

# Verbatim from lib/jev/judge.ts.
HOW = (
    "looking_for 是一个人用自己的话说想找的公司。"
    "每一题是一家候选公司，profile 是它的公开业务资料。"
    "判断这家公司的主营业务是否就是这句话在找的东西。"
    "概念标签沾边但主营无关，回答要低。"
    "地域、是否排除某类公司，资料里写了就按资料判断；资料没写就不要猜。"
    "几家公司可以同时符合。"
)

QUESTION = "company 是否符合 looking_for 要找的公司？"
YES = "主营业务就是这句话在找的，地域等硬条件也对得上。"
NO = "只是概念沾边、名字像、或者属于这句话明确排除的那一类。"

# The 20 acceptance queries, verbatim from the acceptance brief. Do not edit.
QUERIES = [
    ("Q01", "人形机器人上游核心零部件，但不要整机厂"),
    ("Q02", "给数据中心做液冷散热的公司"),
    ("Q03", "AI 算力相关的硬件公司，但不要纯软件公司"),
    ("Q04", "做工业自动化，同时海外业务比较多的公司"),
    ("Q05", "铜价上涨可能直接受益的资源类公司，不要铜加工企业"),
    ("Q06", "新能源汽车上游材料公司，但不要整车厂"),
    ("Q07", "国产半导体设备公司"),
    ("Q08", "专门做半导体清洗、刻蚀或者薄膜沉积设备的公司"),
    ("Q09", "做机器人减速器、伺服、电机这些核心零部件的公司"),
    ("Q10", "给数据中心做供配电、UPS、电源保障的公司"),
    ("Q11", "做消费电子精密零部件，同时有大量海外客户的公司"),
    ("Q12", "主营和苹果产业链有关，但不是手机品牌公司的公司"),
    ("Q13", "工业机器人相关，但不要只因为“机器人概念”就算进去"),
    ("Q14", "AI 数据中心建设会需要的基础设施公司，不要大模型软件公司"),
    ("Q15", "真正做新能源汽车电池材料的公司，不要因为投资了新能源项目就算"),
    ("Q16", "类似汇川技术：工业自动化、伺服、控制器、电机这些方向的公司"),
    ("Q17", "机器人灵巧手可能需要的电机、传动、传感器公司"),
    ("Q18", "半导体国产替代里真正卖生产设备的公司，不要芯片设计公司"),
    ("Q19", "主要靠海外市场赚钱的中国制造业公司"),
    ("Q20", "主营业务和服务器散热、机房温控、液冷有关的公司"),
]

CHECKPOINT = "models/a-share-laya/checkpoint_best"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def collect_meta(companies_path: Path) -> dict:
    import laya

    health = json.loads(urllib.request.urlopen(f"{SIDECAR}/health", timeout=10).read())
    dirty = [line for line in git("status", "--porcelain").splitlines() if line.strip()]
    cfg = json.loads((ROOT / CHECKPOINT / "rl_agent_config.json").read_text(encoding="utf-8"))
    return {
        "purpose": "blind acceptance raw sample — no judging, no tuning; external referee scores relevance",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "git_head": git("rev-parse", "HEAD"),
        "git_worktree_dirty": bool(dirty),
        "git_dirty_paths": sorted({line[3:] for line in dirty}),
        "laya_server_script_blob": git("hash-object", "scripts/laya_server.py"),
        "judge_ts_blob": git("hash-object", "lib/jev/judge.ts"),
        "checkpoint": CHECKPOINT,
        "checkpoint_npm_command": "npm run laya:ft",
        "model_safetensors_sha256": sha256_file(ROOT / CHECKPOINT / "model.safetensors"),
        "rl_agent_config": {k: cfg[k] for k in ("temperature",) if k in cfg} | {"a_share_training": cfg.get("a_share_training")},
        "companies_file": "data/companies.json",
        "companies_sha256_16": sha256_file(companies_path)[:16],
        "n_companies": 0,  # filled by caller
        "laya_python_pkg_version": getattr(laya, "__version__", None),
        "sidecar_health": health,
        "sidecar_overrides": {
            "LAYA_TEMPERATURE_NOUL": "unset (sidecar default 0 → no temperature override)",
            "LAYA_MAX_LEN": "unset (sidecar default 2048)",
            "LAYA_HEAD_MAX_LEN": "unset (sidecar default 512)",
            "LAYA_MIN_NOUL_SPREAD": "unset (sidecar default 0.005, refusal active)",
            "LAYA_CHECKPOINT/LAYA_DEVICE": "argv only: --checkpoint models/a-share-laya/checkpoint_best",
        },
        "chunk_size": CHUNK,
        "client_timeout_ms": TIMEOUT_S * 1000,
        "timeout_deviation_note": "judge.ts uses 12000ms; this harness uses a longer timeout so networking cannot inject chunk failures",
        "ranking_rule": "sort by noul score desc, ties broken by corpus order in data/companies.json",
        "top_k": 20,
    }


def ask_chunk(query: str, part: list[dict]) -> dict:
    """One production wire call, byte-equivalent to judge.ts ask()."""
    questions = {
        f"c{i}": {
            "type": "noul",
            "instructions": {
                "company": {"name": c["name"], "code": c["code"], "profile": c["judgeText"]},
                "question": QUESTION,
                "yes": YES,
                "no": NO,
            },
        }
        for i, c in enumerate(part)
    }
    body = json.dumps(
        {"state": {"looking_for": query[:300], "how_to_judge": HOW}, "questions": questions},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{SIDECAR}/v1/systemone", data=body, headers={"content-type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read())


def tokenizer_counter():
    """Exact token counts via the checkpoint's own build_sequence path."""
    from transformers import AutoTokenizer
    from laya.common import build_sequence

    tok = AutoTokenizer.from_pretrained(str(ROOT / CHECKPOINT / "tokenizer"))

    def count(query: str, company: dict) -> tuple[int, str]:
        instructions = {
            "company": {"name": company["name"], "code": company["code"], "profile": company["judgeText"]},
            "question": QUESTION,
            "yes": YES,
            "no": NO,
        }
        serialized = json.dumps(instructions, ensure_ascii=False)  # sidecar_ins, byte-exact
        q_internal = {"t": "noul", "ins": serialized, "crit": None}
        state = {"looking_for": query[:300], "how_to_judge": HOW}
        seq, _ = build_sequence(tok, state, q_internal, 2048, 512)
        return len(seq), serialized

    return count


def main() -> None:
    companies_path = ROOT / "data" / "companies.json"
    companies = json.loads(companies_path.read_text(encoding="utf-8"))["companies"]
    print(f"companies: {len(companies)}", flush=True)

    meta = collect_meta(companies_path)
    meta["n_companies"] = len(companies)
    count_tokens = tokenizer_counter()

    queries_out = []
    total_started = time.time()
    for qid, qtext in QUERIES:
        scores: list[float | None] = [None] * len(companies)
        anomalies: list[str] = []
        input_tokens = 0
        started = time.time()
        for at in range(0, len(companies), CHUNK):
            part = companies[at : at + CHUNK]
            try:
                out = ask_chunk(qtext, part)
            except Exception as error:  # judge.ts median fallback
                anomalies.append(f"chunk at {at} failed, median fallback: {error}")
                continue
            input_tokens += out.get("usage", {}).get("input_tokens", 0)
            for i, c in enumerate(part):
                answer = out["answers"].get(f"c{i}")
                if answer is None or "noul" not in answer:
                    anomalies.append(f"chunk at {at}: missing noul for {c['code']}")
                    continue
                scores[at + i] = float(answer["noul"])
        got = [s for s in scores if s is not None]
        if not got:
            anomalies.append("ALL chunks failed — no scores for this query")
            queries_out.append({"query_id": qid, "query_text": qtext, "failed": True, "anomalies": anomalies, "top20": []})
            print(f"{qid}: FAILED", flush=True)
            continue
        middle = statistics.median(got)
        for i, s in enumerate(scores):
            if s is None:
                scores[i] = middle
                anomalies.append(f"median fallback applied to {companies[i]['code']} {companies[i]['name']}")
        order = sorted(range(len(companies)), key=lambda i: (-(scores[i]), i))
        top20 = []
        for rank, i in enumerate(order[:20], 1):
            c = companies[i]
            tokens, serialized = count_tokens(qtext, c)
            top20.append(
                {
                    "rank": rank,
                    "company_code": c["code"],
                    "company_name": c["name"],
                    "laya_score": scores[i],
                    "noul_probability": scores[i],
                    "token_count": tokens,
                    "model_input_instructions_serialized": serialized,
                    "model_input_company_profile_judgeText": c["judgeText"],
                }
            )
        elapsed = time.time() - started
        queries_out.append(
            {
                "query_id": qid,
                "query_text": qtext,
                "failed": False,
                "elapsed_s": round(elapsed, 1),
                "input_tokens": input_tokens,
                "scored": len(got),
                "median_fallback_used": middle if len(got) < len(companies) else None,
                "top20": top20,
                "anomalies": anomalies,
            }
        )
        print(f"{qid}: top score {scores[order[0]]:.4f} ({companies[order[0]]['name']}) in {elapsed:.0f}s", flush=True)

    meta["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    meta["total_elapsed_s"] = round(time.time() - total_started, 1)
    meta["n_queries"] = len(queries_out)
    meta["n_result_rows"] = sum(len(q["top20"]) for q in queries_out)
    meta["any_query_failed"] = any(q["failed"] for q in queries_out)
    meta["all_anomalies"] = {q["query_id"]: q["anomalies"] for q in queries_out if q["anomalies"]}

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    json_path = OUT_DIR / "laya_real_search_acceptance_raw.json"
    json_path.write_text(json.dumps({"meta": meta, "queries": queries_out}, ensure_ascii=False, indent=1), encoding="utf-8")

    lines = [
        "# Laya 真实搜索验收 · 原始结果（未评审）",
        "",
        f"- checkpoint: `{CHECKPOINT}`（`npm run laya:ft`，sidecar model: {meta['sidecar_health'].get('model')} on {meta['sidecar_health'].get('device')}）",
        f"- git HEAD: `{meta['git_head']}`{'（工作区有未提交改动，详见 json meta.git_dirty_paths）' if meta['git_worktree_dirty'] else ''}",
        f"- 公司池: data/companies.json {meta['n_companies']} 家（sha {meta['companies_sha256_16']}），每题全池打分，无预筛",
        f"- 排序: noul 原始分降序（并列按池内顺序），Top 20 为纯排序截断，无 threshold / rerank",
        f"- model.safetensors sha256: `{meta['model_safetensors_sha256']}`",
        f"- 用时 {meta['total_elapsed_s']}s；异常: {json.dumps(meta['all_anomalies'], ensure_ascii=False) if meta['all_anomalies'] else '无'}",
        "",
        "本文件只保存原始输出，不含任何正确/错误评价；相关性判定由外部独立裁判完成。",
    ]
    for q in queries_out:
        lines += ["", f"# {q['query_id']}", "", f"> {q['query_text']}", ""]
        if q["failed"]:
            lines += ["（本条全部 chunk 失败，无结果——见 json anomalies）"]
            continue
        lines += ["| Rank | Code | Company | Score |", "| ---- | ---- | ------- | ----- |"]
        for row in q["top20"]:
            lines.append(f"| {row['rank']} | {row['company_code']} | {row['company_name']} | {row['laya_score']:.4f} |")
    md_path = OUT_DIR / "LAYA_REAL_SEARCH_ACCEPTANCE_RAW.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"written: {json_path}", flush=True)
    print(f"written: {md_path}", flush=True)


if __name__ == "__main__":
    main()
