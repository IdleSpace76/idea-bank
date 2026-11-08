import { parseLibrary, summarizeIdea, type IdeaSummary, type Project, type Section } from "./ideas";
import { prepareLocalCatalog, readLocalCatalogPage, readLocalIdea, readMeta, type LocalCatalogCursor } from "./library-store";
import { readReaderCache, readReaderCacheState, removeReaderCache,removeReaderCacheIn, writeReaderCache,readReaderInventory,readerCheckpointKey,readerEpochIn,settleReaderPagesIn,writeReaderCacheIn,freshenReaderEntriesIn,readerPagesIn,type ReaderInventory } from "./reader-cache";
import type { CatalogPage } from "./catalog-storage";
import { overlayIdea,overlayPage } from "./scoped-overlay";
import type { SyncTarget,ScopedRead } from "./scoped-types";
import { noteScopedDeletion,observeScopedAlive,scopedReadCounter,readScopedDeletions } from "./scoped-store";
import { flattenLibrary,validateRead,assembleLibrary,entityKey,keyParts,stable,parseEntity,type EntityIndex,type EntityMap } from "./entity-sync";
import {transaction,request as dbRequest} from "./local-database";
import {readerPageKey,readerCursor,readerCursorOffset,type ReaderBatchRequest,type ReaderBatchResponse} from "./reader-batch-types";
import type {ScopedSummary} from "./scoped-types";
import { cloudFetch, CloudAccessError,cloudAccessProblem } from "./cloud-access";
import { noteReaderCheck, runSharedReaderCheck, runSharedReaderEvents } from "./shared-reader-check";
import { markReaderStale } from "./reader-cache";

export type ReaderPage = { sections: Section[]; ideas: IdeaSummary[]; total: number; counts: Record<string,number>; revision: string; nextCursor: string | null; offline: boolean; uninitialized: boolean; cloudError?: string;applied?:Record<string,string[]> };
export type ReaderIdea = { idea: Project; version: string; offline: boolean; editBase?:ScopedRead; cloudError?: string };
export type ReaderQuery = { query?: string; sectionId?: string; cursor?: string; limit?: number };
export type ReaderPageLoad={localOnly?:boolean;force?:boolean;onCached?:(page:ReaderPage|undefined)=>void};
export class ReaderError extends Error { constructor(public code: string, message: string,public target?:SyncTarget) { super(message); } }
const unavailable = () => new ReaderError("OFFLINE","Для открытия этой идеи нужно подключение к интернету");
const fallback = (error: unknown) => error instanceof TypeError || error instanceof DOMException && ["TimeoutError","NetworkError"].includes(error.name) || error instanceof ReaderError && error.code === "UNAVAILABLE";

