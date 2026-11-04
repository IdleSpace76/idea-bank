import { inspectEntitySync, applyEntitySync, type EntityPlan, type SyncChoices } from "./entity-client";
import { readLocalSnapshot, readMeta, subscribeLocalChanges } from "./library-store";
import type { Library } from "./ideas";
import { equal, type SyncCheckpoint } from "./entity-sync";
import { withSyncLock } from "./sync-lock";

export type SyncPhase = "waiting" | "syncing" | "synced" | "offline" | "retry" | "review" | "conflict" | "migration" | "auth" | "error";
export type SyncView = { phase: SyncPhase; busy: boolean; status: string; error: string; lastSync: string; plan: EntityPlan | null; nextRetry: number | null };
export const initialSyncView: SyncView = {phase:"waiting",busy:false,status:"",error:"",lastSync:"",plan:null,nextRetry:null};
export const syncLabel = (phase: SyncPhase): string => ({waiting:"Ожидает отправки",syncing:"Синхронизация…",synced:"Сохранено в облаке",offline:"Нет сети",retry:"Повторим автоматически",review:"Нужна настройка",conflict:"Есть конфликт",migration:"Нужен переход",auth:"Нужно войти",error:"Ошибка синхронизации"})[phase];
const pollMs=20000, debounceMs=1200;
const retryDelays=[2000,5000,10000,30000,60000];
const paused = new Set<SyncPhase>(["review","conflict","migration","auth","error"]);

