import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import {randomUUID} from "node:crypto";
import { DiskLibraryStore,DiskStorageError } from "./disk-library";
import { readAuthSettings } from "./auth-settings";
import { parseLibrary,summarizeIdea,demoLibrary,type Project } from "./ideas";
import { stable } from "./entity-sync";
import type { DiskCatalog,DiskWrite } from "./disk-protocol";
import type { DiskMediaInput } from "./disk-media";
import { readDiskSettings } from "./disk-settings";

const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Vary":"Origin"};
const connections=globalThis as typeof globalThis & {ideaBankDiskV3?:Promise<DiskLibraryStore>};
const cleanups=new WeakSet<DiskLibraryStore>();
export function scheduleDiskCleanup(db:DiskLibraryStore){if(cleanups.has(db))return;cleanups.add(db);setTimeout(()=>{cleanups.delete(db);try{db.collectGarbage();}catch{console.error("[local-storage] cleanup deferred");}},25).unref();}
class ApiError extends Error {constructor(readonly status:number,readonly code:string,message:string){super(message);}}
const invalid=()=>new ApiError(400,"INVALID_DATA","Некорректный запрос локального хранилища.");
function guard(request:Request,mutation:boolean){
  if(readAuthSettings().mode!=="local" || process.env.VERCEL)throw new ApiError(404,"NOT_FOUND","Локальное хранилище недоступно.");
  const url=new URL(request.url),host=request.headers.get("host"),external=host?new URL(`${url.protocol}//${host}`):url;
  // Next may normalize its internal URL to localhost while the browser uses 127.0.0.1.
  const loopback=(hostname:string)=>["localhost","127.0.0.1","[::1]"].includes(hostname);
  if(!loopback(url.hostname) || !loopback(external.hostname) || url.port!==external.port || external.username || external.password || external.pathname!=="/" || external.search || external.hash)throw new ApiError(403,"ORIGIN_DENIED","Разрешён только локальный адрес приложения.");
  const origin=request.headers.get("origin");
  if(request.headers.get("sec-fetch-site")==="cross-site" || origin && origin!==external.origin || mutation && origin!==external.origin)throw new ApiError(403,"ORIGIN_DENIED","Запрос с другого сайта запрещён.");
}
async function store(){
  if(!connections.ideaBankDiskV3){const pending=DiskLibraryStore.open().then(db=>{scheduleDiskCleanup(db);return db;});connections.ideaBankDiskV3=pending;void pending.catch(()=>{if(connections.ideaBankDiskV3===pending)delete connections.ideaBankDiskV3;});}
  return connections.ideaBankDiskV3;
}
export const localDiskStore=store;
/** Reject non-local requests before opening a database; never reveal filesystem paths in errors. */
export async function localEndpoint(request:Request,mutation:boolean,run:()=>Promise<unknown>|unknown){
  try{guard(request,mutation);const result=await run();return result instanceof Response?result:Response.json(result,{headers});}
  catch(error){
    const known=error instanceof ApiError?error:error instanceof DiskStorageError?new ApiError(error.code==="STALE_WRITE"?409:400,error.code,error.message):null;
    return Response.json({error:{code:known?.code || "LOCAL_STORAGE_UNAVAILABLE",message:known?.message || "Не удалось обратиться к локальному хранилищу. Проверьте доступ к папке данных и свободное место."}},{status:known?.status || 500,headers});
  }
}
export function diskEndpoint(request:Request,mutation:boolean,run:(db:DiskLibraryStore)=>Promise<unknown>|unknown){return localEndpoint(request,mutation,async()=>run(await store()));}
/** Launcher identity needs no database connection and discloses no local paths. */
export function diskStatus(){return {kind:"idea-bank-local",version:1,instanceId:createHash("sha256").update(JSON.stringify([process.cwd(),readDiskSettings().root])).digest("hex")};}
export function diskCatalog(db:DiskLibraryStore,params:URLSearchParams):DiskCatalog {
  const query=params.get("q")?.trim().toLowerCase() || undefined,sectionId=params.get("sectionId") || undefined;
  let cursor;try{cursor=params.has("cursor")?JSON.parse(params.get("cursor")!):undefined;}catch{throw invalid();}
  if(cursor && (!Number.isSafeInteger(cursor.offset) || cursor.offset<0 || cursor.query!==query || cursor.sectionId!==sectionId))throw new ApiError(409,"STALE_CATALOG","Список идей изменился. Загрузи его заново.");
  const limit=params.has("limit")?Number(params.get("limit")):24,page=db.readPage({limit,offset:cursor?.offset,sectionId,query});
  if(cursor && cursor.revision!==page.revision)throw new ApiError(409,"STALE_CATALOG","Список идей изменился. Загрузи его заново.");
  return {...page,nextCursor:page.nextOffset===null?null:{offset:page.nextOffset,revision:page.revision,...(sectionId?{sectionId}:{}),...(query?{query}:{})}};
}
export async function diskPayload(request:Request):Promise<{value:unknown;files:DiskMediaInput[]}> {
  let value:unknown,files:DiskMediaInput[]=[];
  try{
    if(/^multipart\/form-data;/i.test(request.headers.get("content-type") || "")){
      const form=await request.formData(),raw=form.get("manifest");if(typeof raw!=="string" || Buffer.byteLength(raw)>3*1024*1024)throw invalid();value=JSON.parse(raw);
      const names=new Set<string>();
      for(const [key,file] of form){if(key==="manifest")continue;if(!key.startsWith("file:") || typeof file==="string" || names.has(key))throw invalid();names.add(key);files.push({id:key.slice(5),size:file.size,mime:file.type,data:file});}
    }else{
      if(!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || ""))throw invalid();
      const chunks:Uint8Array[]=[];let size=0;
      if(!request.body)throw invalid();for await(const part of request.body as unknown as AsyncIterable<Uint8Array>){size+=part.length;if(size>3*1024*1024)throw invalid();chunks.push(part);}
      value=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    return {value,files};
  }catch{throw invalid();}
}
async function body(request:Request):Promise<{write:DiskWrite;files:DiskMediaInput[]}> {
  const {value,files}=await diskPayload(request);
  try{
    const write=value as DiskWrite,p=write?.patch;
    if(!write || !/^[a-f0-9-]{36}$/i.test(write.operationId) || !Number.isSafeInteger(write.revision) || write.revision<0 || !p || ![p.sections,p.ideas,p.deleteIdeas,p.deleteSections].every(Array.isArray))throw invalid();
    if([...p.deleteIdeas,...p.deleteSections].some(id=>typeof id!=="string" || !id.trim()) || p.ideas.some(row=>!row || typeof row.blocks!=="boolean" || typeof row.create!=="boolean"))throw invalid();
    if(write.settleDrafts!==undefined && (!Array.isArray(write.settleDrafts) || write.settleDrafts.some(row=>!row || typeof row.id!=="string" || !row.id || row.revision!==null && !uuid(row.revision))))throw invalid();
    parseLibrary(JSON.stringify({version:1,sections:p.sections,projects:[]}));
    for(const row of p.ideas){
      for(const idea of [row.idea,...(row.base?[row.base]:[])])parseLibrary(JSON.stringify({version:1,sections:[{id:idea?.sectionId,name:"Validation",description:"",icon:"folder"}],projects:[idea]}));
      if(!row.create && (!row.base || row.base.id!==row.idea.id))throw invalid();
    }
    return {write,files};
  }catch{throw invalid();}
}
export async function writeDisk(request:Request,db:DiskLibraryStore){
  const {write,files}=await body(request),p=write.patch;
  normalizeFiles(files,p.ideas.map(row=>row.idea));
  const fingerprint=createHash("sha256").update(stable({write,files:files.map(({id,size,mime})=>({id,size,mime})).sort((a,b)=>a.id.localeCompare(b.id))})).digest("hex");
  const old=db.readOperation(write.operationId);
  if(old && old.fingerprint!==fingerprint)throw invalid();
  if(!old && db.readState().revision!==write.revision)throw new ApiError(409,"STALE_WRITE","Данные изменились в другом окне. Обновите библиотеку перед сохранением.");
  if(!old){
    const ideas:Project[]=p.ideas.map(row=>{
      const saved=db.readIdea(row.idea.id);
      if(row.create && saved || !row.create && !saved)throw new ApiError(409,"STALE_WRITE","Идея изменилась в другом окне.");
      if(saved && row.base && stable(row.blocks?saved.idea:summarizeIdea(saved.idea))!==stable(row.blocks?row.base:summarizeIdea(row.base)))throw new ApiError(409,"STALE_WRITE","Идея изменилась в другом окне.");
      return {...row.idea,blocks:row.blocks || !saved?row.idea.blocks:saved.idea.blocks};
    });
    await db.commit({sections:p.sections,ideas,deleteSections:p.deleteSections,deleteIdeas:p.deleteIdeas,settleDrafts:write.settleDrafts},write.revision,files,{id:write.operationId,fingerprint});
  }
  if(p.deleteSections.length || p.deleteIdeas.length || write.settleDrafts?.length || p.ideas.some(row=>row.base && (row.blocks || row.base.coverImage?.id!==row.idea.coverImage?.id)))scheduleDiskCleanup(db);
  return {page:diskCatalog(db,new URLSearchParams()),committedRevision:old?.revision ?? db.readOperation(write.operationId)!.revision,drafts:(write.settleDrafts || []).map(row=>({id:row.id,...db.readDraftContext(row.id)}))};
}
const uuid=(value:unknown):value is string=>typeof value==="string" && /^[a-f0-9-]{36}$/i.test(value);
function normalizeFiles(files:DiskMediaInput[],ideas:Project[]){
  const types=new Map(ideas.flatMap(idea=>[...(idea.coverImage?[idea.coverImage]:[]),...idea.blocks.flatMap(block=>block.media || [])]).map(asset=>[asset.id,asset.mime]));
  // Browsers often label GLB as application/octet-stream; the validated manifest owns its type.
  for(const file of files){const type=types.get(file.id);if(!type)throw invalid();file.mime=type;}
}
/** Draft heads remain after deletion, fencing delayed writes from old editor sessions. */
export async function diskDraft(request:Request,db:DiskLibraryStore,id:string){
  if(request.method==="GET")return db.readDraftContext(id);
  const {value,files}=await diskPayload(request),input=value as {instance:string;next:string;expected:string|null;base:Project;project:Project};
  if(!input || !uuid(input.instance) || !uuid(input.next) || input.next===input.expected || input.expected!==null && !uuid(input.expected))throw invalid();
  if(request.method==="DELETE"){
    if(files.length)throw invalid();db.removeDraft(id,input.expected,input.next,input.instance);scheduleDiskCleanup(db);return db.readDraftContext(id);
  }
  try{for(const idea of [input.base,input.project])parseLibrary(JSON.stringify({version:1,sections:[{id:idea?.sectionId,name:"Draft",description:"",icon:"folder"}],projects:[idea]}));}catch{throw invalid();}
  if(input.base.id!==id || input.project.id!==id)throw invalid();
  normalizeFiles(files,[input.base,input.project]);
  const draft=await db.saveDraft(input.base,input.project,input.expected,files,{instance:input.instance,next:input.next});scheduleDiskCleanup(db);return {instance:input.instance,head:draft.revision,draft};
}
export async function diskReset(request:Request,db:DiskLibraryStore){
  const {value,files}=await diskPayload(request),input=value as {operationId:string;revision:number};
  if(!input || !uuid(input.operationId) || !Number.isSafeInteger(input.revision) || input.revision<0 || files.length)throw invalid();
  const fingerprint=createHash("sha256").update(stable({action:"reset",input})).digest("hex"),revision=db.clear(input.revision,{id:input.operationId,fingerprint});scheduleDiskCleanup(db);
  return {page:diskCatalog(db,new URLSearchParams()),committedRevision:revision};
}
/** A bundled idea is an ordinary atomic create, without reading a full library or browser media. */
export async function diskExample(request:Request,db:DiskLibraryStore){
  const {value,files}=await diskPayload(request),input=value as {operationId:string};if(!input || !uuid(input.operationId) || files.length)throw invalid();
  const fingerprint=createHash("sha256").update("idea-bank:example:v1").digest("hex"),old=db.readOperation(input.operationId);
  if(old && old.fingerprint!==fingerprint)throw invalid();
  if(!old && db.hasIdea("example"))return {exists:true};
  if(old && !db.hasIdea("example"))throw new ApiError(409,"STALE_WRITE","Идея изменилась в другом окне.");
  if(!old){
    const revision=db.readState().revision,section=structuredClone(demoLibrary.sections[0]),idea=structuredClone(demoLibrary.projects[0]);idea.updatedAt=new Date().toISOString();
    const media:DiskMediaInput[]=[];
    for(const block of idea.blocks)for(const asset of block.media || []){const name=asset.name;asset.id=randomUUID();media.push({id:asset.id,size:asset.size,mime:asset.mime,data:createReadStream(path.join(process.cwd(),"public","examples",name))});}
    await db.commit({sections:db.readSections().some(row=>row.id===section.id)?[]:[section],ideas:[idea]},revision,media,{id:input.operationId,fingerprint});
  }
  return {exists:false,idea:db.readIdea("example")!.idea,page:diskCatalog(db,new URLSearchParams())};
}
export async function diskBackup(request:Request,db:DiskLibraryStore){
  if(request.method==="GET")return db.beginBackup();
  const {value,files}=await diskPayload(request),input=value as {token:string;action:"release"|"renew"};if(!input || !uuid(input.token) || !["release","renew"].includes(input.action) || files.length)throw invalid();
  if(input.action==="release"){db.releaseBackup(input.token);scheduleDiskCleanup(db);}else db.renewBackup(input.token);return {ok:true};
}
export function diskMedia(request:Request,db:DiskLibraryStore,id:string){
  const media=db.readMedia(id);if(!media)throw new ApiError(404,"NOT_FOUND","Файл не найден на этом устройстве.");
  const range=request.headers.get("range");let start=0,end=media.size-1,status=200;
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match || !match[1] && !match[2])return new Response(null,{status:416,headers:{...headers,"Content-Range":`bytes */${media.size}`}});
    if(!match[1])start=Math.max(0,media.size-Number(match[2]));else start=Number(match[1]);
    if(match[1] && match[2])end=Math.min(end,Number(match[2]));
    if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start> end)return new Response(null,{status:416,headers:{...headers,"Content-Range":`bytes */${media.size}`}});status=206;
  }
  const passive=/^(?:(?:image|audio|video)\/[\w.+-]+|model\/gltf(?:-binary|\+json))$/.test(media.mime) && media.mime!=="image/svg+xml";
  const fileHeaders={...headers,"Content-Type":passive?media.mime:"application/octet-stream","Content-Length":String(Math.max(0,end-start+1)),"Accept-Ranges":"bytes",...(!passive?{"Content-Disposition":"attachment"}:{}),...(status===206?{"Content-Range":`bytes ${start}-${end}/${media.size}`}:{})};
  if(request.method==="HEAD" || !media.size)return new Response(null,{status,headers:fileHeaders});
  const stream=createReadStream(media.path,{start,end});request.signal.addEventListener("abort",()=>stream.destroy(),{once:true});
  return new Response(Readable.toWeb(stream) as ReadableStream,{status,headers:fileHeaders});
}
