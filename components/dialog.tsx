"use client";
import { useI18n } from "./language-picker";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({ title, children, onClose, closeDisabled = false, closeOnBackdrop = true }: { title: string; children: ReactNode; onClose: () => void; closeDisabled?: boolean; closeOnBackdrop?: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onCancel={e => { e.preventDefault(); if(!closeDisabled)onClose(); }} onClick={e => { if (e.target === e.currentTarget && closeOnBackdrop && !closeDisabled) onClose(); }}>
      <div className="dialog-header"><h2 id="dialog-title">{title}</h2><button type="button" className="icon-button" aria-label={t("Закрыть")} disabled={closeDisabled} onClick={onClose}><X /></button></div>
      {children}
    </dialog>
  );
}
