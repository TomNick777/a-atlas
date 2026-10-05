/**
 * Card theming. "classic" is the confirmed baseline and must reproduce the old
 * plate exactly: cream gradient #f4f1ea→#d9d3c7, white edge, near-black name.
 * "sw-industry" tints that same cream with the plate's 申万一级行业 (2021 版).
 * Colors share lightness and dark text; related industries share a hue family.
 */

export type CardTheme = "classic" | "sw-industry";

export const CARD_THEMES: readonly CardTheme[] = ["classic", "sw-industry"];
export const DEFAULT_CARD_THEME: CardTheme = "sw-industry";

export const UNKNOWN_INDUSTRY = "unknown";

/** 申万一级行业（2021 版，31 类），与 data/raw/sw/level1_map.json 同源。 */
export const SW_LEVEL1: readonly string[] = [
  "农林牧渔",
  "基础化工",
  "钢铁",
  "有色金属",
  "电子",
  "汽车",
  "家用电器",
  "食品饮料",
  "纺织服饰",
  "轻工制造",
  "医药生物",
  "公用事业",
  "交通运输",
  "房地产",
  "商贸零售",
  "社会服务",
  "银行",
  "非银金融",
  "综合",
  "建筑材料",
  "建筑装饰",
  "电力设备",
  "机械设备",
  "国防军工",
  "计算机",
  "传媒",
  "通信",
  "煤炭",
  "石油石化",
  "环保",
  "美容护理",
];

export type PlateTint = {
  top: string;
  bottom: string;
  /** Third-tier label color for the industry line on enlarged plates. */
  industry: string;
};

/** The baseline. No sw-industry value may drift from this. */
export const CLASSIC_TINT: PlateTint = {
  top: "#f4f1ea",
  bottom: "#d9d3c7",
  industry: "rgba(28, 31, 24, 0.52)",
};

const ink = "rgba(28, 31, 24, 0.52)";

/**
 * 申万一级行业 → 固定色彩映射；科技蓝紫、制造蓝青、生命与环境绿、消费暖色、资源土金。
 * 保持浅色底与深色文字；未分类用中性灰，不编码行情或匹配度。
 */
export const SW_LEVEL1_COLOR_MAP: Record<string, PlateTint> = {
  农林牧渔: { top: "#dce9b6", bottom: "#b6ce83", industry: ink }, // 麦黄
  基础化工: { top: "#ead7ae", bottom: "#ceb681", industry: ink }, // 沙色
  钢铁: { top: "#d1dce1", bottom: "#a8b9c5", industry: ink }, // 冷灰
  有色金属: { top: "#f0d0ac", bottom: "#d5a57a", industry: ink }, // 淡铜
  电子: { top: "#dfd0f4", bottom: "#b8a0db", industry: ink }, // 淡紫
  汽车: { top: "#c9e0ed", bottom: "#94b8d1", industry: ink }, // 蓝灰
  家用电器: { top: "#d3e6f5", bottom: "#a6c9e4", industry: ink }, // 淡天蓝
  食品饮料: { top: "#f6deb0", bottom: "#e1bb7f", industry: ink }, // 杏色
  纺织服饰: { top: "#f1ccd5", bottom: "#d7a0b1", industry: ink }, // 淡玫瑰
  轻工制造: { top: "#ecdbc0", bottom: "#cdb58c", industry: ink }, // 米棕
  医药生物: { top: "#c6ead6", bottom: "#90c9ac", industry: ink }, // 青绿
  公用事业: { top: "#d7e7c7", bottom: "#adc68f", industry: ink }, // 灰绿
  交通运输: { top: "#cdd8ed", bottom: "#a0b1d2", industry: ink }, // 淡靛蓝
  房地产: { top: "#e9d6be", bottom: "#c8b193", industry: ink }, // 沙灰
  商贸零售: { top: "#f6d0b1", bottom: "#dfa67e", industry: ink }, // 淡橙
  社会服务: { top: "#f3dec1", bottom: "#d8b991", industry: ink }, // 淡青蓝
  银行: { top: "#ccdcea", bottom: "#9fb9d1", industry: ink }, // 冷蓝灰
  非银金融: { top: "#d2d3ea", bottom: "#aaaccf", industry: ink }, // 深一档蓝灰
  综合: { top: "#deded6", bottom: "#bebeb4", industry: ink }, // 中性灰
  建筑材料: { top: "#e8dfb8", bottom: "#c7bd8c", industry: ink }, // 石灰色
  建筑装饰: { top: "#e7cdb6", bottom: "#c9a78c", industry: ink }, // 淡棕灰
  电力设备: { top: "#c0e5df", bottom: "#8ac5b9", industry: ink }, // 淡青
  机械设备: { top: "#c3dfe4", bottom: "#8fb8c5", industry: ink }, // 钢蓝
  国防军工: { top: "#cbd9c9", bottom: "#a0b79b", industry: ink }, // 军灰蓝
  计算机: { top: "#d1d1f2", bottom: "#a6a5d8", industry: ink }, // 蓝紫
  传媒: { top: "#e8cdef", bottom: "#c59dd1", industry: ink }, // 淡粉紫
  通信: { top: "#c7dafa", bottom: "#95b5e0", industry: ink }, // 淡蓝
  煤炭: { top: "#d4d4ce", bottom: "#aeafa7", industry: ink }, // 石墨灰
  石油石化: { top: "#e9d0a9", bottom: "#c8ac7c", industry: ink }, // 暖灰褐
  环保: { top: "#cde7bf", bottom: "#9bc589", industry: ink }, // 绿色系
  美容护理: { top: "#f3cedf", bottom: "#d9a0bc", industry: ink }, // 淡粉
};

