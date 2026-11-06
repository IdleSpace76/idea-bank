import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source=await readFile(new URL("../lib/scoped-controller.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={},timers=new Map();let id=0,refreshes=0,locks=0,flushes=0,receive=()=>{},rows=[];const modes=[];
let receiveRevision=()=>{},foreignDuringFlush=false;
class ScopedError extends Error {}
const modules={
  "./sync-events-client":{SyncEventsClient:class{constructor(options){receiveRevision=options.onRevision;}start(){}stop(){}}},
  "./sync-lock":{withSyncLock:async work=>{locks++;await work(()=>true);return true;}},
  "./sync-controller":{initialSyncView:{phase:"waiting",busy:false,status:"",error:"",lastSync:"",plan:null,nextRetry:null}},
  "./scoped-client":{ScopedError,flushScoped:async entry=>{flushes++;rows=rows.filter(row=>row!==entry);receive("owner");const ownRevision=`own-${entry.sequence}`;receiveRevision(ownRevision);if(foreignDuringFlush)receiveRevision("foreign-write");return {read:{heads:[ownRevision]},ownRevision};}},
  "./scoped-store":{beginScopedBatch:()=>()=>{},readScopedIndex:async()=>[...rows],readScopedEntry:async(_scope,target)=>rows.find(row=>row.target.id===target.id),subscribeScoped:callback=>{receive=callback;return()=>{};}},
  "./reader-cache":{markReaderStale:async()=>{}},
  "./cloud-access":{cloudBackoffRemaining:()=>0,retryCloudAccess:()=>{}},
};
vm.runInNewContext(compiled,{exports,Date,window:new EventTarget(),document:Object.assign(new EventTarget(),{visibilityState:"visible"}),navigator:{onLine:true},setTimeout:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimeout:key=>timers.delete(key),require:name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];}});
const controller=new exports.ScopedSyncController("owner",{canRun:()=>true,refresh:local=>{refreshes++;modes.push(local);}});controller.start();
await controller.check();assert.equal(locks,0,"An idle controller does not acquire a write lease");
assert.equal(refreshes,1);
refreshes=0;
rows=Array.from({length:3},(_,n)=>({scope:"owner",target:{id:String(n),kind:"idea"},sequence:n+1}));
await controller.check(false,undefined,true);
assert.equal(flushes,3);assert.equal(locks,1);assert.equal(refreshes,1,"Per-entry acknowledgements produce one local refresh after the batch");
assert.equal(modes.at(-1),true,"An automatic upload does not download the catalog again");
assert.ok([...timers.values()].some(timer=>timer.delay===600000),"The safety check stays at ten minutes without a broker too");
assert.equal(rows.length,0);assert.equal(controller.getSnapshot().phase,"synced");
assert.ok(![...timers.values()].some(timer=>timer.delay===250),"The broker echo of our own PUT cannot schedule another cloud read");
foreignDuringFlush=true;rows=[{scope:"owner",target:{kind:"idea",id:"foreign-case"},sequence:4}];
await controller.check(false,undefined,true);
assert.ok([...timers.values()].some(timer=>timer.delay===250),"An unrelated event during our PUT is still fetched");
await controller.check(false,undefined,true);assert.equal(modes.at(-1),false);
controller.stop();assert.equal(timers.size,0);
console.log("Scoped controller budget: no idle write lock and one local refresh for a three-idea batch passed.");
