import type { MediaAsset, MediaKind, Project } from "./ideas";

const DB_NAME = "idea-bank.media.v1";
const STORE = "files";

function openMediaDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Медиахранилище недоступно"));
    request.onblocked = () => reject(new Error("Закрой другие вкладки приложения и повтори сохранение."));
  });
}

/** Stores original binary files in one transaction before their metadata is saved. */
export async function saveMediaFiles(files: ReadonlyMap<string, Blob>): Promise<void> {
  if (!files.size) return;
  const db = await openMediaDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Не удалось сохранить медиа"));
      files.forEach((file, id) => tx.objectStore(STORE).put(file, id));
    });
  } finally { db.close(); }
}

export async function readMediaFile(id: string): Promise<Blob | undefined> {
  const db = await openMediaDatabase();
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : undefined);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

/** Reads one consistent media snapshot for a library export. */
export async function readMediaFiles(ids: string[]): Promise<Map<string, Blob>> {
  if (!ids.length) return new Map();
  const db = await openMediaDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const files = new Map<string, Blob>();
      const tx = db.transaction(STORE, "readonly"), store = tx.objectStore(STORE);
      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => { if (request.result instanceof Blob) files.set(id, request.result); };
      }
      tx.oncomplete = () => resolve(files);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Не удалось прочитать медиа для экспорта."));
    });
  } finally { db.close(); }
}

/** Only removes files whose references have already been removed from the saved library. */
export async function removeMediaFiles(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openMediaDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Не удалось удалить медиа"));
      ids.forEach(id => tx.objectStore(STORE).delete(id));
    });
  } finally { db.close(); }
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
