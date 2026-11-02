import { normalizeRichText, type RichDocument } from "./rich-text";

export const STORAGE_KEY = "idea-bank.library.v1";

export const coverNames = {
  forest: "Лес",
  orbit: "Космос",
  water: "Озеро",
  paper: "Блокнот",
  code: "Сумерки",
  sand: "Песок",
} as const;

export type Cover = keyof typeof coverNames;
export type SectionIcon = "gamepad" | "book" | "code" | "folder" | "lightbulb" | "palette" | "rocket";
export type Section = { id: string; name: string; description: string; icon: SectionIcon };
export type BlockWidth = "full" | "half" | "third";
export type MediaKind = "image" | "video" | "audio" | "model";
export type MediaDisplaySize = { width: number; height: number };
export type MediaAsset = { id: string; name: string; kind: MediaKind; mime: string; size: number; displaySize?: MediaDisplaySize };
export type TextBlock = { id: string; heading: string; headingFontSize?: number; text: string; richText?: RichDocument; textPosition?: "above" | "below"; width?: BlockWidth; media?: MediaAsset[] };
export type Project = {
  id: string;
  sectionId: string;
  name: string;
  description: string;
  cover: Cover;
  coverImage?: MediaAsset;
  blocks: TextBlock[];
  updatedAt: string;
};
export type Library = { version: 1; sections: Section[]; projects: Project[] };
export type Route = { screen: "home" } | { screen: "section"; id: string } | { screen: "project"; id: string };

const date = "2026-11-02T08:00:00.000Z";

/** Public starter content; personal libraries are stored separately in the browser. */
export const demoLibrary: Library = {
  version: 1,
  sections: [
    { id: "examples", name: "Примеры", description: "Начни с Example, а затем создай свои разделы и идеи.", icon: "lightbulb" },
  ],
  projects: [{
    id: "example", sectionId: "examples", name: "Example",
    description: "Пример идеи: текст, оформление, медиа и расположение блоков. Его можно изменить или удалить.",
    cover: "forest", updatedAt: date,
    blocks: [
      {
        id: "example-start", heading: "Начни с идеи", text: "Это Example — единственная идея в стартовой библиотеке. Создай свой раздел и добавь в него новую идею.\n\nВ редакторе можно выделить важное, добавить курсив, подчеркнуть текст или вставить код. Используй панель над текстом.\n\nИзменения сохраняются кнопкой с галочкой внизу справа.",
        width: "full",
        richText: { type: "doc", content: [
          { type: "paragraph", content: [{ type: "text", text: "Это " }, { type: "text", text: "Example", marks: [{ type: "bold" }] }, { type: "text", text: " — единственная идея в стартовой библиотеке. Создай свой раздел и добавь в него новую идею." }] },
          { type: "paragraph", content: [{ type: "text", text: "В редакторе можно " }, { type: "text", text: "выделить важное", marks: [{ type: "bold" }] }, { type: "text", text: ", добавить " }, { type: "text", text: "курсив", marks: [{ type: "italic" }] }, { type: "text", text: ", " }, { type: "text", text: "подчеркнуть текст", marks: [{ type: "underline" }] }, { type: "text", text: " или вставить " }, { type: "text", text: "код", marks: [{ type: "code" }] }, { type: "text", text: ". Используй панель над текстом." }] },
          { type: "paragraph", content: [{ type: "text", text: "Изменения сохраняются кнопкой с галочкой внизу справа." }] },
        ] },
      },
      {
        id: "example-media", heading: "Медиа и расположение", width: "half", textPosition: "above",
        text: "В один блок можно добавить фото, видео, аудио и 3D-модели GLB/glTF. Для составной glTF-модели выбери папку с её ресурсами.\n\nЭтот блок занимает половину строки. Добавь рядом ещё один, настрой ширину и перетащи карточки за ручку. Каждое медиа можно растянуть отдельно, а текст разместить над ним или под ним.\n\nСделай резервную копию через «Локальная версия» → «Экспортировать ZIP». Пока облако не подключено, данные хранятся в этом браузере.",
      },
    ],
  }],
};

export function createId(): string {
  return crypto.randomUUID();
}