function cachedState(error: unknown) {
  const server = error instanceof ReaderError && error.code === "UNAVAILABLE" && navigator.onLine !== false;
  return {offline:!server,cloudError:server ? error.message : undefined};
}
function localCacheState() {
  const problem=cloudAccessProblem();
  return {offline:navigator.onLine===false || problem?.status===0,cloudError:navigator.onLine!==false && problem?.status ? problem.message : undefined};
}
function checkedIdea(value: unknown): Project {
  const idea = value as Project;
  const section = {id:idea?.sectionId,name:"validation",description:"",icon:"folder"};
  return parseLibrary(JSON.stringify({version:1,sections:[section],projects:[idea]})).projects[0];
}
function checkedPage(value: unknown): ReaderPage {
  const page = value as CatalogPage;
  if (!page || !Array.isArray(page.sections) || !Array.isArray(page.ideas) || typeof page.revision !== "string" || !Number.isSafeInteger(page.total) || page.total < 0 || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new ReaderError("INVALID_DATA","Некорректные данные облачной библиотеки.");
  const sectionConflict=page.sections.find(section=>section.variants.length!==1 || !section.variants[0]),ideaConflict=page.ideas.find(idea=>idea.conflicted || idea.variants.length!==1 || !idea.variants[0]);
  if(sectionConflict || ideaConflict)throw new ReaderError("IDEA_CONFLICT","Есть конфликт версий. Откройте синхронизацию, чтобы выбрать нужную версию.",sectionConflict?{kind:"section",id:sectionConflict.id}:{kind:"idea",id:ideaConflict!.id});
  const sections = page.sections.map(section => section.variants[0]!);
  const library = parseLibrary(JSON.stringify({version:1,sections,projects:page.ideas.map(card => ({...card.variants[0],blocks:[]}))}));
  return { sections:library.sections,ideas:library.projects.map(summarizeIdea),total:page.total,counts:page.sectionCounts || {},revision:page.revision,nextCursor:page.nextCursor,offline:false,uninitialized:page.uninitialized === true };
}

type BatchWaiter={page?:ReaderQuery;body?:string;media?:string;observe?:string[];resolve:(batch:ReaderBatchResponse)=>void;reject:(error:unknown)=>void};
const batchQueue=new Map<string,BatchWaiter[]>(),batchRequests=new Map<string,Promise<ReaderBatchResponse>>();
const activity=new Map<string,number>(),activityListeners=new Set<()=>void>();
export const readerActivity=(scope?:string)=>scope?(activity.get(scope) || 0):0;
export function subscribeReaderActivity(listener:()=>void){activityListeners.add(listener);return()=>{activityListeners.delete(listener);};}
function changeReaderActivity(scope:string,delta:number){const count=(activity.get(scope) || 0)+delta;if(count)activity.set(scope,count);else activity.delete(scope);for(const listener of activityListeners)listener();}
const mediaTickets=new Map<string,{expires:number;download:NonNullable<ReaderBatchResponse["media"][number]["download"]>}>();
async function bodyFromRead(read:ScopedRead):Promise<ReaderIdea> {
  const parsed=validateRead(read,{},{});
  if(Object.values(parsed.variants).some(variants=>variants.length!==1))throw new ReaderError("IDEA_CONFLICT","У идеи есть несовместимые версии.",read.target);
  let idea:Project|undefined;
  try{idea=assembleLibrary(parsed.remote).projects.find(idea=>idea.id===read.target.id);}
  catch{throw new ReaderError("IDEA_CONFLICT","Идея имеет несовместимые изменения раздела или блоков.",read.target);}
  if(!idea)throw new ReaderError("NOT_FOUND","Идея не найдена.");
  const section=read.index[entityKey("section",idea.sectionId)] || [],blocks=Object.fromEntries(idea.blocks.map(block=>[block.id,read.index[entityKey("block",idea.id,block.id)] || []]));
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stable({id:idea.id,metadata:read.index[entityKey("idea",idea.id)] || [],sections:{[idea.sectionId]:section},blocks})));
  const wanted=new Set([entityKey("idea",idea.id),entityKey("section",idea.sectionId),...idea.blocks.map(block=>entityKey("block",idea.id,block.id))]);
  const editBase={...read,index:Object.fromEntries(Object.entries(read.index).filter(([key])=>wanted.has(key))),records:read.records.filter(record=>wanted.has(record.key))};
  return {idea,version:[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join(""),offline:false,editBase};
}
async function applyBatch(scope:string,batch:ReaderBatchResponse,inventory:ReaderInventory) {
  if(!batch || !Array.isArray(batch.heads) || batch.heads.length>16 || batch.heads.some(head=>!(/^[a-f0-9-]{36}$/).test(head)) || !/^[a-f0-9]{64}$/.test(batch.revision) || !Array.isArray(batch.pages) || !Array.isArray(batch.bodies) || !batch.changes?.index || !Array.isArray(batch.changes.records) || !Array.isArray(batch.changes.previous))throw new ReaderError("INVALID_DATA","Некорректный пакет изменений.");
  const index=Object.fromEntries(Object.entries(batch.changes.index).filter(([,versions])=>versions.length));
  const parsed=validateRead({heads:batch.heads,index,records:batch.changes.records},{},{});
  const conflict=Object.keys(parsed.variants).find(key=>parsed.variants[key].length!==1);
  if(conflict){const part=keyParts(conflict);throw new ReaderError("IDEA_CONFLICT","Есть конфликт версий. Откройте синхронизацию, чтобы выбрать нужную версию.",{kind:part.kind==="section"?"section":"idea",id:part.ids[0]});}
  const previous:EntityMap={};
  for(const record of batch.changes.previous)previous[record.key]=parseEntity(record.key,record.value);
  const rows:ScopedSummary[]=Object.keys(batch.changes.index).filter(key=>["idea","section"].includes(keyParts(key).kind)).map(key=>{
    const part=keyParts(key),id=part.ids[0],target={kind:part.kind as "idea"|"section",id};
    return {key,scope,target,sequence:0,deletedIds:[],...(part.kind==="idea"?{before:previous[key]?summarizeIdea(previous[key] as IdeaSummary):null,idea:parsed.remote[key]?summarizeIdea(parsed.remote[key] as IdeaSummary):null}:{section:parsed.remote[key] as Section|null})};
  });
  const bodies=new Map<string,ReaderIdea|null>();
  for(const value of batch.bodies) {
    if(value.read) {try{bodies.set(value.id,await bodyFromRead(value.read));}catch(error){if(!(error instanceof ReaderError))throw error;bodies.set(value.id,null);}}
    else if(value.error?.code==="NOT_FOUND")bodies.set(value.id,null);
  }
  for(const saved of inventory.ideas) {
    if(bodies.has(saved.id) || !saved.value.editBase)continue;
    const affected=Object.keys(batch.changes.index).some(key=>{const part=keyParts(key);return part.kind==="section" && saved.value.idea.sectionId===part.ids[0] || ["idea","block"].includes(part.kind) && part.ids[0]===saved.id;});
    if(!affected)continue;
    const local=flattenLibrary({version:1,sections:[saved.value.editBase.records.find(record=>record.key===entityKey("section",saved.value.idea.sectionId))?.value as Section],projects:[saved.value.idea]}),versions=Object.fromEntries(Object.entries(saved.value.editBase.index).filter(([key])=>Object.hasOwn(local,key)));
    for(const [key,refs] of Object.entries(batch.changes.index)) {
      const part=keyParts(key);
      if(part.kind!=="section" && part.ids[0]!==saved.id)continue;
      local[key]=parsed.remote[key] || null;if(refs.length)versions[key]=refs;else delete versions[key];
    }
    const own=local[entityKey("idea",saved.id)] as {blockIds:string[]}|null;
    for(const key of Object.keys(local)){const part=keyParts(key);if(part.kind==="block" && !own?.blockIds.includes(part.ids[1])){delete local[key];delete versions[key];}}
    const read:ScopedRead={target:{kind:"idea",id:saved.id},heads:batch.heads,index:versions,records:Object.entries(versions).flatMap(([key,refs])=>refs.map(revision=>({key,revision,value:local[key] || null})))};
    try{const updated=await bodyFromRead(read);if(updated.version!==saved.value.version)bodies.set(saved.id,updated);}catch{bodies.set(saved.id,null);}
  }
  const pages=batch.pages.map(value=>({id:readerPageKey(value.query),page:checkedPage(value.page)}));
  if(inventory.fresh && stable(batch.heads)===stable(inventory.heads) && !rows.length && !pages.length && !bodies.size)return true;
  return transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta");
    if(await readerEpochIn(tx,scope)!==inventory.epoch || stable(await dbRequest(meta.get(readerCheckpointKey(scope))))!==stable(inventory.heads))return false;
    const deletions=await dbRequest<{scope:string;kind:string;id:string;counter:number}[]>(meta.get("scoped-deletions")) || [];
    let deletionChanged=false,counter=await dbRequest<number>(meta.get("scoped-confirmed-counter")) || 0;
    for(const row of rows) {
      const kind=row.target.kind,id=row.target.id,alive=kind==="idea"?row.idea:row.section;
      const offset=deletions.findIndex(value=>value.scope===scope && value.kind===kind && value.id===id);
      if(offset>=0 && alive){deletions.splice(offset,1);deletionChanged=true;}
      else if(offset<0 && !alive){deletions.push({scope,kind,id,counter:++counter});deletionChanged=true;}
    }
    if(deletionChanged){meta.put(deletions,"scoped-deletions");meta.put(counter,"scoped-confirmed-counter");}
    if(rows.length || inventory.pages.some(page=>page.value.revision!==batch.revision))await settleReaderPagesIn(tx,scope,rows,batch.revision,batch.changes.index);
    const retainedPages=await readerPagesIn(tx,scope);
    for(const saved of retainedPages) {
      const key=`reader-entry:${JSON.stringify([scope,"page",saved.id])}`;
      const value=await dbRequest<ReaderPage|undefined>(meta.get(key));if(!value)continue;
      if(batch.reset && !pages.some(page=>page.id===saved.id)){await removeReaderCacheIn(tx,scope,"page",saved.id);continue;}
      if(!pages.some(page=>page.id===saved.id) && value.revision!==batch.revision)await writeReaderCacheIn(tx,scope,"page",saved.id,{...value,revision:batch.revision,nextCursor:value.nextCursor?encodeCursor(value.nextCursor,batch.revision,readerCursorOffset(new URLSearchParams(saved.id).get("cursor"))+value.ideas.length):null});
    }
    for(const value of pages)await writeReaderCacheIn(tx,scope,"page",value.id,value.page);
    await freshenReaderEntriesIn(tx,scope,new Set([...retainedPages.map(value=>`reader-entry:${JSON.stringify([scope,"page",value.id])}`),...inventory.ideas.filter(value=>!bodies.has(value.id)).map(value=>`reader-entry:${JSON.stringify([scope,"idea",value.id])}`)]));
    for(const [id,value] of bodies) {
      if(value)await writeReaderCacheIn(tx,scope,"idea",id,value);
      else await removeReaderCacheIn(tx,scope,"idea",id);
    }
    if(stable(batch.heads)!==stable(inventory.heads))meta.put(batch.heads,readerCheckpointKey(scope));return true;
  });
}
function encodeCursor(cursor:string,revision:string,offset:number) {
  try {const value=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cursor.replace(/-/g,"+").replace(/_/g,"/")),char=>char.charCodeAt(0))));value.revision=revision;value.offset=offset;return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}catch{return null;}
}
async function executeBatch(scope:string,waiters:BatchWaiter[]) {
  changeReaderActivity(scope,1);
  try {
    for(let attempt=0;attempt<3;attempt++) {
      const mediaOnly=waiters.every(waiter=>!!waiter.media && !waiter.page && !waiter.body);
      const inventory:ReaderInventory=mediaOnly?{epoch:0,fresh:true,pages:[],ideas:[]}:await readReaderInventory(scope);
      const body:ReaderBatchRequest={since:inventory.heads,pages:[...new Map(waiters.filter(value=>value.page).map(value=>[readerPageKey(value.page),value.page!])).values()],bodies:[...new Set([...waiters.flatMap(value=>value.body?[value.body]:[]),...inventory.ideas.filter(value=>!value.value.editBase).map(value=>value.id)])],watch:inventory.ideas.map(value=>value.id),media:[...new Set(waiters.flatMap(value=>value.media?[value.media]:[]))],sidebar:!inventory.heads && waiters.some(value=>value.page && !value.page.cursor)};
      if(mediaOnly)body.mediaOnly=true;
      const observe=[...new Set(waiters.flatMap(waiter=>waiter.observe || []))].slice(0,512);if(observe.length)body.observe=observe;
      let response:Response;
      try {if(navigator.onLine===false)throw new TypeError("Offline");response=await cloudFetch("/api/reader/batch",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",cache:"no-store",body:JSON.stringify(body),signal:AbortSignal.timeout(65000)});}
      catch(error){throw error instanceof CloudAccessError && error.status?new ReaderError("UNAVAILABLE",error.message):new TypeError("Offline");}
      const data=await response.json();
      if(!response.ok)throw new ReaderError(response.status>=500?"UNAVAILABLE":data?.error?.code || "READ_FAILED",data?.error?.message || "Не удалось загрузить данные.");
      if(mediaOnly && Array.isArray(data?.media) || !mediaOnly && await applyBatch(scope,data,inventory)){if(!mediaOnly)await noteReaderCheck(scope).catch(()=>{});for(const waiter of waiters)waiter.resolve(data);return;}
    }
    throw new ReaderError("STALE_CATALOG","Локальные данные изменились во время загрузки. Повторите попытку.");
  } catch(error){for(const waiter of waiters)waiter.reject(error);}
  finally{changeReaderActivity(scope,-1);}
}
function readerBatch(scope:string,page?:ReaderQuery,body?:string,media?:string,observe?:string[]) {
  const key=JSON.stringify([scope,page?readerPageKey(page):null,body,media,observe]);
  const existing=batchRequests.get(key);if(existing)return existing;
  const promise=new Promise<ReaderBatchResponse>((resolve,reject)=>{
    let pending=batchQueue.get(scope);
    if(!pending){pending=[];batchQueue.set(scope,pending);setTimeout(()=>{const batch=batchQueue.get(scope)!;batchQueue.delete(scope);void executeBatch(scope,batch);},8);}
    pending.push({page,body,media,observe,resolve,reject});
  }).finally(()=>batchRequests.delete(key));
  batchRequests.set(key,promise);return promise;
}
/** Events, reconnect and the safety timer all share the same incremental packet path. */
export async function syncReader(scope:string,safety=false,revisions?:string[]){
  if(revisions?.length)await runSharedReaderEvents(scope,revisions,async()=>{
    await markReaderStale(scope);
    const batch=await readerBatch(scope,undefined,undefined,undefined,revisions);
    return Array.isArray(batch.observed)?batch.observed:[];
  });
  else if(safety)await runSharedReaderCheck(scope,async()=>{await readerBatch(scope);});else await readerBatch(scope);
}
export async function loadReaderMedia(scope:string,id:string) {
  const key=JSON.stringify([scope,id]),saved=mediaTickets.get(key);
  if(saved && saved.expires>Date.now()+15000)return saved.download;
  const batch=await readerBatch(scope,undefined,undefined,id),value=batch.media.find(value=>value.id===id);
  if(!value?.download)throw new ReaderError(value?.error?.code || "NOT_FOUND",value?.error?.message || "Вложение не найдено.");
  mediaTickets.delete(key);mediaTickets.set(key,{download:value.download,expires:Date.now()+Math.min(value.download.expiresIn,300)*1000});
  while(mediaTickets.size>128)mediaTickets.delete(mediaTickets.keys().next().value!);
  return value.download;
}

export async function loadReaderPage(scope: string | undefined, options: ReaderQuery = {}, load:boolean|ReaderPageLoad=false): Promise<ReaderPage> {
  const {localOnly=false,force=false,onCached}=typeof load==="boolean"?{localOnly:load}:load;
  if (!scope) {
    await prepareLocalCatalog();
    const page = await readLocalCatalogPage({...options,force,cursor:options.cursor ? JSON.parse(options.cursor) as LocalCatalogCursor : undefined}).catch(error=>{
      if(error?.code==="STALE_CATALOG")throw new ReaderError("STALE_CATALOG","Список идей изменился. Загрузи его заново.");
      throw error;
    });
    return { sections:page.sections,counts:page.counts,ideas:page.ideas,total:page.total,revision:String(page.revision),nextCursor:page.nextCursor ? JSON.stringify(page.nextCursor) : null,offline:false,uninitialized:false };
  }
  const params = new URLSearchParams();
  if (options.query?.trim()) params.set("q",options.query.trim());
  if (options.sectionId) params.set("sectionId",options.sectionId);
  if (options.cursor) params.set("cursor",options.cursor);
  params.set("limit",String(options.limit ?? 24));
  const key = params.toString();
  const cached=await readReaderCacheState<ReaderPage>(scope,"page",key).catch(()=>({value:undefined,fresh:false,epoch:0}));
  if(cached.value) {
    const page=await overlayPage(scope,{...cached.value,...localCacheState()},options);
    onCached?.(page);
    if(localOnly || !force && cached.fresh)return page;
  }
  // A complete verified set of card metadata can answer another section/search without B2.
  if(!force && !options.cursor && key!=="limit=24") {
    const navigation=await readReaderCacheState<ReaderPage>(scope,"page","limit=24").catch(()=>({value:undefined,fresh:false,epoch:0}));
    const base=navigation.value;
    if(base && (navigation.fresh || localOnly)) {
      const query=options.query?.trim().toLowerCase();
      const ideas=base.ideas.filter(idea=>(!options.sectionId || idea.sectionId===options.sectionId) && (!query || `${idea.name}\n${idea.description}`.toLowerCase().includes(query)));
      const complete=base.nextCursor===null || !!options.sectionId && !query && ideas.length===(base.counts[options.sectionId] || 0);
      const limit=options.limit ?? 24;
      if(complete || !query && ideas.length>=limit) {
        const total=complete?ideas.length:options.sectionId?base.counts[options.sectionId] || 0:base.total;
        const page={...base,ideas:ideas.slice(0,limit),total,nextCursor:total>limit?readerCursor(options,base.revision,limit):null};
        if(navigation.fresh)await writeReaderCache(scope,"page",key,page,undefined,navigation.epoch).catch(()=>{});
        return overlayPage(scope,{...page,...localCacheState()},options);
      }
    }
  }
  if(!cached.value)onCached?.(undefined);
  if(localOnly)throw new ReaderError("CACHE_MISS","Эта часть списка ещё не загружена.");
  try {
    const started=await scopedReadCounter();
    const batch=await readerBatch(scope,options);
    const loaded=batch.pages.find(value=>readerPageKey(value.query)===key);
    if(!loaded)throw new ReaderError("INVALID_DATA","Неполный пакет карточек.");
    const result=checkedPage(loaded.page);
    await observeScopedAlive(scope,result.ideas.map(idea=>idea.id),result.sections.map(section=>section.id),started);
    return overlayPage(scope,result,options);
  } catch (error) {
    if (!fallback(error)) throw error;
    const saved = await readReaderCache<ReaderPage>(scope,"page",key).catch(() => undefined);
    const status = cachedState(error);
    if (saved) return overlayPage(scope,{...saved,...status},options);
    if ((!options.cursor || options.cursor.startsWith("{")) && (await readMeta<{scope:string}>("sync-v2"))?.scope===scope) {
      const local=await loadReaderPage(undefined,options);return overlayPage(scope,{...local,...status},options);
    }
    if(!options.cursor) {
      const navigation=await readReaderCache<ReaderPage>(scope,"page","limit=24").catch(()=>undefined);
      if(navigation) {
        const ideas=navigation.ideas.filter(idea=>(!options.sectionId || idea.sectionId===options.sectionId) && (!options.query || `${idea.name}\n${idea.description}`.toLowerCase().includes(options.query.trim().toLowerCase())));
        return overlayPage(scope,{...navigation,ideas,total:ideas.length,nextCursor:null,...status},options);
      }
    }
    if(status.cloudError)throw error;
    throw new ReaderError("OFFLINE","Нет сохранённых данных для этой страницы. Подключитесь к интернету.");
  }
}

export async function loadReaderIdea(scope: string | undefined, id: string, onCached?: (value:ReaderIdea)=>void, localOnly=false,force=false): Promise<ReaderIdea> {
  if (!scope) {
    const saved = await readLocalIdea(id,force);
    if (!saved) throw new ReaderError("NOT_FOUND","Идея не найдена.");
    return {idea:saved.idea,version:String(saved.revision),offline:false};
  }
  const pending=await overlayIdea(scope,id);
  if(pending && "deleted" in pending)throw new ReaderError("NOT_FOUND","Идея не найдена.");
  if(pending?.idea)return {idea:pending.idea,version:pending.version!,...localCacheState()};
  const cached=await readReaderCacheState<ReaderIdea>(scope,"idea",id).catch(()=>({value:undefined,fresh:false,epoch:0}));
  let saved = cached.value;
  if (saved) try { checkedIdea(saved.idea); if (!/^[a-f0-9]{64}$/.test(saved.version)) saved = undefined; } catch { saved = undefined; }
  if (!saved && (await readMeta<{scope:string}>("sync-v2"))?.scope===scope) {
    const local=await readLocalIdea(id).catch(()=>null);if(local)saved={idea:local.idea,version:"local",offline:true};
  }
  // Render a verified local copy immediately; the request still checks its version and access.
  if(saved && !(pending && "deleted" in pending))onCached?.({...saved,offline:navigator.onLine===false});
  if((localOnly || !force && cached.fresh) && saved && !(pending && "deleted" in pending))return {...saved,...localCacheState()};
  try {
    const started=await scopedReadCounter();
    const batch=await readerBatch(scope,undefined,saved?.editBase?undefined:id);
    const value=batch.bodies.find(value=>value.id===id);
    if(value?.error)throw new ReaderError(value.error.code,value.error.message);
    const result=value?.read?await bodyFromRead(value.read):await readReaderCache<ReaderIdea>(scope,"idea",id);
    if(!result)throw new ReaderError("NOT_FOUND","Идея не найдена.");
    const idea=result.idea;
    await observeScopedAlive(scope,[id],[idea.sectionId],started);
    if((await readScopedDeletions()).some(row=>row.scope===scope && row.kind==="idea" && row.id===id))throw new ReaderError("NOT_FOUND","Идея не найдена.");
    return result;
  } catch (error) {
    if (error instanceof ReaderError && error.code === "NOT_FOUND") {await noteScopedDeletion(scope,id);await removeReaderCache(scope,"idea",id).catch(() => {});}
    if(error instanceof ReaderError && error.code==="IDEA_CONFLICT")error.target={kind:"idea",id};
    if (!fallback(error)) throw error;
    if(pending && "deleted" in pending)throw new ReaderError("NOT_FOUND","Идея не найдена.");
    const status = cachedState(error);
    if (!saved) {if(status.cloudError)throw error;throw unavailable();}
    return {...saved,...status};
  }
}
