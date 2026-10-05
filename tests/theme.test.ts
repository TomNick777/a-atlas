import { describe, expect, it } from "vitest";
import {
  CLASSIC_TINT,
  CARD_THEMES,
  DEFAULT_CARD_THEME,
  normalizeTheme,
  plateShowsIndustry,
  plateTint,
  SW_LEVEL1,
  SW_LEVEL1_COLOR_MAP,
  themePreviewTint,
  UNKNOWN_INDUSTRY,
} from "../components/floor/theme";
import { boardOf, exchangeOf } from "../lib/profile";

describe("sw theme", () => {
  it("has one tint per level-1 industry, 2021 edition", () => {
    expect(SW_LEVEL1).toHaveLength(31);
    for (const name of SW_LEVEL1) expect(SW_LEVEL1_COLOR_MAP[name]).toBeDefined();
    expect(Object.keys(SW_LEVEL1_COLOR_MAP)).toHaveLength(31);
  });

  it("keeps colored card backgrounds readable with dark code text", () => {
    for (const tint of CARD_THEMES.flatMap(theme => [...SW_LEVEL1, UNKNOWN_INDUSTRY].map(industry => plateTint(theme, industry)))) {
      for (const hex of [tint.top, tint.bottom]) {
        const value = hex.replace("#", "");
        const [r, g, b] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
        const linear = [r, g, b].map(v => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
        const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        // #363a30 is the code color; even the darkest gradient end must pass AA.
        const ink = [54, 58, 48].map(v => ((v / 255 + 0.055) / 1.055) ** 2.4);
        const inkLuminance = ink[0] * 0.2126 + ink[1] * 0.7152 + ink[2] * 0.0722;
        expect((luminance + 0.05) / (inkLuminance + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("reproduces the classic baseline exactly", () => {
    expect(plateTint("classic", "电子")).toEqual(CLASSIC_TINT);
    expect(plateTint("classic", UNKNOWN_INDUSTRY)).toEqual(CLASSIC_TINT);
    expect(plateTint("classic", undefined).top).toBe("#f4f1ea");
    expect(plateTint("classic", undefined).bottom).toBe("#d9d3c7");
    expect(DEFAULT_CARD_THEME).toBe("sw-industry");
  });

  it("falls back to a quiet neutral for unknown and only shows industry in sw theme", () => {
    const unknown = plateTint("sw-industry", "unknown");
    expect(unknown.top).not.toBe(CLASSIC_TINT.top);
    expect(unknown.top).toBe(plateTint("sw-industry", "不存在的行业").top);
    expect(plateShowsIndustry("classic")).toBe(false);
    expect(plateShowsIndustry("sw-industry")).toBe(false);
    expect(themePreviewTint("classic").top).toBe(CLASSIC_TINT.top);
  });

  it("normalizes stored theme values", () => {
    for (const theme of CARD_THEMES) expect(normalizeTheme(theme)).toBe(theme);
    expect(normalizeTheme("sw-industry")).toBe("sw-industry");
    expect(normalizeTheme("classic")).toBe("classic");
    expect(normalizeTheme("neon")).toBe("sw-industry");
    expect(normalizeTheme("aurora")).toBe("sw-industry");
    expect(normalizeTheme(null)).toBe("sw-industry");
  });
});

describe("boards", () => {
  it("reads every listing board, including the 920 Beijing range", () => {
    expect(exchangeOf("920000")).toBe("BJ");
    expect(boardOf("920000")).toBe("北交所");
    expect(exchangeOf("430047")).toBe("BJ");
    expect(exchangeOf("600519")).toBe("SH");
    expect(boardOf("688981")).toBe("科创板");
    expect(boardOf("689009")).toBe("科创板");
    expect(boardOf("302132")).toBe("创业板");
    expect(boardOf("000001")).toBe("主板");
    expect(boardOf("603650")).toBe("主板");
  });
});