/** Rejects incompatible data instead of silently replacing a saved library. */
export function parseLibrary(raw: string): Library {
  const data: unknown = JSON.parse(raw);
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  const str = (value: unknown): value is string => typeof value === "string";
  const nonempty = (value: unknown): value is string => str(value) && value.trim().length > 0;
  if (!record(data) || data.version !== 1 || !Array.isArray(data.sections) || !Array.isArray(data.projects)) throw new Error("Unsupported library");
  const sectionIds = new Set<string>();
  for (const s of data.sections) {
    if (!record(s) || !nonempty(s.id) || !nonempty(s.name) || !str(s.description) || !["gamepad", "book", "code", "folder", "lightbulb", "palette", "rocket"].includes(String(s.icon)) || sectionIds.has(s.id)) throw new Error("Invalid section");
    sectionIds.add(s.id);
  }
  const projectIds = new Set<string>();
  for (const p of data.projects) {
    if (!record(p) || !nonempty(p.id) || !nonempty(p.name) || !str(p.description) || !str(p.sectionId) || !sectionIds.has(p.sectionId) || !str(p.cover) || !Object.hasOwn(coverNames, p.cover) || !str(p.updatedAt) || !Number.isFinite(Date.parse(p.updatedAt)) || !Array.isArray(p.blocks) || projectIds.has(p.id)) throw new Error("Invalid project");
    projectIds.add(p.id);
    if (p.coverImage !== undefined) {
      const image = p.coverImage;
      if (!record(image) || !nonempty(image.id) || !nonempty(image.name) || image.kind !== "image" || !str(image.mime) || !image.mime.startsWith("image/") || image.mime === "image/svg+xml" || typeof image.size !== "number" || !Number.isFinite(image.size) || image.size <= 0) throw new Error("Invalid cover image");
    }
    const blockIds = new Set<string>();
    for (const b of p.blocks) {
      if (!record(b) || !nonempty(b.id) || !str(b.heading) || !str(b.text) || blockIds.has(b.id)) throw new Error("Invalid block");
      blockIds.add(b.id);
      if (b.headingFontSize !== undefined && (typeof b.headingFontSize !== "number" || !Number.isFinite(b.headingFontSize) || b.headingFontSize < 12 || b.headingFontSize > 48)) throw new Error("Invalid heading font size");
      if (b.textPosition !== undefined && b.textPosition !== "above" && b.textPosition !== "below") throw new Error("Invalid text position");
      if (b.richText !== undefined) {
        if (JSON.stringify(normalizeRichText(b.richText)) !== JSON.stringify(b.richText)) throw new Error("Invalid rich text");
      }
      if (b.width !== undefined && !["full", "half", "third"].includes(String(b.width))) throw new Error("Invalid block width");
      if (b.media !== undefined) {
        if (!Array.isArray(b.media)) throw new Error("Invalid media list");
        const mediaIds = new Set<string>();
        for (const asset of b.media) {
          if (!record(asset) || !nonempty(asset.id) || !nonempty(asset.name) || !["image", "video", "audio", "model"].includes(String(asset.kind)) || !str(asset.mime) || (asset.kind === "model" ? !["model/gltf-binary", "model/gltf+json"].includes(asset.mime) : !asset.mime.startsWith(`${asset.kind}/`)) || typeof asset.size !== "number" || !Number.isFinite(asset.size) || asset.size < 0 || mediaIds.has(asset.id)) throw new Error("Invalid media");
          if (asset.displaySize !== undefined) {
            const size = asset.displaySize;
            if (!record(size) || typeof size.width !== "number" || !Number.isFinite(size.width) || size.width < 1 || size.width > 2400 || typeof size.height !== "number" || !Number.isFinite(size.height) || size.height < 80 || size.height > 1200) throw new Error("Invalid media display size");
          }
          mediaIds.add(asset.id);
        }
      }
    }
  }
  return data as Library;
}

export function readRoute(hash: string): Route {
  const match = /^#\/(section|project)\/([^/]+)$/.exec(hash);
  if (!match) return { screen: "home" };
  try { return { screen: match[1] as "section" | "project", id: decodeURIComponent(match[2]) }; }
  catch { return { screen: "home" }; }
}

export function routeHash(route: Route): string {
  return route.screen === "home" ? "#/" : `#/${route.screen}/${encodeURIComponent(route.id)}`;
}

