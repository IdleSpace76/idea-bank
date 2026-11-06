import { request, transaction } from "./local-database";

export const READER_CACHE_BYTES = 32 * 1024 * 1024;
export const READER_CACHE_IDEAS = 20;
export const READER_CACHE_PAGES = 20;
type Kind = "idea" | "page";
type Entry = { key: string; kind: Kind; bytes: number; used: number; scope?:string; stale?:boolean; session?:string; epoch?:number; revision?:string };
const indexKey = "reader-cache-v1";
const entryKey = (scope: string, kind: Kind, id: string) => `reader-entry:${JSON.stringify([scope,kind,id])}`;
const epochKey=(scope:string)=>`reader-epoch:${scope}`;
const revisionKey=(scope:string)=>`reader-revision:${scope}`;
const session=crypto.randomUUID();
export type ReaderCacheState<T>={value:T|undefined;fresh:boolean;epoch:number};

/** This cache contains verified downloads only. Originals, drafts and the outbox use other keys. */
export async function readReaderCache<T>(scope: string, kind: Kind, id: string): Promise<T | undefined> {
  return (await readReaderCacheState<T>(scope,kind,id)).value;
}
/** Freshness is scoped to this page session and the last invalidation, not just to a stored body. */
export async function readReaderCacheState<T>(scope:string,kind:Kind,id:string):Promise<ReaderCacheState<T>> {
  const key=entryKey(scope,kind,id);
  const state=await transaction(["meta"],"readonly",async tx=>{
    const meta=tx.objectStore("meta"),value=await request<T|undefined>(meta.get(key));
    const epoch=await request<number|undefined>(meta.get(epochKey(scope))) || 0;
    const entries=value===undefined?[]:await request<Entry[]|undefined>(meta.get(indexKey)) || [];
    const entry=entries.find(entry=>entry.key===key);
    return {value,epoch,fresh:!!entry && entry.session===session && entry.epoch===epoch && !entry.stale,used:entry?.used};
  });
  if (state.value !== undefined && state.used!==undefined && Date.now()-state.used>=30000) {
    await transaction(["meta"],"readwrite",async tx=>{
      const meta=tx.objectStore("meta");
      const entries = await request<Entry[] | undefined>(meta.get(indexKey)) || [];
      const entry = entries.find(entry => entry.key === key);
      if (entry && Date.now()-entry.used>=30000) { entry.used = Date.now(); meta.put(entries,indexKey); }
    }).catch(()=>{});
  }
  return state;
}

export async function writeReaderCache(scope: string, kind: Kind, id: string, value: unknown, limit = READER_CACHE_BYTES, expectedEpoch?:number) {
  await transaction(["meta"],"readwrite",tx=>writeReaderCacheIn(tx,scope,kind,id,value,limit,expectedEpoch));
}
export async function writeReaderCacheIn(tx: IDBTransaction, scope: string, kind: Kind, id: string, value: unknown, limit = READER_CACHE_BYTES, expectedEpoch?:number) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const meta = tx.objectStore("meta"), key = entryKey(scope,kind,id);
    let epoch=await request<number|undefined>(meta.get(epochKey(scope))) || 0;
    const stored=await request<Entry[] | undefined>(meta.get(indexKey)) || [];
    const outdated=expectedEpoch!==undefined && expectedEpoch!==epoch;
    if(outdated) {
      // Keep a newer downloaded body for display/offline use, without declaring it current.
      // Never overwrite a body already observed in the same or a newer generation.
      const existing=stored.find(entry=>entry.key===key);
      if(existing && (existing.epoch ?? -1)>=expectedEpoch)return;
      epoch=expectedEpoch;
    }
    const entries = stored.filter(entry => entry.key !== key);
    const revision=kind==="page" && value && typeof value==="object" && "revision" in value && typeof value.revision==="string"?value.revision:undefined;
    if(revision!==undefined && !outdated) {
      const previous=await request<string|undefined>(meta.get(revisionKey(scope)));
      if(previous!==undefined && previous!==revision){epoch++;meta.put(epoch,epochKey(scope));}
      meta.put(revision,revisionKey(scope));
      // A verified catalog revision also validates other stored pages of the same immutable view.
      for(const entry of entries)if(entry.scope===scope && entry.kind==="page" && entry.revision===revision){entry.session=session;entry.epoch=epoch;entry.stale=false;}
    }
    meta.delete(key);
    if (bytes <= limit) { meta.put(value,key); entries.push({key,kind,bytes,scope,session,epoch,revision,stale:outdated,used:Date.now()}); }
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
/** Invalidate cached pages and documents; the epoch also protects against older in-flight reads. */
export const markReaderStale=(scope:string)=>transaction(["meta"],"readwrite",async tx=>{
  const meta=tx.objectStore("meta"),entries=await request<Entry[]>(meta.get(indexKey)) || [];
  const epoch=await request<number|undefined>(meta.get(epochKey(scope))) || 0;
  meta.put(epoch+1,epochKey(scope));
  let changed=false;
  for(const entry of entries)if(entry.scope===scope && !entry.stale){entry.stale=true;changed=true;}
  if(changed)meta.put(entries,indexKey);
});
export const markReaderFresh=(scope:string,id:string,expectedEpoch?:number)=>transaction(["meta"],"readwrite",async tx=>{
  const meta=tx.objectStore("meta"),entries=await request<Entry[]>(meta.get(indexKey)) || [];
  const epoch=await request<number|undefined>(meta.get(epochKey(scope))) || 0;
  if(expectedEpoch!==undefined && expectedEpoch!==epoch)return;
  const entry=entries.find(entry=>entry.key===entryKey(scope,"idea",id));
  if(entry && (entry.stale || entry.session!==session || entry.epoch!==epoch)){entry.stale=false;entry.session=session;entry.epoch=epoch;meta.put(entries,indexKey);}
});
