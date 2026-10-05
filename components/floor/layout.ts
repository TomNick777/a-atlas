import type { Anchor, Layout, Rest } from "./scene";

export const LABEL = 22;
const GAP = 14;
const ROW_GAP = 10;
const PAD = 16;
const LIFT = 18;
const TOP = 56;
const MIN_H = 40;

/**
 * Cells sit in a box just above the search bar. The plates are as large as they can be
 * while a row still fits. Past that, the box scrolls and half a row peeks out.
 */
export function gridLayout(count: number, anchor: Anchor, viewport: { width: number }, largest: { w: number; h: number }): Layout {
  if (count <= 0) return { rests: [], box: null, scrollMost: 0 };
  const room = {
    width: Math.min(viewport.width - 32, 1120) - PAD * 2,
    height: Math.max(80, anchor.above - LIFT - TOP - PAD * 2),
  };
  const columnsAt = (w: number) => Math.max(1, Math.floor((room.width + GAP) / (w + GAP)));
  const heightOf = (rows: number, h: number) => rows * (h + LABEL) + (rows - 1) * ROW_GAP;

  let w = largest.w;
  let h = largest.h;
  const minScale = MIN_H / largest.h;
  for (let scale = 1; scale >= minScale; scale -= 0.04) {
    const tryW = Math.round(largest.w * scale);
    const tryH = Math.round(largest.h * scale);
    if (heightOf(Math.ceil(count / columnsAt(tryW)), tryH) <= room.height) {
      w = tryW;
      h = tryH;
      break;
    }
    w = tryW;
    h = tryH;
  }

  const rows = Math.ceil(count / columnsAt(w));
  const perRow = Math.ceil(count / rows);
  const visibleRows = Math.max(1, Math.min(rows, Math.floor((room.height + ROW_GAP) / (h + LABEL + ROW_GAP))));
  const peek = rows > visibleRows ? Math.min((h + LABEL) / 2, room.height - heightOf(visibleRows, h)) : 0;
  const width = perRow * w + (perRow - 1) * GAP + PAD * 2;
  const height = heightOf(visibleRows, h) + Math.max(0, peek) + PAD * 2;
  const box = { x: anchor.x - width / 2, y: anchor.above - LIFT - height, width, height };

  const rests: Rest[] = [];
  for (let k = 0; k < count; k++) {
    const row = Math.floor(k / perRow);
    const inRow = Math.min(perRow, count - row * perRow);
    const rowWidth = inRow * w + (inRow - 1) * GAP;
    rests.push({
      x: anchor.x - rowWidth / 2 + (k - row * perRow) * (w + GAP) + w / 2,
      y: box.y + PAD + row * (h + LABEL + ROW_GAP) + LABEL + h / 2,
      w,
      h,
    });
  }
  return { rests, box, scrollMost: Math.max(0, heightOf(rows, h) + PAD * 2 - height) };
}
