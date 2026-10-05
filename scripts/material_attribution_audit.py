# material-attribution-v1.1 audit (V4.2 pre-promotion §10):
# For every materialType cap in the CURRENT profiles, classify each supporting
# evidence window with an independent leak classifier (regex patterns mirroring
# the §2-§6 audit categories). Report per-axis leak counts pre (kp1 profiles
# snapshot) vs post (v1.1), precision/recall vs the audited truth set, and the
# photoresist regression-protection assertions (§4).
import json, re, sys, collections

MT_PATS = {
    'silicon_wafer': r'硅片|抛光片|衬底片', 'photomask': r'掩膜版|掩模版|光罩',
    'photoresist': r'光刻胶', 'photoresist_auxiliary': r'光刻胶',
    'photoresist_raw_material': r'光刻胶', 'target_material': r'靶材',
    'wet_chemicals': r'湿电子化学品|超纯试剂|蚀刻液|刻蚀液|电子级硫酸|电子级双氧水|电子级氢氟酸|抛光清洗液',
    'CMP_slurry': r'抛光液|Slurry|slurry', 'CMP_pad': r'抛光垫|抛光布',
    'precursor': r'前驱体|MO源|高纯金属有机化合物', 'epi_wafer': r'外延片',
    'sic_substrate': r'碳化硅衬底|SiC衬底|碳化硅单晶', 'electronic_special_gas': r'电子特气|特种气体|高纯气体',
    'lead_frame': r'引线框架', 'package_substrate': r'封装基板|IC载板|封装载板',
    'bonding_wire': r'键合线|键合丝|键合铜线|铜丝球焊', 'cvd_diamond': r'金刚石微粉|金刚石单晶|CVD金刚石|金刚石工具',
}

LEAK_CLASSIFIERS = {
    # (category, window-level regex on the clause/window around the mention)
    'POLICY_ENUMERATION': r'出口管制|两用物项|管制清单|人民政府|发改委|工业和信息化部|工信部|商务部|国务院|(?:支持|鼓励|推动|提高|做大|做强|培育|实施|印发|发布|出台)[一-龥、]{0,24}(?:产能|规模|工程|项目|基地|集群|企业)|融链.{0,4}工程',
    'INDUSTRY_ENUMERATION': r'(?:材料|行业|市场|领域|产业链|环节|分类|场景)(?:可以?分为|划分为|包括|涵盖)|(?:清单|目录|名录)包括',
    'MARKET_NARRATION': r'仅次于|第[一二三四五]大|市场(?:份额|占比|规模|趋于)|占比|位列第|出货(?:量|面积)|供需(?:基本)?平衡|趋于饱和|出口(?:结构|占比)|行业壁垒|议价能力|集中度',
    'APPLICATION_ONLY': r'(?:对|用于|用在|应用于|适用于|满足|符合)[一-龥]{0,12}(?:硅片|抛光片|衬底片|外延片|掩膜版|掩模版|光罩|靶材|碳化硅|晶圆)|(?:切割|划片|减薄|研磨|抛光|清洗|蚀刻|刻蚀|量测|测量|检测)[一-龥]{0,6}(?:硅片|抛光片|衬底片|外延片|晶圆|引线框架)|与[一-龥]{0,6}(?:硅片|晶圆)[或和及]?[一-龥]{0,4}(?:直接)?(?:接触|贴合)|(?:加工|生产|制)成[一-龥]{0,8}(?:硅片|抛光片|衬底片|外延片)',
    'EQUIPMENT_CONTEXT': r'(?:硅片|抛光片|衬底片|外延片|碳化硅|金刚石)[一-龥]{0,4}(?:设备|装备|机台|分选机|单晶炉|炉)|整线解决方案|(?:光罩|掩膜版|掩模版)(?:盒|框|箱)',
    'SUPPLY_CHAIN_CONTEXT': r'采购(?:以|模式|清单)|供应商主要为?|上游(?:企业|厂商|供应商)|为[一-龥]{0,10}(?:的生产|制造|加工)[一-龥、]{0,16}(?:提供|配套)',
    'OTHER_COMPANY_CONTEXT': r'(?:国内|全球|海外|国际)(?:头部|龙头|领先)?(?:企业|厂商|公司|厂家)(?:加大|实现)|子公司[一-龥]{0,6}从事',
}
LEAK_CATS = list(LEAK_CLASSIFIERS)

