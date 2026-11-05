import { parseLibrary, summarizeIdea, STORAGE_KEY, type IdeaSummary, type Library, type Project, type Section, type TextBlock } from "./ideas";
import { request, transaction } from "./local-database";
import { registerCloudCache, pruneCacheIn, MEDIA_CACHE_LIMIT, cacheKey, type CacheState } from "./media-cache-store";
import type { SyncCheckpoint } from "./entity-sync";
import { translate as t } from "./i18n";

export type LocalSnapshot = { library: Library; revision: number };
export type LocalCatalogCursor = { offset: number; revision: number; sectionId?: string; query?: string };
export type LocalCatalogPage = { ideas: IdeaSummary[]; revision: number; nextCursor: LocalCatalogCursor | null; total: number };
export type PendingChange = { entity: "section" | "idea" | "block"; id: string; ideaId?: string; operation: "put" | "delete"; sequence: number; base: unknown; value: unknown };
type Layout = { revision: number; sectionIds: string[]; ideaIds: string[]; catalog?: { id: string; sectionId: string; updatedAt: string }[] };
type IdeaRecord = { value: Project; blockIds: string[] };
const channelName = "idea-bank.local.changes";
export const LEGACY_CLOUD_KEY = "idea-bank.cloud.v1";
const blockKey = (idea: string, block: string) => JSON.stringify([idea, block]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function snapshotIn(tx: IDBTransaction): Promise<LocalSnapshot | null> {
  const meta = await request<Layout | undefined>(tx.objectStore("meta").get("layout"));
  if (!meta) return null;
  const sections = await Promise.all(meta.sectionIds.map(id => request(tx.objectStore("sections").get(id))));
  const projects = await Promise.all(meta.ideaIds.map(async id => {
    const idea: IdeaRecord = await request(tx.objectStore("ideas").get(id));
    const blocks = await Promise.all(idea.blockIds.map(block => request<TextBlock>(tx.objectStore("blocks").get(blockKey(id, block)))));
    return { ...idea.value, blocks };
  }));
  return { library: parseLibrary(JSON.stringify({ version: 1, sections, projects })), revision: meta.revision };
}
export const readLocalSnapshot = () => transaction(["meta", "sections", "ideas", "blocks"], "readonly", snapshotIn);

async function layoutIn(tx: IDBTransaction): Promise<Layout> {
  const layout = await request<Layout | undefined>(tx.objectStore("meta").get("layout"));
  if (!layout) throw new Error("Local library is not initialized");
  return layout;
}

/** Read section metadata without reading any ideas, blocks or media. */
export const readLocalSections = () => transaction(["meta", "sections"], "readonly", async tx => {
  const layout = await layoutIn(tx);
  const sections = await Promise.all(layout.sectionIds.map(id => request<Section>(tx.objectStore("sections").get(id))));
  const counts: Record<string, number> = Object.create(null);
  for (const idea of layout.catalog || []) counts[idea.sectionId] = (counts[idea.sectionId] || 0) + 1;
  return { sections: parseLibrary(JSON.stringify({ version: 1, sections, projects: [] })).sections, revision: layout.revision, counts };
});

/** Add a derived navigation index to old databases without reading or rewriting their blocks. */
export const prepareLocalCatalog = () => transaction(["meta", "ideas"], "readwrite", async tx => {
  const layout = await layoutIn(tx);
  if (layout.catalog) return;
  const ideas = await Promise.all(layout.ideaIds.map(id => request<IdeaRecord>(tx.objectStore("ideas").get(id))));
  layout.catalog = ideas.map(({ value }) => ({ id: value.id, sectionId: value.sectionId, updatedAt: value.updatedAt })).sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  tx.objectStore("meta").put(layout, "layout");
});

/** Pages follow the persisted catalog order. Revision is local, not a cloud entity version. */
export async function readLocalCatalogPage(options: { limit?: number; cursor?: LocalCatalogCursor; sectionId?: string; query?: string } = {}): Promise<LocalCatalogPage> {
  const limit = options.limit ?? 24, cursor = options.cursor, query = options.query?.trim().toLowerCase() || undefined;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid catalog page size");
  if (cursor && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.revision) || cursor.revision < 1)) throw new Error("Invalid catalog cursor");
  return transaction(["meta", "sections", "ideas"], "readonly", async tx => {
    const layout = await layoutIn(tx);
    if (cursor && (cursor.revision !== layout.revision || cursor.sectionId !== options.sectionId || cursor.query !== query)) throw Object.assign(new Error("Local catalog changed; restart pagination"),{code:"STALE_CATALOG"});
    const offset = cursor?.offset ?? 0;
    const sections = await Promise.all(layout.sectionIds.map(id => request<Section>(tx.objectStore("sections").get(id))));
    const ids = layout.catalog ? layout.catalog.filter(idea => !options.sectionId || idea.sectionId === options.sectionId).map(idea => idea.id) : layout.ideaIds;
    const read = async (id: string) => {
      const row = await request<IdeaRecord | undefined>(tx.objectStore("ideas").get(id));
      if (!row || row.value.id !== id) throw new Error("Invalid local idea metadata");
      return { ...summarizeIdea(row.value), blocks: [] };
    };
    const matching = query ? (await Promise.all(ids.map(read))).filter(idea => `${idea.name}\n${idea.description}`.toLowerCase().includes(query)) : null;
    const total = matching?.length ?? ids.length;
    const ideas = matching ? matching.slice(offset, offset + limit) : await Promise.all(ids.slice(offset, offset + limit).map(read));
    const checked = parseLibrary(JSON.stringify({ version: 1, sections, projects: ideas }));
    return { ideas: checked.projects.map(summarizeIdea), revision: layout.revision,
      total, nextCursor: offset + limit < total ? { offset: offset + limit, revision: layout.revision, ...(options.sectionId ? { sectionId: options.sectionId } : {}), ...(query ? { query } : {}) } : null };
  });
}

