import {stable} from "./entity-sync";
import {parseLibrary,type Library,type Project} from "./ideas";
import type {DiskCatalog,DiskCursor,DiskPatch,DiskSnapshot,DiskWrite,DiskDraftState} from "./disk-protocol";
import type {BlockDraft} from "./block-drafts";

let enabled=false,epoch=0,state:{revision:number;initialized:boolean}|undefined,stateRequest:Promise<typeof state>|undefined;
const pages=new Map<string,DiskCatalog>(),ideas=new Map<string,{idea:Project;revision:number}>(),pending=new Map<string,Promise<unknown>>(),staged=new Map<string,Blob>();
const versions=new WeakMap<Library,number>(),operations=new Map<string,DiskWrite>();
const draftContexts=new Map<string,DiskDraftState>(),clearedDrafts=new Set<string>();
type DraftRequest={body:{instance:string;next:string;expected:string|null;base:Project;project:Project};files:Map<string,Blob>;remove?:boolean};
const draftRequests=new Map<string,DraftRequest>();let resetRequest:{operationId:string;revision:number}|undefined,exampleRequest:{operationId:string}|undefined;
export const localDiskEnabled=()=>enabled;
export function configureLocalDisk(value:boolean){if(enabled!==value){enabled=value;invalidateDiskCache();staged.clear();operations.clear();draftContexts.clear();draftRequests.clear();clearedDrafts.clear();resetRequest=undefined;exampleRequest=undefined;}}
export function invalidateDiskCache(){epoch++;state=undefined;stateRequest=undefined;pages.clear();ideas.clear();pending.clear();}
/** One local event stream per visible page; cloud/B2 is never involved. */
export function watchDiskChanges(){
  if(typeof EventSource==="undefined")return ()=>{};
  let source:EventSource|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const connect=()=>{
    if(document.visibilityState==="hidden"){source?.close();source=undefined;return;}
    if(source)return;
    source=new EventSource("/api/local/events");
    source.onmessage=event=>{
      let revision:number;try{revision=JSON.parse(event.data).revision;}catch{return;}
      if(!Number.isSafeInteger(revision) || revision<0)return;
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{
        if(!state || revision<=state.revision)return;
        remember(revision);window.dispatchEvent(new CustomEvent("idea-bank.local.changes",{detail:{kind:"local"}}));
      },30);
    };
  };
  document.addEventListener("visibilitychange",connect);connect();
  return ()=>{source?.close();if(timer)clearTimeout(timer);document.removeEventListener("visibilitychange",connect);};
}
function remember(revision:number,initialized=true){if(!state || revision>state.revision){if(state){epoch++;pages.clear();ideas.clear();pending.clear();}state={revision,initialized};}}
async function api<T>(path:string,init:RequestInit={}):Promise<T>{
  const response=await fetch(`/api/local/${path}`,{credentials:"same-origin",cache:"no-store",...init});
  const data=await response.json();if(!response.ok){if(data?.error?.code==="STALE_WRITE")invalidateDiskCache();throw Object.assign(new Error(data?.error?.message || "Не удалось обратиться к локальному хранилищу."),{code:data?.error?.code});}return data;
}
async function coalesce<T>(key:string,read:()=>Promise<T>):Promise<T>{
  const existing=pending.get(key);if(existing)return existing as Promise<T>;
  const task=read();pending.set(key,task);try{return await task;}finally{if(pending.get(key)===task)pending.delete(key);}
}
export async function diskState(){
  if(state)return state;
  if(!stateRequest){const request=api<{revision:number;initialized:boolean}>("library?state=1");stateRequest=request;void request.finally(()=>{if(stateRequest===request)stateRequest=undefined;}).catch(()=>{});}
  const result=await stateRequest;remember(result!.revision,result!.initialized);return state!;
}
export async function diskSnapshot(){
  const saved=await api<DiskSnapshot>("library");remember(saved.revision,saved.initialized);
  const library=parseLibrary(JSON.stringify(saved.library));versions.set(library,saved.revision);return saved.initialized?{library,revision:saved.revision}:null;
}
const pageKey=(options:{sectionId?:string;query?:string;cursor?:DiskCursor;limit?:number})=>JSON.stringify([options.sectionId || null,options.query?.trim().toLowerCase() || null,options.cursor || null,options.limit || 24]);
export async function diskPage(options:{sectionId?:string;query?:string;cursor?:DiskCursor;limit?:number;force?:boolean}={}):Promise<DiskCatalog>{
  if(options.force)invalidateDiskCache();const key=pageKey(options),cached=pages.get(key);if(cached)return structuredClone(cached);
  const complete=pages.get(pageKey({}));
  if(complete && complete.ideas.length===complete.total && (!options.cursor || options.cursor.revision===complete.revision)){
    const query=options.query?.trim().toLowerCase(),all=complete.ideas.filter(idea=>(!options.sectionId || idea.sectionId===options.sectionId) && (!query || `${idea.name}\n${idea.description}`.toLowerCase().includes(query))),offset=options.cursor?.offset || 0,limit=options.limit || 24;
    return {...structuredClone(complete),ideas:all.slice(offset,offset+limit),total:all.length,nextCursor:offset+limit<all.length?{offset:offset+limit,revision:complete.revision,...(options.sectionId?{sectionId:options.sectionId}:{}),...(query?{query}:{})}:null};
  }
  return coalesce(`page:${epoch}:${state?.revision}:${key}`,async()=>{
    const params=new URLSearchParams({limit:String(options.limit || 24)});if(options.sectionId)params.set("sectionId",options.sectionId);if(options.query?.trim())params.set("q",options.query.trim());if(options.cursor)params.set("cursor",JSON.stringify(options.cursor));
    const start=epoch,result=await api<DiskCatalog>(`catalog?${params}`);
    if(start!==epoch || state && result.revision<state.revision)return diskPage(options);
    remember(result.revision,result.initialized);pages.set(key,result);return structuredClone(result);
  });
}
export async function diskIdea(id:string,force=false):Promise<{idea:Project;revision:number}|null>{
  if(force)ideas.delete(id);const cached=ideas.get(id);if(cached)return structuredClone(cached);
  return coalesce(`idea:${epoch}:${state?.revision}:${id}`,async()=>{
    const start=epoch;let result:{idea:Project;revision:number};
    try{result=await api(`ideas/${encodeURIComponent(id)}`);}catch(error){if((error as {code:string}).code==="NOT_FOUND")return null;throw error;}
    if(start!==epoch || state && result.revision<state.revision)return diskIdea(id);
    remember(result.revision);ideas.set(id,result);return structuredClone(result);
  });
}
export function stageDiskFiles(files:ReadonlyMap<string,Blob>){for(const [id,file] of files)staged.set(id,file);}
export async function diskMediaFile(id:string):Promise<Blob|undefined>{
  if(staged.has(id))return staged.get(id);
  return coalesce(`media:${id}`,async()=>{const response=await fetch(`/api/local/media/${encodeURIComponent(id)}`,{credentials:"same-origin",cache:"no-store"});if(response.status===404)return;if(!response.ok)throw new Error("Не удалось прочитать локальное вложение.");return response.blob();});
}
export function discardDiskFiles(ids:string[]){for(const id of ids)staged.delete(id);}
function requestBody(value:unknown,files:ReadonlyMap<string,Blob>=new Map()):RequestInit{
  if(!files.size)return {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)};
  const form=new FormData();form.set("manifest",JSON.stringify(value));for(const [id,file] of files)form.set(`file:${id}`,file,"media");return {method:"POST",body:form};
}
const draftIds=(value:DiskDraftState)=>new Set(value.draft?[value.draft.base,value.draft.project].flatMap(idea=>[...(idea.coverImage?[idea.coverImage.id]:[]),...idea.blocks.flatMap(block=>(block.media || []).map(file=>file.id))]):[]);
function asDraft(scope:string,id:string,value:DiskDraftState):BlockDraft|undefined{return value.draft?{version:1,scope,id,...value.draft,files:[]}:undefined;}
export async function readDiskDraft(scope:string,id:string){const context=await coalesce(`draft:${id}`,()=>api<DiskDraftState>(`drafts/${encodeURIComponent(id)}`)),old=draftRequests.get(id);if(old && (old.body.instance!==context.instance || context.head!==old.body.expected && context.head!==old.body.next))draftRequests.delete(id);draftContexts.set(id,context);clearedDrafts.delete(id);return asDraft(scope,id,context);}
async function deliverDraft(id:string,request:DraftRequest){
  const keepalive=!request.files.size && new TextEncoder().encode(JSON.stringify(request.body)).length<60000;
  const result=await api<DiskDraftState>(`drafts/${encodeURIComponent(id)}`,{...requestBody(request.body,request.files),keepalive,...(request.remove?{method:"DELETE"}:{})});
  draftContexts.set(id,result);if(draftRequests.get(id)===request)draftRequests.delete(id);return result;
}
export async function writeDiskDraft(scope:string,base:Project,project:Project,files:ReadonlyMap<string,Blob>,expected:string|null){
  let context=draftContexts.get(base.id);if(!context){await readDiskDraft(scope,base.id);context=draftContexts.get(base.id)!;}
  const previous=draftRequests.get(base.id);
  if(previous && !previous.remove && (expected===previous.body.expected || expected===previous.body.next || expected===null)){
    const confirmed=await deliverDraft(base.id,previous);expected=confirmed.head;context=confirmed;
    if(stable({base,project})===stable({base:previous.body.base,project:previous.body.project}))return asDraft(scope,base.id,confirmed)!;
  }
  if(!context.instance)throw Object.assign(new Error("Идея изменилась в другом окне."),{code:"STALE_WRITE"});
  const known=draftIds(context),used=new Set([base,project].flatMap(idea=>[...(idea.coverImage?[idea.coverImage.id]:[]),...idea.blocks.flatMap(block=>(block.media || []).map(file=>file.id))]));
  const request:DraftRequest={body:{instance:context.instance,next:crypto.randomUUID(),expected:expected ?? context.head,base,project},files:new Map([...files].filter(([id])=>used.has(id) && !known.has(id)))};
  draftRequests.set(base.id,request);clearedDrafts.delete(base.id);return asDraft(scope,base.id,await deliverDraft(base.id,request))!;
}
export async function removeDiskDraft(scope:string,id:string,expected:string|null){
  let context=draftContexts.get(id);const pending=draftRequests.get(id);
  if(pending){const previousExpected=pending.body.expected;context=await deliverDraft(id,pending);if(pending.remove){clearedDrafts.add(id);return;}if(expected===previousExpected || expected===null || expected===pending.body.next)expected=context.head;}
  if(clearedDrafts.has(id) && !context?.draft)return;
  if(!context){await readDiskDraft(scope,id);context=draftContexts.get(id)!;}
  if(!context.instance)throw Object.assign(new Error("Идея изменилась в другом окне."),{code:"STALE_WRITE"});
  const placeholder=context.draft?.project || {id} as Project;
  const request:DraftRequest={body:{instance:context.instance,next:crypto.randomUUID(),expected:expected ?? context.head,base:placeholder,project:placeholder},files:new Map(),remove:true};
  draftRequests.set(id,request);await deliverDraft(id,request);clearedDrafts.add(id);
}
export function diskDraftReceipt(id:string,revision:string|null){return {id,revision:revision ?? draftContexts.get(id)?.head ?? null};}
function diff(before:Library,next:Library):DiskPatch{
  const sections=next.sections.filter(value=>stable(before.sections.find(old=>old.id===value.id))!==stable(value));
  const changed=next.projects.flatMap(idea=>{const old=before.projects.find(old=>old.id===idea.id);if(stable(old)===stable(idea))return [];const blocks=!old || stable(old.blocks)!==stable(idea.blocks);return [{idea:blocks?idea:{...idea,blocks:[]},blocks,create:!old,...(old?{base:blocks?old:{...old,blocks:[]}}:{})}];});
  return {sections,ideas:changed,deleteSections:before.sections.filter(old=>!next.sections.some(value=>value.id===old.id)).map(value=>value.id),deleteIdeas:before.projects.filter(old=>!next.projects.some(value=>value.id===old.id)).map(value=>value.id)};
}
function notify(){
  try{const channel=new BroadcastChannel("idea-bank.local.changes");channel.postMessage({kind:"local"});channel.close();}catch{}
  window.dispatchEvent(new CustomEvent("idea-bank.local.changes",{detail:{kind:"local"}}));
}
/** Save only explicitly changed rows; unopened bodies are retained by the server. */
export async function saveDiskVisible(before:Library,next:Library,expectedRevision?:number,files?:ReadonlyMap<string,Blob>,settleDrafts:NonNullable<DiskWrite["settleDrafts"]> = []){
  const proposed=diff(before,next);if(!proposed.sections.length && !proposed.ideas.length && !proposed.deleteSections.length && !proposed.deleteIdeas.length && state?.initialized)return state.revision;
  if(files)stageDiskFiles(files);
  // Form submissions regenerate updatedAt; a retry still represents the same logical edit.
  const key=stable({before,next:{...next,projects:next.projects.map(({updatedAt,...idea})=>idea)},settleDrafts});let write=operations.get(key);
  if(!write){write={operationId:crypto.randomUUID(),revision:expectedRevision ?? (await diskState()).revision,patch:proposed,...(settleDrafts.length?{settleDrafts}:{})};operations.set(key,write);while(operations.size>16)operations.delete(operations.keys().next().value!);}
  const patch=write.patch;
  const used=new Set(patch.ideas.flatMap(({idea})=>[...(idea.coverImage?[idea.coverImage.id]:[]),...idea.blocks.flatMap(block=>(block.media || []).map(file=>file.id))]));
  const supplied=[...staged].filter(([id])=>used.has(id));let init:RequestInit;
  if(supplied.length){const form=new FormData();form.set("manifest",JSON.stringify(write));for(const [id,file] of supplied)form.set(`file:${id}`,file,"media");init={method:"POST",body:form};}
  else init={method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(write)};
  const result=await api<{page:DiskCatalog;committedRevision:number;drafts?:({id:string}&DiskDraftState)[]}>("library",init),previous=new Map(ideas);
  for(const row of result.drafts || []){draftContexts.set(row.id,row);if(!row.draft)clearedDrafts.add(row.id);}
  epoch++;pending.clear();pages.clear();ideas.clear();state={revision:result.page.revision,initialized:true};pages.set(pageKey({}),result.page);
  if(result.committedRevision===result.page.revision){
    for(const [id,cached] of previous)if(!patch.deleteIdeas.includes(id) && !patch.deleteSections.includes(cached.idea.sectionId))ideas.set(id,{...cached,revision:result.page.revision});
    for(const row of patch.ideas){const cached=ideas.get(row.idea.id);if(row.blocks || cached)ideas.set(row.idea.id,{idea:{...row.idea,blocks:row.blocks?row.idea.blocks:cached!.idea.blocks},revision:result.page.revision});}
  }
  for(const [id] of supplied)staged.delete(id);operations.delete(key);notify();
  if(result.committedRevision!==result.page.revision)throw Object.assign(new Error("Данные изменились в другом окне. Обновите библиотеку перед сохранением."),{code:"STALE_WRITE"});
  return result.page.revision;
}
export async function saveDiskLibrary(next:Library,expected:Library|null,files?:ReadonlyMap<string,Blob>){
  let revision=expected?versions.get(expected):undefined;
  if(revision===undefined){const current=await diskSnapshot();if(stable(current?.library || null)!==stable(expected))throw new Error("Библиотека изменилась в другой вкладке. Сохранение остановлено, чтобы не потерять изменения.");revision=current?.revision ?? (await diskState()).revision;}
  const result=await saveDiskVisible(expected || {version:1,sections:[],projects:[]},next,revision,files);versions.set(next,result);return result;
}
export async function initializeDisk(seed:()=>Promise<{library:Library;files:ReadonlyMap<string,Blob>}>){
  const current=await diskState();if(current.initialized)return (await diskSnapshot())!.library;
  const source=await seed();await saveDiskVisible({version:1,sections:[],projects:[]},source.library,current.revision,source.files);return source.library;
}
export async function clearDiskLibrary(){
  if(!resetRequest)resetRequest={operationId:crypto.randomUUID(),revision:(await diskState()).revision};
  let result:{page:DiskCatalog;committedRevision:number};
  try{result=await api("reset",requestBody(resetRequest));}catch(error){if((error as {code:string}).code==="STALE_WRITE")resetRequest=undefined;throw error;}
  invalidateDiskCache();staged.clear();operations.clear();draftContexts.clear();draftRequests.clear();clearedDrafts.clear();resetRequest=undefined;exampleRequest=undefined;
  state={revision:result.page.revision,initialized:true};pages.set(pageKey({}),result.page);notify();
  if(result.committedRevision!==result.page.revision)throw Object.assign(new Error("Данные изменились в другом окне. Обновите библиотеку перед сохранением."),{code:"STALE_WRITE"});
  return {version:1 as const,sections:[],projects:[]};
}
export async function createDiskExample(){
  if(!exampleRequest)exampleRequest={operationId:crypto.randomUUID()};
  const result=await api<{exists:boolean;idea?:Project;page?:DiskCatalog}>("example",requestBody(exampleRequest));exampleRequest=undefined;
  if(result.exists)return {exists:true as const};
  const page=result.page!;invalidateDiskCache();state={revision:page.revision,initialized:true};pages.set(pageKey({}),page);ideas.set(result.idea!.id,{idea:result.idea!,revision:page.revision});notify();
  return {exists:false as const,library:{version:1 as const,sections:page.sections,projects:[result.idea!]}};
}
export async function diskBackupSource(){
  const saved=await api<DiskSnapshot & {token:string}>("backup"),library=parseLibrary(JSON.stringify(saved.library));versions.set(library,saved.revision);
  let released=false;const change=(action:"renew"|"release")=>api("backup",{...requestBody({token:saved.token,action}),signal:AbortSignal.timeout(5000),keepalive:action==="release"});
  const renewal=setInterval(()=>{void change("renew").catch(()=>{});},60000);
  return {library,release:async()=>{if(released)return;released=true;clearInterval(renewal);await change("release").catch(()=>{});}};
}
