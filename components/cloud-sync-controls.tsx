"use client";
import { getLocale } from "@/lib/i18n";
import { useI18n } from "./language-picker";
import { useEffect, useState } from "react";
import { Check, Circle, Cloud, RefreshCw } from "lucide-react";
import { resolvePlan, conflictLabel, type SyncChoices } from "@/lib/entity-client";
import { type SyncController, type SyncView, syncLabel } from "@/lib/sync-controller";
import { loginWithGitHub } from "@/app/auth-actions";
import { type EntityValue } from "@/lib/entity-sync";
import { coverNames, type Library, type TextBlock } from "@/lib/ideas";
import { FormattedText } from "./formatted-text";

export function CloudSyncControls({ controller, view, library, locked, readOnly }: { controller: SyncController; view: SyncView; library: Library; locked: boolean; readOnly: boolean }) {
  const { t } = useI18n();
  const { busy,status,error,lastSync,plan }=view;
  const [choices,setChoices]=useState<SyncChoices>({});
  useEffect(()=>{setChoices({});},[plan]);
  const migrationRequired=view.phase==="migration";
  function synchronize(){void controller.check(migrationRequired);}
  const disabled = busy || locked || readOnly;
  function preview(value: EntityValue | null) { if (!value) return t("Удалено"); const v = value as { name?: string; heading?: string; text?: string; description?:string }; return [v.text || v.name || v.heading || t("Запись"),v.description].filter(Boolean).join(" · ").slice(0,240); }
  return <section className="backup-controls cloud-sync-controls" aria-label={t("Облачная синхронизация")}>
    <h3><Cloud />{t("Синхронизация с облаком")}</h3>
    <p>{t("Изменения синхронизируются автоматически, пока приложение открыто. При конфликте выберите нужную версию.")}</p>
    <p className="sync-phase">{t(syncLabel(view.phase))}</p>
    {view.phase==="auth" && <form action={loginWithGitHub}><button className="primary-button" type="submit">{t("Войти снова")}</button></form>}
    {lastSync && <p>{t("Последняя синхронизация: ")}{new Date(lastSync).toLocaleString(getLocale())}.</p>}
    {(locked && !busy) && <p className="backup-warning">{t("Сначала сохрани или отмени редактирование и дождись завершения других операций.")}</p>}
    <div className="backup-buttons"><button type="button" className="primary-button" disabled={disabled} onClick={synchronize}><RefreshCw className={busy ? "sync-spinning" : ""} />{busy ? t("Синхронизация…") : migrationRequired ? t("Перейти на новую синхронизацию") : plan ? t("Проверить ещё раз") : t("Синхронизировать")}</button></div>
    {status && <p className="backup-status" role="status">{t(status)}</p>}
    {error && <p className="backup-error" role="alert">{t(error)}</p>}
    {plan?.first && <div className="backup-preview cloud-sync-review"><h4>{t("На этом устройстве")}</h4><p>{t("Идей: ")}{library.projects.length}</p><div className="backup-buttons">
      <button className="secondary-button" disabled={disabled} onClick={() => { if (plan.read.heads.length && !window.confirm(t("Заменить облачную библиотеку локальной? Существующие облачные версии останутся в истории."))) return; void controller.resolve(plan,{},"local"); }}>{t("Сохранить локальную в облаке")}</button>
      {!!plan.read.heads.length && <button className="secondary-button" disabled={disabled} onClick={() => { if (!window.confirm(t("Заменить библиотеку на этом устройстве выбранной облачной версией? Перед заменой можно экспортировать локальную ZIP-копию."))) return; void controller.resolve(plan,{},"cloud"); }}>{t("Загрузить облачную на устройство")}</button>}
    </div></div>}
    {plan && !plan.first && !!plan.conflicts.length && <div className="backup-preview cloud-sync-review">
      {plan.conflicts.map(conflict => <div className="cloud-version" key={conflict.key} data-conflict-key={conflict.key}><h4>{conflictLabel(conflict,plan)}</h4>{conflict.structural && <p>{t("Удаление затрагивает изменённое содержимое. Выберите, какую версию сохранить.")}</p>}<div className="menu-options">{conflict.variants.map((value,index) => <button type="button" className="conflict-option" key={index} disabled={disabled} aria-pressed={choices[conflict.key] === index} onClick={() => setChoices(previous => ({ ...previous,[conflict.key]:index }))}>{choices[conflict.key] === index ? <Check className="conflict-option-mark" aria-hidden="true" /> : <Circle className="conflict-option-mark" aria-hidden="true" />}<span>{index === 0 ? t("На этом устройстве") : `${t("В облаке")} ${index}`}<br />{preview(value)}</span></button>)}</div><details className="sync-conflict-details"><summary>{t("Сравнить версии")}</summary>{conflict.variants.map((value,index) => <div className="sync-version-body" key={index}><strong>{index === 0 ? t("На этом устройстве") : `${t("В облаке")} ${index}`}</strong>{!value ? <p>{t("Удалено")}</p> : "text" in value ? <><p>{(value as TextBlock).heading}</p><FormattedText text={(value as TextBlock).text} document={(value as TextBlock).richText} />{!!(value as TextBlock).media?.length && <p>{(value as TextBlock).media!.map(file => file.name).join(", ")}</p>}</> : <><p>{"name" in value ? value.name : ""}</p>{"description" in value && <p>{value.description}</p>}{"cover" in value && <p>{t("Обложка")}: {value.coverImage?.name || t(coverNames[value.cover])}</p>}</>}</div>)}</details></div>)}
      <button className="primary-button" disabled={disabled || resolvePlan(plan,choices,plan.resolveMode || "merge").conflicts.length > 0} onClick={() => { void controller.resolve(plan,choices); }}>{t("Применить выбранные варианты")}</button>
    </div>}
  </section>;
}
