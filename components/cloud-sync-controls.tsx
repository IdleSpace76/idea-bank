"use client";

import { useEffect, useRef, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { inspectCloud, uploadCloud, downloadCloud, type SyncPlan } from "@/lib/cloud-sync";
import type { CloudSnapshot } from "@/lib/cloud-library";
import type { Library } from "@/lib/ideas";
import { readCloudState } from "@/lib/cloud-state";

export function CloudSyncControls({ scope, library, locked, readOnly, onBusyChange, onDownloaded }: { scope: string; library: Library; locked: boolean; readOnly: boolean; onBusyChange: (busy: boolean) => void; onDownloaded: (library: Library) => void }) {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [error, setError] = useState("");
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [lastSync, setLastSync] = useState("");
  const active = useRef(false);
  useEffect(() => { try { setLastSync(readCloudState(scope)?.syncedAt || ""); } catch { setError("Не удалось прочитать настройки синхронизации на устройстве."); } }, [scope, library]);
  async function run(task: () => Promise<void>) {
    if (active.current || locked || readOnly) return;
    active.current = true; setBusy(true); onBusyChange(true); setError("");
    try { await task(); }
    catch (reason) { setStatus(""); setPlan(null); setError(reason instanceof Error ? reason.message : "Не удалось выполнить синхронизацию. Локальная копия сохранена."); }
    finally { active.current = false; setBusy(false); onBusyChange(false); }
  }
  async function send(local: SyncPlan) {
    const state = await uploadCloud(local, setStatus); setLastSync(state.syncedAt); setPlan(null); setStatus("Локальная библиотека и медиа сохранены в облаке.");
  }
  async function receive(local: SyncPlan, snapshot: CloudSnapshot) {
    const result = await downloadCloud(local, snapshot, setStatus);
    onDownloaded(result.library); setLastSync(result.state.syncedAt); setPlan(null); setStatus("Облачная библиотека и все медиа сохранены на этом устройстве.");
  }
  function synchronize() {
    void run(async () => {
      setPlan(null); setStatus("Проверяем локальную и облачную версии…");
      const next = await inspectCloud(scope, library);
      if (next.action === "equal") { setStatus("Библиотека уже синхронизирована. Новых изменений нет."); return; }
      if (next.action === "upload") { await send(next); return; }
      if (next.action === "download") { await receive(next, next.snapshots[0]); return; }
      setPlan(next); setStatus(next.state ? "Есть разные изменения. Выбери библиотеку, которую нужно использовать." : "Первое подключение этого устройства. Выбери направление переноса.");
    });
  }
  const disabled = busy || locked || readOnly;
  return <section className="backup-controls cloud-sync-controls" aria-label="Облачная синхронизация"><h3><Cloud />Синхронизация с облаком</h3>
    <p>Нажми кнопку после сохранения правок. Тексты и медиа хранятся вместе в закрытом B2; локальная копия доступна без сети. На другом устройстве войди в эту же копию приложения и нажми синхронизацию.</p>
    {lastSync && <p>Последняя синхронизация: {new Date(lastSync).toLocaleString("ru")}.</p>}
    {(locked && !busy) && <p className="backup-warning">Сначала сохрани или отмени редактирование и дождись завершения других операций.</p>}
    {readOnly && <p className="backup-warning">Сначала восстанови корректную локальную библиотеку из резервной копии.</p>}
    <div className="backup-buttons"><button type="button" className="primary-button" disabled={disabled} onClick={synchronize}><RefreshCw className={busy ? "sync-spinning" : ""} />{busy ? "Синхронизация…" : plan ? "Проверить ещё раз" : "Синхронизировать"}</button></div>
    {status && <p className="backup-status" role="status">{status}</p>}{error && <p className="backup-error" role="alert">{error}</p>}
    {plan && <div className="backup-preview cloud-sync-review"><h4>На этом устройстве</h4><p>Идей: {plan.library.projects.length}. Разделов: {plan.library.sections.length}.</p><p>{plan.library.projects.slice(0, 3).map(idea => idea.name).join(", ") || "Библиотека пуста"}</p><button type="button" className="secondary-button" disabled={disabled} onClick={() => {
      if (plan.heads.length && !window.confirm("Использовать локальную библиотеку как новую облачную версию? Прежние облачные версии останутся в истории.")) return;
      void run(() => send(plan));
    }}>Сохранить локальную в облаке</button>
      {plan.snapshots.length === 0 && <p>Облако пока пустое. Отправь в него библиотеку с этого устройства.</p>}
      {plan.snapshots.map(snapshot => <div className="cloud-version" key={snapshot.revision}><h4>В облаке · {new Date(snapshot.createdAt).toLocaleString("ru")}</h4><p>Идей: {snapshot.library.projects.length}. Разделов: {snapshot.library.sections.length}.</p><p>{snapshot.library.projects.slice(0, 3).map(idea => idea.name).join(", ") || "Библиотека пуста"}</p><small>Версия {snapshot.revision.slice(0, 8)}</small><button type="button" className="secondary-button" disabled={disabled} onClick={() => {
        if (plan.expectedRaw !== null && !window.confirm("Заменить библиотеку на этом устройстве выбранной облачной версией? Перед заменой можно экспортировать локальную ZIP-копию.")) return;
        void run(() => receive(plan, snapshot));
      }}>Загрузить облачную на устройство</button></div>)}
      {plan.heads.length > 1 && <p>Найдены одновременные изменения. Выбранная библиотека станет общей версией; остальные версии сохранятся в облачной истории.</p>}
    </div>}
  </section>;
}
