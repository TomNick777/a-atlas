"""AUTO-GENERATED from vendor/a-stock-data/SKILL.md — DO NOT EDIT BY HAND.

Extracted mechanically by scripts/extract_stock_data.py (build-time, deterministic).
upstream   : https://github.com/simonlin1212/a-stock-data
commit     : f814dcfe209dd7958f4858f9d878d591ee85fb56
version    : 3.10.0
license    : Apache-2.0 (see vendor/a-stock-data/LICENSE; upstream copyright
             2026 Simon Lin retained — this file is a verbatim extraction of
             the listed SKILL.md blocks with example calls pruned;
             tencent_quote_snapshot is Atlas raw-field projection v1)

Regenerate: python scripts/extract_stock_data.py
"""

import re
import time
import random
import requests
from typing import Optional
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from datetime import datetime
import functools
import math
from datetime import date as _date_cls, datetime, timezone
import pandas as pd
import io
import struct
import zipfile
import zlib


SH_INDEX = {'000300', '000905', '000016', '000688', '000852', '000010'}


def get_prefix(code: str) -> str:
    """6位代码 → 市场前缀（sh/sz/bj）。支持显式前缀/后缀（sh000016 / 000016.SH）透传以解决歧义。"""
    c = code.lower().strip()
    if c.endswith(('.sh', '.sz', '.bj')):
        return c[-2:]
    if c.endswith(('.xshg', '.xshe')):
        return 'sh' if c.endswith('.xshg') else 'sz'
    if c.startswith(('sh', 'sz', 'bj')):
        return c[:2]
    if c.startswith('92'):
        return 'bj'
    if c.startswith(('5', '6', '9')):
        return 'sh'
    if c.startswith(('4', '8')):
        return 'bj'
    if c in SH_INDEX:
        return 'sh'
    return 'sz'


_TICKER_RE = re.compile('^(?:(sh|sz|bj)(\\d{6})|(\\d{6})(?:\\.(sh|sz|bj|xshg|xshe))?)$', re.IGNORECASE)


_JQ_SUFFIX = {'xshg': 'sh', 'xshe': 'sz'}


def _natural_market(digits: str) -> str:
    """6 位码的自然归属市场。仅用于校验显式前缀是否自相矛盾。
    注意 000xxx 是沪指数/深个股共用的歧义段，由调用处单独处理，不走这里。"""
    if digits.startswith(('4', '8', '92')):
        return 'bj'
    if digits[0] in ('5', '6', '9'):
        return 'sh'
    return 'sz'


def norm_ticker(code: str, stock_only: bool=False) -> str:
    """任意受支持写法 → 纯 6 位数字代码。

    支持 600519 / SH600519 / sh600519 / 600519.SH / BJ920982 等。
    stock_only=True：个股专用接口（研报、一致预期等）传这个，会拒绝显式指数写法。
    ⚠️ 不匹配时**抛 ValueError，绝不静默返回空串或猜一个代码**——
    否则调用方会把「代码格式写错」误读成「这只票没有数据」，
    或者更糟：拿到另一只股票的数据还以为是对的。
    """
    raw = str(code).strip()
    m = _TICKER_RE.match(raw)
    if not m:
        raise ValueError(f'无法把 {code!r} 解析为 6 位股票代码；支持格式：600519 / SH600519 / sh600519 / 600519.SH / 600519.XSHG（聚宽）（前缀与后缀二选一，不能同时写）')
    digits = m.group(2) or m.group(3)
    market = (m.group(1) or m.group(4) or '').lower()
    market = _JQ_SUFFIX.get(market, market)
    if market:
        if digits.startswith('000'):
            if market == 'bj':
                raise ValueError(f'{code!r} 市场标识与号段矛盾：000xxx 不属北交所。')
            if stock_only and market == 'sh':
                raise ValueError(f'{code!r} 指向沪市指数而非个股（沪市无 000xxx 个股），本接口只服务个股。要查同号段的深市个股请显式传 sz{digits}。')
        else:
            nat = _natural_market(digits)
            if market != nat:
                raise ValueError(f'{code!r} 的市场标识与号段矛盾：{digits} 属 {nat} 市，而不是 {market} 市。（改用 {nat}{digits} 或去掉市场标识）')
    return digits


def em_market_code(code: str) -> int:
    """东财 secid 的市场号：**沪=1，深/北=0**（V3.7.0 新增 · #46）。

    ⚠️ 绝不要用 `code.startswith("6")` 判市场 —— 那会把**沪市 ETF（51x）**、
    **科创板 ETF（588x）**、**沪 B 股（900x）** 全部错判成深市，接口返回 `data: null`。
    2026-08-19 实测：510300 / 588000 / 600519 / 688112 / 900901 → m=1；
    300750 / 159915 / 920982 / 832982 → m=0（北交所与深市共用 m=0）。
    """
    return 1 if get_prefix(code) == 'sh' else 0


