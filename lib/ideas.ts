import { exampleMedia } from "./example-media";
import { isNormalizedRichText, type RichDocument } from "./rich-text";

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
/** Card metadata, without the idea's blocks or attachment contents. */
export type IdeaSummary = {
  id: string;
  sectionId: string;
  name: string;
  description: string;
  cover: Cover;
  coverImage?: MediaAsset;
  updatedAt: string;
};
export type IdeaContent = { id: string; blocks: TextBlock[] };
export type Project = IdeaSummary & IdeaContent;

export function summarizeIdea(idea: IdeaSummary): IdeaSummary {
  return { id: idea.id, sectionId: idea.sectionId, name: idea.name, description: idea.description,
    cover: idea.cover, ...(idea.coverImage ? { coverImage: idea.coverImage } : {}), updatedAt: idea.updatedAt };
}
export type Library = { version: 1; sections: Section[]; projects: Project[] };
export type Route = { screen: "home" } | { screen: "section"; id: string } | { screen: "project"; id: string };

const date = "2026-11-02T08:00:00.000Z";

/** Public starter content; personal libraries are stored separately in the browser. */
export const demoLibrary: Library = {
  version: 1,
  sections: [{ id: "examples", name: "Examples", description: "Start with Example, then create your own sections and ideas.", icon: "lightbulb" }],
  projects: [{
    id: "example", sectionId: "examples", name: "Example",
    description: "A sample idea with formatted text, a robot image and an interactive 3D model. Edit it, or replace it with your own ideas.",
    cover: "forest", updatedAt: date,
    blocks: [
      {
        id: "example-start", heading: "Start with an idea", width: "full",
        text: "This is Example, the only idea in your starter library. Create a section and add your own idea.\n\nUse the toolbar to make text bold, italic or underlined, add inline code, change colors and sizes, or insert a link.\n\nSave changes with the checkmark button at the bottom right. Sync after saving to make them available on your other devices.",
        richText: { type: "doc", content: [
          { type: "paragraph", content: [{ type: "text", text: "This is " }, { type: "text", text: "Example", marks: [{ type: "bold" }] }, { type: "text", text: ", the only idea in your starter library. Create a section and add your own idea." }] },
          { type: "paragraph", content: [{ type: "text", text: "Use the toolbar to make text " }, { type: "text", text: "bold", marks: [{ type: "bold" }] }, { type: "text", text: ", " }, { type: "text", text: "italic", marks: [{ type: "italic" }] }, { type: "text", text: " or " }, { type: "text", text: "underlined", marks: [{ type: "underline" }] }, { type: "text", text: ", add " }, { type: "text", text: "inline code", marks: [{ type: "code" }] }, { type: "text", text: ", change colors and sizes, or insert a link." }] },
          { type: "paragraph", content: [{ type: "text", text: "Save changes with the checkmark button at the bottom right. Sync after saving to make them available on your other devices." }] }
        ] }
      },
      {
        id: "example-media", heading: "Media and layout", width: "half", textPosition: "above",
        text: "Here is a little robot, shown as an image and as an interactive 3D model. Drag the model to rotate it and zoom to explore it.\n\nIn the editor, resize each media frame independently and change their order. You can also add your own photos, video, audio and GLB/glTF models.\n\nThis block takes half a row. Add another block alongside it, change its width, or drag blocks by their handles. Export a ZIP backup to keep a copy of your text and all attachments.",
        media: exampleMedia,
      }
    ]
  }]
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
        if (!isNormalizedRichText(b.richText)) throw new Error("Invalid rich text");
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