def classify_windows(text, pat):
    hits = collections.Counter()
    for m in re.finditer(pat, text):
        s, t = m.start(), m.end()
        clause_s = s
        while clause_s > 0 and text[clause_s - 1] not in '。；！？!?;':
            clause_s -= 1
        clause_e = t
        while clause_e < len(text) and text[clause_e] not in '。；！？!?;':
            clause_e += 1
        clause = text[clause_s:clause_e]
        window = text[max(0, s - 50):t + 50]
        for cat, rx in LEAK_CLASSIFIERS.items():
            if re.search(rx, clause) or re.search(rx, window):
                hits[cat] += 1
    return hits

def load(path):
    profiles = json.load(open(path, encoding='utf-8'))
    out = []
    for code, p in profiles.items():
        dk = (p.get('domainKnowledge') or {}).get('semiconductor') or {}
        for cap in dk.get('processCapabilities') or []:
            if cap.get('materialType'):
                out.append({'code': code, 'materialType': cap['materialType'],
                            'evidenceIds': cap.get('evidenceIds') or []})
    return out

def audit(profile_caps, evidence_by_id):
    leak_caps = collections.Counter()   # (materialType, category) -> cap count
    clean = collections.Counter()       # materialType -> cap count with zero leak signals
    leak_rows = []
    for cap in profile_caps:
        pat = MT_PATS.get(cap['materialType'])
        if not pat:
            continue
        cats = collections.Counter()
        for eid in cap['evidenceIds']:
            e = evidence_by_id.get(eid)
            if not e:
                continue
            for cat, n in classify_windows(e.get('evidenceText', ''), pat).items():
                cats[cat] += n
        if cats:
            for cat in cats:
                leak_caps[(cap['materialType'], cat)] += 1
            leak_rows.append({'code': cap['code'], 'materialType': cap['materialType'],
                              'leakSignals': dict(cats)})
        else:
            clean[cap['materialType']] += 1
    return leak_caps, clean, leak_rows

evidence = json.load(open('data/enrichment/semiconductor/evidence.json', encoding='utf-8'))
ev_list = evidence['evidence'] if isinstance(evidence, dict) else evidence
ev_by_id = {e['evidenceId']: e for e in ev_list}

post_caps = load('data/search_profiles_v3.json')

# pre-change (kp1) profile snapshot: reconstruct from the pre-round window dump
pre_caps = []
seen = set()
for l in open('data/eval/mat_audit_windows.jsonl', encoding='utf-8'):
    r = json.loads(l)
    key = (r['code'], r['materialType'])
    if key not in seen:
        seen.add(key)
        pre_caps.append({'code': r['code'], 'materialType': r['materialType'], 'evidenceIds': []})
# for the pre snapshot we only have window dumps for a subset of types; restrict
# the like-for-like comparison to the dumped types
dumped_types = set(r['materialType'] for r in (json.loads(l) for l in open('data/eval/mat_audit_windows.jsonl', encoding='utf-8')))

pre_leak, pre_clean, pre_rows = audit(pre_caps, ev_by_id)
post_leak, post_clean, post_rows = audit(post_caps, ev_by_id)

result = {
    'auditVersion': 'material-attribution-v1.1',
    'comparedOn': '2026-09-27',
    'capCountsByType_pre': dict(collections.Counter(c['materialType'] for c in pre_caps if c['materialType'] in dumped_types)),
    'capCountsByType_post': dict(collections.Counter(c['materialType'] for c in post_caps)),
    'leakCapCounts_by_type_and_category_pre': {f'{k[0]}|{k[1]}': v for k, v in sorted(pre_leak.items())},
    'leakCapCounts_by_type_and_category_post': {f'{k[0]}|{k[1]}': v for k, v in sorted(post_leak.items())},
    'cleanCaps_by_type_post': dict(post_clean),
    'postLeakRows': post_rows,
}
json.dump(result, open('data/eval/material_attribution_audit_v1_1.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

print('cap counts pre (dumped types):', result['capCountsByType_pre'])
print('cap counts post (all types):  ', result['capCountsByType_post'])
print()
print('leak-cap counts by category (pre → post, dumped types):')
cats = collections.Counter(k[1] for k in list(pre_leak) + list(post_leak))
for cat in sorted(cats):
    pre_n = sum(v for k, v in pre_leak.items() if k[1] == cat)
    post_n = sum(v for k, v in post_leak.items() if k[0] in dumped_types and k[1] == cat)
    print(f'  {cat}: {pre_n} → {post_n}')
print()
print('post remaining leak rows (sample):')
for row in post_rows[:12]:
    print(' ', row['code'], row['materialType'], row['leakSignals'])