def em_secid(code: str) -> str:
    """东财 push2/push2his 的 secid，如 `1.600519` / `0.300750`。"""
    return f'{em_market_code(code)}.{norm_ticker(code)}'


def to_joinquant(code: str) -> str:
    """任意受支持写法 → 聚宽代码，如 `600519.XSHG` / `000001.XSHE`（#55）。

    000 段歧义码按 get_prefix() 的规则走：`to_joinquant("sh000001")` → `000001.XSHG`（上证指数），
    `to_joinquant("000001")` → `000001.XSHE`（平安银行）。反方向（聚宽 → 本 Skill）用
    `get_prefix(c) + norm_ticker(c)` 得到 `sh000001` 这类显式前缀写法，再传给各端点。
    北交所：聚宽公开文档与 jqdatasdk 源码（2026-09-20 查）只有 .XSHG / .XSHE，没查到北交所后缀，抛 ValueError 不猜。
    """
    digits, market = (norm_ticker(code), get_prefix(code))
    if market == 'bj':
        raise ValueError(f'{code!r} 是北交所证券；聚宽公开文档未给出北交所后缀，不做转换')
    return f"{digits}.{('XSHG' if market == 'sh' else 'XSHE')}"


UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'


DATACENTER_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get'


EM_SESSION = requests.Session()


try:
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    _em_adapter = HTTPAdapter(max_retries=Retry(total=3, connect=3, backoff_factor=0.6, status_forcelist=[429, 500, 502, 503, 504], allowed_methods=['GET']))
    EM_SESSION.mount('https://', _em_adapter)
    EM_SESSION.mount('http://', _em_adapter)
except Exception:
    pass


EM_MIN_INTERVAL = 1.0


_em_last_call = [0.0]


def em_get(url: str, params: Optional[dict]=None, headers: Optional[dict]=None, timeout: int=15, **kwargs):
    """东财统一请求入口：自动节流 + 复用 session + 默认 UA。
    所有 eastmoney.com 接口都应通过它请求，避免高频被封 IP。"""
    wait = EM_MIN_INTERVAL - (time.time() - _em_last_call[0])
    if wait > 0:
        time.sleep(wait + random.uniform(0.1, 0.5))
    try:
        return EM_SESSION.get(url, params=params, headers=headers, timeout=timeout, **kwargs)
    finally:
        _em_last_call[0] = time.time()


def eastmoney_datacenter(report_name: str, columns: str='ALL', filter_str: str='', page_size: int=50, sort_columns: str='', sort_types: str='-1') -> list[dict]:
    """东财数据中心统一查询 — 龙虎榜/解禁/融资融券/大宗交易/股东户数/分红 共用（已内置限流）"""
    params = {'reportName': report_name, 'columns': columns, 'filter': filter_str, 'pageNumber': '1', 'pageSize': str(page_size), 'sortColumns': sort_columns, 'sortTypes': sort_types, 'source': 'WEB', 'client': 'WEB'}
    r = em_get(DATACENTER_URL, params=params, timeout=15)
    d = r.json()
    if d.get('result') and d['result'].get('data'):
        return d['result']['data']
    return []


