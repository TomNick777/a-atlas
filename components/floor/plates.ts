import { logoFor } from "./logoCache";
import { plateShowsIndustry, plateTint, type CardFace, type CardTheme, type PlateTint } from "./theme";

const RADIUS = 0.095;

type PlateOptions = {
  theme?: CardTheme;
  industry?: string;
  /** Third line (industry name) only fits on enlarged plates. */
  showIndustry?: boolean;
  /** LOGO 卡面：图已到达则标志代替文字，未到达回退文字面。 */
  face?: CardFace;
  logo?: HTMLImageElement | null;
  /** Hero metric line (Phase 2) — the query-plan number this card leads with. */
  hero?: string | null;
  /** Level-1 evidence hint (Phase 3.4) — verbatim profile term hits behind the
   * judgement. Rides the hero slot only when there is no hero metric; dimmer
   * than the hero line (second-act information, never the lead). */
  hint?: string | null;
};

/** One company plate: short name, then the code. No logo. */
export function drawPlate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, name: string, code: string, options: PlateOptions = {}) {
  const tint: PlateTint = plateTint(options.theme ?? "classic", options.industry);
  const radius = Math.min(w, h) * RADIUS;
  const inset = Math.max(0.5, h * 0.012);
  const logoFace = options.face === "logo" || options.face === "brand";
  const logo = logoFace ? options.logo : null;

  if (logo && logo.complete && logo.naturalWidth > 0) {
    // LOGO 两面：白底代替行业色底；圆角与描边保持卡片感。
    // logo：标志整卡居中；brand：标志居上、公司名称居下，组成正方形卡。
    const white = ctx.createLinearGradient(x, y, x, y + h);
    white.addColorStop(0, "#ffffff");
    white.addColorStop(1, "#efede6");
    ctx.beginPath();
    ctx.roundRect(x + inset, y + inset, w - inset * 2, h - inset * 2, radius);
    ctx.fillStyle = white;
    ctx.fill();
    ctx.lineWidth = inset;
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.stroke();
    if (options.face === "brand") {
      // 带 hero/hint 行时标志区让出一截、名称上移，卡底留给依据行。
      const hasLine = Boolean(options.hero || options.hint);
      const regionH = h * (hasLine ? 0.6 : 0.68);
      const pad = Math.min(w, regionH) * 0.12;
      const scale = Math.min((w - pad * 2) / logo.naturalWidth, (regionH - pad * 2) / logo.naturalHeight);
      const dw = logo.naturalWidth * scale;
      const dh = logo.naturalHeight * scale;
      ctx.drawImage(logo, x + (w - dw) / 2, y + inset + (regionH - dh) / 2, dw, dh);
      ctx.fillStyle = "#1c1f18";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const nameSize = fitSize(ctx, name, w * 0.82, h * 0.2, h * 0.13);
      ctx.font = `600 ${nameSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      ctx.fillText(name, x + w / 2, y + h * (hasLine ? 0.79 : 0.845));
      if (options.hero) drawHeroLine(ctx, x, y, w, h, options.hero, "#1c1f18");
      else if (options.hint) drawHintLine(ctx, x, y, w, h, options.hint, "rgba(28,31,24,0.74)");
    } else {
      const pad = Math.min(w, h) * 0.1;
      const scale = Math.min((w - pad * 2) / logo.naturalWidth, (h - pad * 2) / logo.naturalHeight);
      const dw = logo.naturalWidth * scale;
      const dh = logo.naturalHeight * scale;
      ctx.drawImage(logo, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
    return;
  }

  const fill = ctx.createLinearGradient(x, y, x, y + h);
  fill.addColorStop(0, tint.top);
  fill.addColorStop(1, tint.bottom);
  ctx.beginPath();
  ctx.roundRect(x + inset, y + inset, w - inset * 2, h - inset * 2, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = inset;
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.stroke();

  // Inset bevel stays inside the atlas cell, so small plates keep crisp edges.
  ctx.beginPath();
  ctx.moveTo(x + radius, y + h - inset * 2);
  ctx.lineTo(x + w - radius, y + h - inset * 2);
  ctx.strokeStyle = "rgba(69,59,40,0.18)";
  ctx.stroke();

  ctx.fillStyle = "#1c1f18";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const nameSize = fitSize(ctx, name, w * 0.82, h * 0.34, h * 0.25);
  ctx.font = `600 ${nameSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx.fillText(name, x + w / 2, y + h * 0.39);
  ctx.fillStyle = "#363a30";
  const codeSize = Math.min(h * 0.22, w * 0.105);
  ctx.font = `400 ${codeSize}px ui-monospace, "Cascadia Mono", monospace`;
  ctx.fillText(code, x + w / 2, y + h * (options.hero || options.hint ? 0.66 : 0.73));
  if (options.hero) drawHeroLine(ctx, x, y, w, h, options.hero, "#363a30");
  else if (options.hint) drawHintLine(ctx, x, y, w, h, options.hint, "rgba(54,58,48,0.76)");
}

/** The hero metric line sits at the card's bottom edge, sized to fit. */
function drawHeroLine(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, hero: string, color: string) {
  ctx.fillStyle = color;
  const size = fitSize(ctx, hero, w * 0.86, h * 0.095, h * 0.055);
  ctx.font = `600 ${size}px ui-monospace, "Cascadia Mono", monospace`;
  ctx.fillText(hero, x + w / 2, y + h * 0.945);
}

/** The evidence hint line: same slot as the hero, a step down in emphasis —
 * regular weight and a dimmer ink, so judgement support never out-shouts the
 * company identity or the plan metric. */
function drawHintLine(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, hint: string, color: string) {
  ctx.fillStyle = color;
  let size = h * 0.085;
  ctx.font = `400 ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  while (size > h * 0.05 && ctx.measureText(hint).width > w * 0.86) {
    size -= 1;
    ctx.font = `400 ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  }
  ctx.fillText(hint, x + w / 2, y + h * 0.945);
}

function fitSize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, start: number, floor: number): number {
  let size = start;
  ctx.font = `600 ${size}px "Microsoft YaHei", sans-serif`;
  while (size > floor && ctx.measureText(text).width > maxWidth) {
    size -= 1;
    ctx.font = `600 ${size}px "Microsoft YaHei", sans-serif`;
  }
  return size;
}

export function renderPlate(name: string, code: string, w: number, h: number, dpr: number, options: PlateOptions = {}): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  drawPlate(ctx, 0, 0, canvas.width, canvas.height, name, code, options);
  return canvas;
}

export function bakeAtlas(
  codes: string[],
  names: string[],
  industries: string[],
  theme: CardTheme,
  plateW: number,
  plateH: number,
  dpr: number,
  face: CardFace = "text",
) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(codes.length)));
  const cellW = Math.round(plateW * dpr);
  const cellH = Math.round(plateH * dpr);
  const gutter = 2;
  const rows = Math.max(1, Math.ceil(codes.length / cols));
  const canvas = document.createElement("canvas");
  canvas.width = cols * (cellW + gutter);
  canvas.height = rows * (cellH + gutter);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { canvas, cols, cellW, cellH, gutter };
  // Pile plates stay two-line: the industry rides on the tint alone.
  const showIndustry = false;
  codes.forEach((code, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    drawPlate(ctx, col * (cellW + gutter), row * (cellH + gutter), cellW, cellH, names[index] ?? code, code, {
      theme,
      industry: industries[index],
      showIndustry,
      face,
      // LOGO 面：取已加载/在途的图；首次烤制未到达的格先落文字面，到达后单格重绘。
      logo: face === "text" ? null : logoFor(code),
    });
  });
  return { canvas, cols, cellW, cellH, gutter };
}

export { plateShowsIndustry };
