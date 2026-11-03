import { parseLibrary, type Library, type MediaAsset } from "./ideas";

export const MAX_CLOUD_JSON_BYTES = 3 * 1024 * 1024;
export const MAX_CLOUD_MEDIA_BYTES = 1024 * 1024 * 1024;
export const revisionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type CloudMedia = { id: string; sha256: string; md5: string; size: number; mime: string };
export type CloudSnapshot = { format: "idea-bank-cloud"; version: 1; revision: string; parents: string[]; createdAt: string; library: Library; media: CloudMedia[] };

export class StorageError extends Error {
  constructor(public status: number, public code: string, message: string, public revisions?: string[]) { super(message); }
}
export function invalid(message = "Некорректные данные облачной библиотеки."): never { throw new StorageError(400, "INVALID_DATA", message); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Only supported passive media types can be uploaded; filenames never become object paths. */
export function parseCloudMedia(value: unknown): CloudMedia {
  if (!record(value)) return invalid();
  const { id, sha256, md5, size, mime } = value;
  if (typeof id !== "string" || !id || id.length > 200 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || typeof md5 !== "string" || !/^[a-f0-9]{32}$/.test(md5) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_CLOUD_MEDIA_BYTES || typeof mime !== "string" || !/^(?:(?:image|audio|video)\/[a-zA-Z0-9.+-]+|model\/gltf(?:-binary|\+json))$/.test(mime) || mime === "image/svg+xml") return invalid("Неверный формат медиа или файл больше 1 ГиБ.");
  return { id, sha256, md5, size, mime };
}

/** Deduplicate shared media IDs and reject inconsistent references, including custom covers. */
export function libraryAssets(library: Library) {
  const assets = new Map<string, MediaAsset>();
  for (const idea of library.projects) for (const asset of [...(idea.coverImage ? [idea.coverImage] : []), ...idea.blocks.flatMap(block => block.media || [])]) {
    if (!asset || typeof asset.id !== "string" || typeof asset.mime !== "string" || !["image", "audio", "video", "model"].includes(asset.kind) || (asset.kind === "model" ? !["model/gltf-binary", "model/gltf+json"].includes(asset.mime) : !asset.mime.startsWith(`${asset.kind}/`))) return invalid();
    const previous = assets.get(asset.id);
    if (previous && (previous.size !== asset.size || previous.mime !== asset.mime || previous.kind !== asset.kind)) return invalid("Несовместимые ссылки на одно медиа.");
    assets.set(asset.id, asset);
  }
  return assets;
}

export function parseCloudSave(value: unknown): { baseRevisions: string[]; library: Library; media: CloudMedia[] } {
  if (!record(value) || !Array.isArray(value.baseRevisions) || value.baseRevisions.length > 16 || value.baseRevisions.some(id => typeof id !== "string" || !revisionPattern.test(id)) || new Set(value.baseRevisions).size !== value.baseRevisions.length || !Array.isArray(value.media)) return invalid();
  let library: Library;
  try { library = parseLibrary(JSON.stringify(value.library)); } catch { return invalid(); }
  const media = value.media.map(parseCloudMedia), assets = libraryAssets(library), seen = new Set<string>();
  if (assets.size !== media.length) return invalid("Не для всех вложений указаны облачные файлы.");
  for (const file of media) {
    const asset = assets.get(file.id);
    if (!asset || seen.has(file.id) || asset.size !== file.size || asset.mime !== file.mime) return invalid("Описание медиа не совпадает с библиотекой.");
    seen.add(file.id);
  }
  return { baseRevisions: [...value.baseRevisions as string[]].sort(), library, media: media.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function parseCloudSnapshot(value: unknown): CloudSnapshot {
  if (!record(value) || value.format !== "idea-bank-cloud" || value.version !== 1 || typeof value.revision !== "string" || !revisionPattern.test(value.revision) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return invalid();
  const saved = parseCloudSave({ baseRevisions: value.parents, library: value.library, media: value.media });
  return { format: "idea-bank-cloud", version: 1, revision: value.revision, parents: saved.baseRevisions, createdAt: value.createdAt, library: saved.library, media: saved.media };
}
