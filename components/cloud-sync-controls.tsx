"use client";
import { getLocale } from "@/lib/i18n";
import { useI18n } from "./language-picker";

import { useEffect, useRef, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { inspectCloud, uploadCloud, downloadCloud, type SyncPlan } from "@/lib/cloud-sync";
import type { CloudSnapshot } from "@/lib/cloud-library";
import type { Library } from "@/lib/ideas";
import { readCloudState } from "@/lib/cloud-state";

export function CloudSyncControls({ scope, library, locked, readOnly, onBusyChange, onDownloaded }: { scope: string; library: Library; locked: boolean; readOnly: boolean; onBusyChange: (busy: boolean) => void; onDownloaded: (library: Library) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [error, setError] = useState("");
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [lastSync, setLastSync] = useState("");
  const active = useRef(false);
  useEffect(() => { try { setLastSync(readCloudState(scope)?.syncedAt || ""); } catch { setError(t("Не удалось прочитать настройки синхронизации на устройстве.")); } }, [scope, library]);
  async function run(task: () => Promise<void>) {
    if (active.current || locked || readOnly) return;
    active.current = true; setBusy(true); onBusyChange(true); setError("");
    try { await task(); }
    catch (reason) { setStatus(""); setPlan(null); setError(reason instanceof Error ? reason.message : t("Не удалось выполнить синхронизацию. Локальная копия сохранена.")); }
    finally { active.current = false; setBusy(false); onBusyChange(false); }
  }
  async function send(local: SyncPlan) {
    const state = await uploadCloud(local, setStatus); setLastSync(state.syncedAt); setPlan(null); setStatus(t("Локальная библиотека и медиа сохранены в облаке."));
  }
  async function receive(local: SyncPlan, snapshot: CloudSnapshot) {
    const result = await downloadCloud(local, snapshot, setStatus);
    onDownloaded(result.library); setLastSync(result.state.syncedAt); setPlan(null); setStatus(t("Облачная библиотека и все медиа сохранены на этом устройстве."));
  }
  function synchronize() {
    void run(async () => {
      setPlan(null); setStatus(t("Проверяем локальную и облачную версии…"));
      const next = await inspectCloud(scope, library);
      if (next.action === "equal") { setStatus(t("Библиотека уже синхронизирована. Новых изменений нет.")); return; }
      if (next.action === "upload") { await send(next); return; }
      if (next.action === "download") { await receive(next, next.snapshots[0]); return; }
      setPlan(next); setStatus(next.state ? t("Есть разные изменения. Выбери библиотеку, которую нужно использовать.") : t("Первое подключение этого устройства. Выбери направление переноса."));
    });
  }
  const disabled = busy || locked || readOnly;
  return <section className="backup-controls cloud-sync-controls" aria-label={t("Облачная синхронизация")}><h3><Cloud />{t("Синхронизация с облаком")}</h3>
    <p>{t("Нажми кнопку после сохранения правок. Тексты и медиа хранятся вместе в закрытом B2; локальная копия доступна без сети. На другом устройстве войди в эту же копию приложения и нажми синхронизацию.")}</p>
    {lastSync && <p>{t("Последняя синхронизация: ")}{new Date(lastSync).toLocaleString(getLocale())}.</p>}
    {(locked && !busy) && <p className="backup-warning">{t("Сначала сохрани или отмени редактирование и дождись завершения других операций.")}</p>}
    {readOnly && <p className="backup-warning">{t("Сначала восстанови корректную локальную библиотеку из резервной копии.")}</p>}
    <div className="backup-buttons"><button type="button" className="primary-button" disabled={disabled} onClick={synchronize}><RefreshCw className={busy ? "sync-spinning" : ""} />{busy ? t("Синхронизация…") : plan ? t("Проверить ещё раз") : t("Синхронизировать")}</button></div>
    {status && <p className="backup-status" role="status">{t(status)}</p>}{error && <p className="backup-error" role="alert">{t(error)}</p>}
    {plan && <div className="backup-preview cloud-sync-review"><h4>{t("На этом устройстве")}</h4><p>{t("Идей: ")}{plan.library.projects.length}{t(". Разделов: ")}{plan.library.sections.length}.</p><p>{plan.library.projects.slice(0, 3).map(idea => idea.name).join(", ") || t("Библиотека пуста")}</p><button type="button" className="secondary-button" disabled={disabled} onClick={() => {
      if (plan.heads.length && !window.confirm(t("Использовать локальную библиотеку как новую облачную версию? Прежние облачные версии останутся в истории."))) return;
      void run(() => send(plan));
    }}>{t("Сохранить локальную в облаке")}</button>
      {plan.snapshots.length === 0 && <p>{t("Облако пока пустое. Отправь в него библиотеку с этого устройства.")}</p>}
      {plan.snapshots.map(snapshot => <div className="cloud-version" key={snapshot.revision}><h4>{t("В облаке · ")}{new Date(snapshot.createdAt).toLocaleString(getLocale())}</h4><p>{t("Идей: ")}{snapshot.library.projects.length}{t(". Разделов: ")}{snapshot.library.sections.length}.</p><p>{snapshot.library.projects.slice(0, 3).map(idea => idea.name).join(", ") || t("Библиотека пуста")}</p><small>{t("Версия ")}{snapshot.revision.slice(0, 8)}</small><button type="button" className="secondary-button" disabled={disabled} onClick={() => {
        if (plan.expectedRaw !== null && !window.confirm(t("Заменить библиотеку на этом устройстве выбранной облачной версией? Перед заменой можно экспортировать локальную ZIP-копию."))) return;
        void run(() => receive(plan, snapshot));
      }}>{t("Загрузить облачную на устройство")}</button></div>)}
      {plan.heads.length > 1 && <p>{t("Найдены одновременные изменения. Выбранная библиотека станет общей версией; остальные версии сохранятся в облачной истории.")}</p>}
    </div>}
  </section>;
}
