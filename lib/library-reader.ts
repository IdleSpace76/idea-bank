import { parseLibrary, summarizeIdea, type IdeaSummary, type Project, type Section } from "./ideas";
import { prepareLocalCatalog, readLocalCatalogPage, readLocalIdea, readMeta, type LocalCatalogCursor } from "./library-store";
import { readReaderCache, removeReaderCache, writeReaderCache,markReaderFresh } from "./reader-cache";
import type { CatalogPage } from "./catalog-storage";
import { overlayIdea,overlayPage } from "./scoped-overlay";
import type { SyncTarget,ScopedRead } from "./scoped-types";
import { noteScopedDeletion,observeScopedAlive,scopedReadCounter,readScopedDeletions } from "./scoped-store";
import { flattenLibrary } from "./entity-sync";
import type { IdeaEditVersions } from "./scoped-types";
import { cloudFetch, CloudAccessError,cloudAccessProblem } from "./cloud-access";

export type ReaderPage = { sections: Section[]; ideas: IdeaSummary[]; total: number; counts: Record<string,number>; revision: string; nextCursor: string | null; offline: boolean; uninitialized: boolean; cloudError?: string };
export type ReaderIdea = { idea: Project; version: string; offline: boolean; editBase?:ScopedRead; cloudError?: string };
export type ReaderQuery = { query?: string; sectionId?: string; cursor?: string; limit?: number };
export class ReaderError extends Error { constructor(public code: string, message: string,public target?:SyncTarget) { super(message); } }
const unavailable = () => new ReaderError("OFFLINE","Для открытия этой идеи нужно подключение к интернету");
const fallback = (error: unknown) => error instanceof TypeError || error instanceof DOMException && ["TimeoutError","NetworkError"].includes(error.name) || error instanceof ReaderError && error.code === "UNAVAILABLE";

async function get(scope: string, path: string, headers: HeadersInit | undefined, generation: number) {
  if (navigator.onLine === false) throw new TypeError("Offline");
  let response: Response;
  try { response = await cloudFetch(path,{headers,credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(65000)},JSON.stringify([scope,generation])); }
  catch(error) { if(error instanceof CloudAccessError && error.status)throw new ReaderError("UNAVAILABLE",error.message);throw error instanceof CloudAccessError ? new TypeError(error.message) : error; }
  if (response.status === 304) return response;
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ReaderError(response.status >= 500 ? "UNAVAILABLE" : data?.error?.code || "READ_FAILED",data?.error?.message || "Не удалось загрузить данные. Повторите попытку.");
  }
  return response;
}
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
/** Versions reuse the already received body, so opening an idea does not transfer its text twice. */
function editBaseline(value:IdeaEditVersions|undefined,idea:Project):ScopedRead|undefined {
  if(!value)return;
  try{
    const library=parseLibrary(JSON.stringify({version:1,sections:[value.section],projects:[idea]})),values=flattenLibrary(library);
    if(Object.keys(value.index).some(key=>!Object.hasOwn(values,key) || value.index[key].length!==1))return;
    return {target:{kind:"idea",id:idea.id},heads:value.heads,index:value.index,records:Object.entries(value.index).map(([key,revisions])=>({key,revision:revisions[0],value:values[key]}))};
  }catch{return;}
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

export async function loadReaderPage(scope: string | undefined, options: ReaderQuery = {}, localOnly=false): Promise<ReaderPage> {
  if (!scope) {
    await prepareLocalCatalog();
    const page = await readLocalCatalogPage({...options,cursor:options.cursor ? JSON.parse(options.cursor) as LocalCatalogCursor : undefined}).catch(error=>{
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
  if(localOnly) {
    const saved=await readReaderCache<ReaderPage>(scope,"page",key).catch(()=>undefined);
    if(saved)return overlayPage(scope,{...saved,...localCacheState()},options);
  }
  try {
    const started=await scopedReadCounter();
    const result = checkedPage(await (await get(scope,`/api/catalog?${key}`,undefined,started)).json());
    await observeScopedAlive(scope,result.ideas.map(idea=>idea.id),result.sections.map(section=>section.id),started);
    await writeReaderCache(scope,"page",key,result).catch(() => {});
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

export async function loadReaderIdea(scope: string | undefined, id: string, onCached?: (value:ReaderIdea)=>void, localOnly=false): Promise<ReaderIdea> {
  if (!scope) {
    const saved = await readLocalIdea(id);
    if (!saved) throw new ReaderError("NOT_FOUND","Идея не найдена.");
    return {idea:saved.idea,version:String(saved.revision),offline:false};
  }
  const pending=await overlayIdea(scope,id);
  if(pending && "deleted" in pending && (!("confirmed" in pending) || navigator.onLine===false))throw new ReaderError("NOT_FOUND","Идея не найдена.");
  if(pending?.idea)return {idea:pending.idea,version:pending.version!,...localCacheState()};
  let saved = await readReaderCache<ReaderIdea>(scope,"idea",id).catch(() => undefined);
  if (saved) try { checkedIdea(saved.idea); if (!/^[a-f0-9]{64}$/.test(saved.version)) saved = undefined; } catch { saved = undefined; }
  if (!saved && (await readMeta<{scope:string}>("sync-v2"))?.scope===scope) {
    const local=await readLocalIdea(id).catch(()=>null);if(local)saved={idea:local.idea,version:"local",offline:true};
  }
  // Render a verified local copy immediately; the request still checks its version and access.
  if(saved && !(pending && "deleted" in pending))onCached?.({...saved,offline:navigator.onLine===false});
  if(localOnly && saved && !(pending && "deleted" in pending))return {...saved,...localCacheState()};
  try {
    const started=await scopedReadCounter();
    const response = await get(scope,`/api/ideas/${encodeURIComponent(id)}`,saved?.editBase && saved.version!=="local" ? {"If-None-Match":`"${saved.version}"`} : undefined,started);
    if (response.status === 304) {
      if (!saved) throw new ReaderError("INVALID_DATA","Некорректный ответ облака.");
      await observeScopedAlive(scope,[id],[saved.idea.sectionId],started);
      if((await readScopedDeletions()).some(row=>row.scope===scope && row.kind==="idea" && row.id===id))throw new ReaderError("NOT_FOUND","Идея не найдена.");
      await markReaderFresh(scope,id).catch(()=>{});
      return {...saved,offline:false};
    }
    const data = await response.json();
    if (!data || data.id !== id || !/^[a-f0-9]{64}$/.test(data.version)) throw new ReaderError("INVALID_DATA","Некорректный ответ облака.");
    const idea = checkedIdea(data.idea);
    if (idea.id !== id) throw new ReaderError("INVALID_DATA","Некорректный ответ облака.");
    await observeScopedAlive(scope,[id],[idea.sectionId],started);
    if((await readScopedDeletions()).some(row=>row.scope===scope && row.kind==="idea" && row.id===id))throw new ReaderError("NOT_FOUND","Идея не найдена.");
    const result:ReaderIdea = {idea,version:data.version as string,offline:false,editBase:editBaseline(data.editBase,idea)};
    await writeReaderCache(scope,"idea",id,result).catch(() => {});
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