def tencent_quote(codes: list[str]) -> dict[str, dict]:
    """
    批量拉取腾讯财经实时行情。
    codes: ["688017", "300476", "002463"]
    也支持指数: ["000001", "000300", "399006"]
    也支持ETF: ["510050", "510300"]
    返回: {code: {name, price, pe_ttm, pb, mcap, ...}}
    """
    SH_INDEX = {'000300', '000905', '000016', '000688', '000852', '000010'}
    prefixed = []
    key_of = {}
    for c in codes:
        low = c.lower()
        if low.startswith(('sh', 'sz', 'bj')):
            p = low
        elif c.startswith('92'):
            p = f'bj{c}'
        elif c in SH_INDEX or c.startswith(('5', '6', '9')):
            p = f'sh{c}'
        elif c.startswith(('4', '8')):
            p = f'bj{c}'
        else:
            p = f'sz{c}'
        prefixed.append(p)
        key_of[p] = c
    url = 'https://qt.gtimg.cn/q=' + ','.join(prefixed)
    req = urllib.request.Request(url)
    req.add_header('User-Agent', 'Mozilla/5.0')
    resp = urllib.request.urlopen(req, timeout=10)
    data = resp.read().decode('gbk')
    result = {}
    for line in data.strip().split(';'):
        if not line.strip() or '=' not in line or '"' not in line:
            continue
        key = line.split('=')[0].split('_')[-1]
        vals = line.split('"')[1].split('~')
        if len(vals) < 53:
            continue
        code = key_of.get(key, key[2:])
        result[code] = {'name': vals[1], 'price': float(vals[3]) if vals[3] else 0, 'last_close': float(vals[4]) if vals[4] else 0, 'open': float(vals[5]) if vals[5] else 0, 'change_amt': float(vals[31]) if vals[31] else 0, 'change_pct': float(vals[32]) if vals[32] else 0, 'high': float(vals[33]) if vals[33] else 0, 'low': float(vals[34]) if vals[34] else 0, 'amount_wan': float(vals[37]) if vals[37] else 0, 'turnover_pct': float(vals[38]) if vals[38] else 0, 'pe_ttm': float(vals[39]) if vals[39] else 0, 'amplitude_pct': float(vals[43]) if vals[43] else 0, 'float_mcap_yi': float(vals[44]) if vals[44] else 0, 'mcap_yi': float(vals[45]) if vals[45] else 0, 'pb': float(vals[46]) if vals[46] else 0, 'limit_up': float(vals[47]) if vals[47] else 0, 'limit_down': float(vals[48]) if vals[48] else 0, 'vol_ratio': float(vals[49]) if vals[49] else 0, 'pe_static': float(vals[52]) if vals[52] else 0}
        q = result[code]
        q['is_stale'] = q['amount_wan'] == 0 and q['price'] == q['last_close'] and (q['price'] > 0)
        if q['is_stale'] and key[2:4] in ('43', '83', '87'):
            q['stale_reason'] = '北交所老号段，多数已迁至 920xxx，请按名称反查现行代码'
        elif q['is_stale']:
            q['stale_reason'] = '成交量为 0（停牌 / 未开盘 / 废码），报价非当日真实成交'
    return result


REPORT_API = 'https://reportapi.eastmoney.com/report/list'


PDF_TPL = 'https://pdf.dfcfw.com/pdf/H3_{info_code}_1.pdf'


UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'


def eastmoney_reports(code: str, max_pages: int=5) -> list[dict]:
    """拉取指定股票的研报列表。

    code 支持 600519 / SH600519 / 600519.SH 等写法（内部归一化为纯 6 位）。
    ⚠️ reportapi 只认纯 6 位数字：传 "SH600519" 会返回 hits=0，
       看起来像「这只票没研报」，实际是格式没归一化——务必先过 norm_ticker()。
    返回 [] 仅表示东财确无该标的研报覆盖（格式错误已在上游抛 ValueError）。
    """
    code = norm_ticker(code, stock_only=True)
    all_records = []
    for page in range(1, max_pages + 1):
        params = {'industryCode': '*', 'pageSize': '100', 'industry': '*', 'rating': '*', 'ratingChange': '*', 'beginTime': '2000-01-01', 'endTime': '2030-01-01', 'pageNo': str(page), 'fields': '', 'qType': '0', 'orgCode': '', 'code': code, 'rcode': '', 'p': str(page), 'pageNum': str(page), 'pageNumber': str(page)}
        r = em_get(REPORT_API, params=params, headers={'Referer': 'https://data.eastmoney.com/'}, timeout=30)
        d = r.json()
        rows = d.get('data') or []
        if not rows:
            break
        all_records.extend(rows)
        if page >= (d.get('TotalPage', 1) or 1):
            break
    if not all_records and code[:2] in ('43', '83', '87'):
        raise ValueError(f'{code} 属北交所老号段（43/83/87），东财研报库已不再按老码索引。北交所存量标的已基本迁至 920xxx（如 832982→920982）；请按股票名称反查现行 920 代码后重试。详见「北交所老号段」警告。')
    return all_records


def download_pdf(record: dict, target_dir: str='./reports') -> Optional[str]:
    """下载单份研报PDF，返回保存路径或None"""
    info_code = record.get('infoCode', '')
    if not info_code:
        return None
    date = (record.get('publishDate') or '')[:10]
    org = re.sub('[\\\\/:*?"<>|]', '_', record.get('orgSName') or '未知')[:40]
    title = re.sub('[\\\\/:*?"<>|]', '_', record.get('title', ''))[:80]
    fname = f'{date}_{org}_{title}.pdf'
    target = Path(target_dir) / fname
    if target.exists():
        return str(target)
    url = PDF_TPL.format(info_code=info_code)
    r = em_get(url, headers={'Referer': 'https://data.eastmoney.com/'}, timeout=60)
    if r.status_code == 200 and len(r.content) >= 1024:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(r.content)
        return str(target)
    return None


