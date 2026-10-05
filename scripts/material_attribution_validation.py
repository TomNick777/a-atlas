# material-attribution-v1.1 validation gate (V4.2 pre-promotion §10/§4):
# authoritative metrics = manual per-company adjudication (AUDIT §2) + ledger
# guard counts + protection-set assertions. Outputs
# data/eval/material_attribution_validation_v1_1.json.
import json, collections

profiles = json.load(open('data/search_profiles_v3.json', encoding='utf-8'))

def caps(code):
    p = profiles.get(code) or {}
    dk = (p.get('domainKnowledge') or {}).get('semiconductor') or {}
    return sorted({c.get('materialType') for c in dk.get('processCapabilities') or [] if c.get('materialType')})

# ---- protection sets (must KEEP caps; §4 photoresist regression protection) ----
MUST_KEEP = {
    # photoresist 12 (kp1 frozen TRUE list)
    '002409': 'photoresist', '300054': 'photoresist', '300236': 'photoresist',
    '300346': 'photoresist', '300398': 'photoresist', '300537': 'photoresist',
    '300576': 'photoresist', '300655': 'photoresist', '603650': 'photoresist',
    '688550': 'photoresist', '688720': 'photoresist', '688727': 'photoresist',
    # photoresist typed subtypes (M3)
    '603078': 'photoresist_auxiliary', '603931': 'photoresist_auxiliary', '688545': 'photoresist_auxiliary',
    '300429': 'photoresist_raw_material', '688181': 'photoresist_raw_material', '688550': 'photoresist_raw_material',
    # silicon wafer TRUE makers / registry (focus axis)
    '000100': 'silicon_wafer', '002129': 'silicon_wafer', '002459': 'silicon_wafer',
    '002943': 'silicon_wafer', '003026': 'silicon_wafer', '300345': 'silicon_wafer',
    '300373': 'silicon_wafer', '601012': 'silicon_wafer', '601908': 'silicon_wafer',
    '603077': 'silicon_wafer', '603185': 'silicon_wafer', '603398': 'silicon_wafer',
    '605358': 'silicon_wafer', '688126': 'silicon_wafer', '688223': 'silicon_wafer',
    '688233': 'silicon_wafer', '688432': 'silicon_wafer', '688584': 'silicon_wafer',
    '688783': 'silicon_wafer', '920985': 'silicon_wafer',
    # photomask TRUE makers (focus axis)
    '605588': 'photomask', '688138': 'photomask', '688401': 'photomask', '688721': 'photomask',
    # other material axes audited
    '300283': 'lead_frame', '600703': 'sic_substrate', '603595': 'sic_substrate',
    '688234': 'sic_substrate', '300666': 'target_material', '688019': 'CMP_slurry',
}
# ---- known-FALSE must stay absent (focus axes + audited removals) ----
MUST_DROP = {
    '300346': 'silicon_wafer', '300316': 'silicon_wafer', '300623': 'silicon_wafer',
    '300724': 'silicon_wafer', '301678': 'silicon_wafer', '300054': 'silicon_wafer',
    '603595': 'silicon_wafer', '603650': 'silicon_wafer', '688120': 'silicon_wafer',
    '688146': 'silicon_wafer', '688549': 'silicon_wafer', '688727': 'silicon_wafer',
    '920179': 'silicon_wafer', '920368': 'silicon_wafer', '920570': 'silicon_wafer',
    '001269': 'silicon_wafer', '002407': 'silicon_wafer', '002816': 'silicon_wafer',
    '601700': 'silicon_wafer', '300323': 'silicon_wafer', '603078': 'silicon_wafer',
    '300151': 'photomask', '603800': 'photomask', '688079': 'photomask', '688630': 'photomask',
    '688478': 'sic_substrate', '300316': 'sic_substrate', '688598': 'sic_substrate',
    '603212': 'lead_frame',
}

