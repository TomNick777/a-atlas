"""Offline candidate experiment over existing annual-report snapshots.

The authority is companies.json, not an expected-company list. Output is a new
private observation, never facts.jsonl, corpus, vectors or production settings.
Model-like strings only locate verbatim prose; no ownership/relation is inferred.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

MODEL = re.compile(r"(?<![A-Za-z0-9])(?=[A-Za-z0-9-]{3,32}(?![A-Za-z0-9-]))(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9-])")
SELF = re.compile(r"本公司|公司|本集团|本企业|我们")
ACTION = re.compile(r"推出|布局|研发|生产|开发|提供|销售")
PRODUCT = re.compile(r"产品|系列|型号")
REJECT = re.compile(r"[□☑√✓]|董事|监事|学历|学位|入职|占年度销售总额比例|占年度采购总额比例|诉讼|仲裁|法院|管辖|违约")
ROOT = Path(__file__).resolve().parents[2]
VERSION = "annual-model-prose-preview-1"


def extract_candidates(pages: list[str]) -> list[dict]:
    """Conservative windows, in source order, with zero semantic expansion."""
    candidates = []
    seen = set()
    for number, text in enumerate(pages, 1):
        flat = re.sub(r"\s+", "", text)
        for match in re.finditer(r"[^。！？；]+[。！？；]?", flat):
            sentence = match.group().strip()
            if not 30 <= len(sentence) <= 220 or REJECT.search(sentence):
                continue
            if not (SELF.search(sentence) and ACTION.search(sentence) and PRODUCT.search(sentence)):
                continue
            models = list(dict.fromkeys(m.group() for m in MODEL.finditer(sentence)))
            if not models or sentence in seen:
                continue
            seen.add(sentence)
            candidates.append({"page": number, "offset": match.start(), "text": sentence, "literalLocators": models,
                               "terms": [], "ownershipInferred": False})
    return candidates


def private_path(value: str) -> Path:
    target = Path(value).resolve()
    if not any(target.is_relative_to(ROOT / base) for base in ("reports", ".local")):
        raise ValueError("Preview files must stay under reports/ or .local/")
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registration", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    registration = private_path(args.registration)
    spec = json.loads(registration.read_text(encoding="utf-8"))
    if spec.get("version") != VERSION or spec.get("cohortSize") != 40 or not isinstance(spec.get("seed"), str):
        raise ValueError("A preregistered version, seed and 40-company cohort are required")
    output = private_path(args.output)
    if output.exists():
        raise ValueError("Preview observations cannot be overwritten")
    companies_file = ROOT / "data/companies.json"
    companies = json.loads(companies_file.read_text(encoding="utf-8"))["companies"]
    available = []
    for company in companies:
        base = ROOT / "data/raw/source_facts" / company["code"]
        pdfs = sorted(base.glob("annual-report-*.pdf"))
        if not pdfs or not (base / "manifest.json").exists():
            continue
        manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
        artifact = next((a for a in manifest["artifacts"] if a["file"] == pdfs[-1].name), None)
        if artifact and artifact.get("filingDate") and artifact.get("sha256") and artifact.get("url"):
            available.append((company, pdfs[-1], artifact))
    # Exchange-stratified deterministic sample; no query, model token or benchmark input.
    ranked = sorted(available, key=lambda row: hashlib.sha256((spec["seed"] + row[0]["code"]).encode()).hexdigest())
    groups = {exchange: [row for row in ranked if row[0]["exchange"] == exchange] for exchange in ("SH", "SZ", "BJ")}
    cohort = []
    while len(cohort) < spec["cohortSize"] and any(groups.values()):
        for group in groups.values():
            if group and len(cohort) < spec["cohortSize"]:
                cohort.append(group.pop(0))
    import pymupdf
    observations = []
    for company, pdf, artifact in cohort:
        actual = hashlib.sha256(pdf.read_bytes()).hexdigest()
        if actual != artifact["sha256"]:
            raise ValueError(f"Snapshot SHA mismatch: {company['code']}")
        try:
            with pymupdf.open(pdf) as doc:
                candidates = extract_candidates([page.get_text() for page in doc])
            observation = {"companyCode": company["code"], "exchange": company["exchange"], "status": "observed",
                           "artifact": artifact, "verifiedSha256": actual, "candidates": candidates}
        except Exception as error:
            observation = {"companyCode": company["code"], "exchange": company["exchange"], "status": "error", "error": str(error)}
        observations.append(observation)
        print(f"{company['code']}: {observation['status']}", flush=True)
    summary = {"companyCount": len(observations), "companiesWithCandidates": sum(bool(o.get("candidates")) for o in observations),
               "candidateCount": sum(len(o.get("candidates", [])) for o in observations),
               "errors": sum(o["status"] == "error" for o in observations)}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        json.dump({"version": VERSION, "mode": "candidate-only", "cloudCalls": 0, "productionChanged": False,
                   "registrationSha256": hashlib.sha256(registration.read_bytes()).hexdigest(),
                   "authoritySha256": hashlib.sha256(companies_file.read_bytes()).hexdigest(),
                   "eligibleCompanyCount": len(available), "summary": summary, "observations": observations,
                   "qualityAccepted": False}, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
