import { parseLibrary, STORAGE_KEY, type Library, type Project, type Section, type TextBlock } from "./ideas";
import { createLibraryBackup, MAX_BACKUP_BYTES } from "./library-backup";
import { translate as t } from "./i18n";

type Layout = { sectionIds: string[]; ideaIds: string[] };
type IdeaRecord = { value: Project; blockIds: string[] };
const invalid = () => new Error(t("Не удалось прочитать прежнюю библиотеку браузера. Исходные данные не изменены."));
const request = <T,>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
});

/** Open only existing databases. Aborting an initial upgrade leaves no empty database behind. */
async function existingDatabase(name: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") throw invalid();
  if (indexedDB.databases) {
    const known = await indexedDB.databases();
    if (!known.some(db => db.name === name)) return null;
  }
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name); let missing = false, blocked = false;
    opening.onupgradeneeded = () => { missing = true; opening.transaction!.abort(); };
    opening.onerror = () => missing ? resolve(null) : reject(invalid());
    opening.onblocked = () => { blocked = true; reject(invalid()); };
    opening.onsuccess = () => {
      const db = opening.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close(); resolve(db);
    };
  });
}

async function readonly<T>(db: IDBDatabase, stores: string[], work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = db.transaction(stores, "readonly");
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(invalid()); });
  void done.catch(() => {});
  try { const result = await work(tx); await done; return result; }
  catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
}

function layout(value: unknown): Layout | null {
  if (value === undefined) return null;
  const row = value as Layout;
  if (!row || ![row.sectionIds, row.ideaIds].every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string") && new Set(ids).size === ids.length)) throw invalid();
  return row;
}
function checkDatabase(db: IDBDatabase) {
  if (db.version !== 1 || ["meta", "sections", "ideas", "blocks", "media"].some(name => !db.objectStoreNames.contains(name))) throw invalid();
}
function legacyJson(): { raw: string; library: Library } | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? null : { raw, library: parseLibrary(raw) };
}

/** Dialog detection reads only the layout, never idea bodies or attachments. */
export async function legacyBrowserIdeaCount(): Promise<number | null> {
  const db = await existingDatabase("idea-bank.local");
  if (db) {
    try {
      checkDatabase(db);
      const saved = await readonly(db, ["meta"], async tx => layout(await request(tx.objectStore("meta").get("layout"))));
      if (saved) return saved.ideaIds.length;
    } finally { db.close(); }
  }
  return legacyJson()?.library.projects.length ?? null;
}

function assets(library: Library) {
  const all = library.projects.flatMap(idea => [...(idea.coverImage ? [idea.coverImage] : []), ...idea.blocks.flatMap(block => block.media || [])]);
  const unique = [...new Map(all.map(asset => [asset.id, asset])).values()];
  if (unique.reduce((sum, asset) => sum + asset.size, 0) > MAX_BACKUP_BYTES) throw new Error(t("Для одного архива поддерживается до 512 МБ данных и 9 997 медиафайлов."));
  return unique;
}
async function filesIn(tx: IDBTransaction, store: string, library: Library) {
  const files = new Map<string, Blob>();
  await Promise.all(assets(library).map(async asset => {
    const file = await request<Blob | undefined>(tx.objectStore(store).get(asset.id));
    if (!(file instanceof Blob) || file.size !== asset.size) throw new Error(t("В прежней библиотеке браузера не найден файл «{0}». Экспорт остановлен; исходные данные сохранены.", { 0: asset.name }));
    files.set(asset.id, file);
  }));
  return files;
}

/** Saved ideas and media come from one readonly transaction; drafts remain in the old browser. */
async function browserSnapshot(): Promise<{ library: Library; files: Map<string, Blob> }> {
  const db = await existingDatabase("idea-bank.local");
  if (db) {
    try {
      checkDatabase(db);
      const saved = await readonly(db, ["meta", "sections", "ideas", "blocks", "media"], async tx => {
        const savedLayout = layout(await request(tx.objectStore("meta").get("layout")));
        if (!savedLayout) return null;
        const sections = await Promise.all(savedLayout.sectionIds.map(id => request<Section>(tx.objectStore("sections").get(id))));
        const projects = await Promise.all(savedLayout.ideaIds.map(async id => {
          const row = await request<IdeaRecord | undefined>(tx.objectStore("ideas").get(id));
          if (!row || row.value?.id !== id || !Array.isArray(row.blockIds)) throw invalid();
          const blocks = await Promise.all(row.blockIds.map(block => request<TextBlock>(tx.objectStore("blocks").get(JSON.stringify([id, block])))));
          return { ...row.value, blocks };
        }));
        const library = parseLibrary(JSON.stringify({ version: 1, sections, projects }));
        return { library, files: await filesIn(tx, "media", library) };
      });
      if (saved) return saved;
    } finally { db.close(); }
  }
  const old = legacyJson();
  if (!old) throw new Error(t("В этом браузере по этому адресу нет прежней локальной библиотеки."));
  const media = assets(old.library), files = new Map<string, Blob>();
  if (media.length) {
    const db = await existingDatabase("idea-bank.media.v1");
    if (!db) throw invalid();
    try {
      if (db.version !== 1 || !db.objectStoreNames.contains("files")) throw invalid();
      const saved = await readonly(db, ["files"], tx => filesIn(tx, "files", old.library));
      for (const [id, file] of saved) files.set(id, file);
    } finally { db.close(); }
  }
  if (localStorage.getItem(STORAGE_KEY) !== old.raw) throw new Error(t("Прежняя библиотека браузера изменилась во время экспорта. Повторите экспорт."));
  return { library: old.library, files };
}

/** Export is deliberately separate from importing to disk and never writes to either library. */
export async function exportLegacyBrowserBackup(progress: (message: string) => void): Promise<Blob> {
  const saved = await browserSnapshot();
  return createLibraryBackup(saved.library, undefined, progress, async id => saved.files.get(id));
}
