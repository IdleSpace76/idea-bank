import { prepareLocalSave } from "./cloud-state";
import { zip, unzip, type Zippable } from "fflate";
import { createId, parseLibrary, STORAGE_KEY, type Library, type MediaAsset } from "./ideas";
import { projectMediaIds, readMediaFiles, removeMediaFiles, saveMediaFiles } from "./media-store";

export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 10000;
type ManifestFile = { id: string; path: string; size: number; sha256: string };
type Manifest = { format: "idea-bank-backup"; version: 1; createdAt: string; librarySha256: string; media: ManifestFile[] };
export type LibraryBackup = { library: Library; files: ReadonlyMap<string, Blob>; createdAt: string; totalBytes: number };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))).map(value => value.toString(16).padStart(2, "0")).join("");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Includes covers and shared references once, rejecting ambiguous file identifiers. */
function collectAssets(library: Library): Map<string, MediaAsset> {
  const assets = new Map<string, MediaAsset>();
  for (const idea of library.projects) {
    for (const asset of [...(idea.coverImage ? [idea.coverImage] : []), ...idea.blocks.flatMap(block => block.media || [])]) {
      if (asset.mime === "image/svg+xml") throw new Error(`Формат SVG не поддерживается: «${asset.name}».`);
      const previous = assets.get(asset.id);
      if (previous && (previous.mime !== asset.mime || previous.size !== asset.size || previous.kind !== asset.kind)) throw new Error(`Несовместимые ссылки на файл «${asset.name}». Экспорт остановлен.`);
      assets.set(asset.id, asset);
    }
  }
  return assets;
}

