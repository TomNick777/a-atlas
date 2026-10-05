"""Fetch the Shenwan level-1 industry classification into data/raw/sw. Safe to re-run: cached per index.

Source: 申万宏源研究 申万指数（2021 版行业分类，31 个一级行业），经 akshare
`sw_index_first_info`（行业清单）与 `index_component_sw`（指数成份）读取。
这是申万官方口径，不是东财/同花顺/证监会行业，两者不得混用。
"""

from __future__ import annotations

import json
import os
import socket
import time
from datetime import date
from pathlib import Path

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"
socket.setdefaulttimeout(25)

import akshare as ak
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "sw"
PAUSE = 0.5


def records(df: pd.DataFrame | None) -> list[dict]:
    if df is None or df.empty:
        return []
    return json.loads(df.to_json(orient="records", force_ascii=False))


def call(name: str, fn, attempts: int = 3):
    last = None
    for attempt in range(attempts):
        try:
            return fn()
        except Exception as error:  # noqa: BLE001 - upstream feeds fail in different ways
            last = error
            print(f"  retry {name} ({attempt + 1}): {error}")
            time.sleep(1.5 * (attempt + 1))
    print(f"  give up {name}: {last}")
    return None


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    industries_path = RAW / "first_info.json"
    if not industries_path.exists():
        industries = records(call("sw_index_first_info", ak.sw_index_first_info))
        if not industries:
            raise SystemExit("sw_index_first_info came back empty; check the network and rerun")
        industries_path.write_text(json.dumps(industries, ensure_ascii=False), encoding="utf-8")
        time.sleep(PAUSE)
    industries = json.loads(industries_path.read_text(encoding="utf-8"))
    print(f"level-1 industries: {len(industries)}")

    members_dir = RAW / "components"
    members_dir.mkdir(parents=True, exist_ok=True)
    mapping: dict[str, dict] = {}
    meta = []
    for row in industries:
        index_code = str(row.get("行业代码") or "").replace(".SI", "")
        name = str(row.get("行业名称") or "").strip()
        if not index_code or not name:
            continue
        path = members_dir / f"{index_code}.json"
        if not path.exists():
            members = records(call(f"components {index_code}", lambda code=index_code: ak.index_component_sw(symbol=code)))
            if not members:
                raise SystemExit(f"no constituents for {index_code} {name}; rerun to retry")
            path.write_text(json.dumps(members, ensure_ascii=False), encoding="utf-8")
            time.sleep(PAUSE)
        members = json.loads(path.read_text(encoding="utf-8"))
        seen: set[str] = set()
        for member in members:
            code = str(member.get("证券代码") or "").split(".")[0].zfill(6)
            if not code.isdigit() or code in seen:
                continue
            seen.add(code)
            mapping[code] = {"industry": name, "industryCode": index_code}
        meta.append({"code": index_code, "name": name, "count": len(seen)})
        print(f"{index_code} {name}: {len(seen)}")

    total = sum(item["count"] for item in meta)
    payload = {
        "source": "申万宏源研究 申万指数（akshare sw_index_first_info / index_component_sw）",
        "classification": "申万行业分类 2021 版",
        "fetchedAt": date.today().isoformat(),
        "level1": meta,
        "map": mapping,
    }
    (RAW / "level1_map.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"mapped {len(mapping)} securities across {len(meta)} industries ({total} seats)")


if __name__ == "__main__":
    main()
