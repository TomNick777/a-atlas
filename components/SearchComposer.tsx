"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { VoiceBeam } from "voice-glow";

const ThinkingOrb = dynamic(() => import("thinking-orbs").then((module) => module.ThinkingOrb), {
  ssr: false,
});

type Props = {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onClear: () => void;
  onStop: () => void;
};

/** The bar is the only control. Enter or the orb runs a search; while busy the orb stops it. */
export function SearchComposer({ value, busy, onChange, onSubmit, onClear, onStop }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pulse = useRef({ level: 0, at: 0 });
  const composing = useRef(false);

  // The beam samples this envelope itself; elapsed time also handles suspended tabs.
  const readLevel = () => pulse.current.level * Math.exp(-(performance.now() - pulse.current.at) / 180);
  const charge = () => {
    pulse.current = { level: Math.min(1, readLevel() + 0.5), at: performance.now() };
  };

  // / 全局聚焦输入框（输入法组和文本框内不抢）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ready = value.trim().length >= 2 && !busy;

  const submit = () => {
    if (composing.current || !ready) return;
    onSubmit(value);
  };

  return (
    <VoiceBeam
      className="composer-beam"
      type="default"
      theme="dark"
      colorVariant="colorful"
      strength={0.9}
      level={readLevel}
      processing={busy}
    >
      <form
        role="search"
        data-busy={busy}
        aria-busy={busy}
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) onStop();
          else submit();
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            charge();
            onChange(event.target.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onClear();
              inputRef.current?.blur();
              return;
            }
            // isComposing 挡住输入法确认用的 Enter（Safari 结束后还会补发一次）。
            if (event.key === "Enter" && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="描述你想找的公司"
          aria-label="描述你想找的公司"
          autoComplete="off"
          spellCheck={false}
          className="search-input"
        />
        {value && (
          <button
            type="button"
            onClick={onClear}
            className="clear-search"
            aria-label="清空"
          >
            <span aria-hidden>×</span>
          </button>
        )}
        <button
          type="submit"
          aria-label={busy ? "停止搜索" : "搜索"}
          disabled={busy ? false : !ready}
          className="orb"
          title={busy ? "停止搜索" : "搜索"}
        >
          <ThinkingOrb
            state={busy ? "searching" : "breathing"}
            theme="dark"
            size={64}
            aria-hidden="true"
            style={{ width: 30, height: 30 }}
          />
          {busy && <span aria-hidden className="orb-stop" />}
        </button>
      </form>
    </VoiceBeam>
  );
}