/** Exports originals with JSON metadata and SHA-256 checksums; missing files abort export. */
export async function createLibraryBackup(library: Library): Promise<Blob> {
  const snapshot = parseLibrary(JSON.stringify(library));
  const assets = collectAssets(snapshot);
  const json = new TextEncoder().encode(JSON.stringify(snapshot, null, 2));
  if (assets.size > MAX_ENTRIES - 3 || json.length + [...assets.values()].reduce((sum, asset) => sum + asset.size, 0) > MAX_BACKUP_BYTES) throw new Error("Для одного архива поддерживается до 512 МБ данных и 9 997 медиафайлов.");
  const files = await readMediaFiles([...assets.keys()]);
  const entries: Zippable = { "library.json": [json, { level: 6 }] };
  const manifest: Manifest = { format: "idea-bank-backup", version: 1, createdAt: new Date().toISOString(), librarySha256: await digest(json), media: [] };
  for (const [id, asset] of assets) {
    const blob = files.get(id);
    if (!blob) throw new Error(`Не найден файл «${asset.name}». Полный архив не создан: восстанови файл или убери его из идеи.`);
    if (blob.size !== asset.size) throw new Error(`Размер файла «${asset.name}» не совпадает с данными библиотеки. Экспорт остановлен.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = (asset.name.split(/[\\/]/).pop() || "file").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 100);
    const path = `media/${String(manifest.media.length + 1).padStart(6, "0")}_${name}`;
    entries[path] = [bytes, { level: 0 }];
    manifest.media.push({ id, path, size: bytes.length, sha256: await digest(bytes) });
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const instructions = new TextEncoder().encode("Резервная копия Idea Bank, версия 1\n\nlibrary.json — разделы, идеи, блоки и ссылки на медиа.\nmanifest.json — версия архива, дата и контрольные суммы SHA-256.\nmedia/ — исходные файлы; glTF содержит встроенные при загрузке ресурсы.\n\nДля восстановления открой Idea Bank > Локальная версия > Импортировать ZIP.\nАрхив содержит личные данные библиотеки. Храни его в безопасном месте.\n");
  if (json.length + manifest.media.reduce((sum, file) => sum + file.size, 0) + manifestBytes.length + instructions.length > MAX_BACKUP_BYTES) throw new Error("Архив превышает ограничение в 512 МБ данных.");
  entries["manifest.json"] = [manifestBytes, { level: 6 }];
  entries["README.txt"] = instructions;
  const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(entries, { level: 0 }, (error, data) => error ? reject(error) : resolve(data)));
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

/** Validates the entire archive without changing browser storage. */
export async function readLibraryBackup(file: Blob): Promise<LibraryBackup> {
  if (!file.size || file.size > MAX_BACKUP_BYTES + 32 * 1024 * 1024) throw new Error("Выбери ZIP-архив Idea Bank размером до 544 МБ.");
  let total = 0, count = 0, problem = "";
  const seen = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    entries = await new Promise((resolve, reject) => unzip(bytes, { filter: entry => {
      total += entry.originalSize; count++;
      if (seen.has(entry.name)) problem ||= "В архиве повторяются имена файлов.";
      seen.add(entry.name);
      if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || total > MAX_BACKUP_BYTES || count > MAX_ENTRIES) problem ||= "Архив превышает ограничение: 512 МБ данных или 10 000 записей.";
      if (entry.name.length > 512 || ![0, 8].includes(entry.compression) || (entry.compression === 0 && entry.size !== entry.originalSize)) problem ||= "В ZIP-архиве неверный размер файла или неподдерживаемое сжатие.";
      if (["manifest.json", "library.json"].includes(entry.name) && entry.originalSize > 16 * 1024 * 1024) problem ||= "Описание библиотеки в архиве слишком большое.";
      return !problem && (["manifest.json", "library.json"].includes(entry.name) || /^media\/[^/\\]+$/u.test(entry.name));
    } }, (error, data) => problem ? reject(new Error(problem)) : error ? reject(error) : resolve(data)));
  } catch { throw new Error(problem || "Не удалось открыть ZIP-архив. Проверь, что файл не повреждён."); }
  if (!entries["manifest.json"] || !entries["library.json"]) throw new Error("Это не архив библиотеки Idea Bank: не найдены manifest.json и library.json.");
  let manifest: unknown;
  try { manifest = JSON.parse(decode(entries["manifest.json"])); } catch { throw new Error("Не удалось прочитать описание архива."); }
  if (!record(manifest) || manifest.format !== "idea-bank-backup" || manifest.version !== 1 || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) || !validHash(manifest.librarySha256) || !Array.isArray(manifest.media)) throw new Error("Неподдерживаемая версия или неверное описание архива Idea Bank.");
  if (await digest(entries["library.json"]) !== manifest.librarySha256) throw new Error("Проверка целостности библиотеки не пройдена. Данные не изменены.");
  let library: Library;
  try { library = parseLibrary(decode(entries["library.json"])); } catch { throw new Error("Библиотека в архиве имеет несовместимый формат. Данные не изменены."); }
  const assets = collectAssets(library), files = new Map<string, Blob>(), paths = new Set<string>();
  if (manifest.media.length !== assets.size) throw new Error("Список медиа в архиве не совпадает с библиотекой.");
  let totalBytes = entries["library.json"].length;
  for (const entry of manifest.media) {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.path !== "string" || !/^media\/[^/\\]+$/u.test(entry.path) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || !validHash(entry.sha256) || files.has(entry.id) || paths.has(entry.path)) throw new Error("В архиве неверное описание медиафайла.");
    const asset = assets.get(entry.id), bytes = entries[entry.path];
    if (!asset || !bytes || bytes.length !== entry.size || asset.size !== entry.size) throw new Error(`В архиве отсутствует или повреждён файл «${asset?.name || entry.id}».`);
    if (await digest(bytes) !== entry.sha256) throw new Error(`Проверка целостности файла «${asset.name}» не пройдена.`);
    files.set(entry.id, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: asset.mime })); paths.add(entry.path); totalBytes += bytes.length;
  }
  return { library, files, createdAt: manifest.createdAt, totalBytes };
}

/** Stages files under fresh IDs; metadata is switched only after the media transaction succeeds. */
export async function restoreLibraryBackup(backup: LibraryBackup, current: Library): Promise<Library> {
  prepareLocalSave();
  const expected = localStorage.getItem(STORAGE_KEY);
  const next = parseLibrary(JSON.stringify(backup.library));
  const oldIds = new Set(current.projects.flatMap(projectMediaIds));
  const staged = new Map<string, Blob>(), replacements = new Map<string, string>();
  for (const [id, asset] of collectAssets(next)) {
    const file = backup.files.get(id);
    if (!file || file.size !== asset.size) throw new Error("Медиа для восстановления не прошли проверку.");
    let fresh = createId(); while (oldIds.has(fresh) || staged.has(fresh)) fresh = createId();
    replacements.set(id, fresh); staged.set(fresh, file);
  }
  for (const idea of next.projects) {
    if (idea.coverImage) idea.coverImage.id = replacements.get(idea.coverImage.id)!;
    for (const block of idea.blocks) for (const asset of block.media || []) asset.id = replacements.get(asset.id)!;
  }
  try {
    await saveMediaFiles(staged);
    if (localStorage.getItem(STORAGE_KEY) !== expected) throw new Error("Библиотека изменилась в другой вкладке. Повтори восстановление, чтобы не потерять изменения.");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    await removeMediaFiles([...staged.keys()]).catch(() => {});
    throw new Error(error instanceof Error && error.message.includes("другой вкладке") ? error.message : "Не удалось записать библиотеку: проверь свободное место и разрешения браузера. Прежняя библиотека сохранена.");
  }
  // Only references from the replaced library are removed; unknown/orphaned files stay untouched.
  void removeMediaFiles([...oldIds]).catch(() => {});
  return next;
}
