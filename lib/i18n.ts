import { english } from "./translations";

export type Locale = "en" | "ru";
export const LANGUAGE_KEY = "idea-bank.language";
export const isLocale = (value: unknown): value is Locale => value === "en" || value === "ru";
let locale: Locale = "en";
const listeners = new Set<() => void>();
export const getLocale = () => locale;
export const subscribeLocale = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Language is a device preference; changing it never writes to the idea library. */
export function setLocale(value: Locale) {
  locale = value;
  if (typeof document !== "undefined") {
    document.documentElement.lang = value;
    document.title = value === "en" ? "Idea Bank — a place for your ideas" : "Idea Bank — место для твоих идей";
    try { localStorage.setItem(LANGUAGE_KEY, value); } catch { /* Keep the language for this session. */ }
  }
  listeners.forEach(listener => listener());
}

type Values = Record<string, string | number>;
const russian = new Map(Object.entries(english).map(([ru, en]) => [en, ru]));
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const messagePattern = (text: string) => new RegExp("^" + text.split(/\{\d+\}/).map(escapePattern).join("([\\s\\S]*?)") + "$");
const parameterKeys = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map(match => match[1]);
const templates = Object.entries(english).filter(([ru]) => /\{\d+\}/.test(ru)).map(([ru, en]) => {
  return { ru, en, ruKeys: parameterKeys(ru), enKeys: parameterKeys(en), ruPattern: messagePattern(ru), enPattern: messagePattern(en) };
}).sort((a, b) => (b.ru + b.en).replace(/\{\d+\}/g, "").length - (a.ru + a.en).replace(/\{\d+\}/g, "").length);

/** Translate interface messages and substitute values without interpreting them as HTML. */
export function translate(message: string, values: Values = {}, language: Locale = getLocale()): string {
  if (!message) return message;
  let source = russian.get(message) ?? message;
  // Already displayed progress/errors may include values; switching language keeps them readable.
  if (!Object.hasOwn(english, source) && !russian.has(message)) {
    for (const template of templates) {
      const match = (language === "ru" ? template.enPattern : template.ruPattern).exec(message);
      const keys = language === "ru" ? template.enKeys : template.ruKeys;
      if (match) return (language === "ru" ? template.ru : template.en).replace(/\{(\d+)\}/g, (token, key: string) => match[keys.indexOf(key) + 1] ?? token);
    }
  }
  const text = language === "en" ? english[source] ?? source : source;
  return text.replace(/\{(\d+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? String(values[key]) : token);
}
