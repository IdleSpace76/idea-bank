import { request, transaction } from "./local-database";
import type { ReaderPage } from "./library-reader";
import type { ScopedSummary } from "./scoped-types";
import type { EntityIndex } from "./entity-sync";
import {readerCursor,readerCursorOffset,readerPageKey} from "./reader-batch-types";

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

/** Apply an acknowledged edit in the same transaction that removes it from the outbox. */
export async function settleReaderPagesIn(tx:IDBTransaction,scope:string,rows:ScopedSummary|ScopedSummary[],revision:string,versions?:EntityIndex) {
  const meta=tx.objectStore("meta"),entries=await request<Entry[]>(meta.get(indexKey)) || [];
  const snapshots=[];
  for(const entry of entries.filter(entry=>entry.scope===scope && entry.kind==="page")) {
    const page=await request<ReaderPage|undefined>(meta.get(entry.key));if(!page)continue;
    const id=JSON.parse(entry.key.slice("reader-entry:".length))[2] as string,params=new URLSearchParams(id);
    snapshots.push({entry,page,id,params,offset:readerCursorOffset(params.get("cursor")),group:JSON.stringify([params.get("sectionId"),params.get("q")?.trim().toLowerCase() || ""])});
  }
  const edits=Array.isArray(rows)?rows:[rows];
  const order=(a:import("./ideas").IdeaSummary,b:import("./ideas").IdeaSummary)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)||a.id.localeCompare(b.id);
  let changed=false;const invalidated=new Set<string>();
  for(const {entry,page,id,params,offset,group} of snapshots) {
    if(page.revision===revision)continue;
    const sectionId=params.get("sectionId"),query=params.get("q")?.trim().toLowerCase();
    const matches=(idea:ScopedSummary["idea"])=>!!idea && (!sectionId || idea.sectionId===sectionId) && (!query || `${idea.name}\n${idea.description}`.toLowerCase().includes(query));
    const siblings=snapshots.filter(value=>value.group===group).sort((a,b)=>a.offset-b.offset);
    let covered=0;
    const pool=new Map<string,import("./ideas").IdeaSummary>();
    for(const sibling of siblings) {
      if(sibling.offset>covered)break;
      for(const idea of sibling.page.ideas)pool.set(idea.id,idea);
      covered=Math.max(covered,sibling.offset+sibling.page.ideas.length);
    }
    const boundary=[...pool.values()].sort(order).at(-1),complete=covered>=page.total;
    for(const row of edits) {
      if(row.target.kind==="idea") {
        const known=pool.has(row.target.id);pool.delete(row.target.id);
        if(row.idea && matches(row.idea) && (known || complete || !boundary || order(row.idea,boundary)<=0))pool.set(row.idea.id,row.idea);
      }else if(!row.section)for(const [id,idea] of pool)if(idea.sectionId===row.target.id)pool.delete(id);
    }
    const next:ReaderPage={...page,sections:[...page.sections],ideas:[...page.ideas],counts:{...page.counts}};
    for(const row of Array.isArray(rows)?rows:[rows]) {
    const key=`${row.target.kind==="idea"?"idea":"section"}:${JSON.stringify([row.target.id])}`;
    if(versions && Object.hasOwn(versions,key) && JSON.stringify(next.applied?.[key])===JSON.stringify(versions[key]))continue;
    if(versions?.[key])next.applied={...next.applied,[key]:versions[key]};
    if(row.target.kind==="idea") {
      const current=next.ideas.find(idea=>idea.id===row.target.id);
      const alreadyApplied=current && JSON.stringify(current)===JSON.stringify(row.idea);
      if(!alreadyApplied) {
        if(row.before && (!row.idea || row.before.sectionId!==row.idea.sectionId))next.counts[row.before.sectionId]=Math.max(0,(next.counts[row.before.sectionId] || 0)-1);
        if(row.idea && (!row.before || row.before.sectionId!==row.idea.sectionId))next.counts[row.idea.sectionId]=(next.counts[row.idea.sectionId] || 0)+1;
        next.total=Math.max(0,next.total+Number(matches(row.idea))-Number(matches(row.before)));
      }
      next.ideas=next.ideas.filter(idea=>idea.id!==row.target.id);
      // Put a new card on the first page only; cursor pages must not duplicate it.
      if(row.idea && matches(row.idea) && (current || !params.has("cursor")))next.ideas.push(row.idea);
      next.ideas.sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)||a.id.localeCompare(b.id));
    } else if(row.section) {
      const offset=next.sections.findIndex(section=>section.id===row.target.id);
      if(offset<0)next.sections.push(row.section);else next.sections[offset]=row.section;
    } else {
      const removed=next.ideas.filter(idea=>idea.sectionId===row.target.id).length;
      next.sections=next.sections.filter(section=>section.id!==row.target.id);
      next.ideas=next.ideas.filter(idea=>idea.sectionId!==row.target.id);
      next.total=Math.max(0,next.total-(query?removed:sectionId && sectionId!==row.target.id?0:next.counts[row.target.id] || 0));
      delete next.counts[row.target.id];
    }
    }
    if(offset<=covered) {
      const limit=Number(params.get("limit") || 24);
      next.ideas=[...pool.values()].sort(order).slice(offset,offset+limit);
      next.nextCursor=next.total>offset+next.ideas.length?readerCursor({sectionId:sectionId || undefined,query:params.get("q") || undefined},revision,offset+next.ideas.length):null;
      if(offset>0 && !next.ideas.length && next.total>offset){meta.delete(entry.key);invalidated.add(entry.key);changed=true;continue;}
    }
    if(params.has("cursor")) {
      const nextId=readerPageKey({sectionId:sectionId || undefined,query:params.get("q") || undefined,cursor:readerCursor({sectionId:sectionId || undefined,query:params.get("q") || undefined},revision,offset),limit:Number(params.get("limit") || 24)});
      const nextKey=entryKey(scope,"page",nextId);
      if(entry.key!==nextKey){meta.delete(entry.key);entry.key=nextKey;changed=true;}
    }
    const json=JSON.stringify(next);
    if(json===JSON.stringify(page) && entry.key===entryKey(scope,"page",id))continue;
    meta.put(next,entry.key);entry.bytes=new TextEncoder().encode(json).byteLength;changed=true;
  }
  if(changed) {
    entries.splice(0,entries.length,...new Map(entries.filter(entry=>!invalidated.has(entry.key)).map(entry=>[entry.key,entry])).values());
    let bytes=entries.reduce((sum,entry)=>sum+entry.bytes,0);
    entries.sort((a,b)=>a.used-b.used);
    while(entries.length && bytes>READER_CACHE_BYTES){const removed=entries.shift()!;bytes-=removed.bytes;meta.delete(removed.key);}
    meta.put(entries,indexKey);
  }
}

