"use client";
import { useI18n } from "./language-picker";

import { Check, LoaderCircle, X } from "lucide-react";

export function EditorActions({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  const { t } = useI18n();
  return <div className="editor-actions"><button type="button" className="round-editor-button cancel-edit" aria-label={t("Отмена")} title={t("Отменить редактирование")} disabled={saving} onClick={onCancel}><X /></button><button type="submit" form="project-editor" className="round-editor-button save-edit" aria-label={saving ? t("Сохраняем…") : t("Сохранить идею")} title={t("Сохранить идею")} disabled={saving}>{saving ? <LoaderCircle /> : <Check />}</button></div>;
}