const UNKNOWN_TINT: PlateTint = { top: "#eae7e0", bottom: "#cbc7bb", industry: ink };

export function plateTint(theme: CardTheme, industry: string | undefined): PlateTint {
  if (theme === "classic") return CLASSIC_TINT;
  if (!industry || industry === UNKNOWN_INDUSTRY) return UNKNOWN_TINT;
  return SW_LEVEL1_COLOR_MAP[industry] ?? UNKNOWN_TINT;
}

/** Representative swatch for the theme-toggle chip: the 银行 tint stands in for the sw look. */
export function themePreviewTint(theme: CardTheme): PlateTint {
  return plateTint(theme, theme === "classic" ? undefined : "银行");
}

/** Cards contain only the security name and code in both themes. */
export function plateShowsIndustry(_theme: CardTheme): boolean {
  void _theme;
  return false;
}

const STORAGE_KEY = "cardTheme";

export function normalizeTheme(value: string | null | undefined): CardTheme {
  return CARD_THEMES.includes(value as CardTheme) ? value as CardTheme : DEFAULT_CARD_THEME;
}

export function loadCardTheme(): CardTheme {
  if (typeof window === "undefined") return DEFAULT_CARD_THEME;
  return normalizeTheme(window.localStorage.getItem(STORAGE_KEY) ?? new URLSearchParams(window.location.search).get("theme"));
}

/** Store + notify. The toggle goes through here so useSyncExternalStore sees it. */
const listeners = new Set<() => void>();

export function subscribeCardTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readCardTheme(): CardTheme {
  return loadCardTheme();
}

export function writeCardTheme(theme: CardTheme): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, theme);
  for (const listener of listeners) listener();
}

/** 卡面：牌堆可选 文字(简称+代码)或纯 LOGO；"brand"(LOGO+名称，正方形) 仅用于举牌。同一套存取/订阅模式。 */
export type CardFace = "text" | "logo" | "brand";
export const CARD_FACES: readonly CardFace[] = ["text", "logo"];
export const DEFAULT_CARD_FACE: CardFace = "logo";

const FACE_STORAGE_KEY = "cardFace";

export function normalizeCardFace(value: string | null | undefined): CardFace {
  return CARD_FACES.includes(value as CardFace) ? value as CardFace : DEFAULT_CARD_FACE;
}

export function loadCardFace(): CardFace {
  if (typeof window === "undefined") return DEFAULT_CARD_FACE;
  return normalizeCardFace(window.localStorage.getItem(FACE_STORAGE_KEY) ?? new URLSearchParams(window.location.search).get("face"));
}

/** Store + notify, same contract as the theme store. */
const faceListeners = new Set<() => void>();

export function subscribeCardFace(listener: () => void): () => void {
  faceListeners.add(listener);
  return () => faceListeners.delete(listener);
}

export function readCardFace(): CardFace {
  return loadCardFace();
}

export function writeCardFace(face: CardFace): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FACE_STORAGE_KEY, face);
  for (const listener of faceListeners) listener();
}