/** Read one complete idea, using only its block IDs; never materialize the entire library. */
export const readLocalIdea = (id: string): Promise<{ idea: Project; revision: number } | null> => transaction(["meta", "sections", "ideas", "blocks"], "readonly", async tx => {
  const layout = await layoutIn(tx);
  if (!layout.ideaIds.includes(id)) return null;
  const row = await request<IdeaRecord | undefined>(tx.objectStore("ideas").get(id));
  if (!row || row.value.id !== id || !Array.isArray(row.blockIds)) throw new Error("Invalid local idea metadata");
  const section = await request<Section>(tx.objectStore("sections").get(row.value.sectionId));
  const blocks = await Promise.all(row.blockIds.map(block => request<TextBlock>(tx.objectStore("blocks").get(blockKey(id, block)))));
  const checked = parseLibrary(JSON.stringify({ version: 1, sections: [section], projects: [{ ...summarizeIdea(row.value), blocks }] }));
  return { idea: checked.projects[0], revision: layout.revision };
});
export async function readLocalLibrary(): Promise<Library> {
  const saved = await readLocalSnapshot();
  if (!saved) throw new Error("Local library is not initialized");
  return saved.library;
}
export const readLocalRaw = async () => { const state = await readLocalSnapshot(); return state ? JSON.stringify(state.library) : null; };
export const readMeta = <T,>(key: string) => transaction(["meta"], "readonly", tx => request<T | undefined>(tx.objectStore("meta").get(key)));
export const readOutbox = () => transaction(["outbox"], "readonly", tx => request<PendingChange[]>(tx.objectStore("outbox").getAll()));

/** Only an untouched generated seed may be replaced automatically on first cloud connection. */
export function isPristineStarter(expected: Library): Promise<boolean> {
  return transaction(["meta", "sections", "ideas", "blocks"], "readonly", async tx => {
    const snapshot = await snapshotIn(tx);
    if (!snapshot || !same(snapshot.library, expected)) return false;
    const starter = await request<{ version: number; revision: number } | undefined>(tx.objectStore("meta").get("starter"));
    if (starter?.version === 1 && starter.revision === snapshot.revision) return true;
    // Older releases already recorded seed provenance. Revision 1 proves no later save occurred.
    const migration = await request<{ version: number; legacy: boolean } | undefined>(tx.objectStore("meta").get("migration"));
    return !starter && migration?.version === 1 && migration.legacy === false && snapshot.revision === 1;
  });
}

