import { assembleLibrary,canonicalLibrary,contentId,entityKey,equal,flattenLibrary,keyParts,stable,type EntityMap,type EntityChange,type SyncCheckpoint } from "./entity-sync";
import { localMedia,resolvePlan,uploadNeeded,validateRead,type EntityPlan,type SyncChoices } from "./entity-client";
import { revisionPattern,type CloudMedia } from "./cloud-library";
import { readReaderCache,writeReaderCache } from "./reader-cache";
import { clearScopedOperation,persistScopedOperation,queueScoped,readScopedEntry,rebaseScoped,settleScoped } from "./scoped-store";
import { editCacheId as cacheId,type ScopedEntry,type ScopedRead,type SyncTarget } from "./scoped-types";
export type ScopedPlan=EntityPlan & {target:SyncTarget;sequence:number};
export class ScopedError extends Error {constructor(public code:string,message:string,public status=0){super(message);}}
export async function scopedApi(path:string,body:unknown,method="POST"):Promise<any> {
  let response:Response;
  try{response=await fetch(path,{method,credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});}
  catch{throw new ScopedError("NETWORK","Нет связи с облаком. Локальные идеи сохранены; повтори синхронизацию позже.");}
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new ScopedError(data?.error?.code || "REQUEST_FAILED",data?.error?.message || "Не удалось выполнить облачный запрос.",response.status);
  if(!data)throw new ScopedError("INVALID_DATA","Неполный ответ истории облака.");return data;
}
export async function readTarget(target:SyncTarget,known?:ScopedRead,includeMedia:string[]=[]):Promise<ScopedRead> {
  const includeIdeas=known ? Object.keys(known.index).filter(key=>keyParts(key).kind==="idea").map(key=>keyParts(key).ids[0]) : [];
  const value:ScopedRead=await scopedApi("/api/sync/scoped",{target,includeIdeas,includeMedia});
  if(!equal(value.target,target))throw new ScopedError("INVALID_DATA","Неполный ответ истории облака.");
  validateRead(value,{},{});return value;
}
export function scopedPlan(entry:ScopedEntry,read:ScopedRead,local=entry.local,baseline?:EntityMap):ScopedPlan {
  const before=validateRead(entry.base,{},{}),remote=validateRead(read,{},{});
  let expected:import("./ideas").Library={version:1,sections:[],projects:[]};
  try{expected=assembleLibrary(local);}catch{/* Structural conflicts are presented by resolvePlan, not guessed here. */}
  const plan:ScopedPlan={scope:entry.scope,target:entry.target,sequence:entry.sequence,expected,local,base:baseline || before.remote,...remote,read,sources:[],first:false,conflicts:[]};
  plan.conflicts=resolvePlan(plan).conflicts;return plan;
}
export async function prepareTarget(scope:string,target:SyncTarget) {
  const pending=await readScopedEntry(scope,target);
  if(pending)return {entry:pending,library:assembleLibrary(pending.local)};
  let read:ScopedRead;
  try{if(navigator.onLine===false)throw new Error("Offline");read=await readTarget(target);await writeReaderCache(scope,"idea",cacheId(target),read).catch(()=>{});}
  catch(error){
    if(navigator.onLine!==false && !(error instanceof ScopedError && error.code==="NETWORK"))throw error;
    const cached=await readReaderCache<ScopedRead>(scope,"idea",cacheId(target));
    if(!cached)throw new ScopedError("OFFLINE","Для изменения этой идеи нужно подключение к интернету.");read=cached;
    if(target.kind==="idea") {
      const document=await readReaderCache<{version:string}>(scope,"idea",target.id);
      const idea=assembleLibrary(validateRead(cached,{},{}).remote).projects.find(idea=>idea.id===target.id);
      if(document && idea && document.version!==await versionOf(cached,idea))throw new ScopedError("OFFLINE","Для изменения этой идеи нужно подключение к интернету.");
    }
  }
  const remote=validateRead(read,{},{});
  const entry:ScopedEntry={scope,target,sequence:0,base:read,local:remote.remote};
  const plan=scopedPlan(entry,read);
  if(plan.conflicts.length)throw Object.assign(new ScopedError("CONFLICT","Сначала завершите синхронизацию и разрешите конфликты."),{plan});
  return {entry,library:assembleLibrary(resolvePlan(plan).values)};
}
/** Keep shared media records: removing an attachment is not permission to delete another idea's file. */
export function scopedLocal(entry:ScopedEntry,library:import("./ideas").Library):EntityMap {
  const result=flattenLibrary(library);
  for(const key of Object.keys(entry.local))if(!Object.hasOwn(result,key))result[key]=keyParts(key).kind==="media"?entry.local[key]:null;
  return result;
}
async function canonicalLocal(entry:ScopedEntry,read:ScopedRead) {
  const library=assembleLibrary(entry.local),remote=validateRead(read,{},{}),files=Object.values(remote.remote).filter((value):value is CloudMedia=>!!value && "sha256" in value);
  const checkpoint:SyncCheckpoint={version:2,scope:entry.scope,index:read.index,values:remote.remote,files,syncedAt:new Date().toISOString()};
  const sources=await localMedia(library,checkpoint),canonical=canonicalLibrary(library,sources);
  const local=flattenLibrary(canonical,sources.map(file=>({...file,id:contentId(file)})));
  for(const key of Object.keys(entry.local))if(!Object.hasOwn(local,key))local[key]=keyParts(key).kind==="media"?entry.local[key]:null;
  return {local,sources};
}
async function versionOf(read:ScopedRead,idea:import("./ideas").Project) {
  const sections={[idea.sectionId]:read.index[entityKey("section",idea.sectionId)] || []},blocks=Object.fromEntries(idea.blocks.map(block=>[block.id,read.index[entityKey("block",idea.id,block.id)] || []]));
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stable({id:idea.id,metadata:read.index[entityKey("idea",idea.id)] || [],sections,blocks})));
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
async function finish(entry:ScopedEntry,read:ScopedRead,base:EntityMap,committed?:ScopedRead) {
  const plan=scopedPlan(entry,read,base,base);
  // Post-commit remote versions may have forked; never acknowledge a winner implicitly.
  if(plan.conflicts.length){const next=await rebaseScoped(entry,committed || read,base);return {plan:scopedPlan(next || entry,read)};}
  const values=resolvePlan(plan).values,library=assembleLibrary(values),idea=library.projects.find(idea=>idea.id===entry.target.id);
  await settleScoped(entry,read,values,idea?{idea,version:await versionOf(read,idea)}:undefined,committed);
  return {read};
}
export async function flushScoped(entry:ScopedEntry,choices:SyncChoices={},choiceIndex?:ScopedRead,progress:(message:string)=>void=()=>{},allowed:()=>boolean=()=>true,attempt=0):Promise<{plan:ScopedPlan}|{read:ScopedRead}|{retry:boolean}> {
  if(!allowed())throw new ScopedError("SYNC_PAUSED","Синхронизация приостановлена.");
  if(attempt>3)throw new ScopedError("NETWORK","Запись изменилась на другом устройстве. Повтори синхронизацию.");
  if(entry.operation) {
    try {
      const saved=await scopedApi("/api/sync/scoped",entry.operation.body,"PUT");
      if(typeof saved.revision!=="string" || !revisionPattern.test(saved.revision))throw new ScopedError("INVALID_DATA","Неполный ответ истории облака.");
      if(!allowed())throw new ScopedError("SYNC_PAUSED","Синхронизация приостановлена.");
      const index={...entry.operation.read.index};for(const change of entry.operation.body.changes)index[change.key]=[saved.revision];
      const committed:ScopedRead={target:entry.target,heads:[saved.revision],index,records:Object.entries(index).flatMap(([key,revisions])=>revisions.map(revision=>({key,revision,value:entry.operation!.values[key] || null})))};
      const read=await readTarget(entry.target,entry.base);
      return finish(entry,read,entry.operation.values,committed);
    } catch(error) {
      if(error instanceof ScopedError && error.code==="STALE_INDEX"){await clearScopedOperation(entry);entry={...entry,operation:undefined};}
      else throw error;
    }
  }
  let read=await readTarget(entry.target,entry.base);
  const canonical=await canonicalLocal(entry,read),extra=canonical.sources.map(contentId).filter(id=>!read.index[entityKey("media",id)]);
  if(extra.length)read=await readTarget(entry.target,entry.base,extra);
  const plan=scopedPlan(entry,read,canonical.local);
  plan.sources=canonical.sources;
  const useChoices=choiceIndex && equal(choiceIndex.index,read.index) ? choices : {};
  const result=resolvePlan(plan,useChoices);
  if(result.conflicts.length)return {plan:{...plan,conflicts:result.conflicts}};
  const values=result.values;assembleLibrary(values);
  const changes:EntityChange[]=[];
  for(const key of new Set([...Object.keys(values),...Object.keys(read.index)])) {
    const value=values[key] || null;
    if(read.index[key]?.length===1 && equal(value,plan.remote[key]) || !read.index[key] && value===null)continue;
    changes.push({key,value,base:read.index[key] || []});
  }
  if(!changes.length)return finish(entry,read,values);
  await uploadNeeded(plan,values,changes,progress);
  if(!allowed())throw new ScopedError("SYNC_PAUSED","Синхронизация приостановлена.");
  const operation={sequence:entry.sequence,before:entry.local,values,read,files:canonical.sources.map(file=>({source:file.id,file:{...file,id:contentId(file)}})),body:{operationId:crypto.randomUUID(),heads:read.heads,changes}};
  if(!await persistScopedOperation(entry,operation))return {retry:true};
  return flushScoped({...entry,operation},{},undefined,progress,allowed,attempt+1);
}
export async function queuePrepared(entry:ScopedEntry,library:import("./ideas").Library) {
  return queueScoped(entry.scope,entry.target,entry.base,scopedLocal(entry,library),entry.sequence);
}
