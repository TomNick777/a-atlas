import { readFileSync } from "node:fs";
const v3 = JSON.parse(readFileSync("data/enrichment/semiconductor/enrichment.json", "utf8")).records;
const v2 = JSON.parse(readFileSync("data/eval/snapshot_stage3_1/enrichment/enrichment.json", "utf8")).records;
const show = (r: any) => ({
  equip: r.equipmentTypes.map((e: any) => e.type).join(",") || "-",
  mat: r.materialTypes.map((e: any) => e.type).join(",") || "-",
  comp: r.componentTypes.map((e: any) => e.type).join(",") || "-",
  labels: r.retrievalLabels.join("/") || "-",
  expo: [...new Set(r.processCapabilities.flatMap((c: any) => c.processExposure ?? []))].join("/") || "-",
});
for (const code of ["688361", "688809", "688371", "688012", "002371", "688072", "688082", "300666", "301611", "002409", "688019", "300316", "300724", "688147"]) {
  const a = v2.find((r: any) => r.code === code);
  const b = v3.find((r: any) => r.code === code);
  if (!a || !b) { console.log(code, "MISSING"); continue; }
  console.log(`== ${b.name} ${code}`);
  console.log("  3.1:", JSON.stringify(show(a)));
  console.log("  3.2:", JSON.stringify(show(b)));
}