def sina_financial_report(code: str, report_type: str='lrb', num: int=8) -> list[dict]:
    """
    新浪财报三表。
    code: 6位代码
    report_type: "fzb"(资产负债表) / "lrb"(利润表) / "llb"(现金流量表)
    num: 取最近 N 期（默认 8 期）
    返回: 按报告期倒序的记录列表，每期一条 dict：
          {"报告期": "2026-03-31", "<科目>": "<值>", "<科目>_同比": <同比>, ...}
          （item_value 为新浪原始字符串数值，仅在有同比时附 "_同比" 键）
    """
    prefix = get_prefix(code)
    paper_code = f'{prefix}{code}'
    url = 'https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022'
    params = {'paperCode': paper_code, 'source': report_type, 'type': '0', 'page': '1', 'num': str(num)}
    headers = {'User-Agent': UA}
    r = requests.get(url, params=params, headers=headers, timeout=15)
    _j = r.json() or {}
    report_list = ((_j.get('result') or {}).get('data') or {}).get('report_list') or {}
    rows = []
    for period in sorted(report_list.keys(), reverse=True)[:num]:
        obj = report_list[period]
        rec = {'报告期': f'{period[:4]}-{period[4:6]}-{period[6:8]}'}
        for it in obj.get('data', []) or []:
            title = it.get('item_title', '')
            if not title or it.get('item_value') is None:
                continue
            rec[title] = it.get('item_value')
            tongbi = it.get('item_tongbi')
            if tongbi not in (None, ''):
                rec[title + '_同比'] = tongbi
        rows.append(rec)
    return rows


def _cninfo_ts_to_date(ts):
    """巨潮 announcementTime 返回 Unix 毫秒整数，需转换为日期字符串。"""
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d')
    return str(ts)[:10] if ts else ''


_CNINFO_ORGID_MAP = {}


def _cninfo_orgid(code: str) -> str:
    """查股票真实 orgId。巨潮 orgId 并非统一 `gssx0{code}` 格式（如 601318→9900002221、
    601398→jjxt0000019、688017→9900041602），硬编码会导致大量股票（尤其 601xxx 段）
    返回 totalAnnouncement=0、查不到公告（#19）。优先动态查官方映射表，查不到再回退硬编码。"""
    global _CNINFO_ORGID_MAP
    if not _CNINFO_ORGID_MAP:
        try:
            r = requests.get('http://www.cninfo.com.cn/new/data/szse_stock.json', headers={'User-Agent': UA}, timeout=15)
            _CNINFO_ORGID_MAP = {s['code']: s['orgId'] for s in r.json().get('stockList', [])}
        except Exception as e:
            print(f'[WARN] 巨潮 orgId 映射表拉取失败，回退硬编码规则: {e}')
    org = _CNINFO_ORGID_MAP.get(code)
    if org:
        return org
    return f'gs{get_prefix(code)}0{code}'


def cninfo_announcements(code: str, page_size: int=30) -> list[dict]:
    """
    巨潮公告全文检索。
    返回: [{title, type, date, url}]
    """
    url = 'https://www.cninfo.com.cn/new/hisAnnouncement/query'
    org_id = _cninfo_orgid(code)
    payload = {'stock': f'{code},{org_id}', 'tabName': 'fulltext', 'pageSize': str(page_size), 'pageNum': '1', 'column': '', 'category': '', 'plate': '', 'seDate': '', 'searchkey': '', 'secid': '', 'sortName': '', 'sortType': '', 'isHLtitle': 'true'}
    headers = {'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.cninfo.com.cn/new/disclosure', 'Origin': 'https://www.cninfo.com.cn'}
    r = requests.post(url, data=payload, headers=headers, timeout=15)
    d = r.json()
    rows = []
    for item in d.get('announcements', []) or []:
        rows.append({'title': item.get('announcementTitle', ''), 'type': item.get('announcementTypeName', ''), 'date': _cninfo_ts_to_date(item.get('announcementTime')), 'url': f"https://www.cninfo.com.cn/new/disclosure/detail?annoId={item.get('announcementId', '')}"})
    return rows


V39_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'


def _v39_http(url, params=None, data=None, headers=None, method='GET', timeout=(10, 40), allow_status=(), allow_redirects=True):
    """非东财的 HTTP 请求：带浏览器 UA。网络错误、非 2xx 一律抛 RuntimeError（不把错误页当数据）；
    allow_status 里的状态码（源用 404 表示「当天没发布」时）原样返回，由调用方判断。"""
    merged = {'User-Agent': V39_UA}
    merged.update(headers or {})
    try:
        response = requests.request(method, url, params=params, data=data, headers=merged, timeout=timeout, allow_redirects=allow_redirects)
        if response.status_code not in allow_status:
            response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f'请求 {url} 失败: {type(exc).__name__}: {exc}') from exc
    return response


