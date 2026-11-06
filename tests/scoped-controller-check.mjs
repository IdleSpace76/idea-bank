import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source=await readFile(new URL("../lib/scoped-controller.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={},timers=new Map();let id=0,refreshes=0,locks=0,flushes=0,receive=()=>{},rows=[];
class ScopedError extends Error {}
const modules={
  "./sync-events-client":{SyncEventsClient:class{start(){}stop(){}}},
  "./sync-lock":{withSyncLock:async work=>{locks++;await work(()=>true);return true;}},
  "./sync-controller":{initialSyncView:{phase:"waiting",busy:false,status:"",error:"",lastSync:"",plan:null,nextRetry:null}},
  "./scoped-client":{ScopedError,flushScoped:async entry=>{flushes++;rows=rows.filter(row=>row!==entry);receive("owner");return {read:{heads:[]}};}},
  "./scoped-store":{beginScopedBatch:()=>()=>{},readScopedIndex:async()=>[...rows],readScopedEntry:async(_scope,target)=>rows.find(row=>row.target.id===target.id),subscribeScoped:callback=>{receive=callback;return()=>{};}},
  "./reader-cache":{markReaderStale:async()=>{}},
  "./cloud-access":{cloudBackoffRemaining:()=>0,retryCloudAccess:()=>{}},
};
vm.runInNewContext(compiled,{exports,Date,window:new EventTarget(),document:Object.assign(new EventTarget(),{visibilityState:"visible"}),navigator:{onLine:true},setTimeout:(fn,delay)=>{timers.set(++id,{fn,delay});return id;},clearTimeout:key=>timers.delete(key),require:name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];}});
const controller=new exports.ScopedSyncController("owner",{canRun:()=>true,refresh:()=>{refreshes++;}});controller.start();
await controller.check();assert.equal(locks,0,"An idle controller does not acquire a write lease");
assert.equal(refreshes,1);
refreshes=0;
rows=Array.from({length:3},(_,n)=>({scope:"owner",target:{id:String(n),kind:"idea"},sequence:n+1}));
await controller.check();
assert.equal(flushes,3);assert.equal(locks,1);assert.equal(refreshes,1,"Per-entry acknowledgements produce one cloud refresh after the batch");
assert.equal(rows.length,0);assert.equal(controller.getSnapshot().phase,"synced");controller.stop();assert.equal(timers.size,0);
console.log("Scoped controller budget: no idle write lock and one cloud refresh for a three-idea batch passed.");
