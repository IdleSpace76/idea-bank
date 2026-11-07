import { createId,demoLibrary,type Library } from "./ideas";
import { loadExampleMedia } from "./example-media";
import { readLocalSnapshot,saveLocalLibrary } from "./library-store";
import { flattenLibrary } from "./entity-sync";
import { overlayIdea } from "./scoped-overlay";
import { queueScoped } from "./scoped-store";
import { cloudFetch } from "./cloud-access";
import { translate as t } from "./i18n";
export type ExampleResult={exists:true}|{exists:false;library:Library};

/** Add the bundled idea once, using the same local save/queue as an ordinary new idea. */
export async function createExample(current:Library,scope?:string):Promise<ExampleResult> {
  const snapshot=scope?null:await readLocalSnapshot(),base=scope?current:snapshot?.library;
  if(!base)throw new Error(t("Не удалось прочитать сохранённую библиотеку."));
  const template=demoLibrary.projects[0],pending=scope?await overlayIdea(scope,template.id):undefined;
  if(pending && "idea" in pending || !pending && base.projects.some(idea=>idea.id===template.id))return {exists:true};
  if(scope){
    const response=await cloudFetch(`/api/ideas/${encodeURIComponent(template.id)}?versionOnly=1`,{credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(15000)});
    if(response.ok)return {exists:true};
    if(response.status!==404){const value=await response.json().catch(()=>null);throw new Error(t(value?.error?.message || "Не удалось загрузить данные. Повторите попытку."));}
  }
  const parent=base.sections.find(section=>section.id===template.sectionId),section=parent || structuredClone(demoLibrary.sections[0]);
  const idea=structuredClone(template),originals=await loadExampleMedia().catch(()=>{throw new Error(t("Не удалось загрузить медиа Example. Проверь соединение и попробуй ещё раз."));}),files=new Map<string,Blob>(),ids=new Map<string,string>();
  for(const [id,blob] of originals){const next=createId();ids.set(id,next);files.set(next,blob);}
  for(const block of idea.blocks)for(const asset of block.media || [])asset.id=ids.get(asset.id)!;
  idea.updatedAt=new Date().toISOString();
  const library:Library={version:1,sections:scope?[section]:parent?base.sections:[...base.sections,section],projects:scope?[idea]:[...base.projects,idea]};
  if(scope){const target={kind:"idea" as const,id:idea.id};await queueScoped(scope,target,{target,heads:[],index:{},records:[]},flattenLibrary(library),0,parent,files);}
  else await saveLocalLibrary(library,snapshot!.library,{files});
  return {exists:false,library};
}
