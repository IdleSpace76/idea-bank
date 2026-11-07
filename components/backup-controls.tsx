"use client";
import { translate as t, getLocale } from "@/lib/i18n";
import { useI18n } from "./language-picker";
import { loadExampleMedia } from "@/lib/example-media";

import { useEffect, useRef, useState } from "react";
import { Download, Eraser, FileArchive, LoaderCircle, RotateCcw, Upload, X } from "lucide-react";
import { demoLibrary, STORAGE_KEY, type Library } from "@/lib/ideas";
import { createLibraryBackup, readLibraryBackup, restoreLibraryBackup,prepareLibraryImport,importLibraryBackup, type LibraryBackup,type LibraryImportPlan,type ImportChoice } from "@/lib/library-backup";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? t("{0} КБ", { 0: (bytes / 1024).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) }) : t("{0} МБ", { 0: (bytes / (1024 * 1024)).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) });

async function prepareExampleBackup(): Promise<LibraryBackup> {
  const files = await loadExampleMedia().catch(() => { throw new Error(t("Не удалось загрузить медиа Example. Проверь соединение и попробуй ещё раз.")); });
  return { library: structuredClone(demoLibrary), files, createdAt: demoLibrary.projects[0].updatedAt, totalBytes: new TextEncoder().encode(JSON.stringify(demoLibrary)).length + [...files.values()].reduce((sum, file) => sum + file.size, 0) };
}