function entities(library: Library) {
  const values = new Map<string, PendingChange>();
  for (const section of library.sections) values.set(`section:${section.id}`, { entity: "section", id: section.id, operation: "put", sequence: 0, base: null, value: section });
  for (const idea of library.projects) {
    const { blocks, ...value } = idea;
    values.set(`idea:${idea.id}`, { entity: "idea", id: idea.id, operation: "put", sequence: 0, base: null, value: { ...value, blockIds: blocks.map(b => b.id) } });
    for (const block of blocks) values.set(`block:${blockKey(idea.id, block.id)}`, { entity: "block", id: block.id, ideaId: idea.id, operation: "put", sequence: 0, base: null, value: block });
  }
  return values;
}
async function writeIn(tx: IDBTransaction, library: Library, previous: LocalSnapshot | null, queue: boolean) {
  const sequence = (previous?.revision || 0) + 1;
  const before = entities(previous?.library || { version: 1, sections: [], projects: [] }), after = entities(library);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key), next = after.get(key);
    if (same(old?.value, next?.value)) continue;
    if (queue) {
      const pending: PendingChange | undefined = await request(tx.objectStore("outbox").get(key));
      const base = pending ? pending.base : old?.value ?? null;
      const value = next?.value ?? null;
      if (same(base, value)) tx.objectStore("outbox").delete(key);
      else tx.objectStore("outbox").put({ ...(next || old!), operation: next ? "put" : "delete", base, value, sequence }, key);
    }
    const entity = next || old!;
    const store = tx.objectStore(entity.entity === "section" ? "sections" : entity.entity === "idea" ? "ideas" : "blocks");
    const id = entity.entity === "block" ? blockKey(entity.ideaId!, entity.id) : entity.id;
    if (!next) store.delete(id);
    else if (entity.entity === "idea") {
      const project = library.projects.find(p => p.id === entity.id)!;
      store.put({ value: { ...project, blocks: [] }, blockIds: project.blocks.map(b => b.id) } satisfies IdeaRecord, id);
    } else store.put(entity.value, id);
  }
  const catalog = library.projects.map(p => ({ id: p.id, sectionId: p.sectionId, updatedAt: p.updatedAt })).sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  tx.objectStore("meta").put({ revision: sequence, sectionIds: library.sections.map(s => s.id), ideaIds: library.projects.map(p => p.id), catalog } satisfies Layout, "layout");
  return sequence;
}
function notify(kind:"local"|"remote") {
  try {
    if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel(channelName); channel.postMessage({kind}); channel.close(); }
  } catch { /* Notification failure must not turn a committed save into a reported failure. */ }
  window.dispatchEvent(new CustomEvent(channelName,{detail:{kind}}));
}
export function subscribeLocalChanges(listener: (kind?:"local"|"remote") => void) {
  let channel: BroadcastChannel | null = null;
  try { if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel(channelName); } catch { /* Focus refresh remains available. */ }
  const receive=(event:Event|MessageEvent)=>{const payload="data" in event?event.data:(event as CustomEvent).detail;listener(payload?.kind=== "remote"?"remote":"local");};
  if (channel) channel.onmessage = receive;
  window.addEventListener(channelName, receive);
  return () => { channel?.close(); window.removeEventListener(channelName, receive); };
}
/** Metadata, outbox and cloud checkpoint are committed together with a stale-write guard. */
export async function saveLocalLibrary(library: Library, expected: Library | null, options: { remote?: boolean; cloud?: unknown; files?: ReadonlyMap<string, Blob>; recover?: boolean; checkpoint?: unknown; clearOperation?: boolean; mediaAliases?: ReadonlyMap<string,string> } = {}) {
  const checked = parseLibrary(JSON.stringify(library));
  const sequence = await transaction(["meta", "sections", "ideas", "blocks", "outbox", "media"], "readwrite", async tx => {
    const previous = await snapshotIn(tx);
    if (!same(previous?.library ?? null, expected) && !options.recover) throw new Error(t("Библиотека изменилась в другой вкладке. Сохранение остановлено, чтобы не потерять изменения."));
    const cache: CacheState = await request(tx.objectStore("meta").get(cacheKey)) || {};
    for (const [id, blob] of options.files || []) { tx.objectStore("media").put(blob, id); delete cache[id]; }
    tx.objectStore("meta").put(cache,cacheKey);
    const used = new Set(checked.projects.flatMap(p=>[...(p.coverImage?[p.coverImage.id]:[]),...p.blocks.flatMap(b=>(b.media||[]).map(m=>m.id))]));
    for(const [from,to] of options.mediaAliases || []) {
      if(from===to)continue;
      const blob=await request<Blob|undefined>(tx.objectStore("media").get(from));
      if(blob && !await request(tx.objectStore("media").getKey(to)))tx.objectStore("media").put(blob,to);
      if(!used.has(from))tx.objectStore("media").delete(from);
    }
    const revision = await writeIn(tx, checked, previous, !options.remote);
    tx.objectStore("meta").delete("starter");
    if (options.remote) tx.objectStore("outbox").clear();
    if (options.cloud !== undefined) tx.objectStore("meta").put(options.cloud, "cloud");
    if (options.checkpoint !== undefined) tx.objectStore("meta").put(options.checkpoint, "sync-v2");
    if (options.clearOperation) tx.objectStore("meta").delete("sync-operation");
    if(options.checkpoint) {
      const checkpoint=options.checkpoint as SyncCheckpoint;
      await registerCloudCache(tx,checkpoint);
      await pruneCacheIn(tx,checkpoint.scope,MEDIA_CACHE_LIMIT);
    }
    return revision;
  });
  notify(options.remote?"remote":"local"); return sequence;
}
/** An upload acknowledges only the snapshot sent; newer local writes keep their queue entries. */
export async function acknowledgeUpload(cloud: unknown, sequence: number, sent?: Library) {
  await transaction(["meta", "outbox"], "readwrite", async tx => {
    const changes = await request<PendingChange[]>(tx.objectStore("outbox").getAll());
    const keys = await request(tx.objectStore("outbox").getAllKeys());
    const uploaded = sent ? entities(sent) : null;
    changes.forEach((entry, index) => {
      const key = keys[index];
      if (entry.sequence <= sequence) tx.objectStore("outbox").delete(key);
      else if (uploaded) {
        const base = uploaded.get(String(key))?.value ?? null;
        if (same(base, entry.value)) tx.objectStore("outbox").delete(key);
        else tx.objectStore("outbox").put({ ...entry, base }, key);
      }
    });
    tx.objectStore("meta").put(cloud, "cloud");
  });
}

