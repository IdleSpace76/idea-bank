"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Globe2 } from "lucide-react";
import { DropdownMenu } from "./dropdown-menu";
import { getLocale, isLocale, LANGUAGE_KEY, setLocale, subscribeLocale, translate, type Locale } from "@/lib/i18n";

export function useI18n() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, (): Locale => "en");
  // Event handlers and asynchronous operations must use the current language too.
  return { locale, t: translate };
}

/** Restore the preference after hydration and keep open tabs in the same language. */
export function LanguageInit() {
  useEffect(() => {
    try { const saved = localStorage.getItem(LANGUAGE_KEY); if (isLocale(saved)) setLocale(saved); } catch { /* English remains the default. */ }
    function changed(event: StorageEvent) { if (event.key === LANGUAGE_KEY) setLocale(isLocale(event.newValue) ? event.newValue : "en"); }
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return null;
}

export function LanguagePicker() {
  const { locale, t } = useI18n();
  return <DropdownMenu label={t("Язык интерфейса")} triggerClassName="theme-trigger language-trigger" triggerContent={<Globe2 aria-hidden="true" />} items={[
    { label: "EN · English", icon: <LanguageFlag locale="en" />, selected: locale === "en", onSelect: () => setLocale("en") },
    { label: "RU · Русский", icon: <LanguageFlag locale="ru" />, selected: locale === "ru", onSelect: () => setLocale("ru") },
  ]} />;
}

function LanguageFlag({ locale }: { locale: Locale }) {
  return <svg className="language-flag" viewBox="0 0 60 40" aria-hidden="true">{locale === "ru" ? <><path fill="#fff" d="M0 0h60v14H0z" /><path fill="#224fc4" d="M0 14h60v13H0z" /><path fill="#df3347" d="M0 27h60v13H0z" /></> : <><path fill="#173b82" d="M0 0h60v40H0z" /><path stroke="#fff" strokeWidth="9" d="m0 0 60 40M60 0 0 40" /><path stroke="#df3347" strokeWidth="3" d="m0 0 60 40M60 0 0 40" /><path stroke="#fff" strokeWidth="13" d="M30 0v40M0 20h60" /><path stroke="#df3347" strokeWidth="7" d="M30 0v40M0 20h60" /></>}</svg>;
}