export function BackupControls({ scope, library, locked, readOnly, onBusyChange, onRestored, loadLibrary }: { scope?: string; library: Library; locked: boolean; readOnly: boolean; onBusyChange: (busy: boolean) => void; onRestored: (library: Library) => void; loadLibrary?: () => Promise<Library> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<LibraryBackup | null>(null);
  const [importPlan,setImportPlan]=useState<LibraryImportPlan|null>(null);
  const [choices,setChoices]=useState<Record<string,ImportChoice>>({});
  const [examplePreview, setExamplePreview] = useState(false);
  const [resetRequested, setResetRequested] = useState(false);
  const resetDialog = useRef<HTMLDialogElement>(null);
  const resetCancel = useRef<HTMLButtonElement>(null);
  const resetBase = useRef<Library | null>(null);
  const active = useRef(false);
  const previewBase = useRef<Library | null>(null);
  useEffect(() => {
    if (!resetRequested) return;
    const dialog = resetDialog.current;
    dialog?.showModal(); resetCancel.current?.focus();
    return () => dialog?.close();
  }, [resetRequested]);
  function closeReset() { resetDialog.current?.close(); setResetRequested(false); resetBase.current = null; }
  function begin(message: string) { if (active.current || locked) return false; active.current = true; setBusy(true); onBusyChange(true); setStatus(message); setError(""); return true; }
  function finish() { active.current = false; setBusy(false); onBusyChange(false); }
  async function exportZip() {
    if (readOnly || !begin(t("Собираем библиотеку и медиа в архив…"))) return;
    try {
      const source=loadLibrary?await loadLibrary():library;
      const blob = await createLibraryBackup(source,scope), now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
      download(blob, `idea-bank-${stamp}.zip`); setStatus(t("Архив подготовлен и передан браузеру для скачивания."));
    } catch (reason) { setStatus(""); setError(reason instanceof Error ? reason.message : t("Не удалось создать архив.")); }
    finally { finish(); }
  }
  async function inspect(file: File) {
    if (!begin(t("Проверяем библиотеку, медиа и целостность архива…"))) return;
    setPreview(null);
    setImportPlan(null);setChoices({});
    setExamplePreview(false);
    try { previewBase.current=structuredClone(loadLibrary?await loadLibrary():library);const backup=await readLibraryBackup(file);const plan=await prepareLibraryImport(backup,previewBase.current,scope);setPreview(backup);setImportPlan(plan); setStatus(t("Архив проверен. Текущая библиотека пока не изменена.")); }
    catch (reason) { setStatus(""); setError(reason instanceof Error ? reason.message : t("Не удалось прочитать архив.")); }
    finally { finish(); }
  }
  async function restore() {
    if (!importPlan || !begin(t("Объединяем идеи и медиа…"))) return;
    try { const next = await importLibraryBackup(importPlan,choices); onRestored(next); }
    catch (reason) { setStatus(""); setError(reason instanceof Error ? reason.message : t("Не удалось восстановить библиотеку.")); }
    finally { finish(); }
  }
  function exportOriginal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) throw new Error(t("В браузере нет исходных сохранённых данных."));
      download(new Blob([raw], { type: "application/json" }), "idea-bank-original-data.json");
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("Не удалось скачать исходные данные.")); }
  }
  async function previewExample() {
    if (!begin(t("Подготавливаем медиа…"))) return;
    try {
      previewBase.current = structuredClone(loadLibrary?await loadLibrary():library);
      const backup=await prepareExampleBackup();setImportPlan(await prepareLibraryImport(backup,previewBase.current,scope));setChoices({});setPreview(backup);
      setExamplePreview(true); setError(""); setStatus(t("Пример подготовлен. Текущая библиотека пока не изменена."));
    } catch { setPreview(null); setError(t("Не удалось загрузить медиа Example. Проверь соединение и попробуй ещё раз.")); }
    finally { finish(); }
  }
  async function requestReset() {
    if (!loadLibrary) { resetBase.current=structuredClone(library);setResetRequested(true);return; }
    if (!begin(t("Подготавливаем медиа…"))) return;
    try { resetBase.current=structuredClone(await loadLibrary());setResetRequested(true); }
    catch(reason) { setError(reason instanceof Error?reason.message:String(reason)); }
    finally { finish(); }
  }
  /** Clearing is the only backup action that removes every idea and section. */
  async function resetLibrary() {
    if (readOnly || !resetBase.current || !begin(t("Очищаем библиотеку…"))) return;
    const base = resetBase.current;
    closeReset(); setPreview(null); setImportPlan(null);setExamplePreview(false);
    try { const next = await restoreLibraryBackup({library:{version:1,sections:[],projects:[]},files:new Map(),createdAt:new Date().toISOString(),totalBytes:0},base); onRestored(next); }
    catch (reason) { setStatus(""); setError(reason instanceof Error ? reason.message : t("Не удалось очистить рабочее пространство. Прежняя библиотека сохранена.")); }
    finally { finish(); }
  }
  return <section className="backup-controls" aria-labelledby="backup-title" aria-busy={busy}>
    <h3 id="backup-title">{t("Резервная копия")}</h3>
    <p>{t("ZIP содержит разделы, идеи, настройки блоков, обложки и все медиа. Поддерживается до 512 МБ данных на архив.")}</p>
    {locked && <p className="backup-warning">{t("Сначала сохрани или отмени редактирование идеи, затем открой резервные копии.")}</p>}
    {readOnly && <p className="backup-warning">{t("Текущую библиотеку не удалось прочитать. Можно ")}<button type="button" className="inline-backup-button" disabled={busy || locked} onClick={exportOriginal}>{t("скачать исходные данные")}</button>.</p>}
    <div className="backup-buttons">
      <button type="button" className="secondary-button" disabled={busy || locked || readOnly} onClick={() => { void exportZip(); }}><Download />{t("Экспортировать ZIP")}</button>
      <label className={`secondary-button backup-upload ${busy || locked ? "is-disabled" : ""}`}><Upload />{t("Импортировать ZIP")}<input type="file" accept=".zip,application/zip,application/x-zip-compressed" aria-label={t("Выбрать архив библиотеки")} disabled={busy || locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void inspect(file); }} /></label>
    </div>
    <div className="backup-buttons backup-reset-buttons">
      <button type="button" className="secondary-button" disabled={busy || locked} onClick={previewExample}><RotateCcw />{t("Загрузить Example")}</button>
      <button type="button" className="secondary-button danger" disabled={busy || locked || readOnly} onClick={() => { void requestReset(); }}><Eraser />{t("Очистить голову")}</button>
    </div>
    {resetRequested && <dialog ref={resetDialog} className="dialog reset-confirmation" aria-labelledby="reset-library-title" aria-describedby="reset-library-warning" onCancel={event => { event.preventDefault(); event.stopPropagation(); closeReset(); }} onClick={event => { if (event.target === event.currentTarget) closeReset(); }}>
      <div className="dialog-header"><h2 id="reset-library-title">{t("Очистить голову?")}</h2><button type="button" className="icon-button" aria-label={t("Закрыть")} onClick={closeReset}><X /></button></div>
      <p id="reset-library-warning">{t("Внимание! Это действие удалит все идеи и разделы, включая Example. Библиотека станет пустой. Перед очисткой можно экспортировать ZIP-копию.")}</p>
      {scope && <p>{t("Если подключено облако, сброс будет синхронизирован с другими устройствами.")}</p>}
      <div className="form-actions"><button type="button" className="secondary-button" ref={resetCancel} onClick={closeReset}>{t("Отмена")}</button><button type="button" className="primary-button reset-library-confirm" disabled={busy || locked || readOnly} onClick={() => { void resetLibrary(); }}>{t("Очистить голову")}</button></div>
    </dialog>}
    {status && <p className="backup-status" role="status">{busy && <LoaderCircle />}{t(status)}</p>}
    {error && <p className="backup-error" role="alert">{t(error)}</p>}
    {preview && <div className="backup-preview">
      <h3><FileArchive />{examplePreview ? t("Пример Example") : t("Библиотека из архива")}</h3>
      <dl><div><dt>{t("Разделов")}</dt><dd>{preview.library.sections.length}</dd></div><div><dt>{t("Идей")}</dt><dd>{preview.library.projects.length}</dd></div><div><dt>{t("Медиафайлов")}</dt><dd>{preview.files.size}</dd></div><div><dt>{t("Объём данных")}</dt><dd>{sizeLabel(preview.totalBytes)}</dd></div></dl>
      {!examplePreview && <p>{t("Создан: ")}{new Date(preview.createdAt).toLocaleString(getLocale())}</p>}
      <p>{t("Импорт добавит новые идеи и разделы. Отсутствующие в архиве идеи останутся в библиотеке. Существующие разделы сохранят свои названия и оформление.")}</p>
      {importPlan && <p className="backup-import-summary">{t("Новых идей: {0}. Уже есть: {1}. Отличаются: {2}.",{0:importPlan.added,1:importPlan.unchanged,2:importPlan.conflicts.length})}</p>}
      {importPlan?.conflicts.map(conflict=><fieldset className="backup-import-conflict" key={conflict.id} disabled={busy}>
        <legend>{t("Идея «{0}»",{0:conflict.current.name})}</legend>
        <div className="backup-import-choices" role="group" aria-label={t("Версия идеи «{0}»",{0:conflict.current.name})}>
          {([['current',t("Оставить текущую")],['archive',t("Взять из архива")],['both',t("Сохранить обе")]] as const).map(([choice,label])=><button type="button" key={choice} className="secondary-button" aria-pressed={choices[conflict.id]===choice} onClick={()=>setChoices(value=>({...value,[conflict.id]:choice}))}>{label}</button>)}
        </div>
        <details><summary>{t("Сравнить версии")}</summary><div className="backup-import-comparison">{[[t("Текущая версия"),conflict.current],[t("Версия из архива"),conflict.incoming]].map(([label,value])=>{const idea=value as Library["projects"][number];return <div key={label as string}><strong>{label as string}</strong><h4>{idea.name}</h4><p>{idea.description}</p>{idea.blocks.map(block=><div key={block.id}><h5>{block.heading}</h5><p>{block.text}</p>{block.media?.map(asset=><small key={asset.id}>{asset.name}</small>)}</div>)}</div>;})}</div></details>
      </fieldset>)}
      {!!importPlan?.conflicts.some(conflict=>!choices[conflict.id]) && <p className="backup-warning">{t("Выберите вариант для каждой отличающейся идеи.")}</p>}
      <div className="backup-buttons"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setPreview(null);setImportPlan(null);setChoices({}); setStatus(""); setError(""); }}>{examplePreview ? t("Отмена") : t("Отмена импорта")}</button><button type="button" className="primary-button" disabled={busy || locked || !importPlan || importPlan.conflicts.some(conflict=>!choices[conflict.id])} onClick={() => { void restore(); }}>{t("Импортировать идеи")}</button></div>
    </div>}
  </section>;
}
