"""Read-only, offline evidence-chain audit. Inputs and outputs stay private.

Run with the local evidence-parser Python environment. This tool does not infer
company eligibility, rebuild facts, call a judge or change historical answers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def rows(path: Path):
    with path.open(encoding="utf-8-sig") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def private_path(value: str) -> Path:
    path = Path(value).resolve()
    if not any(path.is_relative_to(ROOT / base) for base in ("reports", ".local")):
        raise ValueError("Audit inputs and outputs must stay under reports/ or .local/")
    return path


def contexts(text: str, term: str) -> list[dict]:
    return [{"term": term, "offset": match.start(),
             "text": text[max(0, match.start() - 90):match.end() + 170]}
            for match in list(re.finditer(re.escape(term), text, re.I))[:4]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source, output = private_path(args.input), private_path(args.output)
    if output.exists():
        raise ValueError("Audit observations cannot be overwritten")
    spec = read_json(source)
    traces = spec["traceIds"]
    codes = spec["companyCodes"]
    terms = spec["terms"]
    if (not traces or not codes or not terms or
            any(not re.fullmatch(r"s_[A-Za-z0-9_]+", t) for t in traces) or
            any(not re.fullmatch(r"\d{6}", c) for c in codes) or
            any(not isinstance(t, str) or not t.strip() for t in terms)):
        raise ValueError("Nonempty traceIds, canonical companyCodes and literal terms required")
    corpus_path = ROOT / "data/company-corpus/companies.jsonl"
    facts_path = ROOT / "data/source_facts/facts.jsonl"
    docs = {doc["symbol"]: doc for doc in rows(corpus_path)}
    source_facts = {code: [] for code in codes}
    term_counts = {term: {"sourceFacts": 0, "corpusDocuments": 0,
                          "searchableDocuments": 0} for term in terms}
    for fact in rows(facts_path):
        text = fact["rawText"]
        for term in terms:
            if term.lower() in text.lower():
                term_counts[term]["sourceFacts"] += 1
        if fact["companyCode"] in source_facts:
            source_facts[fact["companyCode"]].append(fact)
    for doc in docs.values():
        for term in terms:
            if term.lower() in json.dumps(doc, ensure_ascii=False).lower():
                term_counts[term]["corpusDocuments"] += 1
            if term.lower() in doc["searchableText"].lower():
                term_counts[term]["searchableDocuments"] += 1
    events = []
    event_files = sorted((ROOT / "data/telemetry/events").glob("*.jsonl"))
    for path in event_files:
        events.extend(e for e in rows(path) if e.get("searchId") in traces)
    search_runs = {r["searchId"]: r for r in rows(ROOT / "data/search_log/search_log.jsonl")
                   if r["searchId"] in traces}
    cases = []
    for trace_id in traces:
        run = search_runs.get(trace_id)
        path = ROOT / "data/discovery-answers" / f"{trace_id}.json"
        record = None
        if path.exists():
            envelope = read_json(path)
            if (envelope.get("schemaVersion") != 1 or envelope.get("id") != trace_id or
                    hashlib.sha256(envelope["payload"].encode()).hexdigest() != envelope["sha256"]):
                raise ValueError(f"Saved answer failed integrity check: {trace_id}")
            record = json.loads(envelope["payload"])
        answer = record["answer"] if record else None
        query = run["query"]["raw"] if run else answer["query"] if answer else None
        if answer and answer["query"] != query:
            raise ValueError(f"Trace/query mismatch: {trace_id}")
        candidates = {r["code"]: r for r in run["candidates"]} if run else {}
        cases.append({
            "traceId": trace_id, "query": query,
            "historicalVersions": run["versions"] if run else None,
            "historicalRetrieval": run["retrieval"] if run else None,
            "targetCandidates": {code: candidates.get(code) for code in codes},
            "savedAnswerSha256": digest(path) if path.exists() else None,
            "historicalResults": answer["results"] if answer else None,
            "historicalEvidence": record.get("evidence") if record else None,
            "feedback": [e for e in events if e.get("searchId") == trace_id and e.get("eventType") == "SEARCH_FEEDBACK"],
            "discoverEvents": [e for e in events if e.get("searchId") == trace_id and e.get("eventType") in ("DISCOVER_RECEIVED", "DISCOVER_RESPONSE_READY")],
            "wireInputCaptured": False,
            "limitations": ["Saved views do not prove the exact transported profile or full raw decisions.",
                            "A target absent from historical candidates was not judged on that search.",
                            "Current source inspection is not a historical provider rerun."],
        })
    import pymupdf
    from bs4 import BeautifulSoup
    import importlib.util
    module_spec = importlib.util.spec_from_file_location("surface", ROOT / "scripts/evidence_surface_extract.py")
    surface = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(surface)
    inspected = []
    for code in codes:
        base = ROOT / "data/raw/source_facts" / code
        manifest = read_json(base / "manifest.json")
        artifacts = []
        for artifact in manifest["artifacts"]:
            path = (base / artifact["file"]).resolve()
            if not path.is_relative_to(base.resolve()):
                raise ValueError("Artifact escapes its company snapshot directory")
            if path.suffix not in (".pdf", ".html") or not path.exists():
                continue
            actual_sha = digest(path)
            if actual_sha != artifact.get("sha256"):
                raise ValueError(f"Snapshot hash mismatch: {path}")
            matches = []
            page_candidates = None
            if path.suffix == ".pdf":
                with pymupdf.open(path) as document:
                    for number, page in enumerate(document, 1):
                        text = re.sub(r"\s+", "", page.get_text())
                        for term in terms:
                            matches.extend({"page": number, **c} for c in contexts(text, term))
            else:
                html = surface.decode_html_bytes(path.read_bytes())
                soup = BeautifulSoup(html, "lxml")
                for tag in soup(["script", "style", "noscript", "header", "footer", "nav"]):
                    tag.decompose()
                text = soup.get_text("\n", strip=True)
                for term in terms:
                    matches.extend(contexts(text, term))
                page_candidates = len(surface.page_sentences(html))
            artifacts.append({"artifact": artifact, "verifiedSha256": actual_sha,
                              "matches": matches, "currentProductSentenceCount": page_candidates})
        inspected.append({"companyCode": code, "document": docs.get(code),
                          "sourceFacts": source_facts[code], "artifacts": artifacts,
                          "currentOfficialProductRows": surface.product_rows(code, docs[code]["name"])})
    report = {"schemaVersion": 1, "mode": "offline-source-chain-audit", "cloudCalls": 0,
              "gitHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "inputSha256": digest(source), "termCounts": term_counts,
              "inputDigests": {str(p.relative_to(ROOT)): digest(p) for p in
                               (corpus_path, facts_path, ROOT / "data/companies.json")},
              "cases": cases, "companies": inspected,
              "qualityVerdict": "diagnostic-only; no model or full-pool quality acceptance"}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"output": str(output), "traces": len(cases), "companies": len(inspected),
                      "termCounts": term_counts, "cloudCalls": 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
