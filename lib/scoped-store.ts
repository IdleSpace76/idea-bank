import { request,transaction } from "./local-database";
import { equal,entityKey,mergeValue,type EntityMap } from "./entity-sync";
import { summarizeIdea,type IdeaSummary,type Project,type Section } from "./ideas";
import { removeReaderCacheIn,writeReaderCacheIn } from "./reader-cache";
import { cacheKey,pruneCacheIn,MEDIA_CACHE_LIMIT,type CacheState } from "./media-cache-store";
import type { CloudMedia } from "./cloud-library";
import { editCacheId,targetKey,type ScopedEntry,type ScopedOperation,type ScopedRead,type ScopedSummary,type SyncTarget } from "./scoped-types";
const indexKey="scoped-queue-v1",channelName="idea-bank.scoped.changes";
const activeBatches=new Map<string,number>();
export const scopedBatchActive=(scope:string)=>!!activeBatches.get(scope);
/** Keep local acknowledgements from making the reader re-display an older catalog mid-batch. */
export function beginScopedBatch(scope:string) {
  activeBatches.set(scope,(activeBatches.get(scope)||0)+1);
  return ()=>{const count=(activeBatches.get(scope)||1)-1;if(count)activeBatches.set(scope,count);else activeBatches.delete(scope);};
}
type Deletion={scope:string;kind:"idea"|"section";id:string;counter:number};
export const readScopedDeletions=():Promise<Deletion[]>=>transaction(["meta"],"readonly",async tx=>await request(tx.objectStore("meta").get("scoped-deletions")) || []);
export const scopedReadCounter=():Promise<number>=>transaction(["meta"],"readonly",async tx=>await request(tx.objectStore("meta").get("scoped-confirmed-counter")) || 0);
export async function observeScopedAlive(scope:string,ideas:string[],sections:string[],started:number) {
  await transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),rows=await request<Deletion[]>(meta.get("scoped-deletions")) || [];
    const next=rows.filter(row=>row.scope!==scope || row.counter>started || !(row.kind==="idea"?ideas:sections).includes(row.id));
    if(next.length!==rows.length)meta.put(next,"scoped-deletions");
  });
}
export async function noteScopedDeletion(scope:string,id:string) {
  await transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),rows=await request<Deletion[]>(meta.get("scoped-deletions")) || [];
    if(rows.some(row=>row.scope===scope && row.kind==="idea" && row.id===id))return;
    const counter=(await request<number>(meta.get("scoped-confirmed-counter")) || 0)+1;
    meta.put(counter,"scoped-confirmed-counter");meta.put([...rows,{scope,kind:"idea",id,counter}],"scoped-deletions");
  });
}
export function notifyScoped(scope:string) {
  try{const channel=new BroadcastChannel(channelName);channel.postMessage(scope);channel.close();}catch{}
  window.dispatchEvent(new CustomEvent(channelName,{detail:scope}));
}
export function subscribeScoped(listener:(scope:string,external?:boolean)=>void) {
  let channel:BroadcastChannel|null=null;
  try{channel=new BroadcastChannel(channelName);channel.onmessage=event=>{if(typeof event.data==="string")listener(event.data,true);};}catch{}
  const receive=(event:Event)=>{const value=(event as CustomEvent).detail;if(typeof value==="string")listener(value);};
  window.addEventListener(channelName,receive);return()=>{channel?.close();window.removeEventListener(channelName,receive);};
}
export const readScopedIndex=():Promise<ScopedSummary[]>=>transaction(["meta"],"readonly",async tx=>await request(tx.objectStore("meta").get(indexKey)) || []);
export const readScopedEntry=(scope:string,target:SyncTarget):Promise<ScopedEntry|undefined>=>transaction(["meta"],"readonly",tx=>request(tx.objectStore("meta").get(targetKey(scope,target))));
function summary(entry:ScopedEntry):ScopedSummary {
  const key=entityKey(entry.target.kind==="idea"?"idea":"section",entry.target.id);
  const before=entry.base.records.find(record=>record.key===key)?.value;
  return {key:targetKey(entry.scope,entry.target),scope:entry.scope,target:entry.target,sequence:entry.sequence,
    ...(entry.target.kind==="idea"?{before:before?summarizeIdea(before as IdeaSummary):null,idea:entry.local[key]?summarizeIdea(entry.local[key] as IdeaSummary):null}:{section:entry.local[key] as Section|null}),
    deletedIds:Object.entries(entry.local).filter(([key,value])=>key.startsWith("idea:") && !value).map(([key])=>JSON.parse(key.slice(5))[0])};
}
export async function queueScoped(scope:string,target:SyncTarget,base:ScopedRead,local:EntityMap,expectedSequence:number) {
  const entry=await transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),key=targetKey(scope,target),previous=await request<ScopedEntry|undefined>(meta.get(key));
    if((previous?.sequence || 0)!==expectedSequence)throw new Error("Библиотека изменилась в другой вкладке. Сохранение остановлено, чтобы не потерять изменения.");
    const index=await request<ScopedSummary[]>(meta.get(indexKey)) || [];
    for(const other of index.filter(row=>row.scope===scope && row.key!==key)) {
      const idea=local[entityKey("idea",target.id)] as {sectionId:string}|null;
      if(other.target.kind==="section-tree" && (!other.section && (idea?.sectionId===other.target.id || other.deletedIds.includes(target.id))) || target.kind==="section-tree" && other.idea?.sectionId===target.id)throw new Error("Сначала завершите синхронизацию и разрешите конфликты.");
    }
    const sequence=(await request<number>(meta.get("scoped-sequence")) || 0)+1;
    const next:ScopedEntry={scope,target,sequence,base:previous?.base || base,local,...(previous?.operation?{operation:previous.operation}:{})};
    meta.put(sequence,"scoped-sequence");meta.put(next,key);meta.put([...index.filter(row=>row.key!==key),summary(next)],indexKey);return next;
  });notifyScoped(scope);return entry;
}
export async function persistScopedOperation(entry:ScopedEntry,operation:ScopedOperation) {
  return transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),key=targetKey(entry.scope,entry.target),current=await request<ScopedEntry|undefined>(meta.get(key));
    if(!current || current.sequence!==entry.sequence) return false;
    if(current.operation && !equal(current.operation.body,operation.body))throw new Error("Pending operation changed");
    meta.put({...current,operation},key);return true;
  });
}
export async function clearScopedOperation(entry:ScopedEntry) {
  await transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),key=targetKey(entry.scope,entry.target),current=await request<ScopedEntry|undefined>(meta.get(key));
    if(current?.operation?.body.operationId===entry.operation?.body.operationId) {delete current!.operation;meta.put(current,key);}
  });
}
export async function rebaseScoped(entry:ScopedEntry,base:ScopedRead,local:EntityMap) {
  return transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),key=targetKey(entry.scope,entry.target),current=await request<ScopedEntry|undefined>(meta.get(key));
    if(current?.sequence!==entry.sequence)return;
    const sent=entry.operation?.sequence ?? entry.sequence;
    const next={...current,base,local:current.sequence===sent?local:current.local,operation:undefined};meta.put(next,key);
    const index=await request<ScopedSummary[]>(meta.get(indexKey)) || [];meta.put(index.map(row=>row.key===key?summary(next):row),indexKey);
    return next;
  });
}
/** Cache the verified result and acknowledge its queue generation in one transaction. */
export async function settleScoped(entry:ScopedEntry,read:ScopedRead,values:EntityMap,document?:{idea:Project;version:string},committed?:ScopedRead) {
  await transaction(["meta","media"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),key=targetKey(entry.scope,entry.target),current=await request<ScopedEntry|undefined>(meta.get(key));
    if(!current)return;
    const counter=(await request<number>(meta.get("scoped-confirmed-counter")) || 0)+1;
    const deletions=await request<Deletion[]>(meta.get("scoped-deletions")) || [];
    for(const [key,value] of Object.entries(values)) {
      if(!key.startsWith("idea:") && !key.startsWith("section:"))continue;
      const kind=key.startsWith("idea:")?"idea" as const:"section" as const,id=JSON.parse(key.slice(key.indexOf(":")+1))[0];
      const old=deletions.findIndex(row=>row.scope===entry.scope && row.kind===kind && row.id===id);if(old>=0)deletions.splice(old,1);
      if(!value)deletions.push({scope:entry.scope,kind,id,counter});
      if(!value && kind==="idea")await removeReaderCacheIn(tx,entry.scope,"idea",id);
    }
    meta.put(counter,"scoped-confirmed-counter");meta.put(deletions,"scoped-deletions");
    const files=tx.objectStore("media"),aliases=await request<Record<string,CloudMedia>>(meta.get("scoped-media-aliases")) || {},cache=await request<CacheState>(meta.get(cacheKey)) || {};
    for(const {source,file} of entry.operation?.files || []) {
      const blob=await request<Blob|undefined>(files.get(source));
      if(blob && blob.size===file.size){
        if(source!==file.id){if(!await request(files.getKey(file.id)))files.put(blob,file.id);files.delete(source);delete cache[source];}
        cache[file.id]={scope:entry.scope,size:blob.size,used:Date.now()};
      }
      if(source!==file.id)aliases[source]=file;
    }
    meta.put(aliases,"scoped-media-aliases");meta.put(cache,cacheKey);await pruneCacheIn(tx,entry.scope,MEDIA_CACHE_LIMIT);
    const index=await request<ScopedSummary[]>(meta.get(indexKey)) || [];
    if(document)await writeReaderCacheIn(tx,entry.scope,"idea",document.idea.id,{...document,offline:false});
    else if(entry.target.kind==="idea")await removeReaderCacheIn(tx,entry.scope,"idea",entry.target.id);
    await writeReaderCacheIn(tx,entry.scope,"idea",editCacheId(entry.target),read);
    const sentSequence=entry.operation?.sequence ?? entry.sequence;
    if(current.sequence===sentSequence){meta.delete(key);meta.put(index.filter(row=>row.key!==key),indexKey);}
    else {
      const local={...current.local},before=entry.operation?.before || entry.local;
      const canonical=entry.operation?.values || values;let conflict=false;
      for(const key of new Set([...Object.keys(before),...Object.keys(canonical)])) {
        const merged=mergeValue(key,before[key] || null,local[key] || null,canonical[key] || null);
        if(merged.conflict)conflict=true;else local[key]=merged.value;
      }
      const next={...current,base:conflict?current.base:committed || read,local,operation:undefined};meta.put(next,key);meta.put(index.map(row=>row.key===key?summary(next):row),indexKey);
    }
  });notifyScoped(entry.scope);
}
