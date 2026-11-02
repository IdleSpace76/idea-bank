export const THEME_KEY = "idea-bank.theme";
export const themes = [
  { id: "sage", name: "Шалфей", background: "#faf9f6" },
  { id: "sky", name: "Нежно-голубая", background: "#f3f8fd" },
  { id: "graphite", name: "Графит", background: "#202226" },
] as const;
export type Theme = typeof themes[number]["id"];
export const isTheme = (value: unknown): value is Theme => themes.some(theme => theme.id === value);

/** Restores the saved palette before the first paint, including on a direct project link. */
export const themeInitScript = `(function(){var t='sage';try{var s=localStorage.getItem('${THEME_KEY}');if(['sage','sky','graphite'].includes(s))t=s;}catch(e){}document.documentElement.dataset.theme=t;})();`;
