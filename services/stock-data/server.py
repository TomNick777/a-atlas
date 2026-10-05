"""A-Atlas data service (a-atlas-data) — thin HTTP wrapper over the extracted
a-stock-data functions (services/stock-data/generated/stock_data.py).

Refocus §二十八/§二十九/§三十: the Python data logic must not be rewritten in
TypeScript, and Next.js must not parse 432 KB of Markdown per request — so this
~small stdlib-only server owns the vendor calls, per-block caching and the
EMPTY / UNAVAILABLE / ERROR classification, while the web app only ever sees the
JSON contracts from lib/stockdata/contracts.ts.

Canonical identity: the web always sends the 6-digit code (StockIdentity).
Prefix mapping (sh/sz/bj) happens here, via the generated get_prefix.

Stdlib + requests only. Run: python services/stock-data/server.py  (:8920)
"""

from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SERVICE = "a-atlas-data"
VERSION = "1.0.0"
DEFAULT_PORT = 8920

sys.path.insert(0, str(Path(__file__).resolve().parent / "generated"))
import stock_data as sd  # noqa: E402

# ---------------------------------------------------------------------------
# Per-(kind, symbol) TTL cache — company pages re-render often; upstreams
# throttle. Quote is short-lived, statements/announcements/reports are not.
# ---------------------------------------------------------------------------

TTL_SECONDS = {"quote": 30, "fundamentals": 6 * 3600, "announcements": 30 * 60, "reports": 60 * 60}

