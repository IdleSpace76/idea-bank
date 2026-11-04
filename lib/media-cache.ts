import { request, transaction } from "./local-database";
import { readMeta } from "./library-store";
import { readMediaFile } from "./media-store";
import { cacheKey, MEDIA_CACHE_LIMIT, pruneCacheIn, type CacheState } from "./media-cache-store";
import { contentId, entityKey, type SyncCheckpoint } from "./entity-sync";
import { parseCloudMedia } from "./cloud-library";
import { downloadCloudMedia } from "./cloud-sync";
import { translate as t } from "./i18n";

const downloads = new Map<string, Promise<Blob | undefined>>();
let active=0;
const waiting:Array<()=>void>=[];
async function downloadSlot<T>(work:()=>Promise<T>):Promise<T>{
  if(active>=2)await new Promise<void>(resolve=>waiting.push(resolve));else active++;
  try{return await work();}finally{const next=waiting.shift();if(next)next();else active--;}
}

export async function trimMediaCache(scope: string, limit = MEDIA_CACHE_LIMIT) {
  await transaction(["meta", "media"], "readwrite", tx => pruneCacheIn(tx, scope, limit));
}

/** Local originals work offline. Missing cloud files are fetched once per active request. */
export async function getMediaFile(id: string, scope?: string): Promise<Blob | undefined> {
  const local = await readMediaFile(id);
  if (local) {
    if (scope) await transaction(["meta"], "readwrite", async tx => {
      const store = tx.objectStore("meta"), entries: CacheState = await request(store.get(cacheKey)) || {};
      if (entries[id]?.scope === scope) { entries[id].used = Date.now(); store.put(entries, cacheKey); }
    }).catch(() => {});
    return local;
  }
  if (!scope) return;
  const key = JSON.stringify([scope,id]), existing = downloads.get(key);
  if (existing) return existing;
  const task = downloadSlot(()=>fetchMedia(id,scope)); downloads.set(key, task);
  try { return await task; } finally { downloads.delete(key); }
}

async function fetchMedia(id: string, scope: string): Promise<Blob | undefined> {
  const checkpoint = await readMeta<SyncCheckpoint>("sync-v2"), key = entityKey("media",id);
  if (checkpoint?.scope !== scope || checkpoint.index[key]?.length !== 1 || !checkpoint.values[key]) return;
  const file = parseCloudMedia(checkpoint.values[key]);
  if (contentId(file) !== id) return;
  const response = await fetch(`/api/sync/media?key=${encodeURIComponent(key)}&revision=${checkpoint.index[key][0]}`, { credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(t(response.status === 401 ? "Сессия истекла. Сохрани правки и войди через GitHub снова." : "Не удалось получить вложение из облака."));
  const signed = await response.json(), blob = await downloadCloudMedia(file,signed.url);
  // Oversized files can be viewed without forcing them into the persistent cache.
  if (blob.size <= MEDIA_CACHE_LIMIT) {
    await transaction(["meta","media"],"readwrite",async tx => {
      const meta=tx.objectStore("meta"), current=await request<SyncCheckpoint|undefined>(meta.get("sync-v2"));
      if(current?.scope!==scope || !current.values[key])return;
      await pruneCacheIn(tx,scope,MEDIA_CACHE_LIMIT-blob.size);
      const entries:CacheState=await request(meta.get(cacheKey))||{};
      tx.objectStore("media").put(blob,id); entries[id]={scope,size:blob.size,used:Date.now()}; meta.put(entries,cacheKey);
    }).catch(() => { /* A full/disabled cache must not prevent viewing a verified cloud file. */ });
  }
  return blob;
}
