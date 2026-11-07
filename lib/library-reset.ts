import { assembleLibrary,validateRead,keyParts,equal,type SyncCheckpoint } from "./entity-sync";
import { readLocalSnapshot,saveLocalLibrary } from "./library-store";
import { readTarget,scopedApi } from "./scoped-client";
import { queueScoped,readScopedIndex } from "./scoped-store";
import { parseCloudMedia } from "./cloud-library";
import { withSyncLock } from "./sync-lock";
import { projectMediaIds,removeMediaFiles } from "./media-store";
import { translate as t } from "./i18n";
import type { Library } from "./ideas";

/** Record an explicit reset without seeding Example, hashing files or downloading originals. */
export async function clearLibrary(scope?:string,expectedLibrary?:Library,legacy=false):Promise<Library> {
  const empty:Library={version:1,sections:[],projects:[]};
  const acquired=await withSyncLock(async()=>{
    const expected=await readLocalSnapshot();let baseline=expected?.library || empty,checkpoint:SyncCheckpoint|undefined;
    if(!scope && expectedLibrary && !equal(expected?.library,expectedLibrary))throw new Error(t("Библиотека изменилась в другой вкладке. Сохранение остановлено, чтобы не потерять изменения."));
    if(scope) {
      if(navigator.onLine===false)throw new Error(t("Для очистки облачной библиотеки нужно подключение к интернету."));
      if((await readScopedIndex()).some(row=>row.scope===scope))throw new Error(t("Сначала завершите синхронизацию и разрешите конфликты."));
      const target={kind:"library" as const,id:"all"};
      const read=legacy?await scopedApi("/api/sync",{known:{}}):await readTarget(target),parsed=validateRead(read,{},{});
      if(Object.values(parsed.variants).some(values=>values.length!==1))throw new Error(t("Сначала завершите синхронизацию и разрешите конфликты."));
      baseline=assembleLibrary(parsed.remote);
      if(legacy) {
        const files=Object.entries(parsed.remote).filter(([key,value])=>keyParts(key).kind==="media" && value).map(([,value])=>parseCloudMedia(value));
        checkpoint={version:2,scope,index:read.index,values:parsed.remote,recovery:parsed.recovery,files,syncedAt:new Date().toISOString()};
      }else {
        const local=Object.fromEntries(Object.entries(parsed.remote).map(([key,value])=>[key,keyParts(key).kind==="media"?value:null]));
        // One durable operation is the local reset; cached pages apply its deletion overlay immediately.
        await queueScoped(scope,target,read,local,0);
      }
    }
    if(!scope || legacy)await saveLocalLibrary(empty,expected?.library || null,{checkpoint,clearOperation:true,...(scope?{guardScope:scope,clearFrom:baseline}:{})});
    const ids=new Set([...(expected?.library.projects || []),...baseline.projects].flatMap(projectMediaIds));
    void removeMediaFiles([...ids]).catch(()=>{});
  });
  if(!acquired)throw new Error(t("Синхронизация выполняется в другой вкладке."));
  return empty;
}
