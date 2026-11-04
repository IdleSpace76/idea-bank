import { translate as t } from "./i18n";
import type { MediaAsset, MediaKind, Project } from "./ideas";
import { cacheKey, type CacheState } from "./media-cache-store";
import { request, transaction } from "./local-database";

export async function saveMediaFiles(files: ReadonlyMap<string, Blob>): Promise<void> {
  if (!files.size) return;
  await transaction(["meta","media"], "readwrite", async tx => {
    const entries:CacheState=await request(tx.objectStore("meta").get(cacheKey))||{};
    for (const [id, blob] of files) { tx.objectStore("media").put(blob, id); delete entries[id]; }
    tx.objectStore("meta").put(entries,cacheKey);
  });
}
export const readMediaFile = (id: string): Promise<Blob | undefined> => transaction(["media"], "readonly", tx => request(tx.objectStore("media").get(id)));
export async function readMediaFiles(ids: string[]): Promise<Map<string, Blob>> {
  return transaction(["media"], "readonly", async tx => {
    const values = await Promise.all(ids.map(id => request<Blob | undefined>(tx.objectStore("media").get(id))));
    return new Map(ids.flatMap((id, index) => values[index] ? [[id, values[index]!] as const] : []));
  });
}
export async function removeMediaFiles(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await transaction(["meta", "ideas", "blocks", "media"], "readwrite", async tx => {
    const ideas = await request<{ value: Project }[]>(tx.objectStore("ideas").getAll());
    const blocks = await request<{ media?: MediaAsset[] }[]>(tx.objectStore("blocks").getAll());
    const used = new Set([...ideas.flatMap(p => p.value.coverImage ? [p.value.coverImage.id] : []), ...blocks.flatMap(b => (b.media || []).map(m => m.id))]);
    for (const id of ids) if (!used.has(id)) tx.objectStore("media").delete(id);
  });
}

export function describeMediaFile(file: File): MediaAsset | null {
  if (/\.(glb|gltf)$/i.test(file.name) && file.size) return { id: crypto.randomUUID(), name: file.name, kind: "model", mime: /\.glb$/i.test(file.name) ? "model/gltf-binary" : "model/gltf+json", size: file.size };
  const kind = file.type.split("/")[0];
  if (!["image", "video", "audio"].includes(kind) || !file.size) return null;
  // SVG can contain active content; import raster images and browser-supported audio/video.
  if (file.type === "image/svg+xml") return null;
  return { id: crypto.randomUUID(), name: file.name, kind: kind as MediaKind, mime: file.type, size: file.size };
}

export function mediaIds(blocks: { media?: MediaAsset[] }[]): string[] {
  return blocks.flatMap(block => (block.media || []).map(asset => asset.id));
}

export function projectMediaIds(project: Project): string[] {
  return [...mediaIds(project.blocks), ...(project.coverImage ? [project.coverImage.id] : [])];
}
