"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { isTheme, THEME_KEY, themes, type Theme } from "@/lib/themes";

export function ThemePicker() {
  const [theme, setTheme] = useState<Theme>("sage");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const saved = document.documentElement.dataset.theme;
    if (isTheme(saved)) { setTheme(saved); applyTheme(saved); }
  }, []);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) { if (!root.current?.contains(event.target as Node)) setOpen(false); }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  /** Changes the entire interface, including dialogs mounted outside the app root. */
  function applyTheme(value: Theme) {
    document.documentElement.dataset.theme = value;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themes.find(item => item.id === value)!.background);
  }
  function choose(value: Theme) {
    applyTheme(value); setTheme(value); setOpen(false); trigger.current?.focus({ preventScroll: true });
    try { localStorage.setItem(THEME_KEY, value); } catch { /* The theme remains active for this session. */ }
  }
  return <div className="theme-picker" ref={root} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="theme-trigger" aria-label="Тема оформления" title="Тема оформления" aria-expanded={open} aria-controls={open ? "theme-choices" : undefined} onClick={() => setOpen(value => !value)}><Palette /><span>Тема</span></button>
    {open && <div id="theme-choices" className="theme-choices" role="group" aria-label="Выбрать тему">
      <p>Тема оформления</p>
      {themes.map(item => <button type="button" key={item.id} aria-pressed={theme === item.id} onClick={() => choose(item.id)}><span className={`theme-swatch swatch-${item.id}`} aria-hidden="true" /><span>{item.name}</span>{theme === item.id && <Check aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}
