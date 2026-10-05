import { readFileSync, writeFileSync } from "node:fs";
const v2 = JSON.parse(readFileSync("data/eval/snapshot_stage3_1/enrichment/enrichment.json", "utf8")).records as any[];
const v3 = JSON.parse(readFileSync("data/enrichment/semiconductor/enrichment.json", "utf8")).records as any[];
const capKey = (c: any) => [c.process ?? "-", c.specificProcess ?? "-", c.equipmentType ?? "-", c.materialType ?? "-", c.componentType ?? "-", c.role].join("|");
const changed: any[] = [];
let removedTotal = 0, addedTotal = 0, reclassified = 0, exposureGained = 0;
for (const b of v3) {
  const a = v2.find((r) => r.code === b.code);
  if (!a) continue;
  const aKeys = new Map(a.processCapabilities.map((c: any) => [capKey(c), c]));
  const bKeys = new Map(b.processCapabilities.map((c: any) => [capKey(c), c]));
  const removed = [...aKeys.keys()].filter((k) => !bKeys.has(k));
  const added = [...bKeys.keys()].filter((k) => !aKeys.has(k));
  const labelsChanged = JSON.stringify(a.retrievalLabels) !== JSON.stringify(b.retrievalLabels);
  // 重分类:equipmentType 消失但同 (process,component/material) 或 probe_card 类出现
  const removedEquip = removed.map((k) => aKeys.get(k)).filter((c: any) => c.equipmentType);
  const addedComp = added.map((k) => bKeys.get(k)).filter((c: any) => c.componentType || c.materialType);
  const exposure = [...new Set(b.processCapabilities.flatMap((c: any) => c.processExposure ?? []))];
  if (removed.length || added.length || labelsChanged) {
    changed.push({ code: b.code, name: b.name, removed: removed.map((k) => { const c: any = aKeys.get(k); return [c.process, c.specificProcess, c.equipmentType, c.materialType, c.componentType].filter(Boolean).join("/"); }), added: added.map((k) => { const c: any = bKeys.get(k); return [c.process, c.specificProcess, c.equipmentType, c.materialType, c.componentType].filter(Boolean).join("/"); }), exposureAdded: exposure, labelsChanged });
    removedTotal += removed.length; addedTotal += added.length;
    if (removedEquip.length && addedComp.length) reclassified += removedEquip.length;
    if (exposure.length) exposureGained += 1;
  }
}
const summary = {
  generatedAt: new Date().toISOString(),
  derive: "s3-derive-v2 → s3-derive-v3",
  totalCompanies: v3.length,
  changedCompanies: changed.length,
  unchangedCompanies: v3.length - changed.length,
  removedCapabilities: removedTotal,
  addedCapabilities: addedTotal,
  reclassifiedToComponentMaterial: reclassified,
  companiesWithExposureAdded: exposureGained,
  changed,
};
writeFileSync("data/eval/stage3_2_derive_diff.json", JSON.stringify(summary, null, 1) + "\n");
console.log("changed:", changed.length, "/", v3.length, "removed:", removedTotal, "added:", addedTotal);
const top = changed.filter((c) => c.removed.length).sort((a, b) => b.removed.length - a.removed.length).slice(0, 20);
for (const c of top) console.log(`  ${c.name}(${c.code}) removed=[${c.removed.join("; ")}]`);
