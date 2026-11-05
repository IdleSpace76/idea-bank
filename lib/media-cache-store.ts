import { request } from "./local-database";
import { contentId, entityKey, type SyncCheckpoint } from "./entity-sync";

export const MEDIA_CACHE_LIMIT = 128 * 1024 * 1024;
export const cacheKey = "media-cache";
export type CacheState = Record<string, { scope: string; size: number; used: number }>;

/** Only committed cloud records make a local original safe to evict. */
export async function registerCloudCache(tx: IDBTransaction, checkpoint: SyncCheckpoint) {
  const store = tx.objectStore("meta"), entries: CacheState = await request(store.get(cacheKey)) || {};
  for (const file of checkpoint.files) {
    if (file.id !== contentId(file) || checkpoint.index[entityKey("media", file.id)]?.length !== 1) continue;
    if (await request(tx.objectStore("media").getKey(file.id))) entries[file.id] = { scope: checkpoint.scope, size: file.size, used: entries[file.id]?.used || Date.now() };
  }
  store.put(entries, cacheKey);
}

/** Runs inside the same transaction as cache writes, including in other tabs. */
export async function pruneCacheIn(tx: IDBTransaction, scope: string, limit: number) {
  const meta = tx.objectStore("meta"), entries: CacheState = await request(meta.get(cacheKey)) || {};
  const candidates = Object.entries(entries).filter(([, entry]) => entry.scope === scope).sort((a,b) => a[1].used - b[1].used);
  let size = candidates.reduce((sum, [, entry]) => sum + entry.size, 0);
  for (const [id, entry] of candidates) {
    if (size <= limit) break;
    tx.objectStore("media").delete(id); delete entries[id]; size -= entry.size;
  }
  meta.put(entries, cacheKey);
}
