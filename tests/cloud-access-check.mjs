import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source=await readFile(new URL("../lib/cloud-access.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let now=1000000, calls=0, mode="ok", release;
const exports={},pendingResponses=new Map();
vm.runInNewContext(compiled,{exports,Headers,Date:{now:()=>now},fetch:async path=>{
  calls++;
  if(mode==="race")return new Promise(resolve=>pendingResponses.set(path,resolve));
  if(mode==="held")await new Promise(resolve=>release=resolve);
  if(mode==="denied")return Response.json({error:{code:"STORAGE_ACCESS_DENIED",message:"Fixture denied"}},{status:503});
  if(mode==="unavailable")return Response.json({error:{code:"STORAGE_UNAVAILABLE",message:"Fixture unavailable"}},{status:502});
  if(mode==="network")throw new TypeError("Fixture network");
  return Response.json({ok:true});
}});
const {cloudFetch,cloudBackoffRemaining,retryCloudAccess,CloudAccessError}=exports;
mode="held";
const concurrent=Array.from({length:20},()=>cloudFetch("/api/catalog?limit=24",{},"owner"));
assert.equal(calls,1,"Twenty concurrent identical reads produce one HTTP request");
release();
for(const response of await Promise.all(concurrent))assert.deepEqual(await response.json(),{ok:true},"Every consumer can independently read the body");
mode="ok";
await cloudFetch("/api/catalog?limit=24",{},"another-owner");
assert.equal(calls,2);
mode="denied";
assert.equal((await cloudFetch("/api/catalog",{})).status,503);
assert.equal(cloudBackoffRemaining(),300000);
const before=calls;
for(let n=0;n<50;n++)await assert.rejects(()=>cloudFetch(n%2?"/api/ideas/i":"/api/sync/scoped",n%2?{}:{method:"PUT",body:"fixture"}),e=>e instanceof CloudAccessError && e.code==="STORAGE_ACCESS_DENIED" && e.status===503);
assert.equal(calls,before,"Reads and queued writes cannot bypass the B2 denial pause");
now+=299999;
await assert.rejects(()=>cloudFetch("/api/catalog",{}));assert.equal(calls,before);
now++;
mode="ok";await cloudFetch("/api/catalog",{});
assert.equal(calls,before+1);assert.equal(cloudBackoffRemaining(),0);
mode="denied";await cloudFetch("/api/catalog",{});
retryCloudAccess();mode="ok";await cloudFetch("/api/catalog",{});
assert.equal(cloudBackoffRemaining(),0,"Explicit retry bypasses the pause");
mode="unavailable";
for(const expected of [5000,15000,60000,300000,300000]){
  await cloudFetch("/api/catalog",{});assert.equal(cloudBackoffRemaining(),expected);now+=expected;
}
retryCloudAccess();mode="network";await assert.rejects(()=>cloudFetch("/api/catalog",{}));
assert.equal(cloudBackoffRemaining(),5000);
await assert.rejects(()=>cloudFetch("/api/catalog",{}),e=>e.code==="NETWORK");
console.log("Cloud access: concurrent reads, B2 denial pause, queued-write protection, explicit retry and bounded backoff passed.");

for(const later of [200,502]){
  retryCloudAccess();mode="race";
  const denied=cloudFetch("/api/catalog",{}),other=cloudFetch("/api/other",{});
  pendingResponses.get("/api/catalog")(Response.json({error:{code:"STORAGE_ACCESS_DENIED",message:"Fixture denied"}},{status:503}));await denied;
  pendingResponses.get("/api/other")(Response.json({error:{code:"STORAGE_UNAVAILABLE"}},{status:later}));await other;
  assert.equal(cloudBackoffRemaining(),300000,"A later concurrent success/failure cannot remove or shorten a B2 denial pause");
}
retryCloudAccess();mode="race";
const older=cloudFetch("/api/catalog",{}),newer=cloudFetch("/api/other",{});
pendingResponses.get("/api/other")(Response.json({error:{code:"STORAGE_UNAVAILABLE"}},{status:502}));await newer;
pendingResponses.get("/api/catalog")(Response.json({error:{code:"STORAGE_ACCESS_DENIED",message:"Fixture denied"}},{status:503}));await older;
assert.equal(cloudBackoffRemaining(),300000,"An older request finishing last can still establish a denial pause");
console.log("Cloud pause races: out-of-order successes and weaker errors cannot bypass a B2 denial passed.");

// Media signing participates in the same pause and shares local lookups too.
retryCloudAccess();mode="denied";
const mediaSource=await readFile(new URL("../lib/media-cache.ts",import.meta.url),"utf8"),mediaExports={};
let mediaReads=0;
const modules={
  "./local-database":{transaction:()=>{throw new Error("Unexpected cache write");}},
  "./library-store":{readMeta:async()=>undefined},
  "./media-store":{readMediaFile:async()=>{mediaReads++;return undefined;}},
  "./media-cache-store":{},
  "./entity-sync":{entityKey:()=>"fixture"},
  "./cloud-library":{},"./cloud-sync":{},"./i18n":{translate:value=>value},"./cloud-access":exports,
};
vm.runInNewContext(ts.transpileModule(mediaSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:mediaExports,Date:{now:()=>now},AbortSignal,require:name=>{assert.ok(Object.hasOwn(modules,name));return modules[name];}});
const beforeMedia=calls;
const outcomes=await Promise.allSettled(Array.from({length:20},()=>mediaExports.getMediaFile("fixture","owner")));
assert.ok(outcomes.every(result=>result.status==="rejected"));assert.equal(mediaReads,1);assert.equal(calls,beforeMedia+1);
for(let n=0;n<20;n++)await assert.rejects(()=>mediaExports.getMediaFile("fixture","owner"));
assert.equal(calls,beforeMedia+1,"Media preview retries cannot bypass a storage denial");
console.log("Media access: one local lookup for concurrent previews and no HTTP retries during a B2 pause passed.");