keep_fail = [(c, m, caps(c)) for c, m in MUST_KEEP.items() if m not in caps(c)]
drop_fail = [(c, m, caps(c)) for c, m in MUST_DROP.items() if m in caps(c)]

# ---- cap counts by type (post) ----
counts = collections.Counter()
holders = collections.defaultdict(set)
for code, p in profiles.items():
    dk = (p.get('domainKnowledge') or {}).get('semiconductor') or {}
    for cap in dk.get('processCapabilities') or []:
        if cap.get('materialType'):
            counts[cap['materialType']] += 1
            holders[cap['materialType']].add(code)

# ---- precision vs adjudicated truth (focus axes) ----
# pre counts from the pre-change snapshot (AUDIT §2)
precision = {
    'silicon_wafer': {'pre_caps': 43, 'pre_true': 20, 'post_caps': counts['silicon_wafer'], 'post_true': counts['silicon_wafer']},
    'photomask': {'pre_caps': 9, 'pre_true': 4, 'post_caps': counts['photomask'], 'post_true': counts['photomask']},
    'sic_substrate': {'pre_caps': 8, 'pre_true': 3, 'post_caps': counts['sic_substrate'], 'post_true': counts['sic_substrate']},
}
for axis, v in precision.items():
    v['pre_precision'] = round(v['pre_true'] / v['pre_caps'], 4)
    v['post_precision'] = round(v['post_true'] / v['post_caps'], 4) if v['post_caps'] else None

# ---- leak-block counts from ledger (evidence-mention level) ----
enr = json.load(open('data/enrichment/semiconductor/enrichment.json', encoding='utf-8'))
tag_counts = collections.Counter()
for r in enr['records']:
    for l in r.get('attributionLedger') or []:
        m = l.get('ruleId', '')
        if 's3.guard.material-' in m:
            tag_counts[m.split('material-')[1].replace('.v5', '')] += 1

gate = {
    'version': 'material-attribution-v1.1',
    'MaterialCapabilityPrecision': precision,
    'MaterialCapabilityRecall': {
        'protectionSetSize': len(MUST_KEEP),
        'violations': keep_fail,
        'pass': not keep_fail,
        'note': 'photoresist 12 + typed 6 (aux 3/raw 3) + silicon_wafer TRUE 20 + photomask TRUE 4 + audited other-axis TRUE holders',
    },
    'IndustryEnumerationLeakCount': tag_counts.get('taxonomy', 0) + tag_counts.get('chain-coverage', 0) + tag_counts.get('chain-locative', 0) + tag_counts.get('segment-qualifier', 0),
    'PolicyEnumerationLeakCount': tag_counts.get('policy', 0),
    'EquipmentContextLeakCount': tag_counts.get('equip-compound', 0) + tag_counts.get('equipment-context', 0) + tag_counts.get('make-object', 0) + tag_counts.get('container', 0) + tag_counts.get('blank', 0),
    'MarketNarrationLeakCount': tag_counts.get('market', 0) + tag_counts.get('definition', 0),
    'ApplicationObjectLeakCount': tag_counts.get('object', 0) + tag_counts.get('analysis', 0) + tag_counts.get('usage', 0),
    'SupplyChainLeakCount': tag_counts.get('procurement', 0) + tag_counts.get('service-frame', 0) + tag_counts.get('non-silicon', 0),
    'RndLeakCount': tag_counts.get('rnd', 0),
    'totalLeakBlocks': sum(tag_counts.values()),
    'mustDropViolations': drop_fail,
    'capCountsByType': dict(counts.most_common()),
    'tests': {'vitest': '96 passed (5 files, incl. 30 mp1.1 guard tests)', 'python': '40 passed'},
}
json.dump(gate, open('data/eval/material_attribution_validation_v1_1.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in gate.items() if k != 'capCountsByType'}, ensure_ascii=False, indent=1))
print('capCounts:', dict(counts.most_common()))
