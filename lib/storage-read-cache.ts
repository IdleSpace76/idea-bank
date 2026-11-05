import { createHash } from "node:crypto";
import type { B2Storage } from "./b2-storage";

export const STORAGE_READ_CACHE_BYTES = 8 * 1024 * 1024;
export const STORAGE_READ_CACHE_ENTRIES = 256;
export const STORAGE_READ_CACHE_TTL = 5 * 60 * 1000;
type Entry = { json: string; bytes: number; expires: number };
const entries = new Map<string, Entry>(), pending = new Map<string, Promise<unknown>>();
const namespaces = new WeakMap<B2Storage, string>();
let bytes = 0, generation = 0;
function identity(storage: B2Storage, key: string) {
  let namespace = namespaces.get(storage);
  if (!namespace) {
    const s = storage.settings;
    // Credential changes must never reuse a value read with an older key's permissions.
    namespace = createHash("sha256").update(JSON.stringify([s.endpoint,s.bucket,s.keyId,s.applicationKey,storage.prefix])).digest("hex");
    namespaces.set(storage, namespace);
  }
  return `${namespace}:${key}`;
}
function remove(key: string) {
  const entry = entries.get(key);
  if (entry) { bytes -= entry.bytes; entries.delete(key); }
}
/** Test/maintenance hook. Does not delete or modify anything in B2. */
export function clearStorageReadCache() { generation++; entries.clear(); pending.clear(); bytes = 0; }

/** Positive immutable JSON only. Mutable pointers, missing objects and errors must stay uncached. */
export async function cachedStorageRead<T>(storage: B2Storage, key: string, load: () => Promise<T>): Promise<T> {
  const id = identity(storage, key), now = Date.now(), saved = entries.get(id);
  if (saved && saved.expires > now) {
    entries.delete(id); entries.set(id,saved);
    return JSON.parse(saved.json) as T;
  }
  if (saved) remove(id);
  const active = pending.get(id);
  if (active) return structuredClone(await active) as T;
  const current = generation;
  const operation = (async () => {
    const value = await load();
    if (value !== null && value !== undefined && current === generation) {
      const json = JSON.stringify(value), size = Buffer.byteLength(json);
      if (size <= STORAGE_READ_CACHE_BYTES) {
        for (const [key,entry] of entries) if (entry.expires <= Date.now()) remove(key);
        remove(id);
        while (entries.size && (bytes + size > STORAGE_READ_CACHE_BYTES || entries.size >= STORAGE_READ_CACHE_ENTRIES)) remove(entries.keys().next().value!);
        entries.set(id,{json,bytes:size,expires:Date.now()+STORAGE_READ_CACHE_TTL}); bytes += size;
      }
    }
    return value;
  })();
  // Bound concurrent bookkeeping too; excess distinct reads simply bypass coalescing.
  if (pending.size < STORAGE_READ_CACHE_ENTRIES) pending.set(id,operation);
  try { return structuredClone(await operation); }
  finally { if (pending.get(id) === operation) pending.delete(id); }
}
