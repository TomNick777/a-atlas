/**
 * Phase 4 §0/§1: A-Atlas' runtime no longer has a Laya judge, and lib/jev now
 * means Jev Cloud. The Laya experiment lane (sidecar, checkpoints, training,
 * A/B arms) belongs to a-share-trawler, which still owns :8787 and models/.
 *
 * These scripts are kept here as the provenance chain behind reports/LAYA_*.md,
 * but running one in A-Atlas would now send its "Laya" arm to the cloud and
 * publish a comparison that never happened. Refuse loudly instead.
 */
export function requireLayaLane(script: string): void {
  if (process.env.ATLAS_LAYA_LANE === "1") return;
  console.error(
    [
      `${script}: retired — Laya is not part of the A-Atlas runtime.`,
      "",
      "Phase 4 起 A-Atlas 的判断只提供者为 Jev Cloud，lib/jev 打的是云端；",
      "Laya 实验道（:8787 sidecar、models/ checkpoint、训练与 A/B）归 a-share-trawler。",
      "在本仓库继续运行本脚本，会把「Laya 臂」实际打到 Jev 云上，产出一份没有发生过的对比。",
      "",
      "改到 D:\\workspace\\a-share-trawler 运行同名脚本；",
      "确实要在 A-Atlas 里跑（此时被测对象是 Jev）请显式 ATLAS_LAYA_LANE=1。",
    ].join("\n"),
  );
  process.exit(3);
}