async function legacyFile(id: string): Promise<Blob | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open("idea-bank.media.v1", 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("files");
    opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    opening.onblocked = () => reject(new Error("Legacy media database blocked"));
  });
  try { return await request(db.transaction("files").objectStore("files").get(id)); } finally { db.close(); }
}
/** Old storage is retained untouched. A layout marker becomes visible only after verification. */
export async function initializeLocalLibrary(seed: () => Promise<{ library: Library; files: ReadonlyMap<string, Blob> }>, options: { ignoreLegacy?: boolean } = {}): Promise<Library> {
  const existing = await readLocalSnapshot(); if (existing) return existing.library;
  const raw = options.ignoreLegacy ? null : localStorage.getItem(STORAGE_KEY), cloudRaw = options.ignoreLegacy ? null : localStorage.getItem(LEGACY_CLOUD_KEY);
  const source = raw === null ? await seed() : { library: parseLibrary(raw), files: new Map<string, Blob>() };
  const ids = new Set(source.library.projects.flatMap(p => [...(p.coverImage ? [p.coverImage.id] : []), ...p.blocks.flatMap(b => (b.media || []).map(m => m.id))]));
  const copied = new Map<string, { size: number; type: string }>();
  // Copy one file at a time; an interrupted migration can reuse staged files on retry.
  for (const id of ids) {
    const blob = source.files.get(id) || await legacyFile(id);
    if (blob) {
      copied.set(id, { size: blob.size, type: blob.type });
      await transaction(["meta", "media"], "readwrite", async tx => {
        if (!await request(tx.objectStore("meta").get("layout"))) tx.objectStore("media").put(blob, id);
      });
    }
  }
  let cloud: unknown = null;
  try {
    const value = cloudRaw ? JSON.parse(cloudRaw) : null;
    cloud = value?.journal ? (raw === value.targetRaw ? value.next : value.previous) : value;
  } catch {}
  const baseline = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source.library))))).map(byte => byte.toString(16).padStart(2, "0")).join("");
  const alreadySynced = !!cloud && typeof cloud === "object" && "baseline" in cloud && cloud.baseline === baseline;
  await transaction(["meta", "sections", "ideas", "blocks", "outbox", "media"], "readwrite", async tx => {
    if (await snapshotIn(tx)) return; // Another tab completed the same migration.
    if (!options.ignoreLegacy && (localStorage.getItem(STORAGE_KEY) !== raw || localStorage.getItem(LEGACY_CLOUD_KEY) !== cloudRaw)) throw new Error("Legacy data changed during migration");
    for (const [id, original] of copied) {
      const saved = await request<Blob | undefined>(tx.objectStore("media").get(id));
      if (!(saved instanceof Blob) || saved.size !== original.size || saved.type !== original.type) throw new Error("Media migration verification failed");
    }
    const revision = await writeIn(tx, source.library, null, !alreadySynced);
    if (raw === null) tx.objectStore("meta").put({ version: 1, revision }, "starter");
    if (cloud) tx.objectStore("meta").put(cloud, "cloud");
    tx.objectStore("meta").put({ version: 1, legacy: raw !== null }, "migration");
    const verified = await snapshotIn(tx);
    if (!same(verified?.library, source.library)) throw new Error("Migration verification failed");
  });
  return readLocalLibrary();
}

