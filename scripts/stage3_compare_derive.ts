import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveCompanyCaps, type SemiEvidence } from "../search/knowledge/semiconductor";

/** 快速对比:v1(enrichment.json 现状) vs v2(deriveCompanyCaps 重派生)。 */
const root = process.cwd();
const codes = process.argv.slice(2);
const enrichment = JSON.parse(readFileSync(path.join(root, "data/enrichment/semiconductor/enrichment.json"), "utf8"));
const evidence = JSON.parse(readFileSync(path.join(root, "data/enrichment/semiconductor/evidence.json"), "utf8")).evidence as SemiEvidence[];
const byCompany = new Map<string, SemiEvidence[]>();
for (const e of evidence) {
  const l = byCompany.get(e.companyCode) ?? [];
  l.push(e);
  byCompany.set(e.companyCode, l);
}
for (const code of codes) {
  const rec = enrichment.records.find((r: { code: string }) => r.code === code);
  if (!rec) { console.log(code, "not in enrichment"); continue; }
  const ev = byCompany.get(code) ?? [];
  const t = deriveCompanyCaps(ev);
  const profileCaps = t.caps.filter((c) => c.role !== "unknown");
  const newEquip = [...new Set(profileCaps.filter((c) => c.equipmentType).map((c) => c.equipmentType!))];
  const newRoles = [...new Set(profileCaps.map((c) => c.role))];
  const oldEquip = rec.equipmentTypes.map((x: { type: string }) => x.type);
  const diff = oldEquip.filter((x: string) => !newEquip.includes(x));
  console.log(`== ${code} ${rec.name}`);
  console.log(`   roles: [${rec.roles}] → [${newRoles}]`);
  console.log(`   equip: [${oldEquip}] → [${newEquip}]`);
  if (diff.length) console.log(`   removed: [${diff}]`);
}
