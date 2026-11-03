"use client";
import { translate as t } from "./i18n";


import { useEffect, useState } from "react";
import { readMediaFile } from "./media-store";

/** Releases temporary object URLs when a file changes or its preview unmounts. */
export function useMediaSource(id?: string, file?: Blob) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let url = "";
    setSource(""); setError("");
    if (!id) return;
    async function load() {
      try {
        const blob = file || await readMediaFile(id!);
        if (cancelled) return;
        if (!blob) { setError(t("Файл не найден на этом устройстве.")); return; }
        url = URL.createObjectURL(blob); setSource(url);
      } catch { if (!cancelled) setError(t("Не удалось открыть файл из хранилища браузера.")); }
    }
    void load();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [id, file]);
  return { source, error, setError };
}
