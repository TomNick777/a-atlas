# Scan production profiles for materialType caps + supporting evidence windows.
# Output: per-materialType counts and JSONL of (company, materialType, evidenceText)
# for manual guard-gap classification.
import json, re, sys, collections

profiles = json.load(open('data/search_profiles_v3.json', encoding='utf-8'))
ev_raw = json.load(open('data/enrichment/semiconductor/evidence.json', encoding='utf-8'))
# evidence.json shape: check top-level
if isinstance(ev_raw, dict):
    evidence = ev_raw.get('evidence') or ev_raw.get('evidences') or ev_raw
else:
    evidence = ev_raw
ev_by_id = {}
if isinstance(evidence, dict):
    for k, v in evidence.items():
        if isinstance(v, dict) and 'evidenceId' in v:
            ev_by_id[v['evidenceId']] = v
        elif isinstance(v, list):
            for e in v:
                ev_by_id[e['evidenceId']] = e
elif isinstance(evidence, list):
    for e in evidence:
        ev_by_id[e['evidenceId']] = e

MATERIAL_TYPES = [
    'photoresist', 'photoresist_auxiliary', 'photoresist_raw_material',
    'silicon_wafer', 'photomask', 'target_material', 'wet_chemicals',
    'CMP_slurry', 'CMP_pad', 'precursor', 'epi_wafer', 'sic_substrate',
    'electronic_special_gas', 'lead_frame', 'package_substrate',
    'bonding_wire', 'cvd_diamond',
]

cap_counts = collections.Counter()
rows = []
for code, prof in profiles.items():
    dk = prof.get('domainKnowledge') or {}
    sem = dk.get('semiconductor') or {}
    for cap in sem.get('processCapabilities') or []:
        mt = cap.get('materialType')
        if not mt:
            continue
        cap_counts[mt] += 1
        if mt not in MATERIAL_TYPES:
            continue
        windows = []
        for eid in cap.get('evidenceIds') or []:
            e = ev_by_id.get(eid)
            if not e:
                windows.append({'evidenceId': eid, 'missing': True})
                continue
            text = e.get('evidenceText', '')
            # pull clause windows around each material keyword mention
            pats = {
                'silicon_wafer': r'硅片|抛光片|衬底片', 'photomask': r'掩膜版|掩模版|光罩',
                'photoresist': r'光刻胶', 'target_material': r'靶材',
                'wet_chemicals': r'湿电子化学品|超纯试剂|蚀刻液|刻蚀液|电子级硫酸|电子级双氧水|电子级氢氟酸|抛光清洗液',
                'CMP_slurry': r'抛光液|Slurry|slurry', 'CMP_pad': r'抛光垫|抛光布',
                'precursor': r'前驱体|MO源|高纯金属有机化合物', 'epi_wafer': r'外延片',
                'sic_substrate': r'碳化硅衬底|SiC衬底|碳化硅单晶', 'electronic_special_gas': r'电子特气|特种气体|高纯气体',
            }.get(mt, re.escape(mt))
            seen = set()
            for m in re.finditer(pats, text):
                s, t = m.start(), m.end()
                w = text[max(0, s - 45):t + 45]
                if w not in seen:
                    seen.add(w)
                    windows.append({'evidenceId': eid, 'window': w,
                                    'section': (e.get('locator') or {}).get('section', '')})
        rows.append({'code': code, 'name': (prof.get('identity') or {}).get('shortName', ''),
                     'materialType': mt, 'attribution': cap.get('attribution'),
                     'evidenceQuality': cap.get('evidenceQuality'), 'ruleId': cap.get('ruleId'),
                     'windows': windows[:6]})

print('materialType cap counts (all):')
for k, v in cap_counts.most_common():
    print(f'  {k}: {v}')
print('total rows dumped:', len(rows))
with open('data/eval/mat_audit_windows.jsonl', 'w', encoding='utf-8') as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + '\n')
