import { request, transaction } from "./local-database";

export const READER_CACHE_BYTES = 32 * 1024 * 1024;
export const READER_CACHE_IDEAS = 20;
export const READER_CACHE_PAGES = 20;
type Kind = "idea" | "page";
type Entry = { key: string; kind: Kind; bytes: number; used: number; scope?:string; stale?:boolean };
const indexKey = "reader-cache-v1";
const entryKey = (scope: string, kind: Kind, id: string) => `reader-entry:${JSON.stringify([scope,kind,id])}`;

/** This cache contains verified downloads only. Originals, drafts and the outbox use other keys. */
export async function readReaderCache<T>(scope: string, kind: Kind, id: string): Promise<T | undefined> {
  const key=entryKey(scope,kind,id);
  const value=await transaction(["meta"],"readonly",tx=>request<T | undefined>(tx.objectStore("meta").get(key)));
  if (value !== undefined) {
    await transaction(["meta"],"readwrite",async tx=>{
      const meta=tx.objectStore("meta");
      const entries = await request<Entry[] | undefined>(meta.get(indexKey)) || [];
      const entry = entries.find(entry => entry.key === key);
      if (entry && Date.now()-entry.used>=30000) { entry.used = Date.now(); meta.put(entries,indexKey); }
    }).catch(()=>{});
  }
  return value;
}

export async function writeReaderCache(scope: string, kind: Kind, id: string, value: unknown, limit = READER_CACHE_BYTES) {
  await transaction(["meta"],"readwrite",tx=>writeReaderCacheIn(tx,scope,kind,id,value,limit));
}
export async function writeReaderCacheIn(tx: IDBTransaction, scope: string, kind: Kind, id: string, value: unknown, limit = READER_CACHE_BYTES) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const meta = tx.objectStore("meta"), key = entryKey(scope,kind,id);
    const entries = (await request<Entry[] | undefined>(meta.get(indexKey)) || []).filter(entry => entry.key !== key);
    meta.delete(key);
    if (bytes <= limit) { meta.put(value,key); entries.push({key,kind,bytes,scope,stale:false,used:Date.now()}); }
    entries.sort((a,b) => a.used - b.used);
    let total = entries.reduce((sum,entry) => sum + entry.bytes,0);
    const count = (kind: Kind) => entries.filter(entry => entry.kind === kind).length;
    while (entries.length && (total > limit || count("idea") > READER_CACHE_IDEAS || count("page") > READER_CACHE_PAGES)) {
      const overKind = count("idea") > READER_CACHE_IDEAS ? "idea" : count("page") > READER_CACHE_PAGES ? "page" : null;
      const offset = overKind ? entries.findIndex(entry => entry.kind === overKind) : 0;
      const [removed] = entries.splice(offset,1); total -= removed.bytes; meta.delete(removed.key);
    }
    meta.put(entries,indexKey);
}

export const removeReaderCache = (scope: string, kind: Kind, id: string) => transaction(["meta"],"readwrite",tx=>removeReaderCacheIn(tx,scope,kind,id));
export async function removeReaderCacheIn(tx:IDBTransaction,scope:string,kind:Kind,id:string) {
  const meta = tx.objectStore("meta"), key = entryKey(scope,kind,id);
  meta.delete(key);
  const entries = await request<Entry[] | undefined>(meta.get(indexKey)) || [];
  meta.put(entries.filter(entry => entry.key !== key),indexKey);
}
/** A notification invalidates metadata only; closed document bodies are never read here. */
export const markReaderStale=(scope:string)=>transaction(["meta"],"readwrite",async tx=>{
  const meta=tx.objectStore("meta"),entries=await request<Entry[]>(meta.get(indexKey)) || [];
  let changed=false;
  for(const entry of entries)if(entry.scope===scope && entry.kind==="idea" && !entry.stale){entry.stale=true;changed=true;}
  if(changed)meta.put(entries,indexKey);
});
export const markReaderFresh=(scope:string,id:string)=>transaction(["meta"],"readwrite",async tx=>{
  const meta=tx.objectStore("meta"),entries=await request<Entry[]>(meta.get(indexKey)) || [];
  const entry=entries.find(entry=>entry.key===entryKey(scope,"idea",id));if(entry?.stale){entry.stale=false;meta.put(entries,indexKey);}
});
