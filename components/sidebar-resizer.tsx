"use client";

import { useEffect, useRef } from "react";

export function SidebarResizer({ width, onChange, onCommit, onReset }: { width: number | null; onChange: (width: number) => void; onCommit: (width: number) => void; onReset: () => void }) {
  const active = useRef(false);
  const lastWidth = useRef(width || 242);
  useEffect(() => () => { document.body.classList.remove("is-sidebar-resizing"); }, []);
  const limit = (value: number) => Math.round(Math.max(220, Math.min(Math.min(520, innerWidth - 360), value)));
  function finish() {
    if (!active.current) return;
    active.current = false; document.body.classList.remove("is-sidebar-resizing"); onCommit(lastWidth.current);
  }
  return <div className="sidebar-resizer" role="separator" tabIndex={0} aria-label="Ширина боковой панели" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={520} aria-valuenow={width || 242} onDoubleClick={onReset} onPointerDown={e => {
    if (e.button !== 0) return;
    e.preventDefault(); active.current = true; e.currentTarget.setPointerCapture(e.pointerId); document.body.classList.add("is-sidebar-resizing");
    lastWidth.current = limit(e.clientX); onChange(lastWidth.current);
  }} onPointerMove={e => { if (active.current) { lastWidth.current = limit(e.clientX); onChange(lastWidth.current); } }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={e => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault(); const value = limit(e.key === "Home" ? 220 : e.key === "End" ? 520 : (width || e.currentTarget.getBoundingClientRect().right - 4) + (e.key === "ArrowRight" ? 20 : -20));
    onChange(value); onCommit(value);
  }} />;
}