def _v39_json(response):
    """解析 JSON；不是 JSON 抛 RuntimeError。json 的解析错误是 ValueError 的子类，
    不转换会被调用方当成「确实没有数据」。"""
    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError(f"{getattr(response, 'url', '')} 返回的不是 JSON，可能是错误页") from exc


def _v39_date(value):
    """'2026-09-18' / '20260918' / date 对象 → '2026-09-18'；其他写法抛 ValueError。"""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, _date_cls):
        return value.isoformat()
    text = str(value).strip()
    fmt = '%Y%m%d' if re.fullmatch('[0-9]{8}', text) else '%Y-%m-%d'
    return datetime.strptime(text, fmt).date().isoformat()


def _v39_src_date(value):
    """来源返回的日期 → 'YYYY-MM-DD'；认不出抛 RuntimeError（源格式变了，不是参数写错）。"""
    try:
        return _v39_date(value)
    except ValueError as exc:
        raise RuntimeError(f'来源返回了无法识别的日期 {value!r}') from exc


def _v39_num(value):
    """'1,234.50' → 1234.5；空串 / '-' / '--' / None → None；其他非数字抛 RuntimeError
    （来源给了认不出的值是「源的格式变了」，不能和参数错误的 ValueError 混在一起）。
    JSON 布尔值同样抛错：float(True)=1.0 会把格式错误静默写成价格 / 成交量。"""
    if value is None:
        return None
    if isinstance(value, bool):
        raise RuntimeError(f'来源在数值字段给了布尔值 {value!r}')
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (not math.isfinite(value)):
            return None
        return float(value)
    text = str(value).replace(',', '').strip()
    if text in ('', '-', '--', 'None', 'null'):
        return None
    try:
        number = float(text)
    except ValueError as exc:
        raise RuntimeError(f'来源返回了无法识别的数值 {value!r}') from exc
    return number if math.isfinite(number) else None


def _v39_rows(value, what):
    """来源里可能整段缺失的行列表：字段没有（None）按空处理，其余必须是对象列表。
    写成 `value or []` 会把 {} / '' / 0 这类结构改变也当成空表，静默丢掉整段数据。"""
    if value is None:
        return []
    if not isinstance(value, list) or not all((isinstance(row, dict) for row in value)):
        raise RuntimeError(f'{what} 应为对象列表，实际是 {type(value).__name__}: {str(value)[:120]}')
    return value


def _v39_labels(value, what):
    """来源的标签数组（频道名之类）：None 按空处理，其余必须是字符串列表。
    直接 `value or []` 再 join，来源把数组改成字符串时会被拆成单字（'ab' → 'a,b'）。"""
    if value is None:
        return []
    if not isinstance(value, list) or not all((isinstance(x, str) for x in value)):
        raise RuntimeError(f'{what} 应为字符串列表，实际是 {type(value).__name__}: {str(value)[:120]}')
    return value


def _v39_req_num(value, what):
    """必填数值（价格、成交量）：在 _v39_num 之上，空值 / NaN / inf 也抛 RuntimeError，不能当缺失放过。"""
    number = _v39_num(value)
    if number is None:
        raise RuntimeError(f'来源的 {what} 为空或不是有限数值: {value!r}')
    return number


def _v39_contract(func):
    """统一异常契约：来源行缺字段时 row["X"] 会漏出 KeyError，调用方按「参数错 / 没数据」处理就会
    把「来源格式变了」当成正常情况。这里把它转成带函数名和字段名的 RuntimeError。
    （函数内所有按用户参数取字典的地方都先校验过参数，不会走到这里。）"""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except KeyError as exc:
            raise RuntimeError(f'{func.__name__}: 来源数据缺少字段 {exc}，格式可能已变') from exc
    return wrapper


def _v39_count(value, what):
    """来源自报的页数 / 条数 → 非负 int。只认 int 或纯数字串；bool 抛错（int(True)=1 会让
    「只返回 1 条」通过完整性核对），其他写法也抛 RuntimeError。"""
    text = str(value).strip() if isinstance(value, (int, str)) and (not isinstance(value, bool)) else ''
    if not re.fullmatch('[0-9]+', text):
        raise RuntimeError(f'{what} 不是非负整数: {value!r}')
    return int(text)


def _v39_frame(rows, source, url, columns=None):
    """统一出表：附 source / source_url / fetched_at。rows 为空时返回带列名的空表，
    是否允许为空由调用方判断（「确实没有」与「接口坏了」要分开处理）。"""
    frame = pd.DataFrame(rows, columns=columns)
    frame['source'] = source
    frame['source_url'] = url
    frame['fetched_at'] = datetime.now(timezone.utc).isoformat()
    return frame


