import { SyncEventsClient } from "./sync-events-client";
import { withSyncLock } from "./sync-lock";
import { initialSyncView,type SyncView } from "./sync-controller";
import { flushScoped,scopedPlan,type ScopedPlan,ScopedError } from "./scoped-client";
import { queueScoped,readScopedEntry,readScopedIndex,subscribeScoped } from "./scoped-store";
import type { SyncChoices,EntityPlan } from "./entity-client";
import type { SyncTarget } from "./scoped-types";
import { markReaderStale } from "./reader-cache";
import { cloudBackoffRemaining,retryCloudAccess } from "./cloud-access";
type Options={canRun:()=>boolean;refresh:()=>void};
/** Flush one durable edit domain at a time; events invalidate reads instead of downloading bodies. */
export class ScopedSyncController {
  private view:SyncView={...initialSyncView,phase:"synced"};
  private listeners=new Set<()=>void>();
  private stopped=true;private running=false;private generation=0;private failures=0;
  private timer:ReturnType<typeof setTimeout>|null=null;private events:SyncEventsClient|null=null;
  private cleanup:(()=>void)|null=null;private healthy=false;private refreshPending=false;
  private seen=new Set<string>();
  constructor(readonly scope:string,private options:Options){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  getSnapshot=()=>this.view;
  private patch(value:Partial<SyncView>){this.view={...this.view,...value};for(const listener of this.listeners)listener();}
  private schedule(delay:number,invalidate=false){if(this.stopped || document.visibilityState==="hidden")return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;if(invalidate)this.refreshPending=true;void this.check(false,undefined,true);},Math.max(delay,cloudBackoffRemaining()));}
  private refresh(){if(this.options.canRun()){this.refreshPending=false;this.options.refresh();}else this.refreshPending=true;}
  start(){
    if(!this.stopped)return;this.stopped=false;this.generation++;
    const wake=()=>{if(document.visibilityState==="hidden"){if(this.timer)clearTimeout(this.timer);this.timer=null;return;}if(navigator.onLine===false)this.patch({phase:"offline"});else{if(this.view.phase==="auth")this.patch({phase:"waiting"});this.schedule(100);}};
    const offline=()=>{if(this.timer)clearTimeout(this.timer);this.timer=null;if(!this.running)this.patch({phase:"offline",status:"Нет сети. Изменения сохранены на устройстве."});};
    const unsubscribe=subscribeScoped(scope=>{if(scope===this.scope){this.refresh();if(this.view.phase!=="conflict"){this.patch({phase:navigator.onLine===false?"offline":"waiting"});this.schedule(1200);}}});
    window.addEventListener("online",wake);window.addEventListener("offline",offline);window.addEventListener("focus",wake);document.addEventListener("visibilitychange",wake);
    this.events=new SyncEventsClient({onRevision:revision=>{
      if(this.stopped || this.seen.has(revision))return;this.seen.add(revision);while(this.seen.size>512)this.seen.delete(this.seen.values().next().value!);
      void markReaderStale(this.scope).catch(()=>{});this.refreshPending=true;this.schedule(250);
    },onConnection:ready=>{this.healthy=ready;if(ready){this.refreshPending=true;this.schedule(250);}else if(!this.running)this.schedule(60000);}});
    this.events.start();this.cleanup=()=>{unsubscribe();window.removeEventListener("online",wake);window.removeEventListener("offline",offline);window.removeEventListener("focus",wake);document.removeEventListener("visibilitychange",wake);};
    if(navigator.onLine===false)offline();else this.schedule(100);
  }
  stop(){this.stopped=true;this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=null;this.events?.stop();this.events=null;this.cleanup?.();this.cleanup=null;}
  contextChanged(){if(this.options.canRun() && !["conflict","auth","error"].includes(this.view.phase)){if(this.refreshPending)this.refresh();this.schedule(1200);}}
  review(plan:ScopedPlan){this.patch({phase:"conflict",plan,error:"",busy:false});}
  resolve=async(plan:EntityPlan,choices:SyncChoices={})=>{
    const scoped=plan as ScopedPlan;
    if(!scoped.target)return;
    try {
      const current=await readScopedEntry(this.scope,scoped.target);
      if(scoped.sequence && current?.sequence!==scoped.sequence){this.patch({phase:"waiting",plan:null});await this.check();return;}
      if(!scoped.sequence)await queueScoped(this.scope,scoped.target,{...scoped.read,target:scoped.target},scoped.local,0);
      await this.check(false,{plan:scoped,choices});
    }catch(error){this.patch({phase:"error",error:error instanceof Error?error.message:String(error)});}
  };
  check=async(_activate=false,resolution?:{plan:ScopedPlan;choices:SyncChoices},automatic=false)=>{
    if(this.stopped || this.running)return;
    if(navigator.onLine===false){this.patch({phase:"offline"});return;}
    if(automatic && cloudBackoffRemaining()){this.schedule(cloudBackoffRemaining(),true);return;}
    if(!automatic)retryCloudAccess();
    if(!this.options.canRun()){this.refreshPending=true;this.schedule(2000);return;}
    if(automatic && !resolution && ["conflict","auth","error"].includes(this.view.phase))return;
    if(!automatic)this.refreshPending=true;
    this.running=true;const generation=this.generation;
    if(this.timer)clearTimeout(this.timer);this.timer=null;
    const valid=()=>!this.stopped && generation===this.generation && this.options.canRun();
    try {
      await withSyncLock(async lock=>{
        for(let n=0;n<100 && valid() && lock();n++) {
          const index=(await readScopedIndex()).filter(row=>row.scope===this.scope).sort((a,b)=>a.sequence-b.sequence);
          const row=resolution?index.find(row=>row.target.id===resolution!.plan.target.id && row.target.kind===resolution!.plan.target.kind):index[0];
          if(!row)break;
          const entry=await readScopedEntry(this.scope,row.target);if(!entry)continue;
          this.patch({busy:true,phase:"syncing",error:"",plan:null,status:"Отправляем изменения идеи…"});
          const result=await flushScoped(entry,resolution?.choices,resolution?{...resolution.plan.read,target:resolution.plan.target}:undefined,message=>this.patch({status:message}),()=>valid()&&lock());
          resolution=undefined;
          if("plan" in result){if(valid())this.review(result.plan);return;}
          if("read" in result)for(const revision of result.read.heads)this.seen.add(revision);
          while(this.seen.size>512)this.seen.delete(this.seen.values().next().value!);
          if(valid())this.refresh();
        }
      });
      if(valid() && this.view.phase!=="conflict"){
        this.failures=0;
        const remaining=(await readScopedIndex()).some(row=>row.scope===this.scope);
        this.patch({phase:remaining?"waiting":"synced",error:"",plan:null,lastSync:new Date().toISOString(),status:"Изменения идей синхронизированы."});
        if(this.refreshPending)this.refresh();this.schedule(remaining?1200:this.healthy?600000:60000,!remaining);
      }
    }catch(error){
      if(!this.stopped && generation===this.generation){
        if(error instanceof ScopedError && error.code==="SYNC_PAUSED"){this.patch({phase:"waiting"});this.schedule(1200);return;}
        const auth=error instanceof ScopedError && error.status===401;
        const fatal=error instanceof ScopedError && [400,413,415,422].includes(error.status);
        this.patch({phase:auth?"auth":fatal?"error":error instanceof ScopedError && error.code==="STORAGE_ACCESS_DENIED"?"unavailable":"retry",error:error instanceof Error?error.message:"Не удалось выполнить облачный запрос."});
        if(!auth&&!fatal)this.schedule([2000,5000,10000,30000,60000,120000,300000][Math.min(this.failures++,6)]);
      }
    }finally{this.running=false;if(!this.stopped && generation===this.generation)this.patch({busy:false});}
  };
}
