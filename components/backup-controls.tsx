"use client";
import { translate as t, getLocale } from "@/lib/i18n";
import { useI18n } from "./language-picker";
import { loadExampleMedia } from "@/lib/example-media";

import { useRef, useState } from "react";
import { Download, FileArchive, LoaderCircle, RotateCcw, Upload } from "lucide-react";
import { demoLibrary, STORAGE_KEY, type Library } from "@/lib/ideas";
import { createLibraryBackup, readLibraryBackup, restoreLibraryBackup, type LibraryBackup } from "@/lib/library-backup";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? t("{0} КБ", { 0: (bytes / 1024).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) }) : t("{0} МБ", { 0: (bytes / (1024 * 1024)).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) });

export function BackupControls({ scope, library, locked, readOnly, onBusyChange, onRestored }: { scope?: string; library: Library; locked: boolean; readOnly: boolean; onBusyChange: (busy: boolean) => void; onRestored: (library: Library) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<LibraryBackup | null>(null);
  const [examplePreview, setExamplePreview] = useState(false);
  const active = useRef(false);
  const previewBase = useRef<Library | null>(null);
  function begin(message: string) { if (active.current || locked) return false; active.current = true; setBusy(true); onBusyChange(true); setStatus(message); setError(""); return true; }
  function finish() { active.current = false; setBusy(false); onBusyChange(false); }
  async function exportZip() {
    if (readOnly || !begin(t("Собираем библиотеку и медиа в архив…"))) return;
    try {
      const blob = await createLibraryBackup(library,scope), now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
      download(blob, `idea-bank-${stamp}.zip`); setStatus(t("Архив подготовлен и передан браузеру для скачивания."));
    } catch (reason) { setStatus(""); setError(reason instanceof Error ? reason.message : t("Не удалось создать архив.")); }
    finally { finish(); }
  }
  async function inspect(file: File) {
    if (!begin(t("Проверяем библиотеку, медиа и целостность архива…"))) return;
    setPreview(null);
    previewBase.current = structuredClone(library);
    setExamplePreview(false);
    try { setPreview(await readLibraryBackup(file)); setStatus(t("Архив проверен. Текущая библиотека пока не изменена.")); }
    catch (reason) { setStatus(""); setError(reason instanceof Error ? reason.message : t("Не удалось прочитать архив.")); }
    finally { finish(); }
  }
  async function restore() {
    if (!preview || !begin(t("Восстанавливаем библиотеку и медиа…"))) return;
    try { const next = await restoreLibraryBackup(preview, previewBase.current || library); onRestored(next); }
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
      previewBase.current = structuredClone(library);
      const files = await loadExampleMedia();
      setPreview({ library: structuredClone(demoLibrary), files, createdAt: demoLibrary.projects[0].updatedAt, totalBytes: new TextEncoder().encode(JSON.stringify(demoLibrary)).length + [...files.values()].reduce((sum, file) => sum + file.size, 0) });
      setExamplePreview(true); setError(""); setStatus(t("Пример подготовлен. Текущая библиотека пока не изменена."));
    } catch { setPreview(null); setError(t("Не удалось загрузить медиа Example. Проверь соединение и попробуй ещё раз.")); }
    finally { finish(); }
  }
  return <section className="backup-controls" aria-labelledby="backup-title" aria-busy={busy}>
    <h3 id="backup-title">{t("Резервная копия")}</h3>
    <p>{t("ZIP содержит разделы, идеи, настройки блоков, обложки и все медиа. Поддерживается до 512 МБ данных на архив.")}</p>
    {locked && <p className="backup-warning">{t("Сначала сохрани или отмени редактирование идеи, затем открой резервные копии.")}</p>}
    {readOnly && <p className="backup-warning">{t("Текущую библиотеку не удалось прочитать. Перед заменой можно ")}<button type="button" className="inline-backup-button" disabled={busy || locked} onClick={exportOriginal}>{t("скачать исходные данные")}</button>.</p>}
    <div className="backup-buttons">
      <button type="button" className="secondary-button" disabled={busy || locked || readOnly} onClick={() => { void exportZip(); }}><Download />{t("Экспортировать ZIP")}</button>
      <label className={`secondary-button backup-upload ${busy || locked ? "is-disabled" : ""}`}><Upload />{t("Импортировать ZIP")}<input type="file" accept=".zip,application/zip,application/x-zip-compressed" aria-label={t("Выбрать архив библиотеки")} disabled={busy || locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void inspect(file); }} /></label>
    </div>
    <button type="button" className="secondary-button example-reset" disabled={busy || locked} onClick={previewExample}><RotateCcw />{t("Загрузить Example")}</button>
    {status && <p className="backup-status" role="status">{busy && <LoaderCircle />}{t(status)}</p>}
    {error && <p className="backup-error" role="alert">{t(error)}</p>}
    {preview && <div className="backup-preview">
      <h3><FileArchive />{examplePreview ? t("Пример Example") : t("Библиотека из архива")}</h3>
      <dl><div><dt>{t("Разделов")}</dt><dd>{preview.library.sections.length}</dd></div><div><dt>{t("Идей")}</dt><dd>{preview.library.projects.length}</dd></div><div><dt>{t("Медиафайлов")}</dt><dd>{preview.files.size}</dd></div><div><dt>{t("Объём данных")}</dt><dd>{sizeLabel(preview.totalBytes)}</dd></div></dl>
      {!examplePreview && <p>{t("Создан: ")}{new Date(preview.createdAt).toLocaleString(getLocale())}</p>}
      <p className="backup-warning">{t("Восстановление заменит текущую библиотеку (")}{library.sections.length} {t(" разделов, ")}{library.projects.length} {t(" идей) и её вложения. Если она нужна, сначала экспортируй её в ZIP.")}</p>
      <div className="backup-buttons"><button type="button" className="secondary-button" disabled={busy} onClick={() => { setPreview(null); setStatus(""); setError(""); }}>{examplePreview ? t("Отмена") : t("Отмена импорта")}</button><button type="button" className="primary-button" disabled={busy || locked} onClick={() => { void restore(); }}>{t("Заменить библиотеку")}</button></div>
    </div>}
  </section>;
}
