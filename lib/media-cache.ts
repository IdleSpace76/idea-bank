import { request, transaction } from "./local-database";
import { readMeta } from "./library-store";
import { readMediaFile } from "./media-store";
import { cacheKey, MEDIA_CACHE_LIMIT, pruneCacheIn, type CacheState } from "./media-cache-store";
import { contentId, entityKey, type SyncCheckpoint } from "./entity-sync";
import { parseCloudMedia } from "./cloud-library";
import { downloadCloudMedia } from "./cloud-sync";
import { translate as t } from "./i18n";
import { cloudFetch,CloudAccessError } from "./cloud-access";

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
  const key=JSON.stringify([scope,id]),existing=downloads.get(key);
  if(existing)return existing;
  const task=loadMediaFile(id,scope);downloads.set(key,task);
  try{return await task;}finally{if(downloads.get(key)===task)downloads.delete(key);}
}
async function loadMediaFile(id: string, scope?: string): Promise<Blob | undefined> {
  const local = await readMediaFile(id);
  if (local) {
    if (scope) await transaction(["meta"], "readwrite", async tx => {
      const store = tx.objectStore("meta"), entries: CacheState = await request(store.get(cacheKey)) || {};
      if (entries[id]?.scope === scope && Date.now()-entries[id].used>=30000) { entries[id].used = Date.now(); store.put(entries, cacheKey); }
    }).catch(() => {});
    return local;
  }
  if (!scope) return;
  const alias=(await readMeta<Record<string,import("./cloud-library").CloudMedia>>("scoped-media-aliases"))?.[id];
  if(alias && alias.id!==id)return getMediaFile(alias.id,scope);
  return downloadSlot(()=>fetchMedia(id,scope));
}

async function fetchMedia(id: string, scope: string): Promise<Blob | undefined> {
  const checkpoint = await readMeta<SyncCheckpoint>("sync-v2"), key = entityKey("media",id);
  const known = checkpoint?.scope === scope && checkpoint.index[key]?.length === 1 && checkpoint.values[key];
  const path = known ? `/api/sync/media?key=${encodeURIComponent(key)}&revision=${checkpoint!.index[key][0]}` : `/api/catalog/media?id=${encodeURIComponent(id)}`;
  let response:Response;
  try {response=await cloudFetch(path, { credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(120000) },scope);}
  catch(error){if(error instanceof CloudAccessError)throw new Error(t(error.message));throw error;}
  if (!response.ok) {
    const data=await response.json().catch(()=>null);
    throw new Error(t(data?.error?.message || (response.status === 401 ? "Сессия истекла. Сохрани правки и войди через GitHub снова." : "Не удалось получить вложение из облака.")));
  }
  const signed = await response.json(), file = parseCloudMedia(known || signed.media);
  if (contentId(file) !== id) throw new Error(t("Не удалось получить вложение из облака."));
  const blob = await downloadCloudMedia(file,signed.url);
  // Oversized files can be viewed without forcing them into the persistent cache.
  if (blob.size <= MEDIA_CACHE_LIMIT) {
    await transaction(["meta","media"],"readwrite",async tx => {
      const meta=tx.objectStore("meta");
      // Never turn an independently saved local original into an evictable cache entry.
      const entries:CacheState=await request(meta.get(cacheKey))||{};
      if(await request(tx.objectStore("media").getKey(id)) && !entries[id])return;
      await pruneCacheIn(tx,scope,MEDIA_CACHE_LIMIT-blob.size);
      const next:CacheState=await request(meta.get(cacheKey))||{};
      tx.objectStore("media").put(blob,id); next[id]={scope,size:blob.size,used:Date.now()}; meta.put(next,cacheKey);
    }).catch(() => { /* A full/disabled cache must not prevent viewing a verified cloud file. */ });
  }
  return blob;
}
