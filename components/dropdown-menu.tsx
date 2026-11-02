"use client";

import { useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";

type MenuItem = { label: string; icon: ReactNode; onSelect: () => void; danger?: boolean };

/** Anchors actions to their trigger, keeping the menu inside the viewport. */
export function DropdownMenu({ label, items, disabled }: { label: string; items: MenuItem[]; disabled?: boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  function close(restoreFocus = false) { setOpen(false); if (restoreFocus) trigger.current?.focus(); }

  useLayoutEffect(() => {
    if (!open) return;
    function reposition() {
      const rect = trigger.current!.getBoundingClientRect();
      const bounds = menu.current!.getBoundingClientRect();
      const top = rect.bottom + 6 + bounds.height <= innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - bounds.height - 6);
      setPosition({ top, left: Math.max(8, Math.min(rect.right - bounds.width, innerWidth - bounds.width - 8)) });
    }
    reposition();
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    function outside(e: PointerEvent) {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);
    }
    function scroll(e: Event) { if (!menu.current?.contains(e.target as Node)) reposition(); }
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", scroll, true); };
  }, [open]);

  return <><button ref={trigger} type="button" className="icon-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(value => !value)} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); } }}><Ellipsis /></button>
    {open && createPortal(<div id={id} ref={menu} className="dropdown-menu" role="menu" aria-label={label} style={position} onKeyDown={e => {
      const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>("button"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") { e.preventDefault(); close(true); }
      else if (e.key === "Tab") close();
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>{items.map(item => <button type="button" role="menuitem" key={item.label} className={item.danger ? "danger" : ""} onClick={() => { close(true); item.onSelect(); }}>{item.icon}<span>{item.label}</span></button>)}</div>, document.body)}
  </>;
}
