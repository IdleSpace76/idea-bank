import { parseLibrary, type Project } from "./ideas";
import { projectMediaIds } from "./media-store";
import { request, transaction } from "./local-database";

export type BlockDraft = { version:1; revision:string; scope:string; id:string; base:Project; project:Project; files:[string,Blob][]; savedAt:string };
const key=(scope:string,id:string)=>`block-draft:${JSON.stringify([scope,id])}`;
export class DraftChanged extends Error { constructor(){super("Черновик изменён в другой вкладке. Сохранённая копия не перезаписана.");} }
function checkProject(value:Project) {
  return parseLibrary(JSON.stringify({version:1,sections:[{id:value.sectionId,name:"Draft",description:"",icon:"folder"}],projects:[value]})).projects[0];
}
function checked(value:BlockDraft,scope:string,id:string):BlockDraft {
  if(value.version!==1 || value.scope!==scope || value.id!==id || typeof value.revision!=="string" || !Array.isArray(value.files) || !Number.isFinite(Date.parse(value.savedAt)))throw new Error("Не удалось прочитать локальный черновик. Его данные оставлены без изменений.");
  const base=checkProject(value.base),project=checkProject(value.project);
  if(base.id!==id || project.id!==id || value.files.some(pair=>!Array.isArray(pair) || typeof pair[0]!=="string" || !(pair[1] instanceof Blob)))throw new Error("Не удалось прочитать локальный черновик. Его данные оставлены без изменений.");
  return {...value,base,project};
}
export async function readBlockDraft(scope:string,id:string):Promise<BlockDraft|undefined> {
  const value=await transaction(["meta"],"readonly",tx=>request<BlockDraft|undefined>(tx.objectStore("meta").get(key(scope,id))));
  return value?checked(value,scope,id):undefined;
}
/** The draft and its new attachments commit together, outside both caches and the sync queue. */
export async function writeBlockDraft(scope:string,base:Project,project:Project,files:ReadonlyMap<string,Blob>,expected:string|null):Promise<BlockDraft> {
  const used=new Set(projectMediaIds(project)),originals=new Set(projectMediaIds(base));
  const assets=project.blocks.flatMap(block=>block.media || []);
  for(const asset of assets)if(!originals.has(asset.id) && files.get(asset.id)?.size!==asset.size)throw new Error("Не удалось сохранить вложения черновика. Дождитесь завершения загрузки файлов.");
  return transaction(["meta","media"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),previous=await request<BlockDraft|undefined>(meta.get(key(scope,base.id)));
    if((previous?.revision || null)!==expected)throw new DraftChanged();
    const copies=new Map([...files].filter(([id])=>used.has(id)));
    for(const id of used)if(!copies.has(id)){const blob=await request<Blob|undefined>(tx.objectStore("media").get(id));if(blob)copies.set(id,blob);}
    const next=checked({version:1,revision:crypto.randomUUID(),scope,id:project.id,base,project,files:[...copies],savedAt:new Date().toISOString()},scope,base.id);
    meta.put(next,key(scope,base.id));
    return next;
  });
}
/** Never discard a newer draft written by a different tab. */
export async function removeBlockDraft(scope:string,id:string,expected:string):Promise<void> {
  await transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),previous=await request<BlockDraft|undefined>(meta.get(key(scope,id)));
    if(previous && previous.revision!==expected)throw new DraftChanged();
    meta.delete(key(scope,id));
  });
}