_cache: dict[tuple[str, str], tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def cached(kind: str, symbol: str, produce):
    key = (kind, symbol)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    payload = produce()
    with _cache_lock:
        _cache[key] = (time.time() + TTL_SECONDS[kind], payload)
    return payload


# ---------------------------------------------------------------------------
# Contract helpers: every response carries provenance + availability.
# 没有数据 ≠ 数据源坏了 — ValueError (source declares no coverage) → unavailable;
# genuinely-no-rows → empty; transport/structure failures → error.
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _base(symbol: str, source: str) -> dict:
    return {"symbol": symbol, "source": source, "fetchedAt": _now_iso(), "asOf": None}


def _error(base: dict, exc: Exception) -> dict:
    row = dict(base, available="error", error=f"{type(exc).__name__}: {exc}")
    return row


def _unavailable(base: dict, exc: Exception) -> dict:
    return dict(base, available="unavailable", error=str(exc))


def quote_block(symbol: str) -> dict:
    base = _base(symbol, "腾讯")

    def produce():
        try:
            rows = sd.tencent_quote_snapshot([f"{sd.get_prefix(symbol)}{symbol}"])
        except ValueError as exc:
            return _unavailable(base, exc)
        except Exception as exc:  # transport / structure
            return _error(base, exc)
        row = rows.get(f"{sd.get_prefix(symbol)}{symbol}") or rows.get(symbol)
        if not row:
            return dict(base, available="empty", error="腾讯返回中无该代码行情行")
        as_of = None
        if row.get("source_time"):
            try:
                as_of = datetime.strptime(row["source_time"], "%Y%m%d%H%M%S").replace(tzinfo=timezone(timedelta(hours=8))).isoformat()
            except (ValueError, TypeError) as exc:
                return _error(base, exc)
        return dict(
            base,
            available="ok",
            asOf=as_of,
            name=row.get("name") or None,
            price=row.get("price"),
            lastClose=row.get("last_close"),
            changePct=row.get("change_pct"),
            peTtm=row.get("pe_ttm") or None,
            pb=row.get("pb") or None,
            marketCapYi=row.get("mcap_yi") or None,
            turnoverPct=row.get("turnover_pct") or None,
            stale=bool(row.get("is_stale")),
            staleReason=row.get("stale_reason"),
        )

    return cached("quote", symbol, produce)


def _num(value) -> float | None:
    """Sina reports raw strings ('1,743.6' / '514.42'); parse or give up honestly."""
    if value in (None, ""):
        return None
    try:
        return float(str(value).replace(",", ""))
    except ValueError:
        return None


def _pick(row: dict, candidates: list[str]):
    for key in candidates:
        if key in row and row[key] not in (None, ""):
            return row[key]
    return None


def _derive_fundamentals(lrb: list, fzb: list, base: dict) -> dict:
    if not lrb:
        return dict(base, available="empty")
    latest = lrb[0]
    period = latest.get("报告期")
    equity_row = next((r for r in fzb if r.get("报告期") == period), fzb[0] if fzb else {})

    revenue = _num(_pick(latest, ["营业总收入", "营业收入"]))
    # 毛利率口径用「营业成本」（营业总成本含税金/三费，会显著低估毛利）。
    cost = _num(_pick(latest, ["营业成本", "营业总成本"]))
    profit = _num(_pick(latest, ["归属于母公司所有者的净利润", "归属于母公司股东的净利润", "净利润"]))
    equity = _num(_pick(equity_row, ["归属于母公司股东权益合计", "归属于母公司所有者权益合计", "股东权益合计", "所有者权益合计"]))

    gross = round((revenue - cost) / revenue * 100, 2) if revenue and cost and revenue != 0 else None
    roe = round(profit / equity * 100, 2) if profit is not None and equity else None

    return dict(
        base,
        available="ok",
        asOf=period,
        reportPeriod=period,
        revenue=_pick(latest, ["营业总收入", "营业收入"]),
        revenueYoY=_pick(latest, ["营业总收入_同比", "营业收入_同比"]),
        netProfit=_pick(latest, ["归属于母公司所有者的净利润", "归属于母公司股东的净利润", "净利润"]),
        netProfitYoY=_pick(latest, ["归属于母公司所有者的净利润_同比", "归属于母公司股东的净利润_同比", "净利润_同比"]),
        eps=_pick(latest, ["基本每股收益"]),
        grossMarginPct=gross,
        roePct=roe,
    )


def fundamentals_block(symbol: str) -> dict:
    base = _base(symbol, "新浪财经")

    def produce():
        try:
            lrb = sd.sina_financial_report(symbol, "lrb")
            fzb = sd.sina_financial_report(symbol, "fzb")
        except ValueError as exc:
            return _unavailable(base, exc)
        except Exception as exc:
            return _error(base, exc)
        return _derive_fundamentals(lrb, fzb, base)

    return cached("fundamentals", symbol, produce)


def announcements_block(symbol: str) -> dict:
    base = _base(symbol, "巨潮资讯")

    def produce():
        try:
            rows = sd.cninfo_announcements(symbol, page_size=8)
        except ValueError as exc:
            return dict(_unavailable(base, exc), items=[])
        except Exception as exc:
            return dict(_error(base, exc), items=[])
        return dict(
            base,
            available="ok",
            items=[{"title": r.get("title") or "", "date": r.get("date") or "", "type": r.get("type") or "", "url": r.get("url") or ""} for r in rows],
        )

    return cached("announcements", symbol, produce)


def reports_block(symbol: str) -> dict:
    base = _base(symbol, "东方财富")

    def produce():
        try:
            rows = sd.eastmoney_reports(symbol, max_pages=1)
        except ValueError as exc:
            return dict(_unavailable(base, exc), items=[])
        except Exception as exc:
            return dict(_error(base, exc), items=[])
        items = [
            {
                "title": r.get("title", ""),
                "institution": r.get("orgSName", ""),
                "analyst": r.get("researcher") or None,
                "date": (r.get("publishDate") or "")[:10],
                "rating": r.get("emRatingName") or None,
                "url": f"https://pdf.dfcfw.com/pdf/H3_{r.get('infoCode', '')}_1.pdf" if r.get("infoCode") else "",
            }
            for r in rows[:8]
        ]
        return dict(base, available="ok", items=items)

    return cached("reports", symbol, produce)


BLOCKS = {
    "quote": quote_block,
    "fundamentals": fundamentals_block,
    "announcements": announcements_block,
    "reports": reports_block,
}


class Handler(BaseHTTPRequestHandler):
    server_version = f"{SERVICE}/{VERSION}"

    def log_message(self, fmt, *args):  # ASCII-safe access log
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (stdlib naming)
        parsed = urlparse(self.path)
        if parsed.path in ("/health", "/healthz"):
            self._send(200, {"ok": True, "service": SERVICE, "version": VERSION})
            return
        if parsed.path == "/market-snapshot":
            try:
                from market_runtime import market_snapshot
                self._send(200, market_snapshot(wait=True))
            except Exception as exc:
                self._send(503, {"error": f"{type(exc).__name__}: {exc}"})
            return
        kind = parsed.path.lstrip("/")
        block = BLOCKS.get(kind)
        if block is None:
            self._send(404, {"error": f"unknown resource {parsed.path!r}", "service": SERVICE})
            return
        symbol = (parse_qs(parsed.query).get("symbol") or [""])[0].strip()
        if not symbol.isdigit() or len(symbol) != 6:
            self._send(400, {"error": "symbol must be the canonical 6-digit code", "service": SERVICE})
            return
        self._send(200, block(symbol))


def main() -> None:
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else int(
        __import__("os").environ.get("ATLAS_DATA_PORT", "") or DEFAULT_PORT
    )
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"{SERVICE} {VERSION} listening on 127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
