"use client";

import { useEffect, useRef } from "react";

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
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const decay = useRef<number | null>(null);
  const lastInput = useRef(0);
  const composing = useRef(false);

  // 打字能量驱动辉光：按键同步充能，衰减交给 CSS transition。
  // 不用 rAF——嵌入视图停帧时 rAF 不跑，能量会永远写不进去。
  const charge = () => {
    const form = formRef.current;
    if (!form) return;
    const now = performance.now();
    const interval = now - lastInput.current;
    lastInput.current = now;
    form.style.setProperty("--energy", String(Math.min(1, 0.35 + 140 / Math.max(interval, 100))));
    if (decay.current !== null) window.clearTimeout(decay.current);
    decay.current = window.setTimeout(() => {
      formRef.current?.style.setProperty("--energy", "0");
      decay.current = null;
    }, 300);
  };

  useEffect(
    () => () => {
      if (decay.current !== null) window.clearTimeout(decay.current);
    },
    [],
  );

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
    <div className="composer-beam">
      <form
        ref={formRef}
        role="search"
        data-busy={busy}
        aria-busy={busy}
        className="composer"
        onSubmit={(event) => event.preventDefault()}
      >
        <span aria-hidden className="perimeter-glow" /><span aria-hidden className="perimeter-edge" />
        <span aria-hidden className="search-signal"><i /><i /><i /><i /></span>
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
          onClick={() => (busy ? onStop() : submit())}
          className="orb"
        >
          {busy ? (
            <svg className="orb-stop" aria-hidden viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" /></svg>
          ) : (
            <svg className="orb-arrow" aria-hidden viewBox="0 0 24 24" fill="none"><path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </button>
      </form>
    </div>
  );
}