/** Retire only an acknowledged full replica. Pending edits and other scopes prevent cleanup. */
export async function retireCloudReplica(scope: string): Promise<boolean> {
  return transaction(["meta", "sections", "ideas", "blocks", "outbox"], "readwrite", async tx => {
    const meta = tx.objectStore("meta"), checkpoint = await request<SyncCheckpoint | undefined>(meta.get("sync-v2"));
    if (checkpoint?.version !== 2 || checkpoint.scope !== scope || !await request(meta.get("layout"))) return false;
    if (await request(tx.objectStore("outbox").count()) || await request(meta.get("sync-operation"))) return false;
    const pending = await request<{scope:string}[]>(meta.get("scoped-queue-v1")) || [];
    if (pending.length) return false;
    // A newer tab now reads through the bounded cache; never re-import the old localStorage backup.
    meta.put({ version: 1, scope }, "cloud-reader");
    for (const key of ["layout", "sync-v2", "cloud", "starter", "migration"]) meta.delete(key);
    for (const name of ["sections", "ideas", "blocks"]) tx.objectStore(name).clear();
    return true;
  });
}

/** Persist a retryable cloud operation before making a network request. */
export async function saveSyncOperation(operation: unknown, expected?: Library, replaceId?: string) {
  await transaction(["meta", "sections", "ideas", "blocks"], "readwrite", async tx => {
    if (expected && !same((await snapshotIn(tx))?.library, expected)) throw new Error(t("Библиотека изменилась в другой вкладке. Сохранение остановлено, чтобы не потерять изменения."));
    const pending = await request(tx.objectStore("meta").get("sync-operation"));
    if (operation === null) {
      if (!replaceId || pending?.body?.operationId === replaceId) tx.objectStore("meta").delete("sync-operation");
    } else {
      if (pending && !same(pending,operation) && pending?.body?.operationId !== replaceId) throw new Error(t("Библиотека изменилась в другой вкладке. Повтори синхронизацию."));
      tx.objectStore("meta").put(operation,"sync-operation");
    }
  });
}