def _em_datacenter_strict(report_name, filter_str='', sort_columns='', sort_types='', page_size=500, max_rows=5000, columns='ALL', extra=None):
    """东财 datacenter 严格版：code=0 取数据；第 1 页就 9201(返回数据为空) → []；其他错误码直接抛。

    与旧 eastmoney_datacenter() 的区别：后者把任何失败都变成 []，调用方分不清
    「这只票确实没有」和「参数写错/被风控」。sortTypes 个数必须与 sortColumns 一致，
    否则东财返回 9501「排序字段和顺序数量不一致」。
    翻页中途失败（第 2 页起 9201、空页、非末页不满页、缺 pages / count、总页数或总条数变了、
    最终条数与 count 不符）抛 RuntimeError，不把部分结果当完整结果返回。
    payload / result 不是对象、data 不是由对象组成的列表，同样抛 RuntimeError。
    只有「第 1 页、pages=1、data 为空」才算确实没有数据。
    max_rows 只在来源自报总数 count > max_rows 时提前截断；count 不超过上限的，一律走完分页并核对总数。
    """
    n_cols = len([c for c in sort_columns.split(',') if c]) if sort_columns else 0
    n_types = len([t for t in sort_types.split(',') if t]) if sort_types else 0
    if n_cols != n_types:
        raise ValueError(f'sortColumns({n_cols}) 与 sortTypes({n_types}) 个数不一致')
    rows, page, first = ([], 1, None)
    while True:
        params = {'reportName': report_name, 'columns': columns, 'filter': filter_str, 'pageNumber': str(page), 'pageSize': str(page_size), 'sortColumns': sort_columns, 'sortTypes': sort_types, 'source': 'WEB', 'client': 'WEB'}
        params.update(extra or {})
        try:
            response = em_get(DATACENTER_URL, params=params, timeout=20)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise RuntimeError(f'东财 {report_name} 请求失败: {type(exc).__name__}: {exc}') from exc
        payload = _v39_json(response)
        if not isinstance(payload, dict):
            raise RuntimeError(f'东财 {report_name} 返回的不是 JSON 对象: {str(payload)[:100]}')
        if payload.get('code') == 9201:
            if page == 1:
                return []
            raise RuntimeError(f'东财 {report_name} 第 {page} 页返回「数据为空」，前面已取 {len(rows)} 条，结果不完整')
        if payload.get('code') != 0 or not payload.get('result'):
            raise RuntimeError(f"东财 {report_name} 返回错误: {payload.get('code')} {payload.get('message')}")
        result = payload['result']
        if not isinstance(result, dict):
            raise RuntimeError(f'东财 {report_name} 的 result 不是对象: {str(result)[:100]}')
        pages, count, data = (result.get('pages'), result.get('count'), result.get('data'))
        if data is None:
            data = []
        if not isinstance(data, list) or not all((isinstance(r, dict) for r in data)):
            raise RuntimeError(f'东财 {report_name} 第 {page} 页的 data 不是由对象组成的列表，格式可能已变')
        if any((isinstance(v, bool) or not isinstance(v, int) for v in (pages, count))) or pages < 1 or count < 0:
            raise RuntimeError(f'东财 {report_name} 缺少分页信息（pages={pages!r}, count={count!r}）')
        if first is None:
            first = (pages, count)
        elif (pages, count) != first:
            raise RuntimeError(f'东财 {report_name} 翻页时总页数 / 总条数从 {first} 变成 {(pages, count)}，结果可能错位，请重试')
        if not data and (page > 1 or pages > 1):
            raise RuntimeError(f'东财 {report_name} 第 {page}/{pages} 页是空的，结果不完整')
        if page < pages and len(data) != int(page_size):
            raise RuntimeError(f'东财 {report_name} 第 {page}/{pages} 页只有 {len(data)} 条（非末页应为 {page_size} 条），结果不完整')
        rows.extend(data)
        if len(rows) >= max_rows and count > max_rows:
            return rows[:max_rows]
        if page >= pages:
            if len(rows) != count:
                raise RuntimeError(f'东财 {report_name} 翻页后 {len(rows)} 条，与总数 {count} 不符')
            return rows
        page += 1


def _em_day(value):
    """东财日期串 '2026-09-18 00:00:00' → '2026-09-18'；空值 → None；认不出的写法抛 RuntimeError
    （只截前 10 个字符会把 '2026/09/18' 原样放行，再拿去和日期串比较就会比错）。"""
    return _v39_src_date(str(value)[:10]) if value else None


TDX_PACKAGE_URL = 'https://www.tdx.com.cn/products/data/data/g4day/{ymd}.zip'


