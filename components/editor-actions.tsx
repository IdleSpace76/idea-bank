"use client";

import { Check, LoaderCircle, X } from "lucide-react";

export function EditorActions({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  return <div className="editor-actions"><button type="button" className="round-editor-button cancel-edit" aria-label="Отмена" title="Отменить редактирование" disabled={saving} onClick={onCancel}><X /></button><button type="submit" form="project-editor" className="round-editor-button save-edit" aria-label={saving ? "Сохраняем…" : "Сохранить идею"} title="Сохранить идею" disabled={saving}>{saving ? <LoaderCircle /> : <Check />}</button></div>;
}
