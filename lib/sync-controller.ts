import { inspectEntitySync, applyEntitySync, type EntityPlan, type SyncChoices } from "./entity-client";
import { readLocalSnapshot, readMeta, subscribeLocalChanges } from "./library-store";
import type { Library } from "./ideas";
import { equal, type SyncCheckpoint } from "./entity-sync";
import { withSyncLock } from "./sync-lock";
import { SyncEventsClient } from "./sync-events-client";

export type SyncPhase = "waiting" | "syncing" | "synced" | "offline" | "unavailable" | "retry" | "review" | "conflict" | "migration" | "auth" | "error";
export type SyncView = { phase: SyncPhase; busy: boolean; status: string; error: string; lastSync: string; plan: EntityPlan | null; nextRetry: number | null };
export const initialSyncView: SyncView = {phase:"waiting",busy:false,status:"",error:"",lastSync:"",plan:null,nextRetry:null};
export const syncLabel = (phase: SyncPhase): string => ({waiting:"Ожидает отправки",syncing:"Синхронизация…",synced:"Сохранено в облаке",offline:"Нет сети",unavailable:"Облако недоступно",retry:"Повторим автоматически",review:"Нужна настройка",conflict:"Есть конфликт",migration:"Нужен переход",auth:"Нужно войти",error:"Ошибка синхронизации"})[phase];
const safetyPollMs=600000, fallbackPollMs=60000, debounceMs=1200, wakeThrottleMs=2000;
const retryDelays=[2000,5000,10000,30000,60000,120000,300000];
const paused = new Set<SyncPhase>(["review","conflict","migration","auth","error"]);

type Options = { canRun:()=>boolean; onApplied:(library:Library)=>void };
/** One controller owns automatic work and manual choices; closing the dialog never stops syncing. */
export class SyncController {
  private view:SyncView=initialSyncView;
  private listeners=new Set<()=>void>();
  private timer:ReturnType<typeof setTimeout>|null=null;
  private timerAt=0;
  private lastStarted=0;
  private events:SyncEventsClient|null=null;
  private eventsReady=false;
  private knownRevisions=new Set<string>();
  private pendingRevisions=new Set<string>();
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
  private clearTimer(){if(this.timer!==null)clearTimeout(this.timer);this.timer=null;this.timerAt=0;}
  private schedule(delay:number,earlierOnly=false){
    if(this.stopped || paused.has(this.view.phase) || document.visibilityState==="hidden" || navigator.onLine===false)return;
    if(earlierOnly && this.timer!==null && this.timerAt<=Date.now()+delay)return;
    this.clearTimer();
    this.timerAt=Date.now()+delay;
    this.timer=setTimeout(()=>{this.timer=null;this.timerAt=0;void this.execute();},delay);
  }
  private pollDelay(){return this.eventsReady?safetyPollMs:fallbackPollMs;}
  private wakeCheck(){this.schedule(Math.max(100,this.lastStarted+wakeThrottleMs-Date.now()),true);}
  private remember(state:SyncCheckpoint){
    for(const revisions of Object.values(state.index))for(const revision of revisions)this.knownRevisions.add(revision);
    while(this.knownRevisions.size>512)this.knownRevisions.delete(this.knownRevisions.values().next().value!);
    for(const revision of this.pendingRevisions)if(this.knownRevisions.has(revision))this.pendingRevisions.delete(revision);
  }
  start(){
    if(!this.stopped)return;
    this.stopped=false;this.generation++;
    const wake=()=>{
      if(document.visibilityState==="hidden"){this.clearTimer();return;}
      if(this.view.phase==="auth")this.patch({phase:"waiting",error:""});
      this.failures=0;this.wakeCheck();
    };
    const offline=()=>{
      if(paused.has(this.view.phase))return;
      this.patch({phase:"offline",status:"Нет сети. Изменения сохранены на устройстве."});this.clearTimer();
    };
    const unsubscribe=subscribeLocalChanges(kind=>{
      if(kind==="remote"){
        void readMeta<SyncCheckpoint>("sync-v2").then(state=>{
          if(this.stopped || state?.scope!==this.scope)return;
          this.remember(state);
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
    this.events=new SyncEventsClient({
      onRevision:revision=>{
        if(this.stopped || this.knownRevisions.has(revision) || this.pendingRevisions.has(revision))return;
        // Bound untrusted notification memory. A single pending hint is enough to read the index.
        if(this.pendingRevisions.size<256)this.pendingRevisions.add(revision);
        if(!this.running)this.schedule(250,true);
      },
      onConnection:ready=>{
        if(this.stopped)return;
        this.eventsReady=ready;
        if(ready)this.wakeCheck();
        else if(!this.running)this.schedule(this.queued?debounceMs:this.pollDelay(),true);
      },
    });
    this.events.start();
    this.cleanup=()=>{unsubscribe();window.removeEventListener("focus",wake);window.removeEventListener("online",wake);window.removeEventListener("offline",offline);document.removeEventListener("visibilitychange",wake);};
    if(navigator.onLine===false)offline();else this.schedule(100);
  }
  stop(){this.stopped=true;this.generation++;this.clearTimer();this.events?.stop();this.events=null;this.eventsReady=false;this.cleanup?.();this.cleanup=null;}
  /** Recheck immediately after an editor/save/backup releases its local lock. */
  contextChanged(){
    if(this.stopped)return;
    if(this.options.canRun() && !paused.has(this.view.phase)){if(this.queued || this.pendingRevisions.size)this.schedule(debounceMs,true);else this.wakeCheck();}
  }
  check=(activate=false)=>this.execute({activate});
  resolve=(plan:EntityPlan,choices:SyncChoices={},mode:"merge"|"local"|"cloud"=plan.resolveMode||"merge")=>this.execute({plan,choices,mode});
  private async execute(action?:{activate?:boolean;plan?:EntityPlan;choices?:SyncChoices;mode?:"merge"|"local"|"cloud"}){
    if(this.stopped)return;
    if(this.running){this.queued=true;return;}
    if(!action && navigator.onLine===false){this.patch({phase:"offline",status:"Нет сети. Изменения сохранены на устройстве."});return;}
    if(!action && document.visibilityState==="hidden"){this.queued=true;return;}
    if(!this.options.canRun()){
      this.queued=true;
      if(!paused.has(this.view.phase))this.patch({phase:"waiting",status:"Синхронизация продолжится после завершения редактирования."});
      this.schedule(2000);return;
    }
    if(!action && paused.has(this.view.phase))return;
    this.clearTimer();this.running=true;this.queued=false;this.pendingRevisions.clear();this.lastStarted=Date.now();
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
            this.remember(result.state);
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
        if(!paused.has(this.view.phase))this.schedule(this.view.nextRetry?Math.max(0,this.view.nextRetry-Date.now()):this.queued || this.pendingRevisions.size?debounceMs:this.pollDelay());
      }
    }
  }
}