type Options = { canRun:()=>boolean; onApplied:(library:Library)=>void };
/** One controller owns automatic work and manual choices; closing the dialog never stops syncing. */
export class SyncController {
  private view:SyncView=initialSyncView;
  private listeners=new Set<()=>void>();
  private timer:ReturnType<typeof setTimeout>|null=null;
  private cleanup:(()=>void)|null=null;
  private running=false;
  private stopped=true;
  private generation=0;
  private failures=0;
  private queued=false;
  constructor(readonly scope:string,private options:Options){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  getSnapshot=()=>this.view;
  private patch(update:Partial<SyncView>){this.view={...this.view,...update};for(const listener of this.listeners)listener();}
  private clearTimer(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;}
  private schedule(delay:number){
    if(this.stopped || paused.has(this.view.phase))return;
    this.clearTimer();
    this.timer=setTimeout(()=>{this.timer=null;void this.execute();},delay);
  }
  start(){
    if(!this.stopped)return;
    this.stopped=false;this.generation++;
    const wake=()=>{
      if(document.visibilityState==="hidden")return;
      if(this.view.phase==="auth")this.patch({phase:"waiting",error:""});
      this.failures=0;this.schedule(100);
    };
    const offline=()=>{
      if(paused.has(this.view.phase))return;
      this.patch({phase:"offline",status:"Нет сети. Изменения сохранены на устройстве."});this.schedule(5000);
    };
    const unsubscribe=subscribeLocalChanges(kind=>{
      if(kind==="remote"){
        void readMeta<SyncCheckpoint>("sync-v2").then(state=>{
          if(this.stopped || state?.scope!==this.scope)return;
          if(!this.running)this.patch({phase:"synced",plan:null,error:"",status:"Изменения идей синхронизированы.",lastSync:state.syncedAt,nextRetry:null});
        }).catch(()=>{});
        return;
      }
      this.queued=true;
      if(["migration","auth","error"].includes(this.view.phase))return;
      this.patch({phase:"waiting",plan:null,error:"",status:"Изменения сохранены на устройстве. Ожидаем отправку."});
      this.schedule(debounceMs);
    });
    window.addEventListener("focus",wake);window.addEventListener("online",wake);window.addEventListener("offline",offline);document.addEventListener("visibilitychange",wake);
    this.cleanup=()=>{unsubscribe();window.removeEventListener("focus",wake);window.removeEventListener("online",wake);window.removeEventListener("offline",offline);document.removeEventListener("visibilitychange",wake);};
    this.schedule(100);
  }
  stop(){this.stopped=true;this.generation++;this.clearTimer();this.cleanup?.();this.cleanup=null;}
  /** Recheck immediately after an editor/save/backup releases its local lock. */
  contextChanged(){
    if(this.stopped)return;
    if(this.options.canRun() && !paused.has(this.view.phase))this.schedule(this.queued?debounceMs:100);
  }
  check=(activate=false)=>this.execute({activate});
  resolve=(plan:EntityPlan,choices:SyncChoices={},mode:"merge"|"local"|"cloud"=plan.resolveMode||"merge")=>this.execute({plan,choices,mode});
  private async execute(action?:{activate?:boolean;plan?:EntityPlan;choices?:SyncChoices;mode?:"merge"|"local"|"cloud"}){
    if(this.stopped)return;
    if(this.running){this.queued=true;return;}
    if(!action && document.visibilityState==="hidden"){this.queued=true;return;}
    if(!this.options.canRun()){
      this.queued=true;
      if(!paused.has(this.view.phase))this.patch({phase:"waiting",status:"Синхронизация продолжится после завершения редактирования."});
      this.schedule(2000);return;
    }
    if(!action && paused.has(this.view.phase))return;
    this.clearTimer();this.running=true;this.queued=false;
    const generation=this.generation;
    let revision:number|undefined;
    const current=()=>!this.stopped && generation===this.generation && this.options.canRun();
    this.patch({busy:true,phase:"syncing",error:"",status:"Проверяем изменения идей…",nextRetry:null});
    try{
      const acquired=await withSyncLock(async valid=>{
        const allowed=()=>current()&&valid();
        if(!allowed())throw Object.assign(new Error("Sync paused"),{code:"SYNC_PAUSED"});
        const local=await readLocalSnapshot();if(!local)throw new Error("Local library is not initialized");revision=local.revision;
        if(action?.plan && !equal(action.plan.expected,local.library)){this.queued=true;this.patch({phase:"waiting",plan:null,status:"Данные изменились. Проверяем актуальные версии."});return;}
        let plan=action?.plan || await inspectEntitySync(this.scope,local.library,!!action?.activate,allowed);
        if(!allowed())throw Object.assign(new Error("Sync paused"),{code:"SYNC_PAUSED"});
        if(plan.first && !action?.plan){this.patch({phase:"review",plan,status:"Первое подключение этого устройства. Выбери направление переноса."});return;}
        for(let attempt=0;attempt<3;attempt++){
          const result=await applyEntitySync(plan,attempt===0?action?.choices||{}:{},attempt===0?action?.mode||plan.resolveMode||"merge":"merge",message=>{if(current())this.patch({status:message});},allowed);
          if("library" in result){
            if(allowed())this.options.onApplied(result.library);
            this.failures=0;this.patch({phase:"synced",plan:null,error:"",lastSync:result.state.syncedAt,status:"Изменения идей синхронизированы.",nextRetry:null});return;
          }
          plan=result.plan;
          if(plan.conflicts.length){this.patch({phase:"conflict",plan,status:"Выберите варианты конфликтующих записей."});return;}
        }
        this.queued=true;this.patch({phase:"waiting",plan:null,status:"Есть новые изменения. Повторите синхронизацию."});
      });
      if(!acquired){this.queued=true;this.patch({phase:"waiting",status:"Синхронизация выполняется в другой вкладке."});}
    }catch(reason){
      if(!this.stopped && generation===this.generation){
        const error=reason as Error & {code?:string;status?:number};
        const latest=await readLocalSnapshot().catch(()=>null);
        if(error.code==="SYNC_PAUSED" || !this.options.canRun() || (revision!==undefined && latest?.revision!==revision)){
          this.queued=true;this.patch({phase:"waiting",plan:null,error:"",status:"Изменения сохранены на устройстве. Ожидаем отправку."});
        }else if(error.code==="MIGRATION_REQUIRED"){
          this.patch({phase:"migration",plan:null,status:"Переход обновит облачный формат. Старые версии приложения перестанут синхронизироваться. Выполните переход после обновления приложения на всех устройствах."});
        }else if(error.status===401){
          this.patch({phase:"auth",plan:null,error:error.message,status:"Сессия истекла. Войдите снова, чтобы продолжить синхронизацию."});
        }else if(error.status===0 || error.status===408 || error.status===429 || (error.status||0)>=500 || ["TypeError","AbortError","TimeoutError"].includes(error.name)){
          const delay=retryDelays[Math.min(this.failures++,retryDelays.length-1)];
          this.patch({phase:navigator.onLine===false?"offline":"retry",plan:null,error:error.message,status:"Не удалось связаться с облаком. Повторим автоматически.",nextRetry:Date.now()+delay});
        }else this.patch({phase:"error",plan:null,error:error.message||"Не удалось выполнить синхронизацию. Локальная копия сохранена.",status:""});
      }
    }finally{
      this.running=false;
      if(!this.stopped){
        this.patch({busy:false});
        if(!paused.has(this.view.phase))this.schedule(this.view.nextRetry?Math.max(0,this.view.nextRetry-Date.now()):this.queued?debounceMs:pollMs);
      }
    }
  }
}