TDX_BJ_FIRST_DAY = '20220506'


TDX_MIN_PRICED = {'sh': 10000, 'sz': 3000, 'bj': 50}


def _tdx_parse_package(content, ymd):
    """解析通达信每日增量包：每个市场一对 .cod（代码表，150 字节/条）+ .md1（行情块，512 字节/块）。
    布局参考 jing2uo/tdx2db（MIT）的 tdx/merge.go，已用 600519/000001/920000 与腾讯收盘价对拍。"""
    archive = zipfile.ZipFile(io.BytesIO(content))
    names = set(archive.namelist())
    rows = []
    for market in ('sh', 'sz', 'bj'):
        cod_name, md1_name = (f'{market}{ymd[2:]}.cod', f'{market}{ymd[2:]}.md1')
        if market == 'bj' and ymd < TDX_BJ_FIRST_DAY and (cod_name not in names) and (md1_name not in names):
            continue
        if cod_name not in names or md1_name not in names:
            raise RuntimeError(f'通达信盘后包缺少 {cod_name}/{md1_name}，格式可能已变')
        cod, md1 = (archive.read(cod_name), archive.read(md1_name))
        if len(cod) % 150 or len(md1) % 512:
            raise RuntimeError(f'{market} 代码表或行情块长度不是整块，文件可能被截断')
        if len(cod) // 150 != len(md1) // 512:
            raise RuntimeError(f'{market} 代码表 {len(cod) // 150} 条、行情块 {len(md1) // 512} 块，对不上')
        before, codes, seqs = (len(rows), set(), set())
        for offset in range(0, len(cod), 150):
            record = cod[offset:offset + 150]
            code = record[0:6].rstrip(b'\x00 ').decode('ascii', 'replace')
            seq = struct.unpack('<H', record[32:34])[0]
            if not re.fullmatch('[0-9]{6}', code):
                raise RuntimeError(f'通达信盘后包 {market} 代码表出现非 6 位数字代码 {code!r}，格式可能已变')
            if code in codes or seq in seqs:
                raise RuntimeError(f'通达信盘后包 {market} 代码表有重复的代码 / 行情块序号（{code!r}, seq={seq}）')
            codes.add(code)
            seqs.add(seq)
            block = md1[seq * 512:(seq + 1) * 512]
            if len(block) != 512:
                raise RuntimeError(f'{market}{code} 行情块越界（seq={seq}）')
            prev_close = struct.unpack('<d', block[4:12])[0]
            open_, high, low, close = struct.unpack('<4d', block[12:44])
            amount = struct.unpack('<d', block[72:80])[0]
            if not all((math.isfinite(v) for v in (prev_close, open_, high, low, close, amount))):
                raise RuntimeError(f'通达信盘后包 {market}{code} 行情块出现非有限数值，文件可能已损坏')
            if close <= 0:
                continue
            volume = struct.unpack('<Q', block[56:64])[0]
            raw_name = record[40:72].split(b'\x00')[0]
            try:
                name = raw_name.decode('gbk').strip()
            except UnicodeDecodeError as exc:
                raise RuntimeError(f'通达信盘后包 {market}{code} 的名称不是 GBK，文件可能已损坏') from exc
            if not name:
                raise RuntimeError(f'通达信盘后包 {market}{code} 有价格却没有名称，文件可能已损坏')
            rows.append({'date': f'{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}', 'market': market, 'code': code, 'name': name, 'prev_close': round(prev_close, 4), 'open': round(open_, 4), 'high': round(high, 4), 'low': round(low, 4), 'close': round(close, 4), 'volume': volume, 'amount': round(amount, 2)})
        if len(rows) - before < TDX_MIN_PRICED[market]:
            raise RuntimeError(f'通达信盘后包 {market} 市场只有 {len(rows) - before} 条有价记录（实测下限 {TDX_MIN_PRICED[market]}），文件可能残缺或格式已变')
    return rows


