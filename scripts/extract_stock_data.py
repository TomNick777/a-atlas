"""Build-time extraction of a-stock-data code from the vendored SKILL.md.

Refocus §二十一/§二十二: never parse the 432 KB Markdown at request time, never
hand-copy functions (that loses provenance). This script mechanically extracts
the upstream blocks we need from `vendor/a-stock-data/SKILL.md` into
`services/stock-data/generated/stock_data.py`, using the same block-locating
rules as the upstream test suite (unique `def <name>(` per block + AST pruning
of module-level example calls, cf. vendor/a-stock-data/tests/test_v39_sources.py).

Regeneration flow when upstream updates:
  1. refresh the snapshot under vendor/a-stock-data/ (read-only upstream clone)
  2. bump UPSTREAM_COMMIT / UPSTREAM_VERSION below
  3. python scripts/extract_stock_data.py   (deterministic; tests re-run it and diff)

Stdlib only. Python 3.9+.
"""

from __future__ import annotations

import ast
import copy
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / "vendor" / "a-stock-data" / "SKILL.md"
OUT_DIR = REPO / "services" / "stock-data" / "generated"
OUT = OUT_DIR / "stock_data.py"
MANIFEST = OUT_DIR / "manifest.json"

UPSTREAM_URL = "https://github.com/simonlin1212/a-stock-data"
UPSTREAM_COMMIT = "f814dcfe209dd7958f4858f9d878d591ee85fb56"
UPSTREAM_VERSION = "3.10.0"

# Roots we need for the four first-stage capabilities (refocus §十八) and for
# Market Intelligence build-time ingestion (data/market), in dependency order:
# symbol helpers → throttled eastmoney transport → quote → reports →
# fundamentals → announcements → V3.9.0 shared helpers → tdx full-market daily
# package. Each name must be defined by exactly one ```python block in SKILL.md
# (same rule as the upstream tests). Pulling in _v39_http carries the shared
# helper block (_v39_json/_v39_date/_v39_frame/...), whose imports add pandas —
# a dependency requirements.txt already declares.
ROOTS = [
    "get_prefix",
    "norm_ticker",
    "em_get",
    "tencent_quote",
    "eastmoney_reports",
    "sina_financial_report",
    "cninfo_announcements",
    "_v39_http",
    "tdx_daily_package",
]


def python_blocks(skill_text: str) -> list[str]:
    return re.findall(r"```python\n(.*?)```", skill_text, re.S)


def block_defining(blocks: list[str], name: str) -> str:
    pat = re.compile(rf"^def {re.escape(name)}\(", re.M)
    hits = [b for b in blocks if pat.search(b)]
    if len(hits) != 1:
        raise RuntimeError(f"{name}: defined in {len(hits)} blocks (expected exactly 1)")
    return hits[0]


def defs_only(src: str) -> ast.Module:
    """Keep imports / constants / defs of a tutorial block; drop the example
    calls at module level. Same semantics as upstream `_defs_only`."""
    tree = ast.parse(src)
    names = {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef))}
    keep = []
    for node in tree.body:
        if isinstance(node, (ast.Expr, ast.For, ast.While, ast.With, ast.If)):
            continue
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            calls = {
                c.func.id
                for c in ast.walk(node)
                if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
            }
            if calls & names:
                continue
        keep.append(node)
    tree.body = keep
    return tree


