"use client";

import { useEffect, useRef, useState } from "react";
import { CARD_FACES, CARD_THEMES, plateTint, type CardFace, type CardTheme } from "./floor/theme";

const FACE_LABEL: Record<CardFace, string> = {
  text: "文字卡",
  logo: "LOGO 卡",
  brand: "举牌卡",
};

const FACE_HINT: Record<CardFace, string> = {
  text: "股票简称与代码",
  logo: "正方形，只有公司标志",
  brand: "举牌专用，标志加公司名称",
};

const THEME_LABEL: Record<CardTheme, string> = {
  classic: "经典米白",
  "sw-industry": "申万行业",
};

const THEME_HINT: Record<CardTheme, string> = {
  classic: "温润米白，清晰的简称与代码",
  "sw-industry": "同一申万一级行业，使用固定配色",
};

/**
 * The one preferences surface, modeled on the Next dev-tools popover: a corner
 * badge opens a light card of rows, label on the left and value on the right,
 * with a chevron expanding the group. Deliberately short — the pile is the
 * product, not a dashboard.
 */
export function SettingsPanel({
  theme,
  onSelectTheme,
  face,
  onSelectFace,
}: {
  theme: CardTheme;
  onSelectTheme: (theme: CardTheme) => void;
  face: CardFace;
  onSelectFace: (face: CardFace) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [faceExpanded, setFaceExpanded] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点外面或 Esc 收起。Esc 监听在 window 上，但输入框里的 Escape 不冒泡到这里。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="pointer-events-auto absolute bottom-3 left-3">
      {open && (
        <div
          role="dialog"
          aria-label="设置"
          className="absolute bottom-full mb-2 max-h-[calc(100dvh-72px)] w-[min(300px,calc(100vw-24px))] overflow-y-auto rounded-[10px] border border-black/10 bg-[#fbfaf7] shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
        >
          <button
            type="button"
            onClick={() => setFaceExpanded((value) => !value)}
            aria-expanded={faceExpanded}
            className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors duration-150 hover:bg-black/[0.04]"
          >
            <span className="text-[13px] font-medium text-[#1c1f18]">牌堆卡面</span>
            <span className="flex items-center gap-1.5 text-[12px] text-[#8d887c]">
              {FACE_LABEL[face]}
              <Chevron expanded={faceExpanded} />
            </span>
          </button>
          {faceExpanded && (
            <div className="border-t border-black/5">
              {CARD_FACES.map((option) => {
                const active = option === face;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onSelectFace(option)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-black/[0.04] ${
                      active ? "bg-black/[0.02]" : ""
                    }`}
                  >
                    <span aria-hidden className="grid size-3 shrink-0 place-items-center rounded-[2px] border border-black/10 bg-[#f4f1ea]">
                      {option === "text" ? (
                        <span className="block h-[3px] w-[7px] rounded-[1px] bg-[#1c1f18]/70" />
                      ) : option === "logo" ? (
                        <span className="block size-[7px] rounded-full bg-[#5f7d61]" />
                      ) : (
                        <span className="grid gap-[1px]">
                          <span className="mx-auto block size-[4px] rounded-full bg-[#5f7d61]" />
                          <span className="block h-[2px] w-[7px] rounded-[1px] bg-[#1c1f18]/60" />
                        </span>
                      )}
                    </span>
                    <span className="flex-1">
                      <span className="block text-[12px] leading-4 text-[#1c1f18]">{FACE_LABEL[option]}</span>
                      <span className="block text-[10.5px] leading-4 text-[#8d887c]">{FACE_HINT[option]}</span>
                    </span>
                    {active && (
                      <span aria-hidden className="text-[12px] text-[#5f7d61]">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors duration-150 hover:bg-black/[0.04]"
          >
            <span className="text-[13px] font-medium text-[#1c1f18]">卡片配色</span>
            <span className="flex items-center gap-1.5 text-[12px] text-[#8d887c]">
              {THEME_LABEL[theme]}
              <Chevron expanded={expanded} />
            </span>
          </button>
          {expanded && (
            <div className="border-t border-black/5">
              {CARD_THEMES.map((option) => {
                const active = option === theme;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onSelectTheme(option)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-black/[0.04] ${
                      active ? "bg-black/[0.02]" : ""
                    }`}
                  >
                    <span aria-hidden className="grid shrink-0 grid-cols-2 gap-0.5">
                      {["电子", "医药生物", "食品饮料", "汽车"].map(industry => {
                        const tint = plateTint(option, industry);
                        return <span key={industry} className="size-3 rounded-[2px] border border-black/10" style={{ background: `linear-gradient(${tint.top}, ${tint.bottom})` }} />;
                      })}
                    </span>
                    <span className="flex-1">
                      <span className="block text-[12px] leading-4 text-[#1c1f18]">{THEME_LABEL[option]}</span>
                      <span className="block text-[10.5px] leading-4 text-[#8d887c]">{THEME_HINT[option]}</span>
                    </span>
                    {active && (
                      <span aria-hidden className="text-[12px] text-[#5f7d61]">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
              <p className="border-t border-black/5 px-3 py-2 text-[10.5px] leading-5 text-[#686b61]">
                彩色主题均按申万行业固定映射。<br />
                同类同色，未分类保持中性灰。
              </p>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="设置"
        title="设置"
        className="grid size-9 place-items-center rounded-[8px] border border-white/15 bg-[#12140f]/85 text-[#f4f1ea] transition-colors duration-300 hover:border-white/35"
      >
        <GearIcon />
      </button>
    </div>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className={`size-3 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M4 2.5 7.5 6 4 9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="2.4" />
      <path
        d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