@_v39_contract
def tdx_daily_package(date):
    """通达信官网每日盘后包 — 某一交易日沪深北全部证券的日线（含成交额）。

    走 HTTP 下载（约 2.7MB），与 #52 失效的 TCP 行情命令是两条路。
    个股 volume 单位是「股」、amount 单位是「元」；指数等特殊代码的 volume 为通达信原值。
    非交易日或当日包尚未发布时官网返回 404，本函数抛 ValueError，不返回空表。
    历史包实测 2022-01-04、2023-01-03 可取，2021-01-04 已 404，未逐日验证；
    2022-05-06 之前的包没有北交所文件，只返回沪深，之后缺北交所文件会报错。
    某个市场有价记录少于 TDX_MIN_PRICED 的实测下限、代码不是 6 位数字或重复、行情块序号重复、
    代码表与行情块条数对不上、价格 / 成交额不是有限数，
    都按文件残缺抛 RuntimeError，不把部分市场当全市场返回。
    """
    ymd = _v39_date(date).replace('-', '')
    url = TDX_PACKAGE_URL.format(ymd=ymd)
    response = _v39_http(url, timeout=(10, 90), allow_status=(404,))
    if response.status_code == 404:
        raise ValueError(f'{date} 没有通达信盘后包：非交易日、当日包尚未发布（通常收盘后数小时），或早于官网保留范围（实测 2021-01-04 已没有）')
    if not response.content.startswith(b'PK'):
        raise RuntimeError('通达信盘后包不是 zip 文件，可能是错误页')
    try:
        rows = _tdx_parse_package(response.content, ymd)
    except (zipfile.BadZipFile, zlib.error, EOFError) as exc:
        raise RuntimeError(f'通达信盘后包 {url} 无法解压: {type(exc).__name__}: {exc}') from exc
    return _v39_frame(rows, 'tdx', url)


def tencent_quote_snapshot(codes: list[str]) -> dict[str, dict]:
    """
    批量拉取腾讯财经实时行情。
    codes: ["688017", "300476", "002463"]
    也支持指数: ["000001", "000300", "399006"]
    也支持ETF: ["510050", "510300"]
    返回: {code: {name, price, pe_ttm, pb, mcap, ...}}
    """
    SH_INDEX = {'000300', '000905', '000016', '000688', '000852', '000010'}
    prefixed = []
    key_of = {}
    for c in codes:
        low = c.lower()
        if low.startswith(('sh', 'sz', 'bj')):
            p = low
        elif c.startswith('92'):
            p = f'bj{c}'
        elif c in SH_INDEX or c.startswith(('5', '6', '9')):
            p = f'sh{c}'
        elif c.startswith(('4', '8')):
            p = f'bj{c}'
        else:
            p = f'sz{c}'
        prefixed.append(p)
        key_of[p] = c
    url = 'https://qt.gtimg.cn/q=' + ','.join(prefixed)
    req = urllib.request.Request(url)
    req.add_header('User-Agent', 'Mozilla/5.0')
    resp = urllib.request.urlopen(req, timeout=10)
    data = resp.read().decode('gbk')
    result = {}
    for line in data.strip().split(';'):
        if not line.strip() or '=' not in line or '"' not in line:
            continue
        key = line.split('=')[0].split('_')[-1]
        vals = line.split('"')[1].split('~')
        if len(vals) < 53:
            continue
        code = key_of.get(key, key[2:])
        result[code] = {'name': vals[1], 'price': float(vals[3]) if vals[3] else 0, 'last_close': float(vals[4]) if vals[4] else 0, 'open': float(vals[5]) if vals[5] else 0, 'change_amt': float(vals[31]) if vals[31] else 0, 'change_pct': float(vals[32]) if vals[32] else 0, 'high': float(vals[33]) if vals[33] else 0, 'low': float(vals[34]) if vals[34] else 0, 'amount_wan': float(vals[37]) if vals[37] else 0, 'turnover_pct': float(vals[38]) if vals[38] else 0, 'pe_ttm': float(vals[39]) if vals[39] else 0, 'amplitude_pct': float(vals[43]) if vals[43] else 0, 'float_mcap_yi': float(vals[44]) if vals[44] else 0, 'mcap_yi': float(vals[45]) if vals[45] else 0, 'pb': float(vals[46]) if vals[46] else 0, 'limit_up': float(vals[47]) if vals[47] else 0, 'limit_down': float(vals[48]) if vals[48] else 0, 'vol_ratio': float(vals[49]) if vals[49] else 0, 'pe_static': float(vals[52]) if vals[52] else 0}
        q = result[code]
        q['source_symbol'] = key
        q['source_code'] = vals[2]
        q['source_time'] = vals[30] or None
        q['volume_source'] = float(vals[6]) if vals[6] else None
        q['amount_precise_wan'] = float(vals[57]) if len(vals) > 57 and vals[57] else None
        q['source_ratio_raw'] = vals[49] or None
        q['raw_sha256'] = __import__('hashlib').sha256(data.encode('gbk')).hexdigest()
        q['is_stale'] = q['amount_wan'] == 0 and q['price'] == q['last_close'] and (q['price'] > 0)
        if q['is_stale'] and key[2:4] in ('43', '83', '87'):
            q['stale_reason'] = '北交所老号段，多数已迁至 920xxx，请按名称反查现行代码'
        elif q['is_stale']:
            q['stale_reason'] = '成交量为 0（停牌 / 未开盘 / 废码），报价非当日真实成交'
    return result
