"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, Cloud, CloudCheck, CloudOff, Monitor, RefreshCw } from "lucide-react";
import { syncLabel, type SyncView } from "@/lib/sync-controller";
import { useI18n } from "./language-picker";

/** Keep the active indicator visible while its original header slot scrolls above the viewport. */
export function SyncStatus({ cloud, view, warning, onClick }: { cloud: boolean; view: SyncView; warning: boolean; onClick: () => void }) {
  const { t } = useI18n();
  const anchor = useRef<HTMLSpanElement>(null);
  const [pastTop, setPastTop] = useState(false);
  useEffect(() => {
    const node = anchor.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setPastTop(entry.boundingClientRect.top < 12), { rootMargin: "-12px 0px 0px 0px", threshold: [0, 1] });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const active = cloud && view.busy;
  const floating = active && pastTop;
  return <span className="sync-status-anchor" ref={anchor}>
    <button type="button" aria-label={cloud ? `${t("Синхронизация")}: ${t(syncLabel(view.phase))}` : t("На этом устройстве")} title={cloud ? t(view.error || view.status || syncLabel(view.phase)) : t("На этом устройстве")} data-sync-phase={cloud ? view.phase : undefined} className={`local-status ${warning ? "has-warning" : ""} ${floating ? "is-floating" : ""}`} onClick={onClick}>
      {active ? <RefreshCw className="sync-spinning" /> : warning ? <CircleAlert /> : cloud ? view.phase === "synced" ? <CloudCheck /> : view.phase === "offline" ? <CloudOff /> : <Cloud /> : <Monitor />}
      <span>{cloud ? t(syncLabel(view.phase)) : t("На этом устройстве")}</span>
    </button>
  </span>;
}