export async function readerPagesIn(tx:IDBTransaction,scope:string) {
  const meta=tx.objectStore("meta"),entries=await request<Entry[]>(meta.get(indexKey)) || [];
  const pages:{id:string;value:ReaderPage}[]=[];
  for(const entry of entries)if(entry.scope===scope && entry.kind==="page") {
    const value=await request<ReaderPage|undefined>(meta.get(entry.key));
    if(value)pages.push({id:JSON.parse(entry.key.slice("reader-entry:".length))[2],value});
  }
  return pages;
}

export type ReaderInventory={epoch:number;fresh:boolean;heads?:string[];pages:{id:string;value:ReaderPage}[];ideas:{id:string;value:import("./library-reader").ReaderIdea}[]};
export const readerCheckpointKey=(scope:string)=>`reader-checkpoint:${scope}`;
/** One local transaction supplies the checkpoint and the bounded set of cached documents. */
export const readReaderInventory=(scope:string):Promise<ReaderInventory>=>transaction(["meta"],"readonly",async tx=>{
  const meta=tx.objectStore("meta"),entries=(await request<Entry[]>(meta.get(indexKey)) || []).filter(entry=>entry.scope===scope);
  const epoch=await request<number>(meta.get(epochKey(scope))) || 0;let fresh=true;
  const pages:ReaderInventory["pages"]=[],ideas:ReaderInventory["ideas"]=[];
  for(const entry of entries) {
    const id=JSON.parse(entry.key.slice("reader-entry:".length))[2] as string;
    if(entry.kind==="idea" && id.startsWith("edit:"))continue;
    fresh=fresh && entry.session===session && entry.epoch===epoch && !entry.stale;
    const value=await request<any>(meta.get(entry.key));if(!value)continue;
    if(entry.kind==="page")pages.push({id,value});else if(value.idea)ideas.push({id,value});
  }
  return {epoch,fresh,heads:await request<string[]|undefined>(meta.get(readerCheckpointKey(scope))),pages,ideas};
});
export async function readerEpochIn(tx:IDBTransaction,scope:string){return await request<number>(tx.objectStore("meta").get(epochKey(scope))) || 0;}
/** Reject packets that started before a newly acknowledged local write. */
export async function advanceReaderEpochIn(tx:IDBTransaction,scope:string) {
  const meta=tx.objectStore("meta"),epoch=await readerEpochIn(tx,scope),entries=await request<Entry[]>(meta.get(indexKey)) || [];
  meta.put(epoch+1,epochKey(scope));let changed=false;
  for(const entry of entries)if(entry.scope===scope && entry.epoch===epoch){entry.epoch=epoch+1;changed=true;}
  if(changed)meta.put(entries,indexKey);
}
/** A validated checkpoint freshens metadata without rewriting unchanged document bodies. */
export async function freshenReaderEntriesIn(tx:IDBTransaction,scope:string,ids:Set<string>) {
  const meta=tx.objectStore("meta"),entries=await request<Entry[]>(meta.get(indexKey)) || [],epoch=await readerEpochIn(tx,scope);
  let changed=false;
  for(const entry of entries)if(entry.scope===scope && ids.has(entry.key) && (entry.epoch!==epoch || entry.session!==session || entry.stale)){entry.epoch=epoch;entry.session=session;entry.stale=false;changed=true;}
  if(changed)meta.put(entries,indexKey);
}

/** Verified downloads and acknowledged edits. Originals, drafts and the outbox use other keys. */
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