def extract() -> tuple[str, dict]:
    skill_text = SKILL.read_text(encoding="utf-8")
    blocks = python_blocks(skill_text)
    if len(blocks) < 50:
        raise RuntimeError(f"implausibly few python blocks in SKILL.md: {len(blocks)}")

    seen_imports: dict[str, ast.stmt] = {}
    seen_names: dict[str, ast.expr] = {}
    body_nodes: list[str] = []
    block_index = []

    for root in ROOTS:
        block = block_defining(blocks, root)
        tree = defs_only(block)
        defined = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef, ast.AsyncFunctionDef))]
        block_index.append({"root": root, "defined": defined})
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                key = ast.unparse(node)
                seen_imports.setdefault(key, node)
                continue
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names = [t.id for t in targets if isinstance(t, ast.Name)]
                if names:
                    value_src = ast.dump(node.value)
                    for name in names:
                        if name in seen_names:
                            if ast.dump(seen_names[name]) != value_src:
                                raise RuntimeError(f"constant {name} redefined with a different value across blocks")
                            continue
                        seen_names[name] = node.value
            body_nodes.append(ast.unparse(node))

    # Atlas projection v1: preserve raw source identity/time/units/hash without
    # changing the extracted upstream function. The guard fails on wire drift.
    upstream_quote = next(n for n in ast.parse("\n\n".join(body_nodes)).body if isinstance(n, ast.FunctionDef) and n.name == "tencent_quote")
    projected = copy.deepcopy(upstream_quote)
    projected.name = "tencent_quote_snapshot"
    additions = ast.parse("""
q['source_symbol'] = key
q['source_code'] = vals[2]
q['source_time'] = vals[30] or None
q['volume_source'] = float(vals[6]) if vals[6] else None
q['amount_precise_wan'] = float(vals[57]) if len(vals) > 57 and vals[57] else None
q['source_ratio_raw'] = vals[49] or None
q['raw_sha256'] = __import__('hashlib').sha256(data.encode('gbk')).hexdigest()
""").body
    inserted = 0
    for node in ast.walk(projected):
        if isinstance(node, ast.For):
            for idx, statement in enumerate(node.body):
                if ast.unparse(statement) == 'q = result[code]':
                    node.body[idx + 1:idx + 1] = additions
                    inserted += 1
                    break
    if inserted != 1:
        raise RuntimeError("Tencent projection anchor drift; review wire before regenerating")
    body_nodes.append(ast.unparse(ast.fix_missing_locations(projected)))

    header = (
        '"""AUTO-GENERATED from vendor/a-stock-data/SKILL.md — DO NOT EDIT BY HAND.\n'
        "\n"
        "Extracted mechanically by scripts/extract_stock_data.py (build-time, deterministic).\n"
        f"upstream   : {UPSTREAM_URL}\n"
        f"commit     : {UPSTREAM_COMMIT}\n"
        f"version    : {UPSTREAM_VERSION}\n"
        "license    : Apache-2.0 (see vendor/a-stock-data/LICENSE; upstream copyright\n"
        "             2026 Simon Lin retained — this file is a verbatim extraction of\n"
        "             the listed SKILL.md blocks with example calls pruned;\n"
        "             tencent_quote_snapshot is Atlas raw-field projection v1)\n"
        "\n"
        "Regenerate: python scripts/extract_stock_data.py\n"
        '"""\n'
    )
    imports = "\n".join("# " + ast.unparse(n) and ast.unparse(n) for n in seen_imports.values())
    body = "\n\n\n".join(body_nodes) + "\n"
    generated = header + "\n" + imports + "\n\n\n" + body

    # The generated module must itself be valid, py39-compatible syntax.
    ast.parse(generated)

    manifest = {
        "upstream": UPSTREAM_URL,
        "commit": UPSTREAM_COMMIT,
        "version": UPSTREAM_VERSION,
        "syncedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "skillSha256": hashlib.sha256(skill_text.encode("utf-8")).hexdigest(),
        "blocks": block_index,
        "roots": ROOTS,
        "localProjections": {"tencent_quote_snapshot": "atlas-tencent-raw-1"},
    }
    return generated, manifest


def main() -> int:
    generated, manifest = extract()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(generated, encoding="utf-8", newline="\n")
    manifest["generatedSha256"] = hashlib.sha256(generated.encode("utf-8")).hexdigest()
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(REPO)} ({len(generated)} bytes)")
    print(f"wrote {MANIFEST.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
